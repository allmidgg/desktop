/**
 * The Classic match-history timeline, which everything else in this repo says
 * does not exist.
 *
 * It does. `/lol-match-history/v1/game-timelines/{gameId}` answers 200 with one
 * frame per minute for every one of the ten players, and it answers for games
 * this account never played -- twenty-five gameIds picked at random out of
 * data/matches.jsonl, spanning the whole month the crawler has been running,
 * all returned frames. That is the difference between a curve for the handful of
 * games this machine happened to watch and a curve for all 130,095 games already
 * on disk, plus every game the crawler finds from here on.
 *
 * The claim in tijdlijn.ts that "the only two endpoints there are to ask are the
 * match list and /lol-match-history/v1/games/{gameId}" was never tested; the
 * client's own route index lists the operation as
 * GetLolMatchHistoryV1GameTimelinesByGameId, one name away from where everyone
 * looked. The `timeline` field on Participant does carry goldPerMinDeltas and
 * xpPerMinDeltas alongside lane and role -- they are simply always empty objects,
 * which is presumably why the trail went cold there.
 *
 * What the frames do NOT carry, measured across every event in a full game:
 * only CHAMPION_KILL, BUILDING_KILL and ELITE_MONSTER_KILL. There is no
 * ITEM_PURCHASED and no SKILL_LEVEL_UP, so the build order the live watcher
 * writes to buildorders.jsonl stays the only source for when an item was bought.
 * The two sources complement each other rather than replace one another.
 */
import type { LcuClient } from "./connector";

/**
 * One player's state at one minute.
 *
 * `minionsKilled` and `jungleMinionsKilled` are separate here while the stored
 * match record keeps a single `cs`, so a caller that wants to compare the two
 * has to add them together first.
 */
export interface TimelineParticipantFrame {
  participantId: number;
  currentGold: number;
  totalGold: number;
  xp: number;
  level: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
  position: { x: number; y: number };
  /** Always 0 on this map; kept because the client sends it. */
  dominionScore: number;
  teamScore: number;
}

/**
 * One event, in the flattened shape this API uses.
 *
 * Every event carries every field, so the ones that do not apply arrive as empty
 * strings and zeroes rather than being absent -- a BUILDING_KILL still has a
 * `monsterType` of "". Read a field only after checking `type`.
 */
export interface TimelineEvent {
  type: "CHAMPION_KILL" | "BUILDING_KILL" | "ELITE_MONSTER_KILL" | string;
  /** Milliseconds since the game clock started. */
  timestamp: number;
  killerId: number;
  victimId: number;
  assistingParticipantIds: number[];
  position: { x: number; y: number };
  teamId: number;
  buildingType: string;
  towerType: string;
  laneType: string;
  monsterType: string;
  monsterSubType: string;
  itemId: number;
  skillSlot: number;
  participantId: number;
}

export interface TimelineFrame {
  /** Milliseconds; frames land on the minute, and the last one is the final clock. */
  timestamp: number;
  /** Keyed by participantId as a string, "1" through "10". */
  participantFrames: Record<string, TimelineParticipantFrame>;
  events: TimelineEvent[];
}

export interface GameTimeline {
  frames: TimelineFrame[];
}

export const GAME_TIMELINE_PATH = (gameId: number): string =>
  `/lol-match-history/v1/game-timelines/${gameId}`;

/**
 * Fetches the timeline for one game, or null when there is none.
 *
 * A 404 here is a real answer rather than a failure: an unknown gameId returns
 * one, so a caller backfilling old games can treat null as "this game has no
 * timeline" and move on instead of stopping. Any other status still throws,
 * because a 500 in the middle of a backfill is not something to write down as an
 * absence.
 */
export async function fetchGameTimeline(
  client: LcuClient,
  gameId: number,
): Promise<GameTimeline | null> {
  const timeline = await client.tryGet<GameTimeline>(GAME_TIMELINE_PATH(gameId));
  return timeline?.frames?.length ? timeline : null;
}

/** One player's per-minute series, which is what a curve on screen actually needs. */
export interface SpelerVerloop {
  participantId: number;
  /** Total gold earned, per minute, from minute zero. */
  gold: number[];
  cs: number[];
  xp: number[];
  level: number[];
}

/**
 * Turns frames into per-player series.
 *
 * The wire shape is minute-major -- a frame holds all ten players -- and every
 * question anyone asks of a timeline is player-major: how did my gold run, where
 * did I fall behind. Transposing once here is cheaper than every caller
 * rediscovering that the data is the wrong way round, and it cuts a 87KB
 * response down to roughly 6.5KB of numbers worth keeping.
 */
export function verloopPerSpeler(timeline: GameTimeline): SpelerVerloop[] {
  const ids = new Set<string>();
  for (const frame of timeline.frames) {
    for (const id of Object.keys(frame.participantFrames)) ids.add(id);
  }
  return [...ids]
    .map(Number)
    .sort((a, b) => a - b)
    .map((participantId) => {
      const serie: SpelerVerloop = { participantId, gold: [], cs: [], xp: [], level: [] };
      for (const frame of timeline.frames) {
        const pf = frame.participantFrames[String(participantId)];
        // The first frame is minute zero and can be missing a player entirely,
        // so a gap repeats the previous value rather than dropping to zero and
        // drawing a cliff that never happened.
        const laatste = serie.gold.length - 1;
        serie.gold.push(pf ? pf.totalGold : (serie.gold[laatste] ?? 0));
        serie.cs.push(pf ? pf.minionsKilled + pf.jungleMinionsKilled : (serie.cs[laatste] ?? 0));
        serie.xp.push(pf ? pf.xp : (serie.xp[laatste] ?? 0));
        serie.level.push(pf ? pf.level : (serie.level[laatste] ?? 1));
      }
      return serie;
    });
}

/** Every event in the game, in order, with the frame nesting removed. */
export function gebeurtenissenVan(timeline: GameTimeline): TimelineEvent[] {
  return timeline.frames
    .flatMap((frame) => frame.events ?? [])
    .sort((a, b) => a.timestamp - b.timestamp);
}
