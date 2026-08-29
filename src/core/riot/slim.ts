/**
 * Turning a MATCH-V5 report into the record this application already stores.
 *
 * This is the modern half of `slimGame()` in services/matchStore.ts, and the
 * output is meant to be indistinguishable from it: the same StoredMatch, the
 * same gates, the same refusals, so that everything downstream -- the stats
 * buckets, the tier lists, the baselines, the after-game screen -- cannot tell
 * which source a game came in through. Where the two differ, it is because
 * MATCH-V5 carries something the client never gave us (runes) or because the
 * client's own field would be wrong here (position, duration). Every one of
 * those is written down below with the measurement that settled it.
 *
 * ── Three traps, all of them measured against the live API ───────────────────
 *
 *  1. The puuid namespaces are disjunct. The LCU hands out 36-character puuids
 *     and MATCH-V5 hands out 78-character ones, measured on the same account:
 *     accountByRiotId("poepjunk","EUW") returns 78 characters, and all 40
 *     participant rows in the four matches this file was written against carry
 *     78 as well. The 369,306 puuids in the Classic store are therefore not
 *     seeds for a MATCH-V5 crawl and not comparable to these; no screen may add
 *     the two populations together, because that counts the same people twice
 *     in the flattering direction. What DOES work as a seed is a participant of
 *     a match already fetched -- V5 hands back the same namespace it takes, and
 *     that is how the ARAM game below was found.
 *
 *  2. `gameDuration` is seconds, except on reports from before patch 11.20,
 *     where it is milliseconds. See `durationInSeconds()`.
 *
 *  3. Riot's `gameMode` for the MODERN Summoner's Rift is the string "CLASSIC",
 *     which in this codebase means the opposite. So no identifier here contains
 *     the word, and the mode is never assumed from the source: a game arriving
 *     over MATCH-V5 goes through `resolveMode()` exactly like one arriving over
 *     the client, and is refused if that says something we do not collect.
 *
 * The StoredMatch types are imported type-only on purpose. matchStore.ts pulls
 * in node:fs, and a value import would drag that into anything that ever wants
 * to slim a match -- the same argument shared/types.ts makes for keeping the
 * duration threshold on its side of the line.
 */
import { MINIMALE_GAMEDUUR_SECONDEN } from "../../shared/types";
import { resolveMode } from "../modes/detect";
import { modeCollects } from "../modes/registry";
import type { Position, StoredMatch, StoredPlayer } from "../services/matchStore";

/**
 * The parts of a MATCH-V5 report we read, and nothing else.
 *
 * A participant carries 155 fields; these are the twenty-odd that survive into
 * a stored record. Written out rather than typed as `unknown` so that a rename
 * on Riot's side becomes a compile error at the line that reads the field,
 * instead of an undefined that quietly becomes a zero in a statistic.
 */
export interface MatchV5Perks {
  readonly statPerks?: { readonly offense?: number; readonly flex?: number; readonly defense?: number };
  readonly styles?: ReadonlyArray<{
    /** "primaryStyle" or "subStyle". The ordering key -- see `perksOf()`. */
    readonly description?: string;
    readonly style?: number;
    readonly selections?: ReadonlyArray<{ readonly perk?: number }>;
  }>;
}

