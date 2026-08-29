/**
 * Which minute it went worse, on screen.
 *
 * The timeline under this panel draws the game and lets you go looking. This one
 * does the looking: it names the stretch you came off worst in, says how far
 * behind you fell and what was going on while it happened, and then does the
 * same for the stretch that went your way.
 *
 * Everything on it comes out of shared/omslag.ts, and that split is deliberate.
 * The rule that decides what counts as a bad stretch is arithmetic and belongs
 * somewhere it can be read and argued with; this file only lays out what that
 * rule found. Nothing here computes a figure of its own, so there is no way for
 * the screen and the rule to end up saying different things.
 *
 * It draws nothing at all for a game that cannot answer the question -- which is
 * almost every game, because the readings only exist for the handful this app
 * was running during. An empty frame promising an analysis that will never
 * arrive is worse than silence.
 */
import {
  DREMPEL_MINUTEN, klokTekst, MINIMAAL_SECONDEN,
  type Omslag, type OmslagFeit, type OmslagVenster,
} from "../../../shared/omslag";
import type { ChampionSummary, OpnameRecord } from "../../../shared/types";
import { ChampionIcon, Panel, SectionTitle } from "../ui";

/** Whole numbers. A CS is a countable thing and gold is quoted whole. */
const heel = (n: number): string => String(Math.round(n));

/** One decimal, which is as much as a rate per minute can honestly carry. */
const tempo = (n: number): string => n.toFixed(1);

/**
 * The stretch drawn against the length of the game.
 *
 * A bar rather than a second chart. The timeline directly below already plots
 * this game once, and drawing it twice at two different scales would invite the
 * reader to compare two pictures that are not comparable. All this has to do is
 * say where on the clock the sentence above it is talking about.
 */
function Strook({
  venster,
  duur,
}: {
  venster: OmslagVenster;
  duur: number;
}): JSX.Element {
  const deel = (t: number): number => (duur > 0 ? Math.min(100, Math.max(0, (t / duur) * 100)) : 0);
  const links = deel(venster.van);
  const breedte = Math.max(0.8, deel(venster.tot) - links);

  return (
    <div className="omslag-strook" aria-hidden="true">
      <span
        className={`omslag-strook-vlak ${venster.richting === "achter" ? "omslag-achter" : "omslag-voor"}`}
        style={{ left: `${links}%`, width: `${breedte}%` }}
      />
    </div>
  );
}

