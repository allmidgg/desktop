/**
 * What the timeline is allowed to claim, said out loud above the timeline.
 *
 * The chart in Tijdlijn.tsx draws whatever the recording holds. It cannot tell
 * a game watched end to end from the last eleven minutes of one, and neither
 * can the reader -- both come out as a curve that starts at the left edge. So
 * the left edge gets a caption, and a recording that covers only part of the
 * game gets it in the accent colour rather than the quiet one, because the
 * whole point is that it should not be skimmed past.
 *
 * The two components here read the same verdict from shared/dekking.ts, so the
 * empty case and the partial case can never end up saying different things
 * about the same game.
 */
import type { Dekking } from "../../../shared/dekking";
import { leesbaarVenster } from "../../../shared/dekking";
import { EmptyState } from "../ui";

const klok = (s: number): string =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

/**
 * The one-line caption over a chart drawn from a partial recording.
 *
 * Returns null for a complete one: a game we watched from the opening to the
 * end needs no disclaimer, and printing "complete" over every good game trains
 * the reader to stop reading the line that matters.
 */
export function Dekkingsregel({ dekking }: { dekking: Dekking }): JSX.Element | null {
  if (dekking.soort === "volledig" || dekking.soort === "geen") return null;

  const venster = leesbaarVenster(dekking);
  const titels: Record<Exclude<Dekking["soort"], "volledig" | "geen">, string> = {
    "laat-begonnen": `Recording starts at ${klok(dekking.vanaf)}`,
    "vroeg-gestopt": `Recording stops at ${klok(dekking.tot)}`,
    flard: `Only ${klok(dekking.tot - dekking.vanaf)} of this game was recorded`,
  };

  return (
    <div className="rounded border border-gold-400/30 bg-gold-400/5 px-3 py-2">
      <p className="text-xs font-medium text-gold-400">{titels[dekking.soort]}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-500">{dekking.grond}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        {/* The window is the actual product of this component: it is what stops a
            reader answering "which minute went worse" with a minute we never saw. */}
        Anything this screen says about a particular minute can only be about minute{" "}
        <span className="num">{venster.vanMinuut}</span> through{" "}
        <span className="num">{venster.totMinuut}</span>.
        {dekking.vanaf > 0 ? (
          <>
            {" "}
            Every item held at <span className="num">{klok(dekking.vanaf)}</span> was written down at
            that second because that is when we first looked, not when it was bought.
          </>
        ) : null}
        {dekking.gebeurtenissenVanafNul ? (
          <> Kills and objectives from before then are real: the game handed over its own history.</>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The whole panel, for a game with no recording at all.
 *
 * Which is the ordinary case and has to read like one. The database is 130,086
 * games collected from other people's match histories; nobody was watching any
 * of them, no endpoint backfills them, and a screen that implies otherwise sends
 * the reader back tomorrow to look for something that is never arriving. The
 * same mistake GeenDetail was written to stop making.
 */
export function GeenVerloop(): JSX.Element {
  return (
    <EmptyState
      title="We did not watch this game"
      hint={
        "How a game went is only known while it is running -- the client reports it second by" +
        " second on a server that disappears when the game does, and match history keeps end totals" +
        " and nothing else. So there is a timeline for games you played with AllMid open, and there" +
        " is none for this one. That will not change later."
      }
    />
  );
}