export interface MatchV5Participant {
  readonly puuid?: string;
  readonly championId?: number;
  readonly teamId?: number;
  readonly win?: boolean;
  readonly kills?: number;
  readonly deaths?: number;
  readonly assists?: number;
  /** Lane minions only. The jungle half is counted separately -- see `csOf()`. */
  readonly totalMinionsKilled?: number;
  readonly neutralMinionsKilled?: number;
  readonly goldEarned?: number;
  readonly item0?: number;
  readonly item1?: number;
  readonly item2?: number;
  readonly item3?: number;
  readonly item4?: number;
  readonly item5?: number;
  readonly item6?: number;
  readonly summoner1Id?: number;
  readonly summoner2Id?: number;
  readonly champLevel?: number;
  readonly totalDamageDealtToChampions?: number;
  readonly totalDamageTaken?: number;
  readonly visionScore?: number;
  readonly wardsPlaced?: number;
  /** The role the matchmaker settled on. The one to use; see `positionOf()`. */
  readonly teamPosition?: string;
  /** Riot's own per-player guess. Deliberately not used; see `positionOf()`. */
  readonly individualPosition?: string;
  /** Present but unused: on V5 these describe the lane, not the role. */
  readonly lane?: string;
  readonly role?: string;
  readonly gameEndedInSurrender?: boolean;
  readonly perks?: MatchV5Perks;
}

export interface MatchV5Info {
  readonly gameId?: number;
  readonly gameCreation?: number;
  readonly gameDuration?: number;
  readonly gameStartTimestamp?: number;
  /** Absent on reports from before patch 11.20. That absence is a unit marker. */
  readonly gameEndTimestamp?: number;
  readonly gameMode?: string;
  readonly gameVersion?: string;
  readonly mapId?: number;
  readonly queueId?: number;
  readonly platformId?: string;
  readonly participants?: ReadonlyArray<MatchV5Participant>;
}

export interface MatchV5 {
  readonly metadata?: { readonly matchId?: string; readonly participants?: ReadonlyArray<string> };
  readonly info?: MatchV5Info;
}

