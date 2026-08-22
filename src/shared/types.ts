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
  matches: number;
  players: number;
  usableMatchups: number;
  crawling: boolean;
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
  /** Laatste melding van de automatische mastery-setter. */
  autoMasteryStatus: string | null;
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

export interface Settings {
  autoMasteries: boolean;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  backupPath?: string;
}
