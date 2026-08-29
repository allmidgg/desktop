/**
 * De motor achter de app: houdt de verbinding met de client in stand, luistert
 * naar wat er in de client gebeurt en vertaalt dat naar een momentopname die de
 * UI kan tekenen.
 *
 * Hier woont ook de matchdatabase. Die vult zichzelf op de achtergrond met
 * Classic-games van iedereen die we tegenkomen, want zonder eigen data zijn er
 * geen counters -- niemand anders verzamelt deze modus.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { LcuEventStream } from "../core/lcu/events";
import type { Game } from "../core/lcu/types";
import { JadeCatalog, type JadeChampion } from "../core/jade/catalog";
import { MasteryCatalog } from "../core/jade/masteries";
import { RuneCatalog, RUNE_SLOTS, type RuneKind } from "../core/jade/runes";
import {
  applyLoadoutPatch, buildActivePagePatch, buildMasteryPagePatch, buildRunePagePatch,
  fetchAccountLoadout, readMasteryPages, readRunePages, type Loadout,
} from "../core/services/loadout";
import {
  buildPlayerProfile, fetchCurrentSummoner, fetchJadeGames, participantOf,
  fetchSummonerByRiotId, type PlayerProfile,
} from "../core/services/player";
import { planRunes } from "../core/services/runeOptimizer";
import { planMasteries } from "../core/services/masteryOptimizer";
import {
  watchChampSelect, resolveBans, type ChampSelectView, type ChampSelectPlayer,
} from "../core/services/champSelect";
import { JADE_MAP_ID } from "../core/jade/ids";
import { LiveClient } from "../core/lcu/liveClient";
import { CommunityStatsCache, type CommunityLoad } from "../core/services/communityStats";
import { LiveGameWatcher, championZoeker } from "../core/services/liveGame";
import {
  MatchStore, defaultStorePath, slimGame,
  type Position, type StoredMatch, type StoredPlayer,
} from "../core/services/matchStore";
import { sluitAfgebrokenRegel, TijdlijnStore } from "../core/services/tijdlijn";
import { HistorieTijdlijnStore } from "../core/services/historieTijdlijn";
import { MatchCrawler } from "../core/services/crawler";
import { JadeStats, likelyPosition, MIN_MATCHUP_GAMES, type ChampionStat } from "../core/services/stats";
import { leesBeeldmodus } from "../core/lcu/beeldmodus";
import {
  SettingsStore, defaultSettingsPath, publicSettings, DEFAULT_SETTINGS, type Settings,
} from "../core/services/settings";
import { MatchUploader, defaultUploadStatePath } from "../core/services/uploader";
import type {
  AppSnapshot, ApplyResult, ChampSelectSnapshot, ChampionSummary, GameflowPhase, LaneAnalysis,
  ChampionDetail, ChampionPlan, GameDetail, ItemEntry, MasteryPlanSummary, MasteryTreeInfo,
  HistorieUitslag, MatchupEntry, PerformanceBaseline, RecentGameSummary, SpelerIjklijn,
  RuneInfo, RunePlanSummary, ScoutEntry, TierEntry, UploadStatus,
} from "../shared/types";

const RECONNECT_DELAY_MS = 3_000;
const LANES: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];
/**
 * Failed polls in a row before a game counts as finished.
 *
 * Three, at the two-second cadence a live game is polled on, so the game has to
 * be unreachable for about six seconds. That is long enough that a single
 * dropped response cannot end a recording, and short enough that the harvest
 * still lands while the client is on the end-of-game screen.
 */
const LIVE_MISLUKT_GRENS = 3;

/**
 * Wanneer we delen.
 *
 * Het natuurlijke moment is het einde van een crawlronde: dat is precies waar
 * nieuwe games vandaan komen, dus dan is er ook echt iets te sturen. Alleen
 * daarop wachten is te weinig -- een gebruiker die de app open laat staan zonder
 * te spelen crawlt niet -- dus tikt er daarnaast een timer mee die hetzelfde
 * doet.
 *
 * Zonder rem zou dat de server platleggen: crawlrondes starten bij elke overgang
 * naar EndOfGame of None, en tien minuten lobbyen levert er zo een handvol op.
 * Vandaar de ondergrens: hoe vaak er ook een aanleiding is, er gaat hooguit eens
 * per kwartier verkeer uit. Dat kost weinig, want de uploader vraagt eerst welke
 * game-ID's de server mist -- is er niets nieuws, dan is een ronde één lijstje
 * nummers.
 *
 * De vertraging bij het opstarten houdt de eerste minuut vrij voor waar de
 * gebruiker op wacht: verbinden, catalogi laden, zijn eigen profiel.
 */
const UPLOAD_TICK_MS = 5 * 60_000;
const UPLOAD_MIN_INTERVAL_MS = 15 * 60_000;
const UPLOAD_START_DELAY_MS = 60_000;

/**
 * Fases waarin we niets versturen. Zelfde redenering als bij de crawler: als jij
 * in champ select of in een game zit, hoort deze app geen bandbreedte en geen
 * aandacht op te eisen. Wat blijft liggen gaat gewoon in de volgende ronde mee.
 */
const UPLOAD_BUSY_PHASES: GameflowPhase[] = [
  "ReadyCheck", "ChampSelect", "GameStart", "InProgress", "Reconnect",
];

/** De client noemt de support-positie "utility"; wij houden het bij SUPPORT. */
function normalizePosition(assigned: string | undefined): Position | null {
  switch ((assigned ?? "").toLowerCase()) {
    case "top":
      return "TOP";
    case "jungle":
      return "JUNGLE";
    case "middle":
    case "mid":
      return "MIDDLE";
    case "bottom":
    case "adc":
      return "BOTTOM";
    case "utility":
    case "support":
      return "SUPPORT";
    default:
      return null;
  }
}

export class JadeService extends EventEmitter {
  private client: LcuClient | null = null;
  private jade: JadeCatalog | null = null;
  private masteries: MasteryCatalog | null = null;
  private runes: RuneCatalog | null = null;
  private loadout: Loadout | null = null;
  private stream: LcuEventStream | null = null;
  private stopChampSelect: (() => void) | null = null;

  private readonly store: MatchStore;
  private readonly settings: SettingsStore;
  private stats = new JadeStats();
  private crawler: MatchCrawler | null = null;
  /**
   * Voor welke champion we de masteries voor het laatst gezet hebben. Zonder dit
   * zou elke champ select-update opnieuw naar de client schrijven.
   */
  private autoMasteryFor: number | null = null;
  private autoMasteryBusy = false;
  /** Voorkomt dat losse gebeurtenissen tegelijk een herverbinding starten. */
  private starting = false;

  /**
   * De uploader wordt pas gemaakt als er echt gedeeld gaat worden, en opnieuw
   * gemaakt zodra het adres of de sleutel verandert -- die zitten vast in het
   * object. De handtekening onthoudt waarvoor de huidige gemaakt is.
   */
  private uploader: MatchUploader | null = null;
  private uploaderSignature = "";
  private uploading = false;
  private uploadTimer: NodeJS.Timeout | null = null;
  private uploadStartTimer: NodeJS.Timeout | null = null;
  /** Begin van de laatste poging; de ondergrens tussen rondes rekent hiermee. */
  private lastUploadAt = 0;
  /**
   * Wat er van de laatste ronde te melden valt. `at` blijft null zolang er niet
   * echt verkeer geweest is: een tik die overgeslagen wordt mag niet als "zojuist
   * gedeeld" in beeld komen, want dan zegt de teller iets anders dan er gebeurde.
   */
  private lastUpload: {
    at: number | null;
    uploaded: number;
    serverTotal: number | null;
    error: string | null;
  } | null = null;

