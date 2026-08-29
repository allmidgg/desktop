/**
 * Verzamelt Classic-matches via de client.
 *
 * Elke opgehaalde game levert tien spelers op, en elke speler levert weer games
 * op -- dus we lopen het netwerk van spelers af vanaf jezelf. Zo groeit de
 * database vanzelf, zonder dat er ooit een externe server aan te pas komt.
 *
 * De client stuurt onze verzoeken door naar Riot, dus we houden ons in: één
 * verzoek tegelijk met een pauze ertussen, en alleen wanneer je niet in een game
 * zit. Een tool die je client plat legt terwijl je speelt is geen tool.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LcuClient } from "../lcu/connector";
import type { Game, MatchHistoryResponse } from "../lcu/types";
import { modeOf } from "../modes/detect";
import { COLLECTED_MODES, modeCrawls } from "../modes/registry";
import { slimGame, type MatchStores } from "./matchStore";

const PAGE_SIZE = 20;

/**
 * Pauze tussen verzoeken. Gemeten: de client handelt een onbekende game af in
 * ongeveer 60ms en klaagt niet bij duizend per minuut. Parallel afvuren helpt
 * niet -- de client zet ze intern toch achter elkaar -- dus houden we het simpel
 * en serieel, met net genoeg lucht om niet bovenop zijn eigen verkeer te zitten.
 */
const DELAY_BETWEEN_REQUESTS_MS = 40;

/** Waar we naar terugvallen zodra de client fouten begint te geven. */
const BACKOFF_MS = 1_500;
const BACKOFF_AFTER_ERRORS = 3;
/** Hoeveel games we per speler bekijken voordat we doorgaan naar de volgende. */
const GAMES_PER_PLAYER = 20;
/** Fases waarin de client met belangrijker dingen bezig is dan onze statistiek. */
const BUSY_PHASES = ["ReadyCheck", "ChampSelect", "GameStart", "InProgress", "Reconnect"];
const BUSY_RECHECK_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CrawlProgress {
  visitedPlayers: number;
  queuedPlayers: number;
  storedMatches: number;
  newThisRun: number;
  /** Games per minuut over deze ronde; handig om te zien of het opschiet. */
  gamesPerMinute: number;
}

export class MatchCrawler {
  private readonly queue: string[] = [];
  /**
   * Spiegelt de wachtrij als verzameling. Zonder dit zou elke controle de hele
   * rij aflopen -- en die groeit naar tienduizenden spelers, dus dan wordt de
   * crawler juist trager naarmate hij meer vindt.
   */
  private readonly queued = new Set<string>();
  private readonly visited = new Set<string>();
  private running = false;
  private stopped = false;
  private newThisRun = 0;
  private startedAt = 0;
  /** Opeenvolgende mislukte verzoeken; bepaalt of we gas terugnemen. */
  private consecutiveErrors = 0;

  constructor(
    private readonly client: LcuClient,
    /**
     * The router, not a single file.
     *
     * This used to be one bare MatchStore, and it was the last writer in the app
     * that appended whatever came back without asking which mode it was.
     * slimGame() stopped rejecting on mode on purpose -- slimming a game and
     * deciding where it belongs are two different jobs -- and wrote down that
     * every caller must therefore route through MatchStores.add(). This one did
     * not. It was unreachable only because the list filter below and the store
     * happened to agree, which puts the guarantee in two places that can drift
     * instead of in the one place that decides.
     */
    private readonly stores: MatchStores,
    private readonly onProgress?: (progress: CrawlProgress) => void,
    /** Wordt aangeroepen als de crawler pauzeert of hervat omdat je speelt. */
    private readonly onPause?: (paused: boolean) => void,
  ) {}

  private statePath: string | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  /** Zet spelers in de wachtrij, zonder dubbelingen. */
  seed(puuids: string[]): void {
    for (const puuid of puuids) this.enqueue(puuid);
  }

  private enqueue(puuid: string): void {
    if (!puuid || this.visited.has(puuid) || this.queued.has(puuid)) return;
    this.queued.add(puuid);
    this.queue.push(puuid);
  }

