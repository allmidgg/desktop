/**
 * Types die het main-proces en de UI delen.
 *
 * Alles wat over IPC gaat moet door structured clone heen, dus geen Map, geen
 * class-instanties -- alleen platte objecten en arrays.
 */
import type { PlayerProfile } from "../core/services/player";
import type { RuneKind } from "../core/jade/runes";
import type { Position } from "../core/services/matchStore";
import type { ModeId } from "../core/modes/types";
// Type-only, and circular on paper: matchtijdlijn.ts imports Position back out
// of this file. Both sides are erased at compile time, so nothing circular
// survives to runtime -- the same argument the MINIMALE_GAMEDUUR_SECONDEN block
// below already makes for importing from matchStore.
import type { Laanmeting } from "./matchtijdlijn";

export type { Position };

export type ConnectionState = "connecting" | "connected" | "disconnected";

/** Fase van de client: lobby, champ select, in game, enzovoort. */
export type GameflowPhase =
  | "None" | "Lobby" | "Matchmaking" | "ReadyCheck" | "ChampSelect"
  | "GameStart" | "InProgress" | "WaitingForStats" | "PreEndOfGame" | "EndOfGame"
  | "Reconnect" | "TerminatedInError";

/**
 * One catalogue row, on its way to the interface.
 *
 * The snapshot carries both id spaces in one array, so every row says which mode
 * it belongs to and no screen may index one without filtering on that first. Id
 * 75 is a real collision, not a hypothetical: the client publishes it as both a
 * nameless leftover and as Clairvoyance, and a single `new Map(...)` over the
 * lot lets whichever came last decide what gets drawn.
 */
interface CatalogRowSummary {
  /** ID zoals de game het gebruikt: 60022 in Classic, 22 in het moderne spel. */
  id: number;
  mode: ModeId;
}

