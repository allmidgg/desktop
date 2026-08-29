/**
 * Which mode a game was played in, as one value the whole application agrees on.
 *
 * This module exists because statistics from two modes may never be added
 * together. A Nasus top lane with 6.43 CS per minute in League Classic says
 * nothing about Nasus top in the modern game: different items, different runes,
 * different map timers, different champions. One accidental merge makes every
 * number wrong, and nobody would ever see it happen.
 *
 * One warning first, because the word means two opposite things. Riot's own
 * `gameMode` string for the MODERN Summoner's Rift is "CLASSIC" -- sixteen of
 * the eighty-eight queues the client publishes carry it, all on map 11 -- while
 * the Season 3 remake this app was built for reports "JADE". No identifier here
 * therefore contains the word "classic". Only labels do, and they say which.
 */

/** Every mode we can name, as `game:mode`, so a second game cannot collide. */
export type KnownModeId =
  | "lol:jade"       // The Season 3 remake. Map 453, gameMode JADE.
  | "lol:sr"         // The modern Summoner's Rift. Map 11, gameMode CLASSIC.
  | "lol:kiwi-jade"; // Jade content on the ARAM map. See the note below.

/**
 * The mode of a game we could not place.
 *
 * A real value with real rules, not a fallback. Nothing carrying it may enter a
 * tally, an upload or a baseline. Falling back to the primary mode when in doubt
 * is the single worst thing this module could do: a Riot patch that adds a queue
 * would then move thousands of games into the wrong averages, in silence and
 * retroactively.
 */
export const UNKNOWN_MODE = "unknown" as const;
export type ModeId = KnownModeId | typeof UNKNOWN_MODE;

/** What a queue is for. Decides whether its games count, not which mode they are. */
export type QueueKind = "ranked" | "normal" | "bot" | "custom" | "tutorial";

export interface ModeDescriptor {
  readonly id: KnownModeId;
  /** Human-facing name. Allowed to say "Classic", and says which one. */
  readonly label: string;
  readonly shortLabel: string;
  /**
   * Whether this app collects and counts games in this mode at all.
   *
   * False for lol:kiwi-jade, and that is the whole reason the mode is named
   * rather than left as unknown: we know exactly what it is, we just have
   * nowhere to put it. "unknown" should mean we do not know.
   */
  readonly collect: boolean;
  /**
   * Whether the crawler may walk strangers' match histories for this mode.
   *
   * The distinction `collect` cannot make on its own, and the empty tier list
   * depends on it. A mode can be collected -- have a store, a tally, a place in
   * the status bar -- and still have no way to fill that tally, because the
   * shared numbers come from the crawler and the crawler is only allowed into
   * one mode. So an empty Classic tier list means "keep playing" while an empty
   * modern one means "there is no route to these numbers yet", and a screen that
   * cannot tell the two apart promises data that is never coming.
   *
   * The rule itself is Riot's, not ours: MATCH-V5 documents the way into the
   * modern game, so taking it out of the client instead would be collecting over
   * an undocumented endpoint what we are meant to fetch legally.
   */
  readonly crawl: boolean;
}

/**
 * Whatever the caller happens to know about a game.
 *
 * Every field optional on purpose: a stored record has only a queue id, the live
 * endpoint has only a map number and a mode string, and champ select has neither
 * until the gameflow session exists. Deliberately not tied to the LCU -- Riot's
 * documented MATCH-V5 returns queueId, mapId and gameMode under `info` with the
 * same values, so the same resolver serves both sources. That is what lets the
 * modern game arrive over the documented API while Classic keeps arriving over
 * the client, without two different notions of what a mode is.
 */
export interface ModeSignals {
  readonly queueId?: number;
  readonly mapId?: number;
  readonly gameMode?: string;
  /** Champion ids seen. These corroborate; they never decide. */
  readonly championIds?: readonly number[];
  /** Item ids seen. Kept separate from champions -- see the note in detect.ts. */
  readonly itemIds?: readonly number[];
}

export type ModeConfidence = "queue" | "map+mode" | "mode" | "map" | "none";

export interface ModeVerdict {
  /** UNKNOWN_MODE when nothing decided, or when two signals contradicted. */
  readonly mode: ModeId;
  readonly confidence: ModeConfidence;
  /** Every contradiction found, in words, so a stale table can be spotted. */
  readonly conflicts: readonly string[];
  /** A queue we have never seen. Not an error: a row somebody should add. */
  readonly unknownQueueId?: number;
}
