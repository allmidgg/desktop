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
import { MatchStore, defaultStorePath, type Position } from "../core/services/matchStore";
import { MatchCrawler } from "../core/services/crawler";
import { JadeStats, likelyPosition, MIN_MATCHUP_GAMES, type ChampionStat } from "../core/services/stats";
import {
  SettingsStore, defaultSettingsPath, publicSettings, DEFAULT_SETTINGS, type Settings,
} from "../core/services/settings";
import { MatchUploader, defaultUploadStatePath } from "../core/services/uploader";
import type {
  AppSnapshot, ApplyResult, ChampSelectSnapshot, ChampionSummary, GameflowPhase, LaneAnalysis,
  ChampionDetail, ChampionPlan, GameDetail, ItemEntry, MasteryPlanSummary, MasteryTreeInfo,
  MatchupEntry, RecentGameSummary,
  RuneInfo, RunePlanSummary, ScoutEntry, TierEntry, UploadStatus,
} from "../shared/types";

const RECONNECT_DELAY_MS = 3_000;
const LANES: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];

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
  /** Non-null once the community aggregate is in use, so we can say so. */
  private communityLoad: CommunityLoad | null = null;

  constructor(dataRoot: string) {
    super();
    this.store = new MatchStore(defaultStorePath(dataRoot));
    this.settings = new SettingsStore(defaultSettingsPath(dataRoot));
    this.backupDir = join(dataRoot, "data", "backups");
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
        // Normal before the game is up and after it ends. Only clear what we
        // show once there is nothing there, never mid-game.
        if (this.snapshot.liveGame) this.update({ liveGame: null });
        return;
      }
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
      this.update({
        liveGame: this.liveWatcher!.verwerk(data, this.snapshot.summoner?.riotId ?? null, JADE_MAP_ID),
      });
    };
    void tik().catch(reportBackgroundError);
    this.liveTimer = setInterval(() => void tik().catch(reportBackgroundError), 2_000);
  }

  private stopLiveWatch(): void {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
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
    const records = this.liveWatcher?.oogst() ?? [];
    if (records.length === 0) return;
    try {
      const pad = join(this.backupDir, "..", "buildorders.jsonl");
      const regels = records.map((r) => JSON.stringify(r) + "\n");
      appendFileSync(pad, regels.join(""), "utf8");
      console.log(`[allmid] ${records.length} build orders bewaard in ${pad}`);
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
      const phase = (event.data as GameflowPhase) ?? "None";
      this.update({ phase });
      if (phase === "EndOfGame" || phase === "None") {
        void this.refreshOwnProfile().catch(reportBackgroundError);
        void this.refreshLoadout().catch(reportBackgroundError);
        void this.crawlWhenIdle().catch(reportBackgroundError);
      }
      if (phase === "ChampSelect" || phase === "InProgress") this.crawler?.stop();

      // The live server only answers while a game is up. Starting on GameStart
      // rather than InProgress means the first ability point is not missed:
      // loading screens are long enough to level one.
      if (phase === "GameStart" || phase === "InProgress") this.startLiveWatch();
      else this.stopLiveWatch();
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
      for (const entry of leftovers) {
        const guess = entry.likelyPosition;
        if (guess && guess !== "UNKNOWN" && !byPosition.has(guess)) byPosition.set(guess, entry);
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
    if (phase) this.update({ phase });
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
    const match = this.store.all().find((m) => m.gameId === gameId);
    if (!match) return null;
    const jouwPuuid = this.snapshot.summoner?.puuid ?? null;
    return {
      gameId: match.gameId,
      createdAt: match.createdAt,
      durationSeconds: match.duration,
      queueId: match.queueId,
      patch: match.patch,
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
        isYou: jouwPuuid !== null && p.puuid === jouwPuuid,
      })),
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
  async fetchAsset(path: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    const client = this.client;
    if (!client) return null;
    return client.getBinary(path);
  }

  dispose(): void {
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