/** One finding: the sentence, where it sits on the clock, and what backs it. */
function Venster({
  venster,
  duur,
  champion,
}: {
  venster: OmslagVenster;
  duur: number;
  /** The opponent's champion, when this finding is measured against a person. */
  champion?: ChampionSummary;
}): JSX.Element {
  const achter = venster.richting === "achter";
  const eenheid = venster.eenheid;

  return (
    <div className={`omslag-venster ${achter ? "omslag-venster-achter" : "omslag-venster-voor"}`}>
      <div className="omslag-kop">
        <span className={`omslag-merk ${achter ? "omslag-achter" : "omslag-voor"}`}>
          {achter ? "Worst stretch" : "Best stretch"}
        </span>
        <span className="num omslag-klok">
          {klokTekst(venster.van)} &ndash; {klokTekst(venster.tot)}
        </span>
        <span className="omslag-tegen">
          {venster.soort === "cs-tegenstander" ? (
            <>
              against <ChampionIcon iconPath={champion?.iconPath} name={venster.ijkNaam} size={18} />
              <span>{champion?.name ?? venster.ijkNaam}</span>
            </>
          ) : (
            <>against what this champion normally does here</>
          )}
        </span>
      </div>

      <p className="omslag-zin">{venster.zin}</p>

      <Strook venster={venster} duur={duur} />

      {/* The two rates the finding is the difference between, and the bar it had
          to clear. A sentence that says "you fell 23 CS behind" is worth exactly
          as much as the reader's ability to see where the 23 came from. */}
      <p className="omslag-cijfers">
        <span className="num">
          you {tempo(venster.jouwTempo)} {eenheid === "CS" ? "CS" : "gold"}/min
        </span>
        <span className="omslag-punt">&middot;</span>
        <span className="num">
          {venster.soort === "cs-tegenstander" ? (champion?.name ?? venster.ijkNaam) : "normal"}{" "}
          {tempo(venster.ijkTempo)} {eenheid === "CS" ? "CS" : "gold"}/min
        </span>
        <span className="omslag-punt">&middot;</span>
        <span className="num">
          {heel(venster.verschil)} over {klokTekst(venster.tot - venster.van)}, against a bar of{" "}
          {heel(venster.drempel)}
        </span>
      </p>

      {venster.feiten.length > 1 ? (
        <ul className="omslag-feiten">
          {/* The first fact is already in the sentence above. Repeating it here
              would read as two separate observations that happen to agree. */}
          {venster.feiten.slice(1).map((feit: OmslagFeit, i) => (
            <li key={i} className={`omslag-feit omslag-feit-${feit.soort}`}>
              {feit.at !== null ? <span className="num omslag-feit-tijd">{klokTekst(feit.at)}</span> : null}
              <span>{feit.tekst}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The rule, written out, so the finding can be checked rather than believed. */
function Rekenwerk({ omslag }: { omslag: Omslag }): JSX.Element {
  return (
    <details className="omslag-rekenwerk">
      <summary>How this was worked out</summary>
      <ul>
        <li>
          <span className="num">{omslag.metingen}</span> readings of all ten scorelines, about one
          every <span className="num">{omslag.intervalSeconden}s</span>, covering{" "}
          <span className="num">
            {klokTekst(omslag.dekking.van)} to {klokTekst(omslag.dekking.tot)}
          </span>{" "}
          &mdash; the first reading you appear in to the last. Taken while the game was running;
          nothing rebuilt them afterwards.
        </li>
        <li>
          Every contiguous stretch of at least{" "}
          <span className="num">{klokTekst(MINIMAAL_SECONDEN)}</span> was considered, and the one
          that lost the most was kept. No window length was chosen in advance, which is why the
          stretch above starts and ends where it does rather than on a round number.
        </li>
        <li>
          A minute only counts against you while you are running at under{" "}
          <span className="num">half</span> your normal output. Without that charge the arithmetic
          rewards length over depth and answers with the whole game: measured on a curve with a
          planted three-minute stall in it, it returned <span className="num">0:00&ndash;44:15</span>{" "}
          instead of the stall.
        </li>
        <li>
          A stretch is only reported when it is worth more than{" "}
          <span className="num">{DREMPEL_MINUTEN} minutes</span> of what this champion normally
          produces in this lane &mdash; <span className="num">{heel(omslag.ijk.csPerMin * DREMPEL_MINUTEN)} CS</span>{" "}
          or <span className="num">{heel(omslag.ijk.goldPerMin * DREMPEL_MINUTEN)} gold</span>. Measured
          against your own norm rather than a fixed figure, because ten CS is two minutes of farming
          for a top laner and ten minutes of it for a support.
        </li>
        <li>
          That norm comes from <span className="num">{omslag.ijk.games}</span> recorded games of this
          champion{omslag.ijk.bron === "lane" ? " in this lane" : ", with its lanes pooled"} &mdash;
          the same averages the badge above is scored on.
        </li>
        <li>
          The gold figure is what you were seen to spend on items plus what was in your pocket at the
          reading. Not exactly gold earned: an item sold hands back gold that was never counted going
          out. Both of those are a constant offset, and everything above is a difference between two
          readings, where a constant offset cancels &mdash; so it can measure a stretch and should
          not be quoted as a total.
        </li>
      </ul>
    </details>
  );
}

/**
 * The panel, or nothing.
 *
 * Nothing is the ordinary answer, and for four different reasons that all come
 * back as one: no recording, no readings in it, no seat that was at the
 * keyboard, or no norm yet for the champion. None of those are worth a sentence
 * on screen -- the paragraph under the timeline already explains why a game the
 * crawler found has no curve at all.
 *
 * Takes the finding rather than working it out, because the chart below this
 * panel and the lane strip inside that chart both shade the same stretch, and
 * they have to be shading the stretch this panel is talking about. Three
 * components each running their own search is three answers to the one question
 * the owner actually asked, which is worse than not answering it: a reader who
 * is told the game turned at 22:00 in words, and shown a band over 14:00, has
 * learned that the app does not know.
 */
export function OmslagPaneel({
  omslag,
  opname,
  champions,
}: {
  omslag: Omslag | null;
  opname: OpnameRecord | null;
  champions: Map<number, ChampionSummary>;
}): JSX.Element | null {
  if (!omslag || !opname) return null;

  const duur = Math.max(1, opname.gameLengthSeconds);
  const championVan = (venster: OmslagVenster): ChampionSummary | undefined => {
    if (venster.soort !== "cs-tegenstander" || omslag.tegenstander === null) return undefined;
    const id = opname.spelers[omslag.tegenstander]?.championId;
    return id === null || id === undefined ? undefined : champions.get(id);
  };

  return (
    <div className="space-y-3">
      <SectionTitle
        hint={
          <span className="num">
            {omslag.metingen} readings, every {omslag.intervalSeconden}s
          </span>
        }
      >
        Which minute it went worse
      </SectionTitle>

      <Panel className="omslag">
        {omslag.geenReden ? <p className="omslag-niets">{omslag.geenReden}</p> : null}

        {omslag.ergste ? (
          <Venster venster={omslag.ergste} duur={duur} champion={championVan(omslag.ergste)} />
        ) : null}
        {omslag.beste ? (
          <Venster venster={omslag.beste} duur={duur} champion={championVan(omslag.beste)} />
        ) : null}

        {/* The same game read against the other yardstick. Kept behind a fold
            because two findings is an answer and five is a list to search
            through, which is the thing this panel exists instead of. */}
        {omslag.overig.length > 0 ? (
          <details className="omslag-overig">
            <summary>
              {omslag.overig.length} more {omslag.overig.length === 1 ? "stretch" : "stretches"} cleared
              the same bar
            </summary>
            <ul>
              {omslag.overig.map((venster, i) => (
                <li key={i}>
                  <span className={`num omslag-klok ${venster.richting === "achter" ? "omslag-achter" : "omslag-voor"}`}>
                    {klokTekst(venster.van)}&ndash;{klokTekst(venster.tot)}
                  </span>
                  <span>{venster.zin}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <Rekenwerk omslag={omslag} />
      </Panel>
    </div>
  );
}
