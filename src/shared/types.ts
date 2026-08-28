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
  /** Full splash, for backdrops behind a screen about this champion. */
  splashPath: string;
  /** The wide crop, for a strip of art rather than a whole scene. */
  tilePath: string;
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
  /**
   * The name to put on screen during champion select.
   *
   * Not always the Riot ID. Riot's overlay guidance requires that "summoner
   * names in Ranked Solo/Duo must be obfuscated as 'Ally #' in draft areas", and
   * that is exactly what an app resolving a puuid back into a name would undo.
   * Your own name stays; teammates become Ally 1 to Ally 5.
   */
  /** Real Riot ID, or null when the lobby hides that player. */
  toonNaam: string | null;
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
  /**
   * What the client said was left, at the moment it said it.
   *
   * A checkpoint, not a clock. The LCU only pushes an event when something
   * actually happens -- a pick, a ban -- so between two picks this value does
   * not change at all and a screen that renders it directly appears frozen.
   * Pair it with timerAt and count down locally.
   */
  timeLeftMs: number;
  /** Date.now() when timeLeftMs was read, so the renderer can subtract elapsed time. */
  timerAt: number;
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
  /**
   * Total gold, the same number the shop puts on the icon.
   *
   * Total and not combine cost, which is the whole reason anything adding these
   * up has to subtract the components it swallowed -- see aankoopVerloop in
   * shared/build. The main process already had this from the catalogue; it
   * simply never handed it over, so the renderer could draw a build but never
   * say what it cost.
   */
  price: number;
  /**
   * The components this is built out of, as Jade ids.
   *
   * Needed to read a purchase list as a build: a Long Sword followed by a
   * Vampiric Scepter followed by a Bilgewater Cutlass is one item being
   * assembled, not three unrelated buys, and only the catalogue knows that.
   */
  buildsFrom: number[];
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

/**
 * The shortest game the store will keep, in seconds.
 *
 * A value in a file of types, which is unusual here, and it earns the exception:
 * the screens have to be able to say why a game they cannot open is missing, and
 * that sentence is only true if it quotes the very number slimGame drops games
 * under. Written down twice it drifts, and then a screen states the wrong reason
 * with complete confidence.
 *
 * It lives on this side rather than in matchStore because the renderer needs the
 * value and matchStore pulls in node:fs. The type-only import in the other
 * direction is erased at compile time, so nothing circular survives to runtime.
 */
export const MINIMALE_GAMEDUUR_SECONDEN = 300;

/** One of your numbers beside the same number for everyone else on that pick. */
export interface BaselineNumber {
  you: number;
  average: number;
}

/**
 * This game measured against the champion's normal game in that lane.
 *
 * A number on its own settles nothing: 6.2 CS per minute is a strong game on a
 * support and a poor one on a mid laner, and the only thing that decides which
 * is the same figure over every other recorded game of that pick. So this is
 * always two values and never a grade.
 *
 * Only ever built once the average clears its minimum, so anything handed over
 * here can be drawn as it stands. `games` travels with the numbers because a
 * comparison is worth exactly as much as its sample, and `source` because "the
 * shared database" and "the games this machine happened to crawl" are not the
 * same claim.
 *
 * Note what is not in here: none of the five optional StoredPlayer fields. Every
 * figure below comes from cs, gold, kills, deaths, assists and the match
 * duration, all of which are mandatory -- which is why this block works on games
 * stored long before damage was ever kept.
 */
export interface PerformanceBaseline {
  championId: number;
  position: Position;
  /** Recorded games of this champion in this lane. */
  games: number;
  /** Average length of those games in minutes; what the rates are per. */
  averageMinutes: number;
  /** Length of your game in minutes, so the rates can be checked by hand. */
  yourMinutes: number;
  csPerMin: BaselineNumber;
  goldPerMin: BaselineNumber;
  kda: BaselineNumber;
  kills: BaselineNumber;
  deaths: BaselineNumber;
  assists: BaselineNumber;
  source: "community" | "local";
}

/**
 * One finished game, everyone in it.
 *
 * Comes out of the local store rather than the client, so it keeps working when
 * League is closed and it holds exactly what was actually kept.
 */
