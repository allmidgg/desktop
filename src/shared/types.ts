/**
 * Types die het main-proces en de UI delen.
 *
 * Alles wat over IPC gaat moet door structured clone heen, dus geen Map, geen
 * class-instanties -- alleen platte objecten en arrays.
 */
import type { PlayerProfile } from "../core/services/player";
import type { RuneKind } from "../core/jade/runes";
import type { Position } from "../core/services/matchStore";

export type { Position };

export type ConnectionState = "connecting" | "connected" | "disconnected";

/** Fase van de client: lobby, champ select, in game, enzovoort. */
export type GameflowPhase =
  | "None" | "Lobby" | "Matchmaking" | "ReadyCheck" | "ChampSelect"
  | "GameStart" | "InProgress" | "WaitingForStats" | "PreEndOfGame" | "EndOfGame"
  | "Reconnect" | "TerminatedInError";

export interface ChampionSummary {
  jadeId: number;
  name: string;
  alias: string;
  iconPath: string;
  roles: string[];
}

export interface ScoutEntry {
  cellId: number;
  championId: number;
  championPickIntent: number;
  /** Wat Riot toewijst; leeg in blind pick en voor het vijandelijke team. */
  assignedPosition: string;
  spell1Id: number;
  spell2Id: number;
  isLocalPlayer: boolean;
  /** Null als de speler verborgen is (vijandelijk team in ranked). */
  profile: PlayerProfile | null;
  /** Uit onze eigen database afgeleid: waar speelt deze speler meestal? */
  likelyPosition: Position | null;
  /** Aandeel van zijn games op die positie, 0-1. */
  positionShare: number;
  /** Hoe deze speler het doet op de champion die hij nu pakt. */
  championRecord: { games: number; wins: number } | null;
}

export interface CounterSuggestion {
  championId: number;
  winrate: number;
  games: number;
}

/** Analyse per lane: wie staat er tegenover wie, en wat zegt de data. */
export interface LaneAnalysis {
  position: Position;
  allyChampionId: number | null;
  enemyChampionId: number | null;
  isLocalPlayerLane: boolean;
  /** Winrate van de ally-champion tegen de enemy-champion in deze lane. */
  matchup: { winrate: number; games: number } | null;
  /** Champions die het goed doen tegen de gepickte tegenstander. */
  counters: CounterSuggestion[];
}

/** Wat de data zegt over de champion die jij nu pakt. */
export interface ChampionPlan {
  championId: number;
  position: Position;
  winrate: number | null;
  games: number;
  items: ItemEntry[];
  boots: ItemEntry[];
  spells: SpellEntry[];
  /** Tegenstanders in jouw lane waar deze champion het zwaar tegen heeft. */
  weakAgainst: MatchupEntry[];
}

export interface ChampSelectSnapshot {
  phase: string;
  timeLeftMs: number;
  myTeam: ScoutEntry[];
  theirTeam: ScoutEntry[];
  bans: { myTeamBans: number[]; theirTeamBans: number[] };
  lanes: LaneAnalysis[];
  /** Champion die de lokale speler nu gepickt of gehoverd heeft. */
  localChampionId: number | null;
  /** Build-advies voor die champion, uit onze eigen data. */
  localPlan: ChampionPlan | null;
}

export interface ItemSummary {
  jadeId: number;
  name: string;
  iconPath: string;
}

export interface SpellSummary {
  jadeId: number;
  name: string;
  iconPath: string;
}

/** Stand van de zelfgebouwde matchdatabase. */
export interface DatabaseStatus {
  /** Games this machine crawled itself. Your own history. */
  matches: number;
  players: number;
  usableMatchups: number;
  crawling: boolean;
  /**
   * The shared dataset the advice is drawn from, or null when the app is falling
   * back to locally crawled games. These are not added to `matches`: everything
   * crawled here is uploaded, so it is already counted in there.
   */
  community: { games: number; players: number; newestGame: string } | null;
}

export interface MasteryPageSummary {
  index: number;
  name: string;
  isActive: boolean;
  isEmpty: boolean;
  /** Meegeleverd door Riot; die schrijven we nooit over. */
  isPreset: boolean;
  pointsSpent: number;
  /** [masteryId, punten] -- als array omdat een Map niet over IPC kan. */
  points: Array<[number, number]>;
  perTree: { offense: number; defense: number; utility: number };
}

export interface RunePageSummary {
  index: number;
  name: string;
  isActive: boolean;
  isEmpty: boolean;
  isPreset: boolean;
  slots: Record<RuneKind, number[]>;
}

export interface RuneInfo {
  id: number;
  kind: RuneKind;
  title: string;
  tooltip: string;
  iconPath: string;
  isPerLevel: boolean;
  owned: number;
}

export interface MasteryInfo {
  id: number;
  name: string;
  description: string;
  maxRank: number;
  rowIndex: number;
  tree: "offense" | "defense" | "utility";
  pointsRequired: number;
  activeIconPath: string;
  inactiveIconPath: string;
}

export interface MasteryTreeInfo {
  name: string;
  type: "offense" | "defense" | "utility";
  rows: Array<{ pointsRequired: number; masteries: Array<MasteryInfo | null> }>;
}