  private readonly backupDir: string;
  /** The games this machine watched, so a finished one can be shown over time. */
  private readonly tijdlijnen: TijdlijnStore;
  /**
   * The per-minute curves match history serves for everybody else's games.
   *
   * The store above covers the two games this machine watched. This one covers
   * any of the 130,086 in the database, one at a time, the moment somebody opens
   * it -- see core/services/historieTijdlijn.ts for why it is fetched on demand
   * rather than backfilled.
   */
  private readonly historie: HistorieTijdlijnStore;
  private readonly uploadStatePath: string;
  private readonly community: CommunityStatsCache;
  /**
   * The running game, read from port 2999.
   *
   * A separate server from the LCU that only exists while a game is in progress,
   * so there is no event stream to subscribe to -- polling is the only option.
   */
  private readonly live = new LiveClient();
  private liveWatcher: LiveGameWatcher | null = null;
  private liveTimer: NodeJS.Timeout | null = null;
  /**
   * Writes the first raw response of each run to disk, once.
   *
   * Everything this reads from a live game was written against the documented
   * shape of the API, never against a real Classic match -- and Classic has its
   * own id space, so the champion names in particular are an assumption. One
   * real sample settles it.
   *
   * Stays on this machine: it holds the Riot IDs of the other nine players, so
   * it is gitignored and never uploaded. Delete it whenever.
   */
  private liveSampleGeschreven = false;
  /**
   * Polls in a row that found nothing, while a game was supposed to be running.
   *
   * The server on 2999 disappearing is how a game announces it is over, and it
   * is the only announcement there is. But LiveClient.get answers null for every
   * kind of failure alike -- a refused connection, a non-200, a body that would
   * not parse, a timeout -- so a single missed poll is indistinguishable from
   * the end of the game, and harvesting on the first one is what turns a blip
   * into two recordings of one game. The second is the worse half: after the
   * harvest the watcher is reset, so when the client answers again the next poll
   * is a first sighting, and noteerAankopen stamps every inventory it finds with
   * that one second -- a recording claiming ten players bought their whole build
   * at minute twenty-two.
   *
   * Waiting for a run of failures costs nothing at the real end of a game, since
   * there is no hurry once the game is gone, and the harvest still happens well
   * inside the time it takes to get back to the client.
   */
  private liveMislukt = 0;
  /** Non-null once the community aggregate is in use, so we can say so. */
  private communityLoad: CommunityLoad | null = null;

  constructor(dataRoot: string) {
    super();
    this.store = new MatchStore(defaultStorePath(dataRoot));
    this.settings = new SettingsStore(defaultSettingsPath(dataRoot));
    this.backupDir = join(dataRoot, "data", "backups");
    this.tijdlijnen = new TijdlijnStore(join(dataRoot, "data", "buildorders.jsonl"));
    this.historie = new HistorieTijdlijnStore(
      join(dataRoot, "data", "historie-tijdlijnen.jsonl"),
      // Looked up per request rather than captured: the client goes away and
      // comes back on a different port, and a frozen reference would be a
      // request into a socket that closed an hour ago.
      () => this.client,
      // A fetch settled. Whoever has that game open should ask again; anyone
      // looking at a different game ignores it.
      (gameId) => this.emit("tijdlijn", gameId),
    );
    this.uploadStatePath = defaultUploadStatePath(dataRoot);
    this.community = new CommunityStatsCache(dataRoot);
  }

  /**
   * Pick the numbers to advise from.
   *
   * The community aggregate wins whenever it is there. It covers every game
   * people chose to share, where the local store only holds what this machine
   * happened to crawl -- on a fresh install, nothing at all. They are not added
   * together on purpose: the app uploads what it crawls, so local games are
   * already inside the aggregate and counting them twice would quietly weight
   * one player's matches against everyone else's.
   */
  private rebuildStats(): void {
    const gedeeld = this.communityLoad;
    if (gedeeld) {
      try {
        this.stats = JadeStats.fromAggregate(gedeeld.stats);
        return;
      } catch (err) {
        // A shape change in the published file should not take the app down; it
        // just means falling back to what we counted ourselves.
        reportBackgroundError(err as Error);
        this.communityLoad = null;
      }
    }
    this.stats = JadeStats.from(this.store.all());
  }

  private snapshot: AppSnapshot = {
    connection: "connecting",
    error: null,
    phase: "None",
    summoner: null,
    profile: null,
    champSelect: null,
    champions: [],
    items: [],
    spells: [],
    masteryPages: [],
    runePages: [],
    recentGames: [],
    database: { matches: 0, players: 0, usableMatchups: 0, crawling: false, community: null },
    settings: publicSettings(DEFAULT_SETTINGS),
    upload: {
      enabled: DEFAULT_SETTINGS.shareMatches,
      server: DEFAULT_SETTINGS.uploadServer,
      busy: false,
      lastRunAt: null,
      shared: 0,
      pending: 0,
      lastUploaded: 0,
      serverTotal: null,
      error: null,
    },
    autoMasteryStatus: null,
    liveGame: null,
    beeldmodus: null,
    update: { fase: "uit", versie: null, voortgang: 0, fout: null },
  };

  getSnapshot(): AppSnapshot {
    return this.snapshot;
  }

  private update(patch: Partial<AppSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("snapshot", this.snapshot);
  }

  /** Blijft proberen tot de client draait; de gebruiker hoeft niets te herstarten. */
  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.settings.load();
      this.update({ settings: this.settings.shared });
      await this.store.load();
      this.rebuildStats();
      this.publishDatabaseStatus();
      this.startUploadSchedule();

      // Deliberately not awaited: a slow or unreachable allmid.gg must never
      // hold up connecting to the client. The numbers get better a second later
      // instead of the window staying blank.
      void this.loadCommunityStats().catch(reportBackgroundError);

      // Before connecting, not after: a game can be running while the client is
      // closed, still restarting, or simply confused about what it launched.
      // Nothing here needs the client.
      this.startLiveWatch();

      // The champion catalogue too. Waiting for the client meant a first-time
      // user who opened AllMid before League saw a tier list of raw ids --
      // 60062, 60053 -- instead of champions. The cache on disk, or Community
      // Dragon, answers just as well and needs nobody to be logged in.
      void this.laadCatalogusVastAlvast().catch(reportBackgroundError);
      void this.laadMasteriesVastAlvast().catch(reportBackgroundError);
      void this.ververisBeeldmodus().catch(reportBackgroundError);