export interface GameDetail {
  gameId: number;
  createdAt: number;
  durationSeconds: number;
  queueId: number;
  patch: string;
  /**
   * True when the game ended in a surrender.
   *
   * Optional because the store only started keeping it recently, and undefined
   * is not the same as false: it means we do not know, so nothing is drawn.
   */
  surrendered?: boolean;
  players: GameDetailPlayer[];
  /**
   * What happened over time, for the games this app was watching.
   *
   * Null for every game the crawler found rather than played, which is almost
   * all of them. Match history carries no timeline to reconstruct one from, so
   * the absence is permanent and not a loading state.
   */
  tijdlijn: GameTijdlijn | null;
  /**
   * Your own line in this game against what the champion normally does in that
   * lane. Null when you are not in the game, when your lane came out UNKNOWN, or
   * when too few games sit behind the average to say anything with it.
   */
  baseline: PerformanceBaseline | null;
}

/**
 * One thing that happened, and the second it happened on.
 *
 * Straight out of the running game's own event feed, which is the only place in
 * this app where a timestamp on an event exists at all. Match history hands back
 * end-of-game totals; if this is not written down while the game is running, it
 * never existed.
 *
 * No names, deliberately, the same rule the rest of the recording follows. Riot's
 * feed says "KillerName": we resolve that to a seat in this recording and keep
 * the seat number. Anything that was not one of the ten -- a minion, a turret --
 * resolves to null rather than to a name.
 */
export interface SpelGebeurtenis {
  soort: "kill" | "firstblood" | "dragon" | "baron" | "turret" | "inhibitor";
  /** Game time in seconds. */
  at: number;
  /** Seat in OpnameRecord.spelers, or null when it was not one of the ten. */
  door: number | null;
  aan: number | null;
  assists: number[];
  /** What it was, when the game says so: "Air", "Turret_T1_C_07_A". Never a name. */
  detail: string | null;
  gestolen: boolean;
}

/** One seat in a recording: what a finished match keeps, plus the road there. */
export interface OpnameSpeler {
  championId: number | null;
  championName: string;
  team: "ORDER" | "CHAOS" | "UNKNOWN";
  position: Position | null;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  /** Every item seen appearing, in the order it did. */
  build: BuildStep[];
  /**
   * Only ever present for the seat that was at the keyboard.
   *
   * Which makes it double as the marker for whose game this was: the client
   * reveals nobody else's abilities, so exactly one seat can carry it.
   */
  skillOrder?: string[];
}

/**
 * One whole game as it was watched, one line in buildorders.jsonl.
 *
 * Written the moment the game ends and the server on 2999 disappears. There is
 * no second chance and no backfill: a game nobody watched has no recording and
 * never will get one.
 */
export interface OpnameRecord {
  /** Wall clock at harvest, which doubles as the id of the recording. */
  recordedAt: number;
  gameMode: string;
  mapNumber: number;
  gameLengthSeconds: number;
  spelers: OpnameSpeler[];
  gebeurtenissen: SpelGebeurtenis[];
}

/**
 * Why a recording is believed to belong to a stored match.
 *
 * The recording carries no game id -- the Live Client Data API does not have one
 * -- so the two are matched on what they both describe. The whole reasoning is
 * kept rather than reduced to a yes, because this is a join and a join that
 * cannot be inspected is a guess with better manners.
 */
export interface TijdlijnKoppeling {
  gameId: number;
  /** Seats whose champion, kills, deaths, assists and CS are all identical. */
  gelijkeScores: number;
  spelers: number;
  /** Seconds between the game ending and the recording being written. */
  naEindeSeconden: number;
  /** Live clock minus the duration match history reports. */
  duurVerschilSeconden: number;
  /** True when sides came from match history because the recording predates that field. */
  teamsUitMatch: boolean;
}

export interface GameTijdlijn {
  opname: OpnameRecord;
  koppeling: TijdlijnKoppeling;
}

/**
 * What one champion normally does in one lane, cut down to the four figures the
 * MVP rule measures a player against.
 *
 * Built in the main process out of the same tallies the tier list stands on, and
 * carried per player because shared/naspel.ts cannot reach the store: it lives
 * in shared precisely so the renderer can import it without dragging the League
 * client into the bundle. Plain numbers, so it survives structured clone.
 */
export interface SpelerIjklijn {
  /** Recorded games behind these averages. Never drop it: it is what makes them readable. */
  games: number;
  csPerMin: number;
  goldPerMin: number;
  /** Kills plus assists per minute, the norm the participation factor is held against. */
  kaPerMin: number;
  /** (kills + assists) / deaths over the totals, the same rule as the tier list. */
  kda: number;
  /**
   * Whether this is the champion in this lane, or the champion with every lane
   * pooled because the game came back without positions. The screen says which,
   * because pooled lanes are a coarser measurement and the reader should know.
   */
  bron: "lane" | "champion";
}

