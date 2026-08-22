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
import { MatchStore, defaultStorePath, type Position } from "../core/services/matchStore";
import { MatchCrawler } from "../core/services/crawler";
import { JadeStats, likelyPosition, MIN_MATCHUP_GAMES, type ChampionStat } from "../core/services/stats";
import { SettingsStore, defaultSettingsPath, type Settings } from "../core/services/settings";
import type {
  AppSnapshot, ApplyResult, ChampSelectSnapshot, ChampionSummary, GameflowPhase, LaneAnalysis,
  ChampionDetail, ChampionPlan, ItemEntry, MasteryTreeInfo, MatchupEntry, RecentGameSummary,
  RuneInfo, RunePlanSummary, ScoutEntry, TierEntry,
} from "../shared/types";

const RECONNECT_DELAY_MS = 3_000;
const LANES: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];

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

  private readonly backupDir: string;

  constructor(dataRoot: string) {
    super();
    this.store = new MatchStore(defaultStorePath(dataRoot));
    this.settings = new SettingsStore(defaultSettingsPath(dataRoot));
    this.backupDir = join(dataRoot, "data", "backups");
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
    database: { matches: 0, players: 0, usableMatchups: 0, crawling: false },
    settings: { autoMasteries: false },
    autoMasteryStatus: null,
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
      this.update({ settings: await this.settings.load() });
      await this.store.load();
      this.stats = JadeStats.from(this.store.all());
      this.publishDatabaseStatus();

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

    const summoner = await fetchCurrentSummoner(client);
    this.update({
      connection: "connected",
      error: null,
      champions: [...jade.champions.values()].map(toChampionSummary),
      items: [...jade.items.values()].map((item) => ({
        jadeId: item.jadeId,
        name: item.name,
        iconPath: item.iconPath,
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
    if (process.env.JADE_DEMO_CHAMPSELECT === "1") {
      void this.emitDemoChampSelect();
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
    this.stats = JadeStats.from(this.store.all());
    this.publishDatabaseStatus();
  }

  private publishDatabaseStatus(): void {
    this.update({
      database: {
        matches: this.store.size,
        players: this.store.knownPuuids.length,
        usableMatchups: this.stats.coverage(MIN_MATCHUP_GAMES).usable,
        crawling: this.crawler?.isRunning ?? false,
      },
    });
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

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = await this.settings.update(patch);
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
  }
}

/**
 * Achtergrondwerk mag mislukken zonder de app mee te slepen -- de client kan nu
 * eenmaal midden in een verzoek afsluiten.
 */
function reportBackgroundError(err: unknown): void {
  console.warn("[jade] achtergrondtaak:", (err as Error)?.message ?? err);
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