/** How many seats a game we collect has. Both collected modes are five a side. */
const SEATS = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A finite number, or the fallback. Riot omits fields rather than nulling them. */
const num = (value: number | undefined, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * The shape check that stands between the network and everything below.
 *
 * `RiotApiClient.match()` returns `Record<string, unknown>` on purpose -- the
 * whole point of that method was to go and look at the shape -- so somebody has
 * to narrow it, and doing it here means every caller gets the same answer. What
 * it checks is only what the rest of this file dereferences: an `info` object
 * with an array of participants. Field-level nonsense is handled by the readers
 * themselves, and a report that fails a gate below is refused like any other.
 */
export function asMatchV5(raw: unknown): MatchV5 | null {
  if (!isRecord(raw)) return null;
  const info = raw.info;
  if (!isRecord(info) || !Array.isArray(info.participants)) return null;
  return raw as MatchV5;
}

/**
 * The game's length in seconds, whichever unit Riot wrote it in.
 *
 * Riot changed the unit in patch 11.20 and did not add a version field to say
 * so: before it, `gameDuration` is milliseconds; from it on, seconds. The
 * marker is `gameEndTimestamp`, which only exists on reports from 11.20 onward
 * -- so its absence is the signal, and it is the only signal there is.
 *
 * Getting this wrong is quiet in exactly the way that costs a database. Read a
 * millisecond duration as seconds and a 27-minute game becomes 27,000 seconds,
 * which is 7.5 hours: past the store's upper bound, so it is dropped, and the
 * log line says "too long" about a perfectly ordinary game. Read it the other
 * way and every game becomes one or two seconds and is dropped as a remake.
 * Either way every converted match fails the duration gates while every log
 * line looks healthy.
 *
 * Measured, on all four real matches this file was written against: with
 * `gameEndTimestamp` present, `gameDuration` equals the wall clock in seconds
 * to within a rounding step -- 1621 against (1784583886900 - 1784582265405)/1000
 * = 1621.495 on EUW1_7924801606, and the same for the other three. So the
 * present-tense branch is the identity, and it is the absent-tense branch that
 * has to do the work.
 *
 * What could not be measured, said plainly and not rounded up: no match within
 * reach exercises the millisecond branch. The account probed goes back only to
 * EUW1_7125084623, September 2024 on patch 14.18, and asking past the end of
 * its history returns an empty list rather than older games -- so nothing from
 * before 11.20 was reachable through it. Whether Riot still serves such reports
 * to anyone was not tested, because the only way to try is to guess match ids.
 *
 * The branch was therefore exercised on a real payload rearranged into the old
 * shape: `gameEndTimestamp` removed and `gameDuration` set to that game's own
 * wall clock in milliseconds (1621495), which is exactly what a pre-11.20
 * report contains. It comes back as 1621, and the whole match still passes
 * every gate. Both numbers are measured; only their combination is assembled.
 */
export function durationInSeconds(info: MatchV5Info): number {
  const duration = num(info.gameDuration);
  return info.gameEndTimestamp === undefined ? Math.round(duration / 1000) : duration;
}

/**
 * Riot's five team positions, in this app's words.
 *
 * Only the name of the bottom-lane support differs: Riot says UTILITY and the
 * store has always said SUPPORT. Translating rather than storing Riot's word
 * keeps modern records keyed the same as the 130,197 Classic ones, which is the
 * whole requirement -- a second spelling of the same lane would split every
 * per-position tally in half without a single error anywhere.
 */
const POSITION_BY_TEAM_POSITION: Readonly<Record<string, Position>> = {
  TOP: "TOP",
  JUNGLE: "JUNGLE",
  MIDDLE: "MIDDLE",
  BOTTOM: "BOTTOM",
  UTILITY: "SUPPORT",
};

/**
 * Which lane a participant played, from the one field that knows.
 *
 * MATCH-V5 offers three answers and they are not the same answer:
 *
 *   teamPosition        The role the matchmaker settled on for the team as a
 *                       whole. Empty string when Riot could not work the team
 *                       out at all, which is what a remake looks like.
 *   individualPosition  Riot's per-player guess, documented as a best guess and
 *                       explicitly not the one to prefer. "Invalid" when unsure.
 *   lane + role         The pair `toPosition()` reads for the client, and on V5
 *                       it is about where a player was seen, not what they were.
 *
 * The third is the trap, because it is the one that compiles. Feeding V5's lane
 * and role into the existing `toPosition()` disagrees with `teamPosition` on 7
 * of the 40 participants measured -- a Trundle and a Kayn who both played top
 * are reported as lane JUNGLE role NONE, a Thresh support comes back as lane
 * BOTTOM role SOLO and would be filed as a bot-lane carry, and a Nilah bot lane
 * comes back as lane JUNGLE. That is 17.5% of rows put in the wrong bucket, in
 * a field the whole tier list is keyed on, with nothing anywhere reporting a
 * problem. Reusing `toPosition()` here is the single easiest mistake this file
 * could contain, and it is why it takes a participant rather than two strings.
 *
 * `individualPosition` is refused as a fallback rather than used, and the
 * measurement is why: across all 40 rows it agreed with `teamPosition` on every
 * single one, so it adds nothing while teamPosition is filled in. The only case
 * where it would ever fire is the case where teamPosition is empty -- and that
 * is Riot saying it could not place this game, not an invitation to take the
 * lower-quality guess instead. UNKNOWN is already a value this store keeps, and
 * it is the honest one here.
 */
export function positionOf(participant: MatchV5Participant): Position {
  return POSITION_BY_TEAM_POSITION[participant.teamPosition ?? ""] ?? "UNKNOWN";
}

/**
 * Creep score, counted the way the client counted it.
 *
 * The LCU gave one field, `cs`; V5 splits it into lane minions and neutral
 * monsters, and those two added together are what the client's number was. The
 * trap next door is `totalAllyJungleMinionsKilled` and
 * `totalEnemyJungleMinionsKilled`, which look like they belong in the sum and
 * do not: they are a breakdown OF `neutralMinionsKilled`, not an addition to
 * it. Checked over all 40 rows -- their sum never exceeds the neutral count --
 * so adding them would inflate every jungler's CS by roughly double and leave
 * every laner alone, which is a distortion no screen would show as an error.
 */
const csOf = (p: MatchV5Participant): number =>
  num(p.totalMinionsKilled) + num(p.neutralMinionsKilled);

/**
 * The six runes actually taken, primary tree first.
 *
 * Ordered by `description` rather than by position in the array. Riot happens
 * to send primaryStyle first today, but a stored field whose meaning depends on
 * an undocumented ordering is a field that silently changes meaning; sorting on
 * the label Riot does document costs nothing and cannot drift.
 *
 * This is the one thing MATCH-V5 gives that the client never did. Measured on
 * the client for a Classic game, `perk0` through `perk5` are all zero, which is
 * why no rune statistic has ever been possible in this app; measured here,
 * EUW1_7924801606's Trundle comes back with 8008, 9111, 9104, 8299, 8473, 8446
 * and all ten seats are filled in.
 */
function perksOf(p: MatchV5Participant): number[] | undefined {
  const styles = [...(p.perks?.styles ?? [])].sort((a, b) => {
    const rank = (s: { description?: string }): number => (s.description === "primaryStyle" ? 0 : 1);
    return rank(a) - rank(b);
  });
  const ids = styles
    .flatMap((style) => style.selections ?? [])
    .map((selection) => selection.perk)
    .filter((id): id is number => typeof id === "number" && id > 0);
  // Absent rather than empty when there is nothing to say. An empty array reads
  // as "played no runes", which is not a thing; undefined reads as "not
  // recorded", which is exactly what the older records mean by leaving it out.
  return ids.length > 0 ? ids : undefined;
}

/**
 * The three stat shards, in the order the rune page shows them.
 *
 * Stored for the same reason the mode signals are stored: they answer a
 * question that cannot be asked a second time. A build without its shards is
 * not the build that was played, and getting them later is not a lookup -- it
 * is the entire crawl again, at 95 requests per two minutes.
 *
 * The price, measured over the four real matches rather than estimated: a
 * modern record is 3,545 bytes without either rune field, the six selections
 * add 400 bytes and the three shards 300, so both together are 700 bytes a game
 * and 19.7%. That is the honest figure to weigh, and it is why they are two
 * separate optional fields: whoever decides the shards are not worth 300 bytes
 * can stop writing them without touching the selections.
 */
function shardsOf(p: MatchV5Participant): number[] | undefined {
  const stats = p.perks?.statPerks;
  if (!stats) return undefined;
  const ids = [stats.offense, stats.flex, stats.defense].filter(
    (id): id is number => typeof id === "number" && id > 0,
  );
  return ids.length === 3 ? ids : undefined;
}

/**
 * A MATCH-V5 report as a StoredMatch, or null if it may not be stored.
 *
 * The gates are `slimGame()`'s gates, in the same order and for the same
 * reasons: a mode we do not collect, a game too short to mean anything, and a
 * game we cannot seat ten known players in. Keeping them identical is the
 * point. A modern record that got in under looser rules than a Classic one
 * would make every comparison between the two modes a comparison of the rules
 * rather than of the game.
 */
export function slimMatchV5(raw: unknown): StoredMatch | null {
  const match = asMatchV5(raw);
  if (!match?.info) return null;
  const info = match.info;
  const participants = info.participants ?? [];

  // Both id spaces go in, because both are a veto. Modern items and modern
  // champions must both come back as base ids; a game carrying Jade content
  // under a modern queue is the contradiction resolveMode() exists to catch,
  // and it answers unknown rather than picking the higher-ranked signal.
  const mode = resolveMode({
    queueId: info.queueId,
    mapId: info.mapId,
    gameMode: info.gameMode,
    championIds: participants.map((p) => num(p.championId)),
    itemIds: participants.flatMap((p) => itemsOf(p)),
  });
  // A contradiction is worth a line; a game we simply do not model is not.
  //
  // resolveMode() fills `conflicts` in both cases, so the two have to be told
  // apart here or this warning is useless. `unknownQueueId` is the divider: it
  // is only set when nothing placed the game at all, which for a crawl over a
  // stranger's history is the ordinary case -- every ARAM, every Arena, every
  // rotating mode Riot runs. Measured on a real one, EUW1_7483454886 (queue
  // 450, map 12, gameMode ARAM), that is one line per game and it would bury
  // the case that matters. Without the queue id, a signal we DO know disagreed
  // with another signal we know, which means our table no longer matches what
  // Riot is doing -- and this is the only place that can be noticed.
  if (mode.conflicts.length > 0 && mode.unknownQueueId === undefined) {
    console.warn(
      `[slim] MATCH-V5 game ${info.gameId ?? "?"} was not stored because its signals disagree:` +
        ` ${mode.conflicts.join(" ")}`,
    );
  }
  if (!modeCollects(mode.mode)) return null;

  const duration = durationInSeconds(info);
  // Remakes and early surrenders distort every statistic they touch, and the
  // threshold is quoted from shared/types rather than restated, so the screen
  // that explains a missing game quotes the number that actually dropped it.
  if (duration < MINIMALE_GAMEDUUR_SECONDEN) return null;

  const players: StoredPlayer[] = [];
  for (const p of participants) {
    // No participantIdentities to join against here -- V5 puts the puuid on the
    // participant itself -- but the rule is the client's rule: a seat we cannot
    // name is a seat we cannot count, and it takes the game down with it below.
    if (!p.puuid) continue;
    players.push({
      puuid: p.puuid,
      championId: num(p.championId),
      teamId: num(p.teamId),
      position: positionOf(p),
      win: p.win === true,
      kills: num(p.kills),
      deaths: num(p.deaths),
      assists: num(p.assists),
      cs: csOf(p),
      gold: num(p.goldEarned),
      items: itemsOf(p),
      spells: [num(p.summoner1Id), num(p.summoner2Id)],
      damage: p.totalDamageDealtToChampions,
      damageTaken: p.totalDamageTaken,
      vision: p.visionScore,
      wards: p.wardsPlaced,
      level: p.champLevel,
      perks: perksOf(p),
      statShards: shardsOf(p),
    });
  }
  if (players.length < SEATS) return null;

  return {
    gameId: num(info.gameId),
    // The shard, and on this side it is not optional in the way it is for the
    // client. A gameId is unique within one platform only, the store's index is
    // keyed on the id alone, and MATCH-V5 is regional by design -- so this is
    // the field that stops a NA1 game being filed as a duplicate of an EUW1
    // one. Taken from `info` and falling back to the matchId's own prefix,
    // which carries it too: "EUW1_7924801606".
    platformId: info.platformId ?? match.metadata?.matchId?.split("_")[0],
    createdAt: num(info.gameCreation),
    duration,
    // Read across all ten seats rather than off the first one. A surrender is a
    // property of the game and Riot fills the flag in for everybody, but that
    // is a fact about today's payload; asking whether anyone surrendered cannot
    // become wrong if that changes.
    surrendered: participants.some((p) => p.gameEndedInSurrender === true),
    queueId: num(info.queueId),
    // The verdict from the top of this function, so a record can never carry a
    // mode the gate above would have refused.
    mode: mode.mode,
    gameMode: info.gameMode,
    mapId: info.mapId,
    patch: (info.gameVersion ?? "").split(".").slice(0, 2).join("."),
    players,
  };
}

/**
 * The seven item slots, with the trinket last and 0 for empty.
 *
 * Its own function because the mode veto needs the same list before there is a
 * StoredPlayer to read it off, and two hand-written copies of item0..item6 is
 * one copy too many.
 */
function itemsOf(p: MatchV5Participant): number[] {
  return [
    num(p.item0),
    num(p.item1),
    num(p.item2),
    num(p.item3),
    num(p.item4),
    num(p.item5),
    num(p.item6),
  ];
}
