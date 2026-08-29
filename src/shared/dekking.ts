/**
 * How much of a game we actually watched, and what that allows us to say.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A curve drawn from a recording looks the same whether the recording covers
 * the whole game or the last eleven minutes of it. That is the failure worth
 * preventing: "you fell behind around minute 14" is a real sentence when the
 * recording starts at 0 and a lie when the recording starts at 13:58, because
 * minute 14 is simply the first minute we can see. The reader has no way to
 * tell those apart from the drawing, so the drawing has to say.
 *
 * Nothing here is a heuristic dressed as a fact. Every field is either read off
 * the recording or off match history, and the one inference this file makes --
 * that the watcher joined a game already in progress -- is made on a signature
 * the writer leaves behind on purpose, and is spelled out below.
 *
 * ── The two coverages are not the same coverage ─────────────────────────────
 *
 * A recording carries two independent lines: the purchases, which the watcher
 * assembles poll by poll, and the events, which arrive as a feed. Those do not
 * survive a late start equally, and pretending they do is how a half-covered
 * game gets shown as a whole one.
 *
 * The purchase line cannot survive it. LiveGameWatcher.noteerAankopen says so
 * itself: "No previous reading means the first sighting, and then everything in
 * the inventory counts as bought right now." Join at 13:58 and every item a
 * player is already holding is stamped 13:58 -- not missing, worse than
 * missing, wrong. Which is also what makes the join detectable, see below.
 *
 * The event line may well survive it, because the feed appears to be cumulative
 * rather than incremental -- objectiefTimers filters events by age, which only
 * makes sense on a feed that keeps handing back old ones. That is an inference
 * from how the reader is written, not a measurement, and it is left as one:
 * `gebeurtenissenVanafNul` reports what the recording shows and nothing more.
 * Settle it with a probe against a running client before anything relies on it.
 *
 * Lives in shared/ for the same reason build.ts does: the renderer has to reach
 * it, and nothing under core/services can be imported from a view without
 * dragging undici and the League client into the bundle.
 */
import type { OpnameRecord } from "./types";

/**
 * How late the first purchase in a game may be before it stops looking like an
 * opening and starts looking like a join.
 *
 * The only complete recording on disk has ten seats whose first purchases land
 * at 5, 5, 9, 12, 18, 54, 86, 112, 116 and 152 seconds -- one lobby, so treat
 * the number as an order of magnitude and not as a distribution. Thirty seconds
 * sits below the earliest of those pairs by enough that a normal opening never
 * reaches it. It is deliberately not the whole test: the unanimity rule in
 * `laatBegonnen` is what actually decides, and this threshold only exists so a
 * lobby that all happened to shop at the same second at 0:12 is not accused.
 */
const OPENING_MARGE_SECONDEN = 30;

/**
 * Below this the recording covers less of the game than it misses.
 *
 * This one is a judgement and is labelled as such rather than dressed up: there
 * is no measurement that says half is the line. What it buys is that a partial
 * recording is described by its larger part -- a game we saw the first 60% of
 * reads as "stopped early", a game we saw the last 40% of reads as a fragment.
 */
const FLARD_AANDEEL = 0.5;

export type DekkingSoort =
  /** Nothing was recorded. This app was not running, or it never wrote. */
  | "geen"
  /** Watched from the opening to the end. */
  | "volledig"
  /** The app opened into a game that was already running. */
  | "laat-begonnen"
  /** Polling stopped before the game did. Quit, crash, or a blip on 2999. */
  | "vroeg-gestopt"
  /** Both ends are missing, or so much of the middle that neither end leads. */
  | "flard";

export interface Dekking {
  soort: DekkingSoort;
  /**
   * First second of game time the purchase line can account for.
   *
   * Zero when we were there from the opening. Otherwise the second the watcher
   * arrived, at which point every inventory it found was stamped with this same
   * value -- so purchases at exactly `vanaf` are not purchases, they are the
   * arrival, and a build chart has to start after it rather than at it.
   */
  vanaf: number;
  /** Last second of game time the watcher was still polling. */
  tot: number;
  /**
   * The game's own length, from match history. Null when no match is joined.
   *
   * Without it there is no way to know whether `tot` is the end of the game or
   * the moment we stopped looking, so `gemist` is null too and the verdict can
   * never be "volledig". An unjoined recording is not a complete one; it is one
   * whose completeness nothing has checked.
   */
  duurSeconden: number | null;
  /** Seconds of the game with no purchase line, or null when the length is unknown. */
  gemist: number | null;
  /** Whole minutes of purchase line, which is the most minutes any reading can use. */
  leesbareMinuten: number;
  /**
   * Whether the event line reaches back further than the purchase line does.
   *
   * True when there are events timestamped before `vanaf`, which is proof the
   * feed handed over history the watcher did not witness. False is not the
   * opposite proof: a quiet opening has no events to be missing.
   */
  gebeurtenissenVanafNul: boolean;
  /**
   * Why this verdict, in the recording's own numbers, for the screen to print.
   *
   * Kept rather than reduced to the verdict for the same reason koppel() keeps
   * its reasoning: a judgement you cannot check is a guess with better manners.
   */
  grond: string;
}