      this.client = await LcuClient.connect();
      await this.onConnected();
    } catch (err) {
      const message =
        err instanceof LcuNotRunningError
          ? "Waiting for the League client..."
          : `Could not connect: ${(err as Error).message}`;
      this.update({ connection: "disconnected", error: message });
      setTimeout(() => void this.start(), RECONNECT_DELAY_MS);
    } finally {
      this.starting = false;
    }
  }

  private async onConnected(): Promise<void> {
    const client = this.client;
    if (!client) return;

    const [jade, masteries, runes] = await Promise.all([
      JadeCatalog.load(client),
      MasteryCatalog.load(client),
      RuneCatalog.load(client),
    ]);
    this.jade = jade;
    this.masteries = masteries;
    this.runes = runes;

    // Splash art comes in behind the app rather than in front of it: sixty-three
    // lookups is long enough that waiting for them leaves the window empty, and
    // artwork arriving a second late costs nobody anything.
    void jade
      .verrijkSplashPaden()
      .then((veranderd) => {
        if (veranderd) this.update({ champions: [...jade.champions.values()].map(toChampionSummary) });
      })
      .catch(reportBackgroundError);

    const summoner = await fetchCurrentSummoner(client);
    this.update({
      connection: "connected",
      error: null,
      champions: [...jade.champions.values()].map(toChampionSummary),
      items: [...jade.items.values()].map((item) => ({
        jadeId: item.jadeId,
        name: item.name,
        iconPath: item.iconPath,
        // The catalogue has had this all along and kept it to itself, which is
        // why the renderer could draw a build but never say what it cost.
        price: item.price,
        buildsFrom: item.buildsFrom,
      })),
      spells: [...jade.spells.values()].map((spell) => ({
        jadeId: spell.jadeId,
        name: spell.name,
        iconPath: spell.iconPath,
      })),
      summoner: {
        riotId: `${summoner.gameName}#${summoner.tagLine}`,
        summonerLevel: summoner.summonerLevel,
        profileIconId: summoner.profileIconId,
        puuid: summoner.puuid,
      },
    });

    this.crawler = new MatchCrawler(client, this.store, () => this.publishDatabaseStatus());
    this.crawler.seed([summoner.puuid, ...this.store.knownPuuids]);

    await Promise.all([this.refreshLoadout(), this.refreshOwnProfile(), this.refreshPhase()]);
    this.listen();

    // Ontwikkelhulp: speelt een echte gespeelde game na als champion select, zodat
    // de scout te controleren is zonder in de wachtrij te hoeven staan.
    if (process.env.ALLMID_DEMO_CHAMPSELECT === "1") {
      void this.emitDemoChampSelect().catch(reportBackgroundError);
      return;
    }
    void this.crawlWhenIdle().catch(reportBackgroundError);
  }

  /**
   * Crawlen is verkeer via jouw client, dus we doen het alleen buiten champ
   * select en games om. Zodra je een potje start houdt de crawler zijn mond.
   */
  private async crawlWhenIdle(playersPerRun = 12): Promise<void> {
    const busy = ["ChampSelect", "GameStart", "InProgress", "ReadyCheck"];
    if (busy.includes(this.snapshot.phase) || !this.crawler || this.crawler.isRunning) return;
    await this.crawler.run(playersPerRun);
    this.rebuildStats();
    this.publishDatabaseStatus();
    // Net binnengekomen games zijn de enige reden dat er iets te delen is, dus
    // dit is het moment om het aan te bieden. De ondergrens in syncUploads()
    // zorgt dat een reeks korte rondes niet een reeks uploads wordt.
    void this.syncUploads().catch(reportBackgroundError);
  }

  /**
   * Fetch the community aggregate and switch over to it once it lands.
   *
   * Runs in the background at startup and again after every crawl round, but the
   * cache decides whether that actually reaches the network -- see VERS_MS there.
   */
  private async loadCommunityStats(): Promise<void> {
    const geladen = await this.community.laad();
    if (!geladen) return;
    this.communityLoad = geladen;
    this.rebuildStats();
    this.publishDatabaseStatus();
  }

  /**
   * Poll the running game.
   *
   * Every two seconds. Fast enough that a skill point taken and a second one
   * taken shortly after are still seen in order, slow enough to be invisible --
   * it is a local HTTP call to a server on the same machine.
   */
  /**
   * Watch for a running game, and never stop watching.
   *
   * The gameflow phase used to be the trigger, and it was the wrong one. A
   * custom game the client has lost track of reports phase "None" -- the
   * session endpoint even 404s -- while the game itself is still up and still
   * answering on 2999 with a mode, a map and a clock. Asking the client first
   * only added a way to miss the game entirely.
   *
   * The Live Client Data API exists only while a game is running, so its
   * answering IS the signal. Nothing else has to agree.
   */
  private startLiveWatch(): void {
    if (this.liveTimer) return;
    // Look the champion list up per call instead of capturing it once: the
    // catalogue can still be loading when a game starts, and a lookup frozen
    // while it was empty would report every champion as unrecognised.
    this.liveWatcher ??= new LiveGameWatcher(
      (naam) => championZoeker(this.snapshot.champions)(naam),
      (itemId) => this.jade?.item(itemId)?.price ?? 0,
    );
    const tik = async () => {
      const data = await this.live.allGameData();
      if (!data) {
        // Normal before the game is up and after it ends. A game that was there
        // a moment ago and is not there now has just finished, and that is the
        // last chance to keep what we watched -- nothing else tells us.
        //
        // Only after a run of them, though. See liveMislukt: one poll answering
        // null is not evidence a game ended, and acting on it costs the game
        // twice over -- once by harvesting half of it, and again by stamping
        // everyone's whole inventory onto the second the client came back.
        if (this.snapshot.liveGame && ++this.liveMislukt >= LIVE_MISLUKT_GRENS) {
          this.bewaarBuildOrders();
          this.liveWatcher?.reset();
          this.liveSampleGeschreven = false;
          this.liveMislukt = 0;
          this.update({ liveGame: null });
        }
        return;
      }
      // Answered, so whatever the last few polls were, the game is still on.
      this.liveMislukt = 0;
      if (!this.liveSampleGeschreven) {
        this.liveSampleGeschreven = true;
        try {
          const pad = join(this.backupDir, "..", "live-sample.json");
          writeFileSync(pad, JSON.stringify(data, null, 2), "utf8");
          console.log(`[allmid] ruwe live-data weggeschreven naar ${pad}`);
        } catch (err) {
          reportBackgroundError(err as Error);
        }
      }
      // A game appearing is the one moment the setting is worth re-reading:
      // it is what someone changes when they are trying to get the overlay to
      // show up, and they change it between games.
      const eersteTik = !this.snapshot.liveGame;
      this.update({
        liveGame: this.liveWatcher!.verwerk(data, this.snapshot.summoner?.riotId ?? null, JADE_MAP_ID),
      });
      if (eersteTik) void this.ververisBeeldmodus().catch(reportBackgroundError);
    };
    // A timeout that reschedules itself rather than a fixed interval, so the
    // gap can widen while nothing is running. A refused connection on localhost
    // fails in well under a millisecond, but there is no reason to ask twice a
    // second for hours on end.
    const plan = (): void => {
      if (!this.liveTimer) return;
      this.liveTimer = setTimeout(() => {
        void tik()
          .catch(reportBackgroundError)
          .finally(plan);
      }, this.snapshot.liveGame ? 2_000 : 5_000);
    };
    // Set before the first tick so plan() knows the watch is live.
    this.liveTimer = setTimeout(() => undefined, 0);
    void tik()
      .catch(reportBackgroundError)
      .finally(plan);
  }

  /**
   * Get champion, item and spell names on screen without waiting for a client.
   *
   * Uses the cache written by a previous run, and falls back to Community
   * Dragon's copy of the same files. Skipped once a real catalogue is loaded,
   * because the client's own assets are the authoritative ones.
   */
  private async laadCatalogusVastAlvast(): Promise<void> {
    if (this.jade) return;
    const pad = join(this.backupDir, "..", "catalog.json");
    const cached = await JadeCatalog.fromCache(pad).catch(() => null);
    const catalogus = cached ?? (await JadeCatalog.fromCommunityDragon().catch(() => null));
    if (!catalogus) return;
    // A client that connected while we were fetching wins: its assets are the
    // real ones, and overwriting them with a cache would be a downgrade.
    if (this.jade) return;
    this.jade = catalogus;
    if (!cached) await catalogus.save(pad).catch(() => undefined);
    this.update({
      champions: [...catalogus.champions.values()].map(toChampionSummary),
      items: [...catalogus.items.values()].map((item) => ({
        jadeId: item.jadeId,
        name: item.name,
        iconPath: item.iconPath,
        price: item.price,
        buildsFrom: item.buildsFrom,
      })),
      spells: [...catalogus.spells.values()].map((spell) => ({
        jadeId: spell.jadeId,
        name: spell.name,
        iconPath: spell.iconPath,
      })),
    });
  }

  /** De updater duwt zijn stand hierlangs de snapshot in. */
  zetUpdateStand(stand: AppSnapshot["update"]): void {
    this.update({ update: stand });
  }

  /** Is er nu een Classic-game bezig? De updater gebruikt dit om weg te blijven. */
  get inGame(): boolean {
    return Boolean(this.snapshot.liveGame?.isClassic) || Boolean(this.snapshot.champSelect);
  }

  /**
   * De masterybomen alvast, van de publieke spiegel.
   *
   * Zonder dit bleef het Masteries-tabblad hangen op een spinner zolang League
   * niet draaide. De bomen zijn statische spelgegevens en hebben geen client
   * nodig; verbindt die later alsnog, dan winnen zijn eigen assets.
   */
  private async laadMasteriesVastAlvast(): Promise<void> {
    if (this.masteries) return;
    const catalogus = await MasteryCatalog.fromCommunityDragon().catch(() => null);
    if (!catalogus || this.masteries) return;
    this.masteries = catalogus;
    // De bomen zitten niet in de snapshot maar worden per aanroep opgehaald,
    // dus een lege update laat de UI opnieuw vragen.
    this.update({});
  }

  /** Re-read League's window mode. Failing to find it is not an error. */
  private async ververisBeeldmodus(): Promise<void> {
    const modus = await leesBeeldmodus();
    if (modus !== this.snapshot.beeldmodus) this.update({ beeldmodus: modus });
  }

  private stopLiveWatch(): void {
    if (this.liveTimer) {
      clearTimeout(this.liveTimer);
      this.liveTimer = null;
    }
    this.bewaarBuildOrders();
    this.liveWatcher?.reset();
    if (this.snapshot.liveGame) this.update({ liveGame: null });
  }

  /**
   * Write down the build orders of the game that just finished.
   *
   * This is the only moment they exist. They were assembled from what the client
   * reported second by second, and that server is gone as soon as the game ends,
   * so anything not written here is gone with it.
   */
  private bewaarBuildOrders(): void {
    const opname = this.liveWatcher?.oogst();
    if (!opname) return;
    try {
      const pad = join(this.backupDir, "..", "buildorders.jsonl");
      // Stand behind a whole line or behind nothing: an append landing on top of
      // a half-written one fuses the two into a line neither game survives.
      sluitAfgebrokenRegel(pad);
      appendFileSync(pad, JSON.stringify(opname) + "\n", "utf8");
      // The cache in front of that file is now a version behind, and the game
      // that just ended is exactly the one somebody is about to open.
      this.tijdlijnen.vergeet();
      console.log(
        `[allmid] game van ${opname.gameLengthSeconds}s bewaard in ${pad}` +
          ` (${opname.spelers.length} spelers, ${opname.gebeurtenissen.length} gebeurtenissen,` +
          ` ${opname.verloop?.tijden.length ?? 0} metingen)`,
      );
    } catch (err) {
      reportBackgroundError(err as Error);
    }
  }

  private publishDatabaseStatus(): void {
    const gedeeld = this.communityLoad;
    this.update({
      database: {
        matches: this.store.size,
        players: this.store.knownPuuids.length,
        usableMatchups: this.stats.coverage(MIN_MATCHUP_GAMES).usable,
        crawling: this.crawler?.isRunning ?? false,
        // Where the advice comes from. Without this the window shows "412 games"
        // next to numbers drawn from 128,628, which reads as a bug.
        community: gedeeld
          ? { games: gedeeld.games, players: gedeeld.players, newestGame: gedeeld.newestGame }
          : null,
      },
    });
  }

  /**
   * Zet de klok neer die het delen op gang houdt.
   *
   * Eén keer, ook als start() na een herverbinding opnieuw langskomt: anders
   * krijg je bij elke herstart van de client een timer erbij en gaat de frequentie
   * ongemerkt omhoog.
   */
  private startUploadSchedule(): void {
    this.publishUploadStatus();
    // De afvinklijst meteen inlezen, anders meldt de teller "0 gedeeld" tot de
    // eerste ronde langskomt -- en dat is een leugen tegen iemand die juist
    // controleert wat er al weg is. Kost alleen een bestand van schijf.
    if (this.settings.value.shareMatches) {
      void this.ensureUploader()
        .then(() => this.publishUploadStatus())
        .catch(reportBackgroundError);
    }
    if (this.uploadTimer) return;

    this.uploadStartTimer = setTimeout(() => {
      void this.syncUploads().catch(reportBackgroundError);
    }, UPLOAD_START_DELAY_MS);
    this.uploadTimer = setInterval(() => {
      void this.syncUploads().catch(reportBackgroundError);
    }, UPLOAD_TICK_MS);

    // Deze twee mogen het proces nooit in leven houden; het venster bepaalt of
    // de app draait, niet onze klok.
    this.uploadStartTimer.unref?.();
    this.uploadTimer.unref?.();
  }

  /** Zet de laatst bekende stand van het delen in de momentopname. */
  private publishUploadStatus(): void {
    const settings = this.settings.value;
    const shared = this.uploader?.confirmedCount ?? 0;
    this.update({
      upload: {
        enabled: settings.shareMatches,
        server: this.serverUrl(),
        busy: this.uploading,
        lastRunAt: this.lastUpload?.at ?? null,
        shared,
        pending: Math.max(0, this.store.size - shared),
        lastUploaded: this.lastUpload?.uploaded ?? 0,
        serverTotal: this.lastUpload?.serverTotal ?? null,
        error: this.lastUpload?.error ?? null,
      },
    });
  }

  /**
   * Het adres waar we heen sturen. De omgevingsvariabele wint van het bestand,
   * zodat je een testserver kunt aanwijzen zonder de instellingen van de
   * gebruiker te overschrijven.
   */
  private serverUrl(): string {
    return (process.env.ALLMID_SERVER ?? this.settings.value.uploadServer).trim();
  }

  /**
   * De uploader voor het huidige adres en de huidige sleutel.
   *
   * Hij houdt zelf bij wat er al verstuurd is, dus we hergebruiken hem zolang
   * die twee niet wijzigen. Verandert er één, dan is de oude afvinklijst niet
   * meer waar -- een andere server heeft onze games niet -- en beginnen we met
   * een nieuwe uploader die zijn staat opnieuw inleest.
   */
  private async ensureUploader(): Promise<MatchUploader | null> {
    const server = this.serverUrl();
    if (!server) return null;

    const key = process.env.ALLMID_KEY ?? this.settings.value.uploadKey;
    const signature = JSON.stringify([server, key]);
    if (this.uploader && this.uploaderSignature === signature) return this.uploader;

    const uploader = new MatchUploader(server, key, this.store);
    await uploader.loadState(this.uploadStatePath);
    this.uploader = uploader;
    this.uploaderSignature = signature;
    return uploader;
  }

  /**
   * Biedt de verzamelde games aan bij de gedeelde server.
   *
   * `force` overslaat alleen de wachttijd tussen rondes, niet de fasecontrole:
   * ook wie zelf op de knop drukt wil niet dat er midden in champ select verkeer
   * uitgaat. Dat het wacht is dan wél te zien, want het staat in de momentopname.
   *
   * Deze functie gooit nooit. Een server die plat ligt is een normale toestand
   * voor een app die naast een game draait: het verzamelen gaat door, de melding
   * komt in beeld, en de volgende ronde probeert het opnieuw met precies dezelfde
   * wachtrij -- MatchUploader vinkt immers alleen af wat bevestigd is.
   */
  async syncUploads(force = false): Promise<void> {
    if (!this.settings.value.shareMatches || this.uploading) return;

    if (UPLOAD_BUSY_PHASES.includes(this.snapshot.phase)) {
      this.lastUpload = {
        ...(this.lastUpload ?? { at: null, uploaded: 0, serverTotal: null }),
        error: "Paused while you are in a game — it goes out afterwards.",
      };
      this.publishUploadStatus();
      return;
    }
    if (!force && Date.now() - this.lastUploadAt < UPLOAD_MIN_INTERVAL_MS) return;

    const uploader = await this.ensureUploader();
    if (!uploader) {
      this.lastUpload = {
        ...(this.lastUpload ?? { at: null, uploaded: 0, serverTotal: null }),
        error: "No server address set, so nothing is being shared.",
      };
      this.publishUploadStatus();
      return;
    }

    this.lastUploadAt = Date.now();
    this.uploading = true;
    this.publishUploadStatus();
    try {
      const result = await uploader.sync();
      this.lastUpload = {
        at: Date.now(),
        uploaded: result.uploaded,
        serverTotal: result.serverTotal,
        error: result.error ? `Could not reach the server (${result.error}).` : null,
      };
    } catch (err) {
      // sync() vangt zijn eigen fouten af, dus hier komt alleen het onverwachte
      // terecht -- een kapotte staatsmap bijvoorbeeld. Ook dat mag de app niet
      // meeslepen.
      this.lastUpload = {
        at: Date.now(),
        uploaded: 0,
        serverTotal: this.lastUpload?.serverTotal ?? null,
        error: `Sharing failed (${(err as Error).message}).`,
      };
    } finally {
      this.uploading = false;
      this.publishUploadStatus();
    }
  }

  /** Handmatig delen vanuit de UI; slaat de wachttijd over, de rest niet. */
  async uploadNow(): Promise<void> {
    await this.syncUploads(true);
  }

  private listen(): void {
    const client = this.client;
    if (!client) return;

    this.stream?.close();
    const stream = new LcuEventStream(client);
    this.stream = stream;

    stream.on_(/^\/lol-gameflow\/v1\/gameflow-phase$/, (event) => {
      this.pasFaseToe((event.data as GameflowPhase) ?? "None", true);
    });

    stream.on_(/^\/lol-loadouts\/v4\/loadout/, () => {
      void this.refreshLoadout().catch(reportBackgroundError);
    });

    // Zonder deze luisteraar gooit de EventEmitter zijn fout door en valt het
    // hele main-proces om. Een client die afsluit is normaal, geen ramp.
    stream.on("error", (err: unknown) => {
      console.warn("[lcu] event-stream:", (err as Error)?.message ?? err);
    });

    stream.on("disconnected", () => {
      // De client krijgt bij een herstart een nieuwe poort, dus de oude stream
      // kan nooit meer verbinden. Weg ermee, en opnieuw beginnen bij het lockfile.
      stream.close();
      if (this.stream === stream) this.stream = null;
      this.crawler?.stop();
      this.update({ connection: "disconnected", error: "Lost connection to the League client." });
      setTimeout(() => void this.start(), RECONNECT_DELAY_MS);
    });

    stream.connect();

    this.stopChampSelect?.();
    this.stopChampSelect = watchChampSelect(client, {
      onUpdate: (view) => {
        const snapshot = this.toChampSelectSnapshot(view);
        this.update({ champSelect: snapshot });
        void this.syncAutoMasteries(snapshot.localChampionId, snapshot.localPlan?.position ?? null)
          .catch(reportBackgroundError);
      },
      onEnd: () => {
        this.update({ champSelect: null });
        this.autoMasteryFor = null;
        void this.crawlWhenIdle().catch(reportBackgroundError);
      },
    });
  }

  private toChampSelectSnapshot(view: ChampSelectView): ChampSelectSnapshot {
    const matches = this.store.all();

    const toEntry = (scouted: {
      cell: ChampSelectPlayer;
      profile: PlayerProfile | null;
      isLocalPlayer: boolean;
    }): ScoutEntry => {
      const championId = scouted.cell.championId || scouted.cell.championPickIntent;
      const position = scouted.profile ? likelyPosition(matches, scouted.profile.puuid) : null;
      const record = scouted.profile?.jade.topChampions.find((c) => c.championId === championId);
      return {
        cellId: scouted.cell.cellId,
        championId: scouted.cell.championId,
        championPickIntent: scouted.cell.championPickIntent,
        assignedPosition: scouted.cell.assignedPosition ?? "",
        spell1Id: scouted.cell.spell1Id,
        spell2Id: scouted.cell.spell2Id,
        isLocalPlayer: scouted.isLocalPlayer,
        profile: scouted.profile,
        likelyPosition: position?.position ?? null,
        positionShare: position?.share ?? 0,
        championRecord: record ? { games: record.games, wins: record.wins } : null,
        // The real Riot ID, when the client gives us one. Null means the lobby
        // is hiding that player, and the screen falls back to their champion.
        toonNaam: scouted.profile?.riotId ?? null,
      };
    };

    const myTeam = view.myTeam.map(toEntry);
    const theirTeam = view.theirTeam.map(toEntry);

    const lanes = this.analyzeLanes(myTeam, theirTeam);
    const local = myTeam.find((entry) => entry.isLocalPlayer);
    const localChampionId = local ? local.championId || local.championPickIntent || null : null;
    const localLane = lanes.find((lane) => lane.isLocalPlayerLane);

    return {
      phase: view.session.timer?.phase ?? "",
      timeLeftMs: view.session.timer?.adjustedTimeLeftInPhase ?? 0,
      timerAt: Date.now(),
      myTeam,
      theirTeam,
      bans: resolveBans(view.session),
      lanes,
      localChampionId,
      localPlan: this.buildPlan(localChampionId, localLane?.position ?? null),
    };
  }

  /**
   * Koppelt de twee teams per lane aan elkaar.
   *
   * Riot geeft alleen voor jouw eigen team een toegewezen positie, en zelfs die
   * ontbreekt in blind pick. Voor de rest gebruiken we waar iemand volgens onze
   * database meestal speelt. Weten we het niet, dan laten we de lane leeg in
   * plaats van te gokken.
   */
  private analyzeLanes(myTeam: ScoutEntry[], theirTeam: ScoutEntry[]): LaneAnalysis[] {
    const assign = (entries: ScoutEntry[]): Map<Position, ScoutEntry> => {
      const byPosition = new Map<Position, ScoutEntry>();
      const leftovers: ScoutEntry[] = [];
      for (const entry of entries) {
        const assigned = normalizePosition(entry.assignedPosition);
        if (assigned && !byPosition.has(assigned)) byPosition.set(assigned, entry);
        else leftovers.push(entry);
      }
      // Wie geen toewijzing heeft, plaatsen we op zijn gebruikelijke positie --
      // maar alleen als die nog vrij is.
      const rest: ScoutEntry[] = [];
      for (const entry of leftovers) {
        const guess = entry.likelyPosition;
        if (guess && guess !== "UNKNOWN" && !byPosition.has(guess)) byPosition.set(guess, entry);
        else rest.push(entry);
      }
      // Still unplaced: fall back to the lane the champion is normally played in.
      // Weaker than someone's own history, but it is the only guess that works
      // for a fresh account -- and without it your own pick dropped out of the
      // grid entirely until you had four games on record.
      for (const entry of rest) {
        const championId = entry.championId || entry.championPickIntent;
        if (!championId) continue;
        const vrij = this.stats
          .positionsFor(championId)
          .find((p) => p.position !== "UNKNOWN" && !byPosition.has(p.position));
        if (vrij) byPosition.set(vrij.position, entry);
      }
      return byPosition;
    };

    const allies = assign(myTeam);
    const enemies = assign(theirTeam);

    return LANES.map((position) => {
      const ally = allies.get(position);
      const enemy = enemies.get(position);
      const allyChampionId = ally ? ally.championId || ally.championPickIntent : 0;
      const enemyChampionId = enemy ? enemy.championId || enemy.championPickIntent : 0;

      const matchup =
        allyChampionId && enemyChampionId
          ? this.stats.matchup(allyChampionId, enemyChampionId, position)
          : null;

      // Alleen champions die de matchup daadwerkelijk winnen. Een "counter" met
      // 46% winrate is geen counter -- die zou je juist niet moeten pakken.
      const counters = enemyChampionId
        ? this.stats
            .countersFor(enemyChampionId, position)
            .filter((entry) => entry.winrate > 0.5)
            .slice(0, 5)
            .map((entry) => ({
              championId: entry.championId,
              winrate: entry.winrate,
              games: entry.games,
            }))
        : [];

      return {
        position,
        allyChampionId: allyChampionId || null,
        enemyChampionId: enemyChampionId || null,
        isLocalPlayerLane: ally?.isLocalPlayer ?? false,
        matchup: matchup && matchup.games >= MIN_MATCHUP_GAMES
          ? { winrate: matchup.winrate, games: matchup.games }
          : null,
        counters,
      };
    });
  }

  /**
   * Bouwt een champion select-momentopname uit de laatste opgeslagen game.
   * Alleen bedoeld om de weergave te testen; staat achter een omgevingsvariabele.
   */
  private async emitDemoChampSelect(): Promise<void> {
    const client = this.client;
    const match = this.store.all().sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!client || !match) return;

    const matches = this.store.all();
    const toEntry = async (player: (typeof match.players)[number], index: number): Promise<ScoutEntry> => {
      const profile = await buildPlayerProfile(client, player.puuid, 20).catch(() => null);
      const position = likelyPosition(matches, player.puuid);
      const record = profile?.jade.topChampions.find((c) => c.championId === player.championId);
      return {
        cellId: index,
        championId: player.championId,
        championPickIntent: 0,
        assignedPosition: player.position.toLowerCase(),
        spell1Id: player.spells[0],
        spell2Id: player.spells[1],
        isLocalPlayer: player.puuid === this.snapshot.summoner?.puuid,
        profile,
        likelyPosition: position?.position ?? null,
        positionShare: position?.share ?? 0,
        championRecord: record ? { games: record.games, wins: record.wins } : null,
        toonNaam: profile?.riotId ?? null,
      };
    };

    const blue = match.players.filter((p) => p.teamId === 100);
    const red = match.players.filter((p) => p.teamId === 200);
    const myTeam = await Promise.all(blue.map(toEntry));
    const theirTeam = await Promise.all(red.map((p, i) => toEntry(p, i + 5)));
    if (!myTeam.some((entry) => entry.isLocalPlayer) && myTeam[3]) myTeam[3].isLocalPlayer = true;

    const localChampionId = myTeam.find((entry) => entry.isLocalPlayer)?.championId ?? null;
    this.update({
      phase: "ChampSelect",
      champSelect: {
        phase: "BAN_PICK",
        timeLeftMs: 27_000,
        timerAt: Date.now(),
        myTeam,
        theirTeam,
        // Twee champions die niet in de game zaten, zodat de banstrook zichtbaar is.
        bans: {
          myTeamBans: [60001, 60011],
          theirTeamBans: [60017, 60036],
        },
        lanes: this.analyzeLanes(myTeam, theirTeam),
        localChampionId,
        localPlan: this.buildPlan(localChampionId, null),
      },
    });

    // Ook de demo loopt via dezelfde weg als een echte champ select, anders test
    // hij niet wat hij hoort te testen.
    void this.syncAutoMasteries(localChampionId, null).catch(reportBackgroundError);
  }

  private async refreshPhase(): Promise<void> {
    const phase = await this.client?.tryGet<GameflowPhase>("/lol-gameflow/v1/gameflow-phase");
    // Same handling as an event, because the app can start up while a game is
    // already running. That was the bug: watching only ever began on a phase
    // *change*, and there is no change to hear when you were already in a game
    // before the app opened. It said "Game in progress" and showed nothing.
    if (phase) this.pasFaseToe(phase, false);
  }

  /**
   * React to whatever phase the client is in, however we learned about it.
   *
   * `gewisseld` separates a real transition from reading the current state at
   * startup: profile and loadout only need refreshing when a game has actually
   * just ended, not every time we look.
   */
  private pasFaseToe(phase: GameflowPhase, gewisseld: boolean): void {
    this.update({ phase });

    if (gewisseld && (phase === "EndOfGame" || phase === "None")) {
      void this.refreshOwnProfile().catch(reportBackgroundError);
      void this.refreshLoadout().catch(reportBackgroundError);
      void this.crawlWhenIdle().catch(reportBackgroundError);
    }
    if (phase === "ChampSelect" || phase === "InProgress") this.crawler?.stop();

    // Deliberately not tied to the phase any more -- see startLiveWatch. It is
    // already running; this only makes sure it is.
  }

  async refreshLoadout(): Promise<void> {
    const { client, masteries } = this;
    if (!client || !masteries) return;
    const loadout = await fetchAccountLoadout(client);
    this.loadout = loadout;
    this.update({
      masteryPages: readMasteryPages(loadout, masteries).map((page) => ({
        index: page.index,
        name: page.name,
        isActive: page.isActive,
        isEmpty: page.isEmpty,
        isPreset: page.isPreset,
        pointsSpent: page.pointsSpent,
        points: [...page.points.entries()],
        perTree: masteries.pointsPerTree(page.points),
      })),
      runePages: readRunePages(loadout).map((page) => ({
        index: page.index,
        name: page.name,
        isActive: page.isActive,
        isEmpty: page.isEmpty,
        isPreset: page.isPreset,
        slots: page.slots,
      })),
    });
  }

  async refreshOwnProfile(): Promise<void> {
    const { client } = this;
    const puuid = this.snapshot.summoner?.puuid;
    if (!client || !puuid) return;
    const [profile, games] = await Promise.all([
      buildPlayerProfile(client, puuid, 30),
      fetchJadeGames(client, puuid, 15),
    ]);
    this.update({ profile, recentGames: games.map((game) => toRecentGame(game, puuid)) });

    await this.bewaarEigenGames(games);
  }

  /**
   * Puts your own games in the database, which is where the detail screen looks.
   *
   * The match list and the match detail are not the same payload, and that
   * difference is the whole reason this method exists. A game from
   * `/lol-match-history/v1/products/lol/{puuid}/matches` arrives with exactly
   * ONE participant on it -- you -- because the list is a list of your results
   * rather than of the games. `slimGame` needs all ten and so returns null for
   * every one of them.
   *
   * That is not a guess: measured against the running client, the list form of
   * game 7965097532 carries 1 participant and 1 identity, and slimGame refuses
   * it; the detail form of the same id carries 10 and is accepted. So mapping
   * slimGame straight over the list -- which is what stood here -- stored
   * precisely nothing, every time, and said so to nobody: the result was an
   * empty array rather than an error, and the "did anything land" check read
   * zero and moved on. Six of this account's twenty games were missing from the
   * store because of it, including the newest, which is also the only one with
   * a recording.
   *
   * So the detail is fetched, exactly as the crawler does it. Games already in
   * the store are skipped first, which keeps the usual refresh at zero requests
   * -- there is normally nothing new -- and caps the worst case at one request
   * per game in the list.
   */
  private async bewaarEigenGames(games: Game[]): Promise<void> {
    const { client } = this;
    if (!client) return;

    const onbekend = games.filter((game) => !this.store.has(game.gameId));
    if (onbekend.length === 0) return;

    const eigen: StoredMatch[] = [];
    for (const game of onbekend) {
      const volledig = await client
        .tryGet<Game>(`/lol-match-history/v1/games/${game.gameId}`)
        .catch(() => null);
      if (!volledig) continue;
      // slimGame still does the deciding: not Classic, or under five minutes,
      // and it stays out. This only makes sure it is judging the whole game.
      const slim = slimGame(volledig);
      if (slim) eigen.push(slim);
    }

    if (eigen.length === 0) return;
    const nieuw = await this.store.add(eigen);
    if (nieuw > 0) {
      this.rebuildStats();
      this.publishDatabaseStatus();
    }
  }

  masteryTrees(): MasteryTreeInfo[] {
    return (this.masteries?.trees ?? []).map((tree) => ({
      name: tree.name,
      type: tree.type,
      rows: tree.rows.map((row) => ({
        pointsRequired: row.pointsRequired,
        masteries: row.masteries.map((m) => (m ? { ...m } : null)),
      })),
    }));
  }

  runeCatalog(): RuneInfo[] {
    const runes = this.runes;
    if (!runes) return [];
    return runes.all().map((rune) => ({
      id: rune.id,
      kind: rune.kind,
      title: rune.title,
      tooltip: rune.tooltip,
      iconPath: rune.iconPath,
      isPerLevel: rune.isPerLevel,
      owned: runes.quantityOwned(rune.id),
    }));
  }

  planRunesFor(championId: number | null, role?: string): RunePlanSummary | null {
    const { runes, jade } = this;
    if (!runes) return null;
    const champion = championId ? (jade?.champion(championId) ?? null) : null;
    const plan = planRunes(runes, champion, role);
    return {
      championId: champion?.jadeId ?? null,
      championName: champion?.name ?? null,
      role: plan.role,
      kinds: plan.kinds.map((kind) => ({
        kind: kind.kind,
        slots: kind.slots,
        emptySlots: kind.emptySlots,
        choices: kind.choices.map((choice) => ({
          runeId: choice.rune.id,
          title: choice.rune.title,
          iconPath: choice.rune.iconPath,
          tooltip: choice.rune.tooltip,
          count: choice.count,
        })),
        upgrade: kind.upgrade
          ? {
              runeId: kind.upgrade.id,
              title: kind.upgrade.title,
              gapPercent:
                kind.bestPossibleScore > 0
                  ? Math.round((1 - kind.score / kind.bestPossibleScore) * 100)
                  : 0,
            }
          : null,
      })),
      slots: plan.slots,
      totalStats: Object.entries(plan.totalStats).sort((a, b) => b[1] - a[1]),
    };
  }

  /** Schrijft een rune-pagina en maakt hem actief. Maakt eerst een backup. */
  async applyRunePlan(pageIndex: number, slots: Record<RuneKind, number[]>): Promise<ApplyResult> {
    const { client, runes, loadout } = this;
    if (!client || !runes || !loadout) return { ok: false, message: "Not connected to the client yet." };
    try {
      const patch = {
        ...buildRunePagePatch(runes, pageIndex, slots),
        ...buildActivePagePatch("rune", pageIndex),
      };
      const { backupPath } = await applyLoadoutPatch(client, loadout, patch, { backupDir: this.backupDir });
      await this.refreshLoadout();
      const filled = Object.values(slots).flat().filter((id) => id > 0).length;
      return {
        ok: true,
        message: `Rune page ${pageIndex} applied (${filled} of ${totalRuneSlots()} slots filled).`,
        backupPath,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Maakt een bestaande mastery-pagina actief. Overschrijft niets. */
  async activateMasteryPage(pageIndex: number): Promise<ApplyResult> {
    const { client, loadout } = this;
    if (!client || !loadout) return { ok: false, message: "Not connected to the client yet." };
    try {
      await applyLoadoutPatch(client, loadout, buildActivePagePatch("mastery", pageIndex), {
        backupDir: this.backupDir,
      });
      await this.refreshLoadout();
      return { ok: true, message: `Mastery page ${pageIndex} is now active.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * One finished game with everyone in it.
   *
   * Read from the local store, not the client: it is the same data the numbers
   * elsewhere are built from, and it still answers with League closed.
   */
  gameDetail(gameId: number): GameDetail | null {
    // The store keeps its games in a Map keyed by gameId, so this is a lookup
    // and not a search. The previous version walked values() and compared, on
    // the reasoning that it avoided copying the whole database into an array --
    // true, and it still visited up to 130,127 entries to answer a question the
    // key already answers. Measured on the real file: 1.39 ms to reach the last
    // record and 1.00 ms to conclude a game is absent, against 0.0001 ms here.
    const match = this.store.get(gameId);
    if (!match) return null;
    const jouwPuuid = this.snapshot.summoner?.puuid ?? null;
    // The seat and the player together, from one search. findIndex answers -1
    // for a game you were not in, which is 130,067 of them.
    const jouwStoel = jouwPuuid === null ? -1 : match.players.findIndex((p) => p.puuid === jouwPuuid);
    const jij = jouwStoel < 0 ? null : (match.players[jouwStoel] ?? null);

    // A recording, when this machine happened to be watching. Two games out of
    // 130,086, and no more are coming for the old ones -- a recording is made
    // while the game runs or not at all.
    const opname = this.tijdlijnen.voor(match);

    // The coarser curve from match history, fetched for every game including the
    // ones we have a recording of.
    //
    // This used to skip the fetch whenever a recording existed, on the reasoning
    // that the recording is the better source. Measured against the one game
    // where both exist (7965097532) that reasoning does not survive: the
    // recording's creep score came out low on nine of the ten seats, by up to
    // 131, and every one of its ten values is a multiple of ten while none of
    // the timeline's are -- the client reports another seat's creeps rounded.
    // The recording also holds gold for one seat, because a running game only
    // ever reveals your own wallet, while the frames carry gold earned for all
    // ten. So the two are complementary per measure rather than ranked per game,
    // and shared/samenloop.ts is what picks between them column by column.
    //
    // The cost of asking anyway is two extra requests in the life of this
    // install, because two recordings exist.
    const historie: HistorieUitslag = this.historie.uitslagVoor(
      match.gameId,
      match.players.length,
      jouwStoel < 0 ? null : jouwStoel,
      // The tripwire's input. See stemtOvereen: participantId 1..10 lining up
      // with players[0..9] is measured, not promised, and a silent reordering
      // would give every player somebody else's curve.
      match.players.map((p) => p.cs),
    );

    return {
      gameId: match.gameId,
      createdAt: match.createdAt,
      durationSeconds: match.duration,
      queueId: match.queueId,
      patch: match.patch,
      surrendered: match.surrendered,
      baseline: jij ? this.baselineFor(jij, match.duration) : null,
      // Null for nearly every game, and permanently so: the crawler collects
      // other people's matches and nobody was watching any of them.
      tijdlijn: opname,
      historie,
      players: match.players.map((p) => ({
        championId: p.championId,
        team: p.teamId,
        position: p.position,
        win: p.win,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        cs: p.cs,
        gold: p.gold,
        items: p.items,
        spells: p.spells,
        // Passed through exactly as stored, undefined included. Filling a gap
        // with a zero here would be indistinguishable from a real zero further
        // down, and the screen decides what to do with a missing field.
        damage: p.damage,
        damageTaken: p.damageTaken,
        vision: p.vision,
        wards: p.wards,
        level: p.level,
        // What this champion normally does in this lane, for all ten rather
        // than only for you. baselineFor() below answers "how did your game
        // go"; the badge answers "who played best", and that needs a norm on
        // every seat or it cannot use one on any of them.
        ijklijn: this.ijklijnVoor(p),
        isYou: jouwPuuid !== null && p.puuid === jouwPuuid,
      })),
    };
  }

  /**
   * The four figures the badge measures one seat against.
   *
   * The lane first, because that is the comparison that means something, and the
   * champion with its lanes pooled second, because one stored game in eight comes
   * back with no positions at all and a badge still has to be handed out in those.
   * Null only when neither exists, which leesNaspel reads as "this whole game
   * falls back on the middle of the lobby".
   *
   * Touches none of the five optional StoredPlayer fields, which is why it works
   * on every match in the database rather than only on the ones stored from today
   * onwards.
   */
  private ijklijnVoor(speler: StoredPlayer): SpelerIjklijn | null {
    const lane =
      speler.position === "UNKNOWN" ? null : this.stats.baseline(speler.championId, speler.position);
    const ijk = lane ?? this.stats.championBaseline(speler.championId);
    if (!ijk || !(ijk.minutes > 0)) return null;
    return {
      games: ijk.games,
      csPerMin: ijk.csPerMin,
      goldPerMin: ijk.goldPerMin,
      // The tallies hold totals, so average kills plus assists divided by the
      // average game length is exactly total kills plus assists over total
      // minutes -- the same way round as csPerMin and goldPerMin, and not an
      // average of per-game rates, which would weigh a 19-minute stomp the same
      // as a 48-minute slog.
      kaPerMin: (ijk.kills + ijk.assists) / ijk.minutes,
      kda: ijk.kda,
      bron: lane ? "lane" : "champion",
    };
  }

  /**
   * Your line in one game beside the champion's normal line in that lane.
   *
   * Both sides come out of recorded games: yours from this match, the averages
   * from the same tallies the tier list stands on. Nothing is estimated, so when
   * the averages are not there the answer is null and the screen has one block
   * fewer rather than a number nobody can defend.
   *
   * Touches none of the five optional StoredPlayer fields, which is why it works
   * on every match in the database rather than only on the ones stored from
   * today onwards.
   */
  private baselineFor(jij: StoredPlayer, duration: number): PerformanceBaseline | null {
    const gemiddelde = this.stats.baseline(jij.championId, jij.position);
    if (!gemiddelde) return null;
    // slimGame refuses anything under five minutes, so this only still guards a
    // corrupted record that would otherwise divide by zero.
    const minuten = duration / 60;
    if (minuten <= 0) return null;

    return {
      championId: jij.championId,
      position: jij.position,
      games: gemiddelde.games,
      averageMinutes: gemiddelde.minutes,
      yourMinutes: minuten,
      csPerMin: { you: jij.cs / minuten, average: gemiddelde.csPerMin },
      goldPerMin: { you: jij.gold / minuten, average: gemiddelde.goldPerMin },
      kda: {
        // The same rule on both sides of the comparison, including what happens
        // at zero deaths. Two different definitions in one row would be a lie
        // the reader has no way of spotting.
        you: jij.deaths === 0 ? jij.kills + jij.assists : (jij.kills + jij.assists) / jij.deaths,
        average: gemiddelde.kda,
      },
      kills: { you: jij.kills, average: gemiddelde.kills },
      deaths: { you: jij.deaths, average: gemiddelde.deaths },
      assists: { you: jij.assists, average: gemiddelde.assists },
      source: this.communityLoad ? "community" : "local",
    };
  }

  /**
   * The mastery page we would set for a champion, without setting it.
   *
   * Same planner the auto-setter uses, so what the screen shows is exactly what
   * the button would write. Anything else would be a demo rather than a preview.
   */
  masteryPlanFor(championId: number): MasteryPlanSummary | null {
    const { masteries, jade } = this;
    if (!masteries || !jade) return null;
    const champion = jade.champion(championId) ?? null;
    if (!champion) return null;
    const plan = planMasteries(masteries, champion, roleForPosition(null));
    return {
      championId,
      championName: champion.name,
      role: plan.role,
      perTree: plan.perTree,
      points: [...plan.points.entries()].map(([masteryId, points]) => ({ masteryId, points })),
      errors: plan.errors,
    };
  }

  async lookupPlayer(riotId: string): Promise<PlayerProfile | null> {
    const client = this.client;
    if (!client) return null;
    const [gameName, tagLine] = riotId.split("#");
    if (!gameName || !tagLine) return null;
    const summoner = await fetchSummonerByRiotId(client, gameName, tagLine);
    if (!summoner) return null;
    return buildPlayerProfile(client, summoner.puuid, 30);
  }

  /** Zelfde verhaal voor masteries: genereren, wegschrijven, activeren. */
  async autoApplyMasteries(championId: number | null, position?: Position | null): Promise<ApplyResult> {
    const { client, masteries, jade, loadout } = this;
    if (!client || !masteries || !loadout) return { ok: false, message: "Not connected to the client yet." };

    const champion = championId ? (jade?.champion(championId) ?? null) : null;
    const plan = planMasteries(masteries, champion, roleForPosition(position));
    if (plan.errors.length > 0) {
      return { ok: false, message: `Generated page is invalid: ${plan.errors[0]}` };
    }

    const page = this.targetPage(this.snapshot.masteryPages);
    if (!page) return { ok: false, message: "No editable mastery page available." };

    try {
      const patch = {
        ...buildMasteryPagePatch(masteries, page.index, plan.points),
        ...buildActivePagePatch("mastery", page.index),
      };
      const { backupPath } = await applyLoadoutPatch(client, loadout, patch, { backupDir: this.backupDir });
      await this.refreshLoadout();
      const spread = `${plan.perTree.offense}/${plan.perTree.defense}/${plan.perTree.utility}`;
      return {
        ok: true,
        message: `Masteries set on "${page.name}" for ${plan.championName ?? "your champion"} (${spread}).`,
        backupPath,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * De pagina waar we in mogen schrijven: liefst een lege eigen pagina, anders de
   * eerste eigen pagina. Riot's presets vallen altijd af.
   */
  private targetPage<T extends { index: number; name: string; isPreset: boolean; isEmpty: boolean }>(
    pages: T[],
  ): T | undefined {
    const own = pages.filter((page) => !page.isPreset);
    return own.find((page) => page.isEmpty) ?? own[0] ?? pages[0];
  }

  /**
   * Build-advies voor een champion op een positie. Zonder bekende positie nemen
   * we de positie waarop hij het vaakst gespeeld wordt.
   */
  private buildPlan(championId: number | null, position: Position | null): ChampionPlan | null {
    if (!championId) return null;
    const chosen = position ?? this.stats.positionsFor(championId)[0]?.position ?? null;
    if (!chosen || chosen === "UNKNOWN") return null;

    const stat = this.stats.championStat(championId, chosen);
    const allItems = this.stats.itemStats(championId, chosen, 20);
    const isBoots = (itemId: number): boolean => {
      const item = this.jade?.item(itemId);
      return Boolean(item && (item.buildsFrom.includes(771001) || item.jadeId === 771001));
    };
    const toItem = (i: { itemId: number; games: number; winrate: number; pickRate: number }): ItemEntry => ({
      itemId: i.itemId, games: i.games, winrate: i.winrate, pickRate: i.pickRate,
    });

    return {
      championId,
      position: chosen,
      winrate: stat?.winrate ?? null,
      games: stat?.games ?? 0,
      items: allItems.filter((i) => !isBoots(i.itemId)).slice(0, 6).map(toItem),
      boots: allItems.filter((i) => isBoots(i.itemId)).slice(0, 2).map(toItem),
      spells: this.stats.spellStats(championId, chosen, 20).slice(0, 2).map((s) => ({
        spells: s.spells, games: s.games, winrate: s.winrate, pickRate: s.pickRate,
      })),
      weakAgainst: this.stats.strugglesAgainst(championId, chosen).slice(0, 4).map(toMatchupEntry),
    };
  }

  /**
   * Neemt alleen `Settings` aan, niet `StoredSettings`: de uploadsleutel komt uit
   * settings.json of uit de omgeving, nooit uit een venster.
   */
  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.settings.update(patch);
    const next = this.settings.shared;
    this.update({ settings: next });
    // Meteen toepassen als het net aangezet wordt terwijl je al gepickt hebt.
    if (patch.autoMasteries) {
      this.autoMasteryFor = null;
      const select = this.snapshot.champSelect;
      if (select) {
        void this.syncAutoMasteries(select.localChampionId, select.localPlan?.position ?? null)
          .catch(reportBackgroundError);
      }
    }
    // Wie de schakelaar omzet wil zien dat er iets gebeurt, niet een kwartier
    // wachten op de volgende ronde. Bij uitzetten is de stand meteen goed.
    if (patch.shareMatches === true || (patch.uploadServer !== undefined && next.shareMatches)) {
      this.lastUpload = null;
      void this.syncUploads(true).catch(reportBackgroundError);
    } else {
      this.publishUploadStatus();
    }
    return next;
  }

  /**
   * Houdt je mastery-pagina gelijk aan de champion die je gepickt hebt.
   *
   * Wordt bij elke champ select-update aangeroepen, maar schrijft alleen als de
   * champion echt veranderd is -- anders zou elke tik van de timer een schrijf-
   * actie naar je client opleveren.
   */
  private async syncAutoMasteries(championId: number | null, position: Position | null): Promise<void> {
    if (!this.settings.value.autoMasteries) return;
    if (!championId || championId === this.autoMasteryFor || this.autoMasteryBusy) return;

    this.autoMasteryBusy = true;
    try {
      const result = await this.autoApplyMasteries(championId, position);
      this.autoMasteryFor = result.ok ? championId : null;
      this.update({ autoMasteryStatus: result.message });
    } finally {
      this.autoMasteryBusy = false;
    }
  }

  /** Ranglijst voor een positie, uit onze eigen verzamelde games. */
  tierList(position: Position, minGames = 25): TierEntry[] {
    return this.stats.tierList(position, minGames).map(toTierEntry);
  }

  /**
   * Alles wat we van een champion weten. Zonder positie kiezen we de positie
   * waarop hij het vaakst gespeeld wordt -- dat is bijna altijd wat je wilt zien.
   */
  championDetail(championId: number, position?: Position): ChampionDetail {
    const positions = this.stats.positionsFor(championId);
    const chosen = position ?? positions[0]?.position ?? null;
    if (!chosen) {
      return {
        championId, positions, position: null, stat: null,
        items: [], boots: [], spells: [], strongAgainst: [], weakAgainst: [],
      };
    }

    const stat = this.stats.championStat(championId, chosen);
    const allItems = this.stats.itemStats(championId, chosen);
    // Schoenen apart: ze bouwen allemaal uit Boots of Speed en horen niet
    // tussen de kernitems, want iedereen koopt er precies één paar.
    const isBoots = (itemId: number): boolean => {
      const item = this.jade?.item(itemId);
      return Boolean(item && (item.buildsFrom.includes(771001) || item.jadeId === 771001));
    };

    const toItemEntry = (entry: { itemId: number; games: number; winrate: number; pickRate: number }): ItemEntry => ({
      itemId: entry.itemId,
      games: entry.games,
      winrate: entry.winrate,
      pickRate: entry.pickRate,
    });

    return {
      championId,
      positions,
      position: chosen,
      stat: stat ? toTierEntry(stat) : null,
      items: allItems.filter((i) => !isBoots(i.itemId)).slice(0, 8).map(toItemEntry),
      boots: allItems.filter((i) => isBoots(i.itemId)).slice(0, 4).map(toItemEntry),
      spells: this.stats.spellStats(championId, chosen).slice(0, 4).map((entry) => ({
        spells: entry.spells,
        games: entry.games,
        winrate: entry.winrate,
        pickRate: entry.pickRate,
      })),
      strongAgainst: this.stats.strongAgainst(championId, chosen).slice(0, 6).map(toMatchupEntry),
      weakAgainst: this.stats.strugglesAgainst(championId, chosen).slice(0, 6).map(toMatchupEntry),
    };
  }

  /** Start het verzamelen handmatig, bijvoorbeeld vanuit een knop in de UI. */
  async crawlNow(players = 25): Promise<void> {
    await this.crawlWhenIdle(players);
  }

  /** Haalt een asset op bij de client; het jade://-protocol gebruikt dit. */
  /**
   * An icon, from the client if it is running and from Community Dragon if not.
   *
   * The client is authoritative and stays first. But returning null without one
   * meant every portrait in the app was a broken image until League was open --
   * a tier list of names with no faces, on the very first run. Community Dragon
   * mirrors the same asset tree under the same paths, so the fallback is the
   * identical file from a public host.
   */
  async fetchAsset(path: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    const client = this.client;
    if (client) {
      try {
        return await client.getBinary(path);
      } catch {
        // Client closed mid-request. Fall through and try the mirror.
      }
    }
    return this.fetchAssetVanSpiegel(path);
  }

  /** The same asset from Community Dragon. Null when it has no copy either. */
  private async fetchAssetVanSpiegel(
    path: string,
  ): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    // Client paths look like /lol-game-data/assets/v1/champion-icons/60001.png;
    // the mirror serves everything below the assets root, lowercased.
    const rest = path.replace(/^\/lol-game-data\/assets\//, "").toLowerCase();
    if (rest === path.toLowerCase()) return null;
    const url = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/${rest}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return {
        body: await res.arrayBuffer(),
        contentType: res.headers.get("content-type") ?? "image/png",
      };
    } catch {
      return null;
    }
  }

  dispose(): void {
    // The one way out of the app that used to lose a whole game. stopLiveWatch
    // harvests whatever the watcher is holding, and nothing called it -- so
    // quitting mid-game threw the recording away, because it lived only in
    // memory until the game ended on its own. That was survivable while the
    // recording was a list of purchases. It is not now that it carries the
    // score curve, and it fails hardest in exactly the case someone most wants
    // to look back at: the game that went badly enough to quit during.
    this.stopLiveWatch();
    this.crawler?.stop();
    this.stopChampSelect?.();
    this.stream?.close();
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    if (this.uploadStartTimer) clearTimeout(this.uploadStartTimer);
    this.uploadTimer = null;
    this.uploadStartTimer = null;
  }
}

/**
 * Achtergrondwerk mag mislukken zonder de app mee te slepen -- de client kan nu
 * eenmaal midden in een verzoek afsluiten.
 */
function reportBackgroundError(err: unknown): void {
  console.warn("[allmid] achtergrondtaak:", (err as Error)?.message ?? err);
}

/**
 * De positie waarop je speelt zegt meer over je masteries dan het champion-label
 * van Riot: een Blitzcrank mid wil andere punten dan een Blitzcrank support.
 */
function roleForPosition(position: Position | null | undefined): string | undefined {
  switch (position) {
    case "SUPPORT":
      return "support";
    case "JUNGLE":
      return "fighter";
    default:
      return undefined;
  }
}

const toTierEntry = (stat: ChampionStat): TierEntry => ({
  championId: stat.championId,
  position: stat.position,
  games: stat.games,
  winrate: stat.winrate,
  pickRate: stat.pickRate,
  kda: stat.avgDeaths === 0
    ? stat.avgKills + stat.avgAssists
    : (stat.avgKills + stat.avgAssists) / stat.avgDeaths,
});

const toMatchupEntry = (stat: { opponentId: number; winrate: number; games: number }): MatchupEntry => ({
  championId: stat.opponentId,
  winrate: stat.winrate,
  games: stat.games,
});

const totalRuneSlots = (): number =>
  Object.values(RUNE_SLOTS).reduce((sum, slot) => sum + slot.count, 0);

const toChampionSummary = (champion: JadeChampion): ChampionSummary => ({
  jadeId: champion.jadeId,
  name: champion.name,
  alias: champion.alias,
  iconPath: champion.iconPath,
  splashPath: champion.splashPath,
  tilePath: champion.tilePath,
  roles: champion.roles,
});

function toRecentGame(game: Game, puuid: string): RecentGameSummary {
  const found = participantOf(game, puuid);
  const stats = found?.participant.stats;
  return {
    gameId: game.gameId,
    createdAt: game.gameCreation,
    durationSeconds: game.gameDuration,
    queueId: game.queueId,
    win: stats?.win ?? false,
    championId: found?.participant.championId ?? 0,
    kills: stats?.kills ?? 0,
    deaths: stats?.deaths ?? 0,
    assists: stats?.assists ?? 0,
    items: stats
      ? [stats.item0, stats.item1, stats.item2, stats.item3, stats.item4, stats.item5, stats.item6]
      : [],
    spell1Id: found?.participant.spell1Id ?? 0,
    spell2Id: found?.participant.spell2Id ?? 0,
    cs: (stats?.totalMinionsKilled ?? 0) + (stats?.neutralMinionsKilled ?? 0),
    gold: stats?.goldEarned ?? 0,
  };
}
