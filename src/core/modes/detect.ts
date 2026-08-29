/**
 * Establishing which mode a game was in, from whatever is known about it.
 *
 * The signals are not equal and the order matters:
 *
 *   queueId          Sharpest. Maps to exactly one map and one mode, is the only
 *                    signal stored on disk, and the only one both the local
 *                    client and MATCH-V5 give.
 *   mapId+gameMode   Second, and only together. Map 11 carries twelve mode
 *                    strings in the client's own table and map 12 carries three,
 *                    so the map alone narrows rather than decides; the mode
 *                    string can gain new values -- KIWI_JADE is one -- and its
 *                    value "CLASSIC" means the opposite of what this codebase
 *                    calls Classic.
 *   gameMode / mapId Alone, and only when exactly one mode matches.
 *   champion/item id Never decides. It vetoes.
 *
 * The id ranges correlate perfectly in our own data -- all 1.3 million stored
 * participant rows sit in the Jade range -- and are still not allowed a vote,
 * because game 7953675289 carries modern champion ids and Jade item ids at the
 * same time. Content space is not mode. Deciding on the range would file an ARAM
 * game as a Rift game, which is the merge this module exists to prevent.
 */
import { isJadeChampionId, isJadeItemId } from "../jade/ids";
import { MODE_SPACES } from "../ids/space";
import { modeForPair, queueRow } from "./registry";
import {
  UNKNOWN_MODE,
  type KnownModeId,
  type ModeConfidence,
  type ModeId,
  type ModeSignals,
  type ModeVerdict,
} from "./types";

const unknown = (conflicts: string[], strayQueue?: number): ModeVerdict => ({
  mode: UNKNOWN_MODE,
  confidence: "none",
  conflicts,
  ...(strayQueue === undefined ? {} : { unknownQueueId: strayQueue }),
});

/**
 * Which id space a set of ids came from, per kind.
 *
 * Kept per kind rather than per game, and that is not tidiness. Game 7953675289
 * has champions in the base space and items in the Jade space simultaneously, so
 * a single "this game's id space" would have to be wrong about one of them.
 * Returns null when the ids disagree among themselves, which is itself worth
 * reporting: a game with both a Jade and a base champion in it is not a game.
 */
function observedSpace(ids: readonly number[], isJade: (id: number) => boolean): "base" | "jade" | "mixed" | null {
  let jade = 0;
  let base = 0;
  for (const id of ids) {
    if (!id || id < 0) continue; // 0 is an empty slot, -1 is an unpicked champion.
    if (isJade(id)) jade++;
    else base++;
  }
  if (jade > 0 && base > 0) return "mixed";
  if (jade > 0) return "jade";
  if (base > 0) return "base";
  return null;
}

/**
 * Works out the mode, and says how sure it is and what disagreed.
 *
 * When two signals that both resolve to a known mode point at different modes,
 * the answer is unknown rather than the higher-ranked one. That is the most
 * important line here. A contradiction means our table no longer matches what
 * Riot is doing, and a stale table that keeps answering confidently is precisely
 * the machine that puts a Classic game into a modern tally. Losing a game costs
 * one game. Filing it wrongly costs the trust in every number in the app, and
 * nobody ever notices.
 */
export function resolveMode(signals: ModeSignals): ModeVerdict {
  const conflicts: string[] = [];

  const row = signals.queueId === undefined ? null : queueRow(signals.queueId);
  const byQueue = row?.mode ?? null;
  const byPair =
    signals.mapId !== undefined && signals.gameMode
      ? modeForPair(signals.mapId, signals.gameMode)
      : null;

  const ladder: ReadonlyArray<[ModeConfidence, KnownModeId | null]> = [
    ["queue", byQueue],
    ["map+mode", byPair],
  ];

  const decision = ladder.find(([, id]) => id !== null);
  if (!decision) {
    // Nothing placed it. An unrecognised queue is reported by number, because a
    // new queue is not a failure -- it is a row somebody should add.
    const stray = signals.queueId !== undefined && row === null ? signals.queueId : undefined;
    if (signals.gameMode && signals.mapId !== undefined) {
      conflicts.push(`Map ${signals.mapId} with mode "${signals.gameMode}" is not in our table.`);
    }
    return unknown(conflicts, stray);
  }

  const [confidence, decided] = decision as [ModeConfidence, KnownModeId];

  for (const [name, candidate] of ladder) {
    if (candidate === null || name === confidence) continue;
    if (candidate !== decided) {
      conflicts.push(`The ${name} signal says ${candidate} while the ${confidence} signal says ${decided}.`);
    }
  }

  // The id ranges are the veto. They cannot choose a mode; they can refuse one.
  // The same table the catalogue picks its indexes from, and deliberately not a
  // second copy of it: a mode vetoed here on one numbering while its names are
  // looked up under another is a disagreement no screen would show.
  const expect = MODE_SPACES[decided];
  const champSpace = signals.championIds?.length
    ? observedSpace(signals.championIds, isJadeChampionId)
    : null;
  const itemSpace = signals.itemIds?.length ? observedSpace(signals.itemIds, isJadeItemId) : null;
  if (champSpace === "mixed") conflicts.push("This game contains both Classic and base champion ids.");
  else if (champSpace && champSpace !== expect.champion) {
    conflicts.push(`${decided} uses ${expect.champion} champion ids; this game has ${champSpace} ones.`);
  }
  if (itemSpace && itemSpace !== "mixed" && itemSpace !== expect.item) {
    conflicts.push(`${decided} uses ${expect.item} item ids; this game has ${itemSpace} ones.`);
  }

  if (conflicts.length > 0) return unknown(conflicts);
  return { mode: decided, confidence, conflicts: [] };
}

/** The common case, when only the answer is wanted. */
export const modeOf = (signals: ModeSignals): ModeId => resolveMode(signals).mode;

/**
 * The mode of a stored record.
 *
 * Records written from now on carry it explicitly. The 130,197 written before
 * the field existed carry only a queue id, and all three queue ids present in
 * them -- 4310 (126,340), 4320 (3,852) and 3262 (5), counted over the whole file
 * -- resolve to lol:jade on the queue signal alone. So the mode of the existing
 * database is derived rather than migrated, and matches.jsonl (326 MB,
 * append-only by design) is never rewritten.
 *
 * Anything unrecognised answers unknown, never lol:sr. That asymmetry matters:
 * treating an unfamiliar queue as modern would hand a whole future era of
 * Classic games to the wrong tallies, quietly and all at once.
 */
export const modeOfStored = (match: { queueId: number; mode?: ModeId }): ModeId =>
  match.mode ?? modeOf({ queueId: match.queueId });