  /**
   * Onthoudt welke spelers we al gehad hebben, zodat een volgende ronde verder
   * gaat waar deze ophield in plaats van het begin over te doen.
   */
  async loadState(path: string): Promise<void> {
    this.statePath = path;
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as { visited?: string[]; queue?: string[] };
      for (const puuid of data.visited ?? []) this.visited.add(puuid);
      for (const puuid of data.queue ?? []) this.enqueue(puuid);
    } catch {
      // Kapotte staat is niet erg: dan beginnen we gewoon opnieuw met verzamelen.
    }
  }

  async saveState(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    // De wachtrij kan enorm worden; een voorraad van 50k is ruim genoeg werk.
    await writeFile(
      this.statePath,
      JSON.stringify({ visited: [...this.visited], queue: this.queue.slice(0, 50_000) }),
      "utf8",
    );
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Loopt de wachtrij af tot hij leeg is of tot `maxPlayers` bereikt is.
   * Meerdere keren aanroepen is veilig: er draait er altijd maar één.
   */
  async run(maxPlayers = 40): Promise<CrawlProgress> {
    if (this.running) return this.progress();
    this.running = true;
    this.stopped = false;
    this.newThisRun = 0;
    this.startedAt = Date.now();

    try {
      let handled = 0;
      while (this.queue.length > 0 && handled < maxPlayers && !this.stopped) {
        const puuid = this.takeNext();
        if (!puuid) continue;
        this.queued.delete(puuid);
        if (this.visited.has(puuid)) continue;
        this.visited.add(puuid);
        handled++;

        await this.waitWhileBusy();
        if (this.stopped) break;

        const { games, ok } = await this.fetchJadeGames(puuid);
        if (!ok) {
          // Client weg: speler terug in de rij en wachten tot hij er weer is.
          this.visited.delete(puuid);
          this.enqueue(puuid);
          handled--;
          await this.waitForClient();
          continue;
        }
        const detailed = await this.fetchDetails(games);
        const slimmed = detailed.map(slimGame).filter((m): m is NonNullable<typeof m> => m !== null);
        // Each game into the file its own record says it belongs in. The list
        // filter above should mean every one of these is a crawled mode, and
        // this is what makes that a fact rather than an agreement between two
        // filters: a game that slipped through lands in its own store instead of
        // in the Classic one, where nothing downstream would ever have said so.
        const gefileerd = await this.stores.add(slimmed);
        this.newThisRun += gefileerd.jade + gefileerd.sr;

        // Nieuwe spelers uit deze games achteraan in de rij.
        for (const match of slimmed) {
          for (const player of match.players) this.enqueue(player.puuid);
        }
        this.onProgress?.(this.progress());
        // Regelmatig opslaan, zodat een afgebroken ronde niets kost.
        if (handled % 25 === 0) await this.saveState();
      }
    } finally {
      this.running = false;
      await this.saveState();
    }
    return this.progress();
  }

  /**
   * Pakt de volgende speler willekeurig uit de wachtrij in plaats van vooraan.
   *
   * Op volgorde werken betekent dat je een vriendenkring helemaal uitspit: die
   * mensen spelen met elkaar, dus hun games kennen we na de eerste paar al. Door
   * te springen belanden we steeds in een ander deel van het netwerk, en levert
   * elke speler veel vaker games op die we nog niet hadden.
   */
  private takeNext(): string | undefined {
    if (this.queue.length === 0) return undefined;
    const index = Math.floor(Math.random() * this.queue.length);
    const last = this.queue.length - 1;
    const puuid = this.queue[index];
    // Het laatste element naar voren halen is goedkoper dan de rij opschuiven.
    if (index !== last) this.queue[index] = this.queue[last]!;
    this.queue.pop();
    return puuid;
  }

  /**
   * Houdt de crawler stil zolang je in de wachtrij, in champ select of in een
   * game zit. Hij pikt vanzelf de draad weer op als je klaar bent, zodat een
   * lange verzamelronde je nooit in de weg zit.
   */
  private async waitWhileBusy(): Promise<void> {
    let announced = false;
    for (;;) {
      const phase = await this.client
        .tryGet<string>("/lol-gameflow/v1/gameflow-phase")
        .catch(() => null);
      if (!phase || !BUSY_PHASES.includes(phase) || this.stopped) {
        if (announced) this.onPause?.(false);
        return;
      }
      if (!announced) {
        announced = true;
        this.onPause?.(true);
      }
      await sleep(BUSY_RECHECK_MS);
    }
  }

  /**
   * How many games sit in the stores this crawler is allowed to fill.
   *
   * Summed over the crawled modes rather than reading one file, so the number
   * beside "games" on the CLI keeps meaning "what this run is adding to" if a
   * second mode is ever opened to crawling. Modes it may not crawl are left out:
   * counting the modern store here would make the line grow every time you played
   * a game yourself, which is not what a crawl counter reports.
   */
  private get storeSize(): number {
    let total = 0;
    for (const mode of COLLECTED_MODES) {
      if (modeCrawls(mode)) total += this.stores.for(mode).size;
    }
    return total;
  }

  private progress(): CrawlProgress {
    const minutes = (Date.now() - this.startedAt) / 60_000;
    return {
      visitedPlayers: this.visited.size,
      queuedPlayers: this.queue.length,
      storedMatches: this.storeSize,
      newThisRun: this.newThisRun,
      gamesPerMinute: minutes > 0 ? this.newThisRun / minutes : 0,
    };
  }

  /**
   * Haalt de Classic-games van een speler op.
   *
   * `ok: false` betekent dat de aanvraag zelf mislukte -- meestal omdat de client
   * afgesloten is. Dat is iets heel anders dan "deze speler heeft geen games", en
   * dat onderscheid is cruciaal: zonder dat zou een nacht met League dicht
   * duizenden spelers als afgehandeld wegstrepen die we nooit bekeken hebben.
   */
  /**
   * Pauzeert tussen verzoeken, en langer zodra het misgaat. Zo blijven we snel
   * als het goed gaat en trekken we ons vanzelf terug als de client het zwaar
   * heeft -- zonder dat iemand een knop hoeft om te zetten.
   */
  private async pace(): Promise<void> {
    await sleep(
      this.consecutiveErrors >= BACKOFF_AFTER_ERRORS ? BACKOFF_MS : DELAY_BETWEEN_REQUESTS_MS,
    );
  }

  private async fetchJadeGames(puuid: string): Promise<{ games: Game[]; ok: boolean }> {
    const found: Game[] = [];
    for (let begin = 0; begin < GAMES_PER_PLAYER; begin += PAGE_SIZE) {
      await this.pace();
      let res: MatchHistoryResponse | null;
      try {
        res = await this.client.tryGet<MatchHistoryResponse>(
          `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=${begin}&endIndex=${begin + PAGE_SIZE - 1}`,
        );
      } catch {
        this.consecutiveErrors++;
        return { games: found, ok: false };
      }
      this.consecutiveErrors = 0;
      const page = res?.games?.games ?? [];
      if (page.length === 0) break;
      // Still filtered, and deliberately so. This walks the match histories of
      // strangers, which is the act Riot's developer policy is about -- and for
      // the modern game there is a documented way in (MATCH-V5) while for
      // Classic there is none. Opening this would collect data we are meant to
      // fetch legally, at the cost of the data we cannot get any other way: the
      // client answers one request at a time, so every modern game fetched here
      // is a Classic game not fetched, and the store is the memory ceiling of
      // the app long before the disk is (measured on the real database: 130,188
      // games hold 483 MB of heap, and nothing sets --max-old-space-size).
      //
      // A classifier rather than the old boolean, so this is routing that
      // currently has one destination instead of a wall. Your own history is a
      // different question: reading the games you played yourself is what every
      // companion app does, and it is not a scrape.
      // The literal "lol:jade" used to stand here. It now asks the registry the
      // same question, because the empty tier list has to print the reason this
      // filter exists and two copies of one rule drift apart without anything
      // failing.
      found.push(
        ...page.filter((game) =>
          modeCrawls(modeOf({ queueId: game.queueId, mapId: game.mapId, gameMode: game.gameMode })),
        ),
      );
    }
    return { games: found, ok: true };
  }

  /**
   * Wacht tot de client weer reageert. Sluit je League af, dan blijft de crawler
   * gewoon staan wachten in plaats van de wachtrij leeg te malen.
   */
  private async waitForClient(): Promise<void> {
    let announced = false;
    for (;;) {
      if (this.stopped) return;
      const alive = await this.client
        .tryGet<string>("/lol-gameflow/v1/gameflow-phase")
        .then(() => true)
        .catch(() => false);
      if (alive) {
        if (announced) this.onPause?.(false);
        return;
      }
      if (!announced) {
        announced = true;
        this.onPause?.(true);
      }
      await sleep(BUSY_RECHECK_MS);
    }
  }

  /**
   * De lijstweergave bevat alleen de opgevraagde speler; voor de andere negen
   * hebben we het volledige rapport nodig. Games die we al hebben slaan we over,
   * en dat is precies waarom herhaald crawlen goedkoop blijft.
   */
  private async fetchDetails(games: Game[]): Promise<Game[]> {
    const detailed: Game[] = [];
    for (const game of games) {
      // The platform comes along, because a game id is only unique within one
      // shard. The list form carries it (measured: "EUW1" on every row), so
      // asking with it costs nothing and keeps this from skipping a game we do
      // not have on the strength of a number another region handed out.
      // Across both stores, for the same reason bewaarEigenGames asks that way:
      // at this point we hold an id and not the detail that says which mode it
      // is, so "do we already have this game" is a question about the database
      // and not about one file.
      if (this.stores.has(game.gameId, game.platformId) || this.stopped) continue;
      await this.pace();
      const full = await this.client
        .tryGet<Game>(`/lol-match-history/v1/games/${game.gameId}`)
        .catch(() => null);
      if (full) {
        this.consecutiveErrors = 0;
        detailed.push(full);
      } else {
        this.consecutiveErrors++;
      }
    }
    return detailed;
  }
}
