/**
 * The modes we can name and the queues that lead to them.
 *
 * Read out of the running client rather than guessed: GET
 * /lol-game-queues/v1/queues returned 88 queues spread over 22 distinct
 * (mapId, gameMode) pairs on 2026-08-29. Only the rows this application acts on
 * are copied here -- copying all 88 would be duplicating something the client
 * already publishes and that will go stale. `learnQueues` folds in the rest at
 * runtime, for the times League is open.
 */
import { UNKNOWN_MODE, type KnownModeId, type ModeDescriptor, type ModeId, type QueueKind } from "./types";

export const MODES: readonly ModeDescriptor[] = [
  { id: "lol:sr", label: "League of Legends", shortLabel: "LoL", collect: true },
  { id: "lol:jade", label: "League Classic", shortLabel: "Classic", collect: true },
  {
    // Jade content on the Howling Abyss, and the single clearest reason this
    // module models more than a Classic/modern flag. Game 7953675289 is real:
    // gameMode KIWI_JADE, map 12, queue 2450, 22 minutes, championIds
    // 15/89/54/4/80/17/22/24/62/30 -- all MODERN base ids -- with items
    // 773087/773006/773035/... -- all JADE ids -- and lanes that toPosition()
    // turns into five TOP, four MIDDLE and one JUNGLE on a map that has no
    // lanes. It is neither mode and it must be counted nowhere.
    //
    // Named rather than left unknown, because we know exactly what it is. The
    // reason it is stored nowhere is `collect: false`, not ignorance.
    id: "lol:kiwi-jade",
    label: "ARAM: Mayhem (Classic)",
    shortLabel: "Mayhem",
    collect: false,
  },
];

const byId = new Map<KnownModeId, ModeDescriptor>(MODES.map((m) => [m.id, m]));

export const describeMode = (id: ModeId): ModeDescriptor | null =>
  id === UNKNOWN_MODE ? null : (byId.get(id) ?? null);
export const modeLabel = (id: ModeId): string => describeMode(id)?.label ?? "Unknown mode";
/** Whether this mode is stored and counted at all. False for kiwi-jade and unknown. */
export const modeCollects = (id: ModeId): boolean => describeMode(id)?.collect ?? false;

export interface QueueRow {
  readonly mode: KnownModeId;
  readonly mapId: number;
  readonly gameMode: string;
  readonly kind: QueueKind;
}

const q = (mode: KnownModeId, mapId: number, gameMode: string, kind: QueueKind): QueueRow => ({
  mode, mapId, gameMode, kind,
});

/**
 * Every queue we act on, verbatim from the client.
 *
 * `kind` lives on the queue and not on the mode, because one mode spans several
 * kinds: Classic has a ranked queue (4310), a bot queue (4320) and two custom
 * queues (3260, 3262), and only the first belongs in a tally. The 3,852 bot
 * games and 5 custom games already stored are genuinely Classic; they are just
 * not played against people who are trying.
 */
const QUEUES = new Map<number, QueueRow>([
  // League Classic, map 453. These four are exactly JADE_QUEUES, confirmed
  // against the client's own table.
  [4310, q("lol:jade", 453, "JADE", "ranked")],
  [4320, q("lol:jade", 453, "JADE", "bot")],
  [3260, q("lol:jade", 453, "JADE", "custom")],
  [3262, q("lol:jade", 453, "JADE", "custom")],
  // Modern Summoner's Rift. Note that gameMode is the string "CLASSIC".
  [400, q("lol:sr", 11, "CLASSIC", "normal")],
  [420, q("lol:sr", 11, "CLASSIC", "ranked")],
  [430, q("lol:sr", 11, "CLASSIC", "normal")],
  [440, q("lol:sr", 11, "CLASSIC", "ranked")],
  [830, q("lol:sr", 11, "CLASSIC", "bot")],
  [840, q("lol:sr", 11, "CLASSIC", "bot")],
  [850, q("lol:sr", 11, "CLASSIC", "bot")],
  // Classic on the Howling Abyss. Present so these games resolve to something
  // other than unknown and are then declined by modeCollects(), rather than
  // being mistaken for either real mode.
  [2450, q("lol:kiwi-jade", 12, "KIWI_JADE", "normal")],
  [3280, q("lol:kiwi-jade", 12, "KIWI_JADE", "custom")],
]);

/** Which modes claim a (mapId, gameMode) pair. The pair is unambiguous; neither half is. */
const PAIRS = new Map<string, KnownModeId>([
  ["453|JADE", "lol:jade"],
  ["11|CLASSIC", "lol:sr"],
  ["12|KIWI_JADE", "lol:kiwi-jade"],
]);

export const queueRow = (queueId: number): QueueRow | null => QUEUES.get(queueId) ?? null;

export const modeForPair = (mapId: number, gameMode: string): KnownModeId | null =>
  PAIRS.get(`${mapId}|${gameMode.toUpperCase()}`) ?? null;

/**
 * Whether a queue's games belong in statistics.
 *
 * Bots play differently and customs are arranged rather than matched, so both
 * distort every average they touch. This used to be one number -- JADE_QUEUES.BOT
 * -- which is the Classic bot queue only; the client lists more than a dozen
 * modern ones, four of which report gameMode SWIFTPLAY and would sail straight
 * through any filter that looks at the mode string. An unknown queue counts for
 * nothing, which is the same rule the unknown mode follows.
 */
export const queueCounts = (queueId: number): boolean => {
  const kind = QUEUES.get(queueId)?.kind;
  return kind === "ranked" || kind === "normal";
};

/**
 * Folds the client's own queue table into ours, for queues we do not know.
 *
 * Adding rows is safe and useful. Changing them is not, and is refused. The mode
 * ids are what stored tallies are keyed by, so letting a runtime answer move a
 * known queue to a different mode would put yesterday's numbers under a different
 * key today -- adding two modes together without ever having mixed two modes, and
 * with no way to find it afterwards. The refusals are returned so a caller can
 * report them instead of swallowing them.
 */
export function learnQueues(
  rows: ReadonlyArray<{ id: number; mapId: number; gameMode: string }>,
): { added: number; refused: string[] } {
  const refused: string[] = [];
  let added = 0;
  for (const row of rows) {
    const known = QUEUES.get(row.id);
    if (known) {
      if (known.mapId !== row.mapId || known.gameMode.toUpperCase() !== row.gameMode.toUpperCase()) {
        refused.push(
          `Queue ${row.id} is on record as ${known.gameMode} on map ${known.mapId} but the client ` +
            `now reports ${row.gameMode} on map ${row.mapId}. The table was left alone; this needs a ` +
            `human before any tally trusts this queue.`,
        );
      }
      continue;
    }
    const mode = modeForPair(row.mapId, row.gameMode);
    if (!mode) continue; // A mode we do not model. Stays unknown, which is honest.
    // A learned queue is assumed not to count until someone classifies it by
    // hand. Erring toward counting nothing is the discipline of this module.
    QUEUES.set(row.id, { mode, mapId: row.mapId, gameMode: row.gameMode.toUpperCase(), kind: "custom" });
    added++;
  }
  return { added, refused };
}
