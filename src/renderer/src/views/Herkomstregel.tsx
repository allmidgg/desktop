/**
 * Where the curve above this line came from, said under the curve.
 *
 * Dekkingsregel answers "how much of this game did we see". This answers the
 * question that only exists now that there are two sources: which of them drew
 * the line you are looking at, and how often it looked. They are separate
 * captions on purpose -- coverage is a fact about one recording, provenance is a
 * fact about a choice this app made between two recordings of the same game --
 * and a screen showing a merged curve needs both.
 *
 * ── Why this cannot be a badge ───────────────────────────────────────────────
 *
 * The tempting version is a little tag reading "match history" next to the
 * measure switch. That fails on the one case it exists for. Switching the
 * measure switches the source underneath: creep score comes off a frame once a
 * minute and kills off a poll every ten seconds, so the same chart, the same
 * game and the same two players change cadence when the reader touches a
 * control that appears to change only the units. Somebody comparing the two will
 * read the minute curve as the steadier player. A tag does not stop that; a
 * sentence naming the cadence does, and shared/samenloop.ts writes the sentence
 * where the numbers behind it are, rather than here where they would drift.
 *
 * ── Why it is quiet and not an alarm ─────────────────────────────────────────
 *
 * Dekkingsregel earns the accent colour because it is a warning: the chart is
 * about to be read as more than it covers. This one is not a warning in the
 * ordinary case. A curve drawn from match history for a game nobody watched is
 * the normal state of 130,086 of the games on this machine and it is completely
 * sound, so shouting about it would train the reader past the line that does
 * matter. It goes loud in exactly one case, and `dringend` below is where that
 * is decided.
 */
import type { Herkomst, SamenloopVeld } from "../../../shared/samenloop";

/**
 * The one case where provenance is a warning rather than a note.
 *
 * A creep score read off our own recording, with no timeline to check it
 * against. That number was measured to be low by as much as 131 on a single
 * game's ten seats and to be rounded to whole tens on every one of them, and
 * creep score is the measure the head-to-head strip opens on -- so it is the
 * combination where a reader is most likely to draw a conclusion about a lane
 * from a figure that is quietly wrong. Every other combination is either exact
 * or honest about being coarse without being wrong.
 */
const dringend = (herkomst: Herkomst): boolean =>
  herkomst.veld === "cs" && herkomst.bron === "opname" && !herkomst.andereBestond;

const NAAM: Record<SamenloopVeld, string> = {
  cs: "Creep score",
  gold: "Gold earned",
  kills: "Kills",
  deaths: "Deaths",
  assists: "Assists",
  level: "Level",
  wards: "Ward score",
};

/**
 * The line under one chart, for whichever measure that chart is showing.
 *
 * Never returns null for a measure that has a source. There is no "obvious
 * enough to omit" case here the way there is for complete coverage: with two
 * sources in play, an uncaptioned curve is a curve whose cadence the reader has
 * to guess, and guessing wrong is the whole failure this component prevents.
 */
export function Herkomstregel({ herkomst }: { herkomst: Herkomst | null }): JSX.Element | null {
  if (!herkomst) return null;
  const luid = dringend(herkomst);
  return (
    <p
      className={`text-xs leading-relaxed ${luid ? "text-gold-400" : "text-ink-500"}`}
      data-bron={herkomst.bron}
    >
      <span className="font-medium">{NAAM[herkomst.veld]}:</span> {herkomst.zin}
    </p>
  );
}

/**
 * The whole panel for a measure nothing measured.
 *
 * Which is a real state and not an error. Ward score has exactly one source and
 * the frames carry no vision figure of any kind, so a game nobody watched has no
 * ward curve and never will; gold has exactly one source the other way round, so
 * a game with no reachable timeline has no gold curve until League is running.
 * Both of those are permanent facts about a measure rather than something that
 * finishes loading, and the sentence has to say which of the two it is or the
 * reader comes back tomorrow to look for it.
 */
export function GeenHerkomst({
  veld,
  clientDraait,
}: {
  veld: SamenloopVeld;
  clientDraait: boolean;
}): JSX.Element {
  const reden =
    veld === "wards"
      ? "Ward score is only ever read from a game this app had open while it ran. The" +
        " match-history frames carry no vision figure of any kind, so there is nothing to" +
        " fetch for this one and there never will be."
      : clientDraait
        ? "Neither source has this for this game."
        : "Gold for all ten seats only comes from match history, and match history is only" +
          " reachable while the League client is running. Start the client and open this game" +
          " again.";
  return (
    <p className="text-xs leading-relaxed text-ink-500">
      <span className="font-medium">{NAAM[veld]}:</span> not measured. {reden}
    </p>
  );
}