/** Earliest and latest second anything was seen, across both lines. */
function bereik(opname: OpnameRecord): { eersteAankoop: number | null; eersteGebeurtenis: number | null } {
  let eersteAankoop: number | null = null;
  for (const speler of opname.spelers) {
    for (const stap of speler.build) {
      if (eersteAankoop === null || stap.at < eersteAankoop) eersteAankoop = stap.at;
    }
  }
  const eersteGebeurtenis = opname.gebeurtenissen.length
    ? Math.min(...opname.gebeurtenissen.map((g) => g.at))
    : null;
  return { eersteAankoop, eersteGebeurtenis };
}

/**
 * Did the watcher walk in on a game already running?
 *
 * The signature is unanimity, not lateness. Every seat is first seen on the
 * same poll, so on a join every player holding anything gets their first
 * BuildStep stamped with that one identical second. Play from the opening and
 * the seats scatter, because ten people do not press buy at the same instant --
 * the one full recording on disk spreads its ten first purchases over 5 to 152
 * seconds.
 *
 * So: late, and every seat that bought anything agrees on the second. Either
 * one alone would be wrong. Lateness alone accuses a slow lobby; unanimity
 * alone accuses the genuine case of two seats buying on the same poll at 0:05.
 */
function laatBegonnen(opname: OpnameRecord, eersteAankoop: number): boolean {
  if (eersteAankoop <= OPENING_MARGE_SECONDEN) return false;
  const kopers = opname.spelers.filter((s) => s.build.length > 0);
  if (kopers.length < 2) return false;
  return kopers.every((s) => Math.min(...s.build.map((b) => b.at)) === eersteAankoop);
}

const klok = (s: number): string =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

/**
 * What we have of one game.
 *
 * `duurSeconden` is the length match history reports, when a match was joined.
 * Pass null when nothing was joined -- that is not the same as passing the
 * recording's own length, which only says when we stopped watching.
 */
export function leesDekking(opname: OpnameRecord | null, duurSeconden: number | null): Dekking {
  if (!opname) {
    return {
      soort: "geen",
      vanaf: 0,
      tot: 0,
      duurSeconden,
      gemist: duurSeconden,
      leesbareMinuten: 0,
      gebeurtenissenVanafNul: false,
      grond: "No recording: this app was not watching while this game ran.",
    };
  }

  const { eersteAankoop, eersteGebeurtenis } = bereik(opname);
  const laat = eersteAankoop !== null && laatBegonnen(opname, eersteAankoop);
  const vanaf = laat ? eersteAankoop : 0;
  const tot = opname.gameLengthSeconds;
  const gemist = duurSeconden === null ? null : Math.max(0, duurSeconden - (tot - vanaf));
  const gebeurtenissenVanafNul = eersteGebeurtenis !== null && eersteGebeurtenis < vanaf;
  const leesbareMinuten = Math.max(0, Math.floor((tot - vanaf) / 60));

  // A recording that stops materially before the game did. The threshold is one
  // poll interval doubled: the harvest fires on the first failed poll, so up to
  // four seconds of tail is the mechanism working normally rather than a gap.
  const staartGemist = duurSeconden !== null && duurSeconden - tot > 4;
  const gedektAandeel = duurSeconden === null || duurSeconden <= 0 ? 1 : (tot - vanaf) / duurSeconden;

  let soort: DekkingSoort;
  let grond: string;
  if (laat && staartGemist) {
    soort = "flard";
    grond =
      `Recorded from ${klok(vanaf)} to ${klok(tot)} of a game that ran ${klok(duurSeconden ?? tot)}:` +
      ` the app opened into it and stopped before it ended.`;
  } else if (laat) {
    soort = gedektAandeel < FLARD_AANDEEL ? "flard" : "laat-begonnen";
    grond =
      `Every player's first purchase is stamped ${klok(vanaf)}, the same second for all of them,` +
      ` which is the app arriving rather than a lobby shopping. Nothing before ${klok(vanaf)} was seen.`;
  } else if (staartGemist) {
    soort = gedektAandeel < FLARD_AANDEEL ? "flard" : "vroeg-gestopt";
    grond =
      `The last poll was at ${klok(tot)} of a game match history says ran ${klok(duurSeconden ?? tot)}.` +
      ` Polling stopped ${Math.round((duurSeconden ?? tot) - tot)}s before the game did.`;
  } else if (duurSeconden === null) {
    // Not joined to a match, so nothing has checked the tail. Honest default is
    // the weaker claim, not the flattering one.
    soort = "vroeg-gestopt";
    grond =
      `Recorded from the opening to ${klok(tot)}. No stored match matches this recording, so there` +
      ` is nothing to check that against -- the game may have run longer than we watched.`;
  } else {
    soort = "volledig";
    grond = `Watched from the opening to ${klok(tot)}, the full length match history reports.`;
  }

  return { soort, vanaf, tot, duurSeconden, gemist, leesbareMinuten, gebeurtenissenVanafNul, grond };
}

/**
 * The sentence a per-minute reading may not step outside of.
 *
 * A "which minute went worse" answer is only allowed to name a minute inside
 * this window, and callers should clamp to it rather than filter after the
 * fact: the minute with the worst number in a late-started recording is very
 * often `vanaf` itself, because that is where a whole inventory got stamped.
 */
export function leesbaarVenster(dekking: Dekking): { vanMinuut: number; totMinuut: number } {
  // One minute of slack after the arrival, because the arrival second carries
  // every item the players already had and no reading of it means anything.
  const vanMinuut = dekking.vanaf === 0 ? 0 : Math.ceil((dekking.vanaf + 60) / 60);
  return { vanMinuut, totMinuut: Math.floor(dekking.tot / 60) };
}