export interface GameDetailPlayer {
  championId: number;
  team: 100 | 200 | number;
  position: Position;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  items: number[];
  spells: [number, number];
  /**
   * The five figures the client always sent and the store only recently began
   * keeping. All optional, all absent on every match saved before that, and
   * there is no backfill -- so a screen that reads them has to be able to draw
   * itself without them rather than substituting a zero, which would put a
   * player at the bottom of a bar he was never measured for.
   */
  damage?: number;
  damageTaken?: number;
  vision?: number;
  wards?: number;
  level?: number;
  /**
   * What this champion normally does in this lane, for the MVP rule.
   *
   * Optional and nullable for two different reasons that both mean the same
   * thing: undefined when whatever built this record does not fill it, null when
   * the store holds too few games of the combination to say anything. Either way
   * the scoring falls back, for the whole game at once, on the middle of the
   * lobby.
   */
  ijklijn?: SpelerIjklijn | null;
  /** True for the player whose profile this was opened from. */
  isYou: boolean;
}

/**
 * The mastery page suggested for one champion.
 *
 * points is a plain list rather than a Map because it has to survive the trip
 * through IPC, which turns a Map into an empty object without complaining.
 */
export interface MasteryPlanSummary {
  championId: number;
  championName: string;
  role: string;
  perTree: Record<"offense" | "defense" | "utility", number>;
  points: Array<{ masteryId: number; points: number }>;
  errors: string[];
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
  /**
   * League's window mode, or null when we cannot tell.
   *
   * Only interesting because the overlay cannot draw over exclusive fullscreen.
   */
  beeldmodus: "fullscreen" | "borderless" | "windowed" | null;
  /** Where the auto-updater is. "uit" in development, where there is nothing to update. */
  update: {
    fase: "uit" | "kijken" | "actueel" | "downloaden" | "klaar" | "fout";
    versie: string | null;
    voortgang: number;
    fout: string | null;
  };
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
  /** Gold sitting in this player's inventory. */
  itemWaarde: number;
  /** Share of their team's kills this player was part of, 0-1. */
  killDeelname: number;
  /** Wards placed, which the running game does report per player. */
  wards: number;
  /** True when slot 6 is empty. Only ever set for you. */
  trinketLeeg: boolean;
  /**
   * Every item seen appearing in this player's inventory, in the order it did.
   *
   * This is the thing match history cannot give. A finished game reports the six
   * slots someone ended on; it says nothing about what they bought first, and
   * a component that got built into something else leaves no trace at all. By
   * watching the inventory during the game, the real sequence falls out --
   * Long Sword, Long Sword, Vampiric Scepter, Bloodthirster -- for all ten
   * players, not only the one at the keyboard.
   */
  build: BuildStep[];
  isYou: boolean;
}

export interface BuildStep {
  /** Jade item id. */
  itemId: number;
  /** Game time in seconds when it first showed up. */
  at: number;
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
  /**
   * Everything the game has announced so far, oldest first.
   *
   * Kills, first blood, dragons, barons, turrets, inhibitors -- all of it with a
   * timestamp, all of it already on ten screens. This is the timeline, and it
   * exists only while the game is running.
   */
  gebeurtenissen: SpelGebeurtenis[];
  /** Set when something is worth saying about what we are looking at. */
  note: string | null;
  /** Team totals, timers and shares. Everything derived, computed once. */
  inzichten: LiveInzichtenUit | null;
}

/** The derived numbers, flattened so they survive IPC. */
export interface LiveInzichtenUit {
  order: TeamTotaalUit;
  chaos: TeamTotaalUit;
  /** Positive when blue side carries more item gold. Not a gold lead: see TeamTotaal. */
  itemVerschil: number;
  objectieven: Array<{
    soort: "dragon" | "baron" | "inhibitor";
    detail: string | null;
    gevallenOp: number;
    terugOp: number;
    overSeconden: number;
  }>;
}

export interface TeamTotaalUit {
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  wards: number;
  itemWaarde: number;
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
  /** Show the panel on top of the game while a Classic game is running. */
  overlay: boolean;
  autoMasteries: boolean;
  shareMatches: boolean;
  /** Close hides to the tray instead of quitting. */
  sluitNaarTray: boolean;
  /** Start with Windows. */
  startMetWindows: boolean;
  /** When started with Windows, come up as a tray icon with no window. */
  startVerborgen: boolean;
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