export interface ChampionSummary extends CatalogRowSummary {
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
   * The mode this lobby is queueing for.
   *
   * Null while nothing has said yet: the gameflow session had no queue and
   * nobody has hovered a champion. "unknown" means it did say and we could not
   * place it. In both cases, and in any mode we hold no games for, everything
   * below that is advice -- lanes, matchups, the plan -- comes back empty on
   * purpose. There is no honest way to fill it, and filling it from the other
   * mode is the exact mistake this field exists to prevent.
   */
  mode: ModeId | null;
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

export interface ItemSummary extends CatalogRowSummary {
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
   * The components this is built out of, in this row's own id space.
   *
   * Needed to read a purchase list as a build: a Long Sword followed by a
   * Vampiric Scepter followed by a Bilgewater Cutlass is one item being
   * assembled, not three unrelated buys, and only the catalogue knows that.
   */
  buildsFrom: number[];
}

export interface SpellSummary extends CatalogRowSummary {
  name: string;
  iconPath: string;
}

/**
 * What one mode's numbers add up to.
 *
 * Split off per mode because a single total beside advice drawn from one pool
 * reads as a bug -- the same failure the `community` field below was added to
 * fix, at the size two modes make it: a bar announcing 130,197 games while every
 * modern screen says there are not enough games to say anything yet.
 */
export interface DatabaseModusStatus {
  /** Games counted in this mode: the shared aggregate when there is one. */
  matches: number;
  usableMatchups: number;
  /**
   * The shared dataset this mode's advice is drawn from, or null when it is
   * falling back to locally crawled games. Not added to `matches`: everything
   * crawled here is uploaded, so it is already counted in there.
   */
  community: { games: number; players: number; newestGame: string } | null;
  /**
   * Why this mode's count is lower than the file it was read from, or null.
   *
   * Non-null only when building the tally hit records that do not belong to this
   * mode: they are left out and this sentence says how many. It exists because
   * the alternative was a number that quietly shrank -- the meta screen prints
   * "from N collected X games" whatever happens, and a reader has no way to tell
   * a database that grew slowly from one that dropped a thousand games this
   * morning. Written as a whole sentence in English because it is shown to the
   * user unchanged.
   */
  probleem: string | null;
}

/** Stand van de zelfgebouwde matchdatabase. */
export interface DatabaseStatus {
  /**
   * Classic's figures, kept only because publishDatabaseStatus still writes
   * them.
   *
   * Nothing reads them any more. Every screen that used to -- the title bar, the
   * meta screen, the tier column on Live -- now goes through `perModus` and
   * names the mode it is showing, which is what step 10 did. They are named
   * here as what they are rather than left looking like the app's totals,
   * because the next person to reach for `database.matches` beside a modern
   * heading would be printing Classic's count under it with nothing on screen to
   * give that away. Read `perModus[mode]` instead; `crawling` below is the one
   * field here that is still live, and it is a flag rather than a figure.
   */
  matches: number;
  players: number;
  /** Whether the crawler is running. Mode-independent: it works in one mode. */
  crawling: boolean;
  /** Classic's shared dataset. Dead alongside `matches`; see the note above. */
  community: { games: number; players: number; newestGame: string } | null;
  /**
   * The same figures again, one entry per mode we collect, and the ones every
   * screen actually reads.
   *
   * Partial on purpose: only collected modes get an entry, so a reader has to
   * handle a mode being absent instead of assuming every mode has a bucket.
   */
  perModus: Partial<Record<ModeId, DatabaseModusStatus>>;
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
   * all of them, and nothing backfills it: a recording is made while the game
   * runs or not at all. Match history does serve a per-minute timeline for
   * Classic (core/lcu/timeline.ts), but it carries no purchases and no skill
   * levels, so it could never produce one of these -- it would be a different
   * and coarser source, not a way to fill this in.
   */
  tijdlijn: GameTijdlijn | null;
  /**
   * The coarser curve from match history, which does exist for crawled games.
   *
   * Fetched the moment somebody opens a game and cached from then on, so this is
   * never "not collected yet" -- it is either here, being fetched, or absent for
   * a reason the union names. Never null: the reason is the answer.
   *
   * The paragraph above about `tijdlijn` still holds. That field stays a
   * recording and stays empty for games nobody watched; this one is a different
   * and coarser source sitting beside it, not a backfill of it.
   */
  historie: HistorieUitslag;
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
 * One seat's six numbers across the whole game, one array per number.
 *
 * Stored column by column rather than as a list of readings, and that is a
 * measurement rather than a preference. Priced over 3,000 real games out of
 * matches.jsonl at a reading every fifteen seconds -- coarser than the ten the
 * sampler actually keeps, so all three figures are floors rather than the live
 * cost -- the same curve costs 80,064 bytes a game written as one named object
 * per player per reading, 20,428 as a fixed-order tuple per player per reading,
 * and 18,216 like this. It is both the
 * smallest of the three and the only cheap one that still says which number is
 * which.
 *
 * Every array here is exactly as long as Verloop.tijden, and index i in all of
 * them is the reading taken at tijden[i]. A null is a seat that had no reading
 * at that moment -- a player the client had not listed yet, because the app
 * started watching a game already in progress. Never a zero: a zero draws as a
 * real measurement of a player doing nothing, and once it is on disk there is no
 * telling the two apart.
 */
export interface VerloopKolommen {
  kills: Array<number | null>;
  deaths: Array<number | null>;
  assists: Array<number | null>;
  cs: Array<number | null>;
  /**
   * Riot's ward score, rounded. A score and not a count of wards; the name the
   * running game uses is kept so the figure can be traced back to it.
   */
  wards: Array<number | null>;
  level: Array<number | null>;
}

/* A row-shaped view of the above -- VerloopSpeler and VerloopMonster -- lived
   here for a while so that a reader walking readings in time order would not
   have to transpose. Removed: nothing ever imported either of them, and the
   transpose that would have connected them to the stored shape was never
   written. A second description of the same data with no consumer cannot be
   kept honest by anything, so it is the half that goes stale, and it goes stale
   silently -- which is worse than the transpose it was meant to save. Column-
   major is the one shape, because that is the one that was measured. */

/**
 * How the game went, as opposed to how it ended.
 *
 * This is what the rest of a recording cannot give. OpnameSpeler holds the
 * scoreline a player finished on and the events hold the moments something was
 * announced; neither answers "which minute did it start going wrong", because
 * that question is about the shape of the numbers between the announcements.
 *
 * Only ever exists for games this app watched itself. Nothing backfills it: the
 * games in matches.jsonl were crawled out of other people's match history and
 * nobody was watching any of them. Match history does serve a per-minute
 * timeline for Classic (core/lcu/timeline.ts), but it is a coarser and different
 * source -- minutes rather than seconds, no purchases, no skill levels -- so it
 * could sit beside this and never become it.
 *
 * ── This stays on the machine that recorded it ───────────────────────────────
 *
 * Nine of the ten seats in here belong to people who did not install anything.
 * A final scoreline for ten players is a row of numbers; a per-reading series
 * for ten players is a behavioural fingerprint, enough to pick one game and one
 * account out of a pile without a name attached to it. The uploader is
 * accordingly built only against MatchStore and never opens buildorders.jsonl,
 * and both that file and the raw live sample are gitignored.
 *
 * That is not a settled question either: docs/riot-ticket.md records Riot's
 * position that Classic data is not approved for aggregation or display on
 * third-party products, and that ticket is unanswered. Anything that would put
 * this on a wire is the owner's decision to take deliberately, not a change to
 * make in passing while wiring something else up.
 */
export interface Verloop {
  /**
   * Seconds the sampler was aiming for between readings.
   *
   * A statement of intent and never the time axis. A poll that failed leaves a
   * wider gap than this, and the value doubles if a game runs long enough to hit
   * the sample cap. `tijden` is the truth; nothing may plot a reading at index
   * times interval.
   */
  interval: number;
  /** Game time in seconds at each reading, ascending. The time axis. */
  tijden: number[];
  /**
   * Your own gold in hand at each reading, or null where the poll did not say.
   *
   * Only ever yours. The Live Client Data API reports currentGold for the active
   * player and for nobody else, so this is the one gold figure that exists at
   * all while a game runs -- and it is gold in the pocket rather than gold
   * earned, so it drops every time you spend. A wallet, not a score.
   */
  goud: Array<number | null>;
  /**
   * One entry per seat -- but WHICH seat order depends on where the curve came
   * from, and the two sources do not use the same one.
   *
   *   from a recording (OpnameRecord.verloop): the order of OpnameRecord.spelers,
   *       which is the order the running client listed players in. Not promised
   *       by anything; core/services/tijdlijn.ts refuses to derive teams from it
   *       for exactly that reason, and data/live-sample.json shows the active
   *       player hoisted to the front of that list while the stored match has
   *       that same player ninth.
   *   from match history (HistorieTijdlijn.verloop): the order of
   *       StoredMatch.players, which is participantId 1..10. Measured exact on
   *       220 seats across 22 games on all six columns, and again on 60 seats
   *       across six other games on creeps and gold.
   *
   * Whoever draws this must take its seat list from the same source. Handing a
   * match-ordered curve to a component whose seats came from a recording gives
   * every player somebody else's line, and nothing on screen would look wrong.
   * shared/samenloop.ts is the one place that lines the two up -- on champion,
   * never on index -- and Tijdlijnpaneel is the one caller that needs to.
   */
  spelers: VerloopKolommen[];
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
  /**
   * The score curve, for recordings taken after the sampler landed.
   *
   * Optional because every line already in buildorders.jsonl predates it, and
   * those lines are read back unchanged. A reader has to be able to draw itself
   * without this rather than substituting an empty curve, which would claim a
   * game was measured and found flat.
   */
  verloop?: Verloop;
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
  /**
   * Seats whose champion and whole kill/death/assist line are identical.
   *
   * Creep score is deliberately not in here. The one recording on disk that
   * overlaps a real match (7965097532) agrees on kills, deaths and assists for
   * all ten seats and on creeps for one, because its recorded creep score is
   * quantised to multiples of ten -- 230,140,280,240,10,250,160,270,260,30
   * against the match's 268,271,298,258,13,257,160,274,266,37. With creeps in
   * the key this figure read 1 out of 10 for a join that is exact, and
   * TijdlijnStore.voor() ranks candidate recordings by it.
   */
  gelijkeScores: number;
  /** Seats whose creep score also agrees. Reported, never required; see above. */
  gelijkeCs: number;
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
 * Which columns of a history timeline were measured and which were not.
 *
 * Carried with the data instead of written in a comment, because the flags the
 * screen needs are exactly the ones that would otherwise be read off a default:
 * a ward column full of nulls and a `gestolen` that is always false are not
 * findings about the game, they are the shape of the source. A screen that can
 * read this can say "not recorded" where it would otherwise draw a zero.
 */
export interface HistorieGemeten {
  cs: boolean;
  level: boolean;
  kills: boolean;
  deaths: boolean;
  assists: boolean;
  /** Always false. The timeline carries no ward or vision figure of any kind. */
  wards: boolean;
  /** Always false. There is no field for a stolen objective and no way to derive one. */
  gestolen: boolean;
  /** Always false. No ITEM_PURCHASED events; buildorders.jsonl stays the only source. */
  aankopen: boolean;
  /** Always false. No SKILL_LEVEL_UP events either. */
  skills: boolean;
}

/**
 * How a game went, rebuilt from match history rather than from watching it.
 *
 * The counterpart to GameTijdlijn and explicitly not the same thing. That one is
 * a recording: ten-second samples, every purchase with a timestamp, and the
 * seat that was at the keyboard identifiable because only that seat has a skill
 * order. This one is one frame a minute out of
 * `/lol-match-history/v1/game-timelines/{gameId}`, which exists for games nobody
 * installed anything to watch -- the 130,086 in matches.jsonl included -- and
 * carries no purchases, no skill levels and no ward figure at all.
 *
 * The two complement each other and neither replaces the other, so they travel
 * side by side on GameDetail and each says what it is.
 *
 * Only reachable while the League client is running: the endpoint is the
 * client's, not a public one. HistorieUitslag is what says so.
 */
export interface HistorieTijdlijn {
  gameId: number;
  /** Wall clock when it was fetched, so a cached line can be dated. */
  opgehaaldOp: number;
  /**
   * The per-minute series in the same shape a recording's curve uses, so the
   * charts that already read Verloop need no second code path.
   *
   * Seat i here is players[i] of the same GameDetail. That is not an assumption:
   * participantId 1..10 was checked against the stored scoreline on 100 seats
   * across ten games and matched exactly on creeps, and on 50 seats across five
   * games for kills, deaths and assists.
   */
  verloop: Verloop;
  /**
   * Total gold earned per seat per minute -- the one series this source has that
   * a recording does not, since a running game reveals gold for your seat only.
   *
   * Kept beside Verloop instead of inside VerloopKolommen: adding a column there
   * would put a permanently empty gold axis on every live recording ever made.
   * Same length and same order as `verloop.spelers`.
   */
  goudPerStoel: Array<Array<number | null>>;
  /** Champion kills, buildings and elite monsters. Nothing else is in the frames. */
  gebeurtenissen: SpelGebeurtenis[];
  /**
   * Where each seat actually stood, read off the map coordinates before the
   * frames were thrown away.
   *
   * One entry per seat, same order as `verloop.spelers`. Measured here rather
   * than left to the renderer because the coordinates are the bulk of an 80 KB
   * response and they answer exactly one question -- see laanmetingenUit in
   * shared/matchtijdlijn.ts, which turns these into lanes and which is where the
   * thresholds and their evidence live.
   *
   * It matters because Riot's own position labels on the stored games are bad,
   * and this is the only thing in the app that can contradict them.
   */
  laanmetingen: Laanmeting[];
  /** Your seat, when you were in this game at all. Null for a crawled game. */
  jouwStoel: number | null;
  gemeten: HistorieGemeten;
}

/**
 * Whether there is a history timeline for a game, and if not, why not.
 *
 * A union rather than a nullable, because the four ways of having nothing mean
 * genuinely different things to somebody looking at an empty panel. "No client"
 * is a thing he can fix by starting League; "no timeline" is a fact about that
 * game; "busy" resolves on its own; only "mislukt" is a fault, and it is the
 * only one that should read like one.
 */
export type HistorieUitslag =
  | { staat: "gevonden"; tijdlijn: HistorieTijdlijn }
  /** Being fetched now. A game:tijdlijn event follows; ask for the detail again. */
  | { staat: "bezig" }
  /*
   * There is deliberately no "a recording already exists, so we did not ask"
   * state. There was one, and the measurement retired it: on the single game
   * where both sources exist the recording's creep score came out low on nine
   * seats out of ten -- by up to 131, every value a multiple of ten -- and the
   * recording carries gold for one seat only, because a running game never
   * reveals anybody else's wallet. A game we have a recording of is therefore
   * the game where having both is worth most, not the one where the second
   * source is redundant. shared/samenloop.ts picks between them per measure.
   */
  /** League is not running, so the only endpoint that serves this is unreachable. */
  | { staat: "geen-client" }
  /** The client answered 404: this game has no timeline, and will not grow one. */
  | { staat: "geen-tijdlijn" }
  /**
   * The request failed. Reported once, then forgotten, so opening the game again
   * is a fresh attempt rather than a screen permanently stuck on an old error.
   */
  | { staat: "mislukt"; reden: string };

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
  /**
   * The mode this game was played in, settled once where the client's answer is
   * still complete.
   *
   * The row travels with it rather than the screens working it out again,
   * because a history list is the one place where two modes sit under each
   * other and everything below a row -- the aftermath panel, the timeline, the
   * champion and item lookups -- has to follow the row and not the window. It
   * can be `unknown`: a game we cannot place is still yours and still shown,
   * labelled as unplaced instead of quietly filed under whichever mode the app
   * happens to be pointed at.
   */
  modus: ModeId;
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
  /**
   * The mode the rune and mastery screens work in.
   *
   * It used to be the window's browse mode as well, and it no longer is: the
   * window keeps that choice itself and hands it to every call that reads
   * statistics, so nothing has to be mirrored here and the two can no longer
   * disagree. What is left is loadout, and loadout is Classic by construction --
   * the modern game has no mastery trees and no Jade rune shop, so a champion
   * list that followed the reader's browse choice would offer pages that cannot
   * be written.
   *
   * A screen showing one particular GAME takes that game's mode instead --
   * reading back a Classic game while queued for something else is the ordinary
   * case, not the edge case.
   */
  loadoutModus: ModeId;
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
  /**
   * Which mode is being played, resolved from the map number and the mode string.
   *
   * The one field a screen should index a catalogue by while a game is running:
   * the running game carries its own mode and owes nothing to whatever the
   * window is browsing. May be "unknown", and that is an answer -- never a
   * reason to fall back to Classic.
   */
  mode: ModeId;
  /**
   * What the client calls the mode, verbatim. JADE for Classic.
   *
   * Kept beside the resolved mode rather than instead of it, because the two
   * disagree in the one place it matters: the modern Summoner's Rift reports the
   * string "CLASSIC". Only ever shown, never compared against.
   */
  gameMode: string;
  mapNumber: number;
  /**
   * True only for League Classic. What gets recorded, and what the overlay draws over.
   *
   * Named after the mode id and not after the word Classic, because `gameMode`
   * three lines up holds the string "CLASSIC" for the modern Summoner's Rift. An
   * `isClassic` sitting next to it would read as shorthand for
   * `gameMode === "CLASSIC"` while meaning the exact opposite of it in every
   * modern game, and nothing about either name would show the reader the
   * contradiction.
   */
  isJade: boolean;
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