export interface RunePlanSummary {
  championId: number | null;
  championName: string | null;
  role: string;
  kinds: Array<{
    kind: RuneKind;
    slots: number;
    emptySlots: number;
    choices: Array<{ runeId: number; title: string; iconPath: string; count: number; tooltip: string }>;
    upgrade: { runeId: number; title: string; gapPercent: number } | null;
  }>;
  slots: Record<RuneKind, number[]>;
  totalStats: Array<[string, number]>;
}

export interface RecentGameSummary {
  gameId: number;
  createdAt: number;
  durationSeconds: number;
  queueId: number;
  win: boolean;
  championId: number;
  kills: number;
  deaths: number;
  assists: number;
  items: number[];
  spell1Id: number;
  spell2Id: number;
  cs: number;
  gold: number;
}

export interface AppSnapshot {
  connection: ConnectionState;
  error: string | null;
  phase: GameflowPhase;
  summoner: { riotId: string; summonerLevel: number; profileIconId: number; puuid: string } | null;
  profile: PlayerProfile | null;
  champSelect: ChampSelectSnapshot | null;
  champions: ChampionSummary[];
  items: ItemSummary[];
  spells: SpellSummary[];
  masteryPages: MasteryPageSummary[];
  runePages: RunePageSummary[];
  recentGames: RecentGameSummary[];
  database: DatabaseStatus;
  settings: Settings;
  /** Stand van het delen met de gedeelde server. */
  upload: UploadStatus;
  /** Laatste melding van de automatische mastery-setter. */
  autoMasteryStatus: string | null;
  /** The game currently running, read from the client on port 2999. */
  liveGame: LiveGameSnapshot | null;
}

export interface LiveGamePlayer {
  /** Resolved from the name the client reports. Null when we cannot place it. */
  championId: number | null;
  championName: string;
  riotId: string | null;
  team: "ORDER" | "CHAOS" | "UNKNOWN";
  position: Position | null;
  level: number;
  isDead: boolean;
  /** Seconds until respawn, 0 when alive. */
  respawnIn: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  /** Jade item ids, trinket excluded, in slot order. Same keys as snapshot.items. */
  items: number[];
  isYou: boolean;
}

export interface LiveGameSnapshot {
  /** What the client calls the mode. JADE for Classic. */
  mode: string;
  mapNumber: number;
  /** False when a game is running but it is not Classic; we show it, we do not count it. */
  isClassic: boolean;
  gameTimeSeconds: number;
  players: LiveGamePlayer[];
  /**
   * The order you levelled your own abilities in, so far.
   *
   * Only your own: the client does not reveal anyone else's abilities. This is
   * the one thing match history can never give, because a finished game records
   * levels but not the order they were taken in.
   */
  skillOrder: string[];
  /** Set when something is worth saying about what we are looking at. */
  note: string | null;
}

export interface TierEntry {
  championId: number;
  position: Position;
  games: number;
  winrate: number;
  pickRate: number;
  kda: number;
}

export interface ItemEntry {
  itemId: number;
  games: number;
  winrate: number;
  pickRate: number;
}

export interface SpellEntry {
  spells: [number, number];
  games: number;
  winrate: number;
  pickRate: number;
}

export interface MatchupEntry {
  championId: number;
  winrate: number;
  games: number;
}

/** Alles wat we over één champion weten, voor de detailweergave. */
export interface ChampionDetail {
  championId: number;
  positions: Array<{ position: Position; games: number; share: number }>;
  /** De positie waarop de onderstaande cijfers slaan. */
  position: Position | null;
  stat: TierEntry | null;
  items: ItemEntry[];
  boots: ItemEntry[];
  spells: SpellEntry[];
  strongAgainst: MatchupEntry[];
  weakAgainst: MatchupEntry[];
}

/**
 * De instellingen zoals de interface ze kent.
 *
 * Spiegelt bewust alleen de publieke helft van `StoredSettings` in
 * core/services/settings.ts: de uploadsleutel hoort in het main-proces te
 * blijven en staat daarom niet in deze vorm. Zie daar waarom.
 */
export interface Settings {
  autoMasteries: boolean;
  shareMatches: boolean;
  uploadServer: string;
}

/**
 * Wat er van het delen te zien is.
 *
 * Alles wat hier in staat is er omdat een gebruiker het hoort te kunnen
 * controleren: staat het aan, waar gaat het heen, wanneer is er voor het laatst
 * iets verstuurd, hoeveel, en wat ging er mis. Een upload die alleen in een
 * logbestand zichtbaar is telt niet als zichtbaar.
 */
export interface UploadStatus {
  enabled: boolean;
  /** Het adres waar de games heen gaan; leeg betekent nergens heen. */
  server: string;
  /** Nu bezig met versturen. */
  busy: boolean;
  /** Einde van de laatste poging, ms sinds epoch. Null als er nog geen was. */
  lastRunAt: number | null;
  /** Games die de server aantoonbaar heeft gekregen vanuit deze installatie. */
  shared: number;
  /** Games die nog aangeboden moeten worden. */
  pending: number;
  /** Wat de laatste ronde nieuw op de server zette. */
  lastUploaded: number;
  /** Totaal aantal games op de server, voor zover die het meldde. */
  serverTotal: number | null;
  /** Laatste foutmelding; null als de laatste ronde goed ging. */
  error: string | null;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  backupPath?: string;
}
