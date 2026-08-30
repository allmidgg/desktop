/**
 * You against the man you were standing next to.
 *
 * ── Why this is a separate scope and not another chart ───────────────────────
 *
 * The chart above this one is ten players in two teams, and it answers "did we
 * win the game". That is a fact about nine other people. The question actually
 * asked -- which minute did it go worse, what was I doing wrong -- is a question
 * about one player, and the only fair thing to hold one player against is the
 * one player who had the same job on the other side.
 *
 * So this draws no clock of its own. It is handed the parent's xVan, its
 * scrubber second and its setter, which means there is exactly one time axis on
 * the screen and no way for two of them to drift apart. Everything here is
 * plotted into the parent's coordinate space and lines up, column for column,
 * with the purchases and the events already drawn against it.
 *
 * ── Why CS is the default and not kills ──────────────────────────────────────
 *
 * Only one of the six sampled numbers moves often enough to have a shape.
 * Measured over all 126,287 non-bot games in data/matches.jsonl, the median
 * laner farms 5.78 creeps a minute in top, 5.43 in bottom, 5.34 in middle and
 * 4.59 in the jungle -- one creep every ten to thirteen seconds, so at the
 * sampler's cadence the creep score changes on almost every reading. A level
 * changes seventeen times in a whole game. Kills and levels can say a lane was
 * lost; only the creep score can say when it started, and when is the question.
 *
 * A support farms 0.78 a minute, which is why the measure switch matters rather
 * than being a nicety: on that seat the creep curve is a flat line with the
 * occasional step, and kills or vision is the one worth reading instead.
 *
 * ── What is not here ─────────────────────────────────────────────────────────
 *
 * No composite. Mixing creeps, kills and levels into one "who is ahead" figure
 * needs weights, nothing measured in this repository supplies them, and a dip in
 * a number nobody can decompose is a dip nobody can learn anything from. One
 * measured quantity at a time, in its own unit, named on screen.
 */
import { useMemo, useState } from "react";
import { duelVan, puntOp, voorsprongVan, type Kromme, type Punt } from "../../../shared/meting";
import {
  banenVan, duelUitBanen, ijkpuntVan,
  BESLISSEND_VERSCHIL, IJKMINUTEN, LAANNORM_15, NIETSZEGGEND_VERSCHIL,
  type Laanmeting,
} from "../../../shared/matchtijdlijn";
// One curve, and underneath it where the curve came from. Every measure on this
// strip now comes out of the same merge, so the switch below changes the source
// as well as the units -- creep score off a frame once a minute, kills off a
// poll every ten seconds -- and the caption is not a nicety here, it is what
// stops the coarser line being read as the steadier player.
import { krommeVoor, type Samenloop, type SamenloopVeld } from "../../../shared/samenloop";
import type { OmslagVenster } from "../../../shared/omslag";
import type { ChampionSummary, Position } from "../../../shared/types";
import { ChampionIcon, PositionIcon } from "../ui";
import { GeenHerkomst, Herkomstregel } from "./Herkomstregel";

const klok = (s: number): string =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

/** The minimum the strip needs to say anything: one seat, a side, and a lane. */
export interface Duelspoor {
  championId: number | null;
  championName: string;
  team: "ORDER" | "CHAOS" | "UNKNOWN";
  position: Position | null;
  isYou: boolean;
}

/* ── Geometry ────────────────────────────────────────────────────────────────
   Its own height, the parent's width. The x mapping arrives as a function so
   this strip cannot disagree with the chart above it about where 14:02 is --
   which is the entire reason a second time axis was not drawn. */
const H = 96;
/** The lead sits under the two lines, against its own zero. */
const STRIP_H = 34;
const PAD_BOVEN = 10;
const PAD_ONDER = 8;
const GRAF_H = H - PAD_BOVEN - PAD_ONDER;

/**
 * The five measures the axis can carry, in the order they are offered.
 *
 * Which of them a given game can actually show is not written here. It is read
 * off `Samenloop.herkomst`, which is null for a measure neither source carried a
 * single reading of -- so gold disappears when there is no timeline, vision
 * disappears when there is no recording, and neither of those is a rule this
 * file has to keep in step with the merge.
 *
 * Gold leads because it is the only quantity here that is a score rather than a
 * count, and the only one both sides are always earning. It also could not exist
 * until the timeline did: the Live Client Data API reports gold for the seat at
 * the keyboard and for nobody else, and even that is gold in hand -- a wallet
 * that drops every time somebody shops -- while the frames carry gold earned for
 * all ten.
 */
interface Grootheid {
  veld: SamenloopVeld;
  naam: string;
  /** Singular unit for the sentence, so "14 CS" and "2 levels" both read. */
  eenheid: (n: number) => string;
}

const GROOTHEDEN: readonly Grootheid[] = [
  {
    veld: "gold",
    naam: "Gold",
    // Rounded to ten, because the fourth digit of a gold total is passing
    // ambient income and reads as precision the comparison does not have.
    eenheid: (n) => `${Math.round(n / 10) * 10} gold`,
  },
  { veld: "cs", naam: "CS", eenheid: (n) => `${n} CS` },
  { veld: "kills", naam: "Kills", eenheid: (n) => `${n} ${n === 1 ? "kill" : "kills"}` },
  { veld: "level", naam: "Level", eenheid: (n) => `${n} ${n === 1 ? "level" : "levels"}` },
  { veld: "wards", naam: "Vision", eenheid: (n) => `${n} ward score` },
];

/** Thousands on the axis for gold, plain counts for everything that is a count. */
const asWaarde = (veld: SamenloopVeld, waarde: number): string =>
  veld === "gold" ? `${(waarde / 1000).toFixed(1)}k` : String(Math.round(waarde));

const klokMinuut = (m: number): string => `${m}:00`;

/**
 * Why a measure has no curve, for the button that cannot be pressed.
 *
 * Two of the five can genuinely be absent and they are absent for opposite
 * reasons. Ward score exists only in a recording, because the match-history
 * frames carry no vision figure of any kind -- that is permanent for a game
 * nobody watched. Gold exists only in the frames, because a running game reports
 * a wallet for the seat at the keyboard and for nobody else -- that is fixable
 * by starting the client. Saying "no data" for both would make one of them look
 * broken and the other look hopeless.
 */
const redenGeen = (veld: SamenloopVeld, heeftHistorie: boolean): string =>
  veld === "wards"
    ? "Only a game this app had open while it ran has a ward score. The match-history frames carry no vision figure of any kind."
    : veld === "gold" && !heeftHistorie
      ? "Total gold for all ten seats comes from match history, which needs the League client running. Start it and open this game again."
      : "Neither source carried a reading of this for this game.";

/**
 * A step path, not a smoothed one, for the same reason the chart above uses one.
 *
 * A reading is a value that was true at the second it was taken. What the number
 * did between two readings was not observed, and sloping across the gap draws a
 * measurement nobody made.
 */
function stapPad(punten: Punt[], lees: (p: Punt) => number, xVan: (t: number) => number, max: number, eind: number): string {
  if (punten.length === 0) return "";
  const y = (w: number): number => PAD_BOVEN + GRAF_H - (max > 0 ? Math.min(1, w / max) : 0) * GRAF_H;
  const deel: string[] = [];
  punten.forEach((p, i) => {
    const x = xVan(p.t);
    if (i === 0) deel.push(`M ${x.toFixed(1)} ${y(lees(p)).toFixed(1)}`);
    else deel.push(`H ${x.toFixed(1)}`, `V ${y(lees(p)).toFixed(1)}`);
  });
  deel.push(`H ${xVan(eind).toFixed(1)}`);
  return deel.join(" ");
}

/** The lead as a closed area against its own zero, in the strip's own scale. */
function voorsprongPad(
  punten: Punt[],
  kant: "ORDER" | "CHAOS",
  xVan: (t: number) => number,
  maxVoorsprong: number,
  links: number,
  eind: number,
): string {
  if (punten.length === 0) return "";
  const midden = STRIP_H / 2;
  const y = (v: number): number =>
    midden - (maxVoorsprong > 0 ? Math.max(-1, Math.min(1, v / maxVoorsprong)) : 0) * (midden - 4);

  const deel: string[] = [`M ${links.toFixed(1)} ${midden.toFixed(1)}`];
  for (const p of punten) deel.push(`H ${xVan(p.t).toFixed(1)}`, `V ${y(voorsprongVan(p, kant)).toFixed(1)}`);
  deel.push(`H ${xVan(eind).toFixed(1)}`, `V ${midden.toFixed(1)}`, "Z");
  return deel.join(" ");
}

export function Duelkromme({
  sporen,
  bron,
  laanmetingen,
  duur,
  moment,
  zetMoment,
  zweef,
  champions,
  xVan,
  links,
  rechts,
  breedte,
  /** Which seat the duel is drawn around. The player at the keyboard unless one is picked. */
  anker,
  venster,
}: {
  sporen: Duelspoor[];
  /**
   * Both sources laid on one clock, each measure taken from whichever owns it.
   *
   * One curve and one seat order. This used to take the recording's `verloop`
   * and the timeline separately and pick between them at each call site, which
   * meant a crawled game -- 130,067 of the 130,086 -- drew a blank creep-score
   * curve while the frames holding that very number sat one prop away. See
   * shared/samenloop.ts for the table of who owns what and why.
   */
  bron: Samenloop;
  /**
   * Where each seat actually stood, in the same seat order as `bron`.
   *
   * Null per seat when the timeline had nothing for it, and null altogether when
   * there is no timeline -- in which case the pairing falls back to the stored
   * position label and the caption says so.
   */
  laanmetingen: Array<Laanmeting | null> | null;
  duur: number;
  moment: number;
  /** Pin a second. Only a deliberate act calls this: a click, a key. */
  zetMoment: (t: number) => void;
  /** Point at a second, or at nothing when the pointer leaves. Never pins. */
  zweef: (t: number | null) => void;
  champions: Map<number, ChampionSummary>;
  xVan: (t: number) => number;
  links: number;
  rechts: number;
  breedte: number;
  anker: number | null;
  /**
   * The stretch the panel above the chart named, shaded here too.
   *
   * This strip used to run its own search over its own two seats, which is how
   * one game ended up with three worst minutes on one screen: the team chart
   * found one, this strip found another, and the sentence at the top of the page
   * named a third. They were all defensible and no two agreed, which makes the
   * screen useless for the one question it exists to answer. One search now,
   * upstream, against the champion's own norm; this draws where it landed.
   */
  venster: OmslagVenster | null;
}): JSX.Element | null {
  // A measure is offered when something actually measured it. `herkomst` is
  // filled in per measure by the merge and left null where neither source
  // carried a single reading, so this is the measurement itself deciding what
  // the buttons say rather than a guess about which source is present.
  const beschikbaar = GROOTHEDEN.filter((g) => bron.herkomst[g.veld] !== null);
  const heeftHistorie = Boolean(bron.herkomst.gold);
  // Gold when it exists, because it is the one quantity here that is a score
  // rather than a count and the only one both sides are always earning. CS
  // stays the fallback for the reason this file already argues: it is the one
  // sampled number that moves often enough to have a shape.
  const [gekozenVeld, zetVeld] = useState<SamenloopVeld>("gold");
  const veld: SamenloopVeld =
    beschikbaar.find((g) => g.veld === gekozenVeld)?.veld ?? beschikbaar[0]?.veld ?? "cs";

  const zitplaats = anker ?? sporen.findIndex((s) => s.isYou);

  /**
   * Who was standing opposite, measured first and labelled second.
   *
   * The stored position is a bad answer often enough that it cannot be the only
   * one: counted over all 126,278 non-bot games, only 28.91% carry five
   * distinct lanes on both sides and 57.97% put two players on one side under a
   * single label, where duelVan takes whichever it meets first and says
   * nothing. Placing seats by where they actually stood took the same figure to
   * 94.2% on 120 sampled games. So the timeline answers when it is here, the
   * label answers when it is not, and `gemetenDuel` says which happened so the
   * caption underneath can too.
   */
  const banen = useMemo(
    () =>
      laanmetingen
        ? banenVan(laanmetingen, sporen.map((s) => s.team))
        : null,
    [laanmetingen, sporen],
  );
  const gemetenDuel = useMemo(
    () => (banen === null || zitplaats < 0 ? null : duelUitBanen(banen, sporen.map((s) => s.team), zitplaats)),
    [banen, sporen, zitplaats],
  );
  const duel = useMemo(
    () => gemetenDuel ?? (zitplaats < 0 ? null : duelVan(sporen, zitplaats)),
    [gemetenDuel, sporen, zitplaats],
  );

  // One call for all five measures, gold included. The merge already decided
  // which source owns each of them and put them on one clock, so there is no
  // branch here to disagree with the caption underneath.
  const kromme = useMemo<Kromme | null>(
    () => (duel === null ? null : krommeVoor(bron, [duel.orde], [duel.chaos], veld)),
    [bron, duel, veld],
  );

  /**
   * The two checkpoints, for the whole game rather than for this lane.
   *
   * Printed as numbers with a weight and never as a verdict, because the
   * measurement behind them will not carry one. Over 120 sampled games the side
   * ahead at fifteen won 75.2% -- but split by width, a lead of two thousand or
   * more won 89.3% (n=75) while a lead under a thousand won 53.3% (n=30), which
   * is a coin. A badge reading "ahead at 15" over a 700-gold lead would be a
   * confident statement about nothing.
   */
  const ijkpunten = useMemo(
    () =>
      IJKMINUTEN.map((m) =>
        ijkpuntVan(
          bron.verloop?.tijden,
          bron.goudPerStoel,
          sporen.flatMap((s, i) => (s.team === "ORDER" ? [i] : [])),
          sporen.flatMap((s, i) => (s.team === "CHAOS" ? [i] : [])),
          m,
        ),
      ),
    [bron, sporen],
  );

  // Whose side the lead is signed from: the anchor's, so "behind" always means
  // behind for the person this strip was drawn for.
  const kant = zitplaats >= 0 ? sporen[zitplaats]?.team : undefined;
  const mijnKant: "ORDER" | "CHAOS" = kant === "CHAOS" ? "CHAOS" : "ORDER";

  const grootheid = beschikbaar.find((g) => g.veld === veld) ?? beschikbaar[0]!;

  /**
   * The three paths, built once per curve rather than once per mouse move.
   *
   * The scrubber changes on every pixel the cursor travels, and every one of
   * those is a re-render. Rebuilding a step path there means walking the whole
   * reading list three times to produce strings that did not change. The median
   * of the 130,197 games in matches.jsonl runs 1,807 seconds, which is 181
   * readings at the sampler's ten-second cadence and 31 at the one-frame-a-minute
   * cadence the match-history timeline answers on, so it is small either way --
   * but it is also exactly the work a memo exists to skip.
   */
  const paden = useMemo(() => {
    if (!kromme || kromme.punten.length === 0) return null;
    const eind = Math.max(duur, kromme.punten[kromme.punten.length - 1]?.t ?? duur);
    return {
      eind,
      chaos: stapPad(kromme.punten, (p) => p.chaos, xVan, kromme.max, eind),
      orde: stapPad(kromme.punten, (p) => p.orde, xVan, kromme.max, eind),
      voorsprong: voorsprongPad(kromme.punten, mijnKant, xVan, kromme.maxVoorsprong, links, eind),
    };
  }, [kromme, mijnKant, xVan, links, duur]);

  // ── The cases where there is nothing honest to draw ────────────────────────
  // Each one says which it is. A blank frame under a heading promising a
  // comparison is worse than a sentence explaining that the comparison cannot
  // be made, because the reader cannot tell a missing feature from a broken one.
  if (zitplaats < 0) {
    return (
      <p className="duel-leeg">
        Nothing in this recording says which seat was yours, so there is no lane to compare. Only
        the player at the keyboard leaves a mark &mdash; the client reveals nobody else&rsquo;s
        abilities, so the skill order is the marker, and this recording has none.
      </p>
    );
  }
  // Only when neither source has anything. A crawled game has no recording at
  // all and used to stop here; it now has a match-history timeline, which is
  // the whole point, so the sentence may only be printed when that is missing
  // too.
  //
  // It used to open with "Nobody was watching it", and that was a claim this
  // component is in no position to make. Seen on screen during a live game: the
  // sentence sat directly under a chart that was drawing, beside a count reading
  // READINGS 11, telling the reader nobody was watching a game the app was
  // watching at that moment. What is actually known here is that neither source
  // filled a single measure, not why -- so the text now says that, and stops.
  if (beschikbaar.length === 0) {
    return (
      <p className="duel-leeg">
        Nothing along the clock for this game yet &mdash; neither a recording of it nor a
        match-history timeline. The timeline needs the League client running, so if it is closed,
        opening it and coming back here is enough.
      </p>
    );
  }
  if (duel === null) {
    const mij = sporen[zitplaats];
    const gemetenBaan = banen?.[zitplaats];
    // Three different silences, and they are not interchangeable. With a
    // timeline in hand the lane was measured, so "no opponent" means two of
    // them shared it -- a lane swap, a bot lane that never split -- and that is
    // a fact about the game rather than a gap in the record.
    return (
      <p className="duel-leeg">
        {gemetenBaan && gemetenBaan !== "UNKNOWN"
          ? `You were measured in ${gemetenBaan.toLowerCase()}, but two players on the other side spent the laning phase there, so there is no single opposite number. Picking one of them would be a guess.`
          : mij?.position
            ? `Nobody on the other side was recorded in ${mij.position.toLowerCase()}, so there is no opposite number to hold you against.`
            : "Nothing here says who was standing opposite you. Guessing would put a jungler's creep score against a support's and call it a lane."}
      </p>
    );
  }
  if (!kromme || paden === null || kromme.punten.length < 2) {
    return (
      <p className="duel-leeg">
        Only {kromme?.punten.length ?? 0} readings cover both of you, which is not a curve.
        {veld === "gold"
          ? " Match history serves one frame a minute, so a game that ended inside two minutes has nothing to draw."
          : " The sampler starts when the app starts watching, so a game joined in progress has no measured opening."}
      </p>
    );
  }

  const mij = sporen[zitplaats]!;
  const hij = sporen[mijnKant === "ORDER" ? duel.chaos : duel.orde]!;
  const mijnSeat = mijnKant === "ORDER" ? duel.orde : duel.chaos;
  const nu = puntOp(kromme.punten, moment);
  const voorsprong = voorsprongVan(nu, mijnKant);
  const mijnWaarde = mijnKant === "ORDER" ? nu.orde : nu.chaos;
  const zijnWaarde = mijnKant === "ORDER" ? nu.chaos : nu.orde;

  const x = xVan(moment);

  return (
    <div className="duel">
      <div className="duel-kop">
        <span className="duel-paar">
          <ChampionIcon
            iconPath={mij.championId === null ? undefined : champions.get(mij.championId)?.iconPath}
            name={mij.championName}
            size={22}
          />
          <span className={mijnKant === "ORDER" ? "tijdlijn-blauw" : "tijdlijn-rood"}>
            {mij.championName}
          </span>
          <span className="duel-tegen">vs</span>
          <ChampionIcon
            iconPath={hij.championId === null ? undefined : champions.get(hij.championId)?.iconPath}
            name={hij.championName}
            size={22}
          />
          <span className={mijnKant === "ORDER" ? "tijdlijn-rood" : "tijdlijn-blauw"}>
            {hij.championName}
          </span>
          {mij.position ? (
            <span className="duel-lane">
              <PositionIcon position={mij.position} size={12} />
            </span>
          ) : null}
        </span>

        {/* One measured quantity at a time. The buttons are a switch and not a
            filter: nothing is hidden by picking one, the axis simply changes
            unit, which is why they are worded as nouns and not as toggles.

            A measure nothing measured is shown greyed rather than dropped. Two
            of the five are absent for reasons the reader can act on or needs to
            know -- gold needs the League client running, ward score exists only
            for a game this app watched -- and a button that silently vanishes
            teaches him the app cannot do it at all. */}
        <span className="duel-maten" role="group" aria-label="What the axis measures">
          {GROOTHEDEN.map((g) => (
            <button
              key={g.veld}
              type="button"
              onClick={() => zetVeld(g.veld)}
              disabled={!bron.herkomst[g.veld]}
              aria-pressed={g.veld === veld}
              className={`duel-maat ${g.veld === veld ? "duel-maat-aan" : ""}`}
              // The one thing a reader has to know before believing a line:
              // which of the two sources it came off, and how often it looked.
              // They have different cadences and different blind spots, and a
              // button that hid that would let a once-a-minute curve be read as
              // a ten-second one. Taken from the merge rather than from a
              // constant on the button, because which source wins a measure is
              // decided per game by what each of them turned out to carry.
              //
              // Both halves here, unlike the caption under the chart. A tooltip
              // is already a fold -- nobody reads it who did not ask for it --
              // so it is the one place the reasoning costs the reader nothing.
              title={
                bron.herkomst[g.veld]
                  ? [bron.herkomst[g.veld]?.zin, bron.herkomst[g.veld]?.nuance]
                      .filter((s) => s)
                      .join(" ")
                  : redenGeen(g.veld, heeftHistorie)
              }
            >
              {g.naam}
            </button>
          ))}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${breedte} ${H + STRIP_H}`}
        className="duel-strip"
        role="img"
        aria-label={`${grootheid.naam} for ${mij.championName} against ${hij.championName}, over the game`}
        // A hover shows a second and lasts as long as the hover. It used to pin
        // one, and nothing put it back, so a pointer crossing this strip on its
        // way down the page left every row below reading a second nobody chose.
        onMouseMove={(e) => {
          const kader = e.currentTarget.getBoundingClientRect();
          if (kader.width <= 0) return;
          // Undo the viewBox scaling by hand rather than trusting a CTM: the svg
          // is width-100% and the browser has already scaled it. Same method the
          // chart above uses, so both land the scrubber on the same second.
          const inStrip = ((e.clientX - kader.left) / kader.width) * breedte;
          const deel = (inStrip - links) / (breedte - links - rechts);
          zweef(Math.round(Math.min(1, Math.max(0, deel)) * duur));
        }}
        onMouseLeave={() => zweef(null)}
      >
        {/* The stretch that went worst, as a band rather than a marker. It has a
            width because it happened over time, and drawing it as a single line
            would put a moment where a minute belongs. The same band, over the
            same seconds, as the one on the chart above -- both are given it. */}
        {venster ? (
          <rect
            x={xVan(venster.van)}
            y={0}
            width={Math.max(1, xVan(venster.tot) - xVan(venster.van))}
            height={H + STRIP_H}
            className="duel-val"
            onClick={() => zetMoment(venster.tot)}
          >
            <title>{`${klok(venster.van)}–${klok(venster.tot)} — the stretch named above the chart`}</title>
          </rect>
        ) : null}

        {[0, 0.5, 1].map((deel) => {
          const y = PAD_BOVEN + GRAF_H - deel * GRAF_H;
          return (
            <g key={deel}>
              <line
                x1={links}
                x2={breedte - rechts}
                y1={y}
                y2={y}
                className="tijdlijn-raster"
                vectorEffect="non-scaling-stroke"
              />
              <text x={links - 6} y={y + 3.5} textAnchor="end" className="tijdlijn-aslabel">
                {asWaarde(veld, kromme.max * deel)}
              </text>
            </g>
          );
        })}

        {/* Sides keep the colours they have everywhere else in this panel, and
            gold stays reserved for the scrubber and the read-out. Which line is
            yours is said by the dot on it and by the words underneath, not by a
            third colour competing with the two that already mean something. */}
        <path
          d={paden.chaos}
          className="tijdlijn-lijn tijdlijn-chaos"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={paden.orde}
          className="tijdlijn-lijn tijdlijn-orde"
          vectorEffect="non-scaling-stroke"
        />

        <g transform={`translate(0 ${H})`}>
          <line
            x1={links}
            x2={breedte - rechts}
            y1={STRIP_H / 2}
            y2={STRIP_H / 2}
            className="tijdlijn-raster"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={paden.voorsprong}
            className={voorsprong >= 0 ? "duel-voor" : "duel-achter"}
          />
        </g>

        <line
          x1={x}
          x2={x}
          y1={0}
          y2={H + STRIP_H}
          className="tijdlijn-scrubber"
          vectorEffect="non-scaling-stroke"
        />
        {/* The gold dot is on your line only. It is the accent doing the one job
            the accent is for: saying which of these two is the reader. */}
        <circle
          cx={x}
          cy={
            PAD_BOVEN +
            GRAF_H -
            (kromme.max > 0 ? Math.min(1, mijnWaarde / kromme.max) : 0) * GRAF_H
          }
          r={3.5}
          className="duel-jij"
        />
      </svg>

      <div className="duel-afleeslat">
        <span className="num tijdlijn-klok">{klok(moment)}</span>
        <span className="num">{asWaarde(veld, mijnWaarde)}</span>
        <span className="tijdlijn-scheiding">{grootheid.naam} against</span>
        <span className="num">{asWaarde(veld, zijnWaarde)}</span>
        <span className={`num ml-auto ${voorsprong >= 0 ? "duel-woord-voor" : "duel-woord-achter"}`}>
          {voorsprong === 0
            ? "level"
            : `${grootheid.eenheid(Math.abs(Math.round(voorsprong)))} ${voorsprong > 0 ? "ahead" : "behind"}`}
        </span>
      </div>

      {/* Where the line above came from, in the same place the line is. The
          measure switch changes the source underneath it, so this sentence and
          that curve can never drift apart. */}
      <Herkomstregel herkomst={bron.herkomst[veld]} />

      {/* And when the headline measure of this whole panel is the one that is
          missing, why. Gold earned for all ten seats is what match history added
          and what nothing else in the app can supply, so its absence is worth a
          sentence rather than a greyed button the reader has to hover. */}
      {bron.herkomst.gold ? null : <GeenHerkomst veld="gold" clientDraait={false} />}

      {/* ── The two checkpoints ────────────────────────────────────────────
          The whole game rather than this lane, which is why they sit under the
          strip and not in its read-out. Printed with a weight and never with a
          verdict: the sign of a lead this size is worth roughly a coin toss and
          the width is what carries the signal, so the screen shows both and
          lets the reader do the arithmetic that the sample size will support. */}
      {heeftHistorie ? (
        <div className="duel-ijkpunten">
          {ijkpunten.map((punt) => {
            const vanMij = mijnKant === "ORDER" ? punt.verschil : -punt.verschil;
            return (
              <button
                key={punt.minuut}
                type="button"
                className={`duel-ijkpunt duel-ijkpunt-${punt.gewicht}`}
                disabled={!punt.bereikt}
                onClick={() => zetMoment(punt.minuut * 60)}
                title={
                  punt.bereikt
                    ? punt.gewicht === "geen"
                      ? `Under ${NIETSZEGGEND_VERSCHIL} gold. Over 120 sampled games a lead this narrow at fifteen minutes went on to win 53% of the time, which is a coin toss.`
                      : punt.gewicht === "breed"
                        ? `${BESLISSEND_VERSCHIL} gold or more. The side holding one at this point won 89% of the sampled games.`
                        : `Between ${NIETSZEGGEND_VERSCHIL} and ${BESLISSEND_VERSCHIL} gold, which the sample is too small to say much about either way.`
                    : "The game ended before this minute."
                }
              >
                <span className="duel-ijkpunt-klok num">{klokMinuut(punt.minuut)}</span>
                {punt.bereikt ? (
                  <span className={`num ${vanMij >= 0 ? "duel-woord-voor" : "duel-woord-achter"}`}>
                    {vanMij > 0 ? "+" : vanMij < 0 ? "−" : ""}
                    {Math.abs(vanMij).toLocaleString("en")}
                  </span>
                ) : (
                  <span className="duel-ijkpunt-leeg">never reached</span>
                )}
              </button>
            );
          })}
          {/* What a lead of that size normally is, as two figures rather than as
              a clause. The buttons above are gold, your team against theirs;
              these are the middle of the measured spread at the same two
              minutes, so a reader can see at a glance whether his 900 is small.
              The sample travels with them, because 120 games is what these two
              medians stand on and a median without its sample is a rumour. */}
          <span className="duel-ijkpunt-uitleg">
            <span className="feit">
              <span className="feit-kop">Median at 10</span>
              <span className="num feit-waarde">1,562</span>
            </span>
            <span className="feit">
              <span className="feit-kop">At 15</span>
              <span className="num feit-waarde">3,167</span>
            </span>
            <span className="feit">
              <span className="feit-kop">Games</span>
              <span className="num feit-waarde">120</span>
            </span>
          </span>
        </div>
      ) : null}

      {/* ── What this strip is, in figures ────────────────────────────────
          This used to be a paragraph of five sentences under the chart, and the
          owner's answer to it was that he wanted the statistics rather than the
          essay. Every figure that was inside those sentences is now a labelled
          cell -- the lane's normal gap at fifteen, the tail of it, the sample it
          stands on, where measurement starts -- and the argument for why the
          pairing and the cadence are what they are sits one click below, word
          for word. No verdict sentence here either way: the stretch is named
          once, at the top of the page, with the deaths and objectives that were
          in it. */}
      <div className="feitenrij">
        <span className="feit">
          <span className="feit-kop">Read from</span>
          <span className="feit-waarde-stil">
            {veld === "gold" ? "match history · 1 frame/min" : "the running game"}
          </span>
        </span>
        <span className="feit">
          <span className="feit-kop">Seats</span>
          <span className="num feit-waarde">
            {mijnSeat + 1} vs {(mijnKant === "ORDER" ? duel.chaos : duel.orde) + 1}
          </span>
        </span>
        <span className="feit">
          <span className="feit-kop">Paired on</span>
          <span className="feit-waarde-stil">
            {gemetenDuel ? "where you stood, min 2-10" : "the stored lane label"}
          </span>
        </span>
        {/* The lane's own normal gap, which is the figure that tells the reader
            whether the number on the read-out above is large. Only on the gold
            axis, because that is the axis LAANNORM_15 was measured on. */}
        {(() => {
          const baan = gemetenDuel ? banen?.[zitplaats] : null;
          const norm = baan && baan !== "UNKNOWN" ? LAANNORM_15[baan] : null;
          return norm && veld === "gold" ? (
            <>
              <span className="feit">
                <span className="feit-kop">Normal gap at 15:00</span>
                <span className="num feit-waarde">{norm.goud.toLocaleString("en")}</span>
              </span>
              <span className="feit">
                <span className="feit-kop">1 pair in 10 past</span>
                <span className="num feit-waarde">{norm.goudP90.toLocaleString("en")}</span>
              </span>
              <span className="feit">
                <span className="feit-kop">Games</span>
                <span className="num feit-waarde">{norm.games}</span>
              </span>
            </>
          ) : null;
        })()}
        {/* A recording that began mid-game, which is the one fact on this row
            that changes what the curve on screen means rather than merely
            describing it. */}
        {kromme.vanaf > 0 ? (
          <span className="feit">
            <span className="feit-kop">Starts at</span>
            <span className="num feit-waarde">{klok(kromme.vanaf)}</span>
          </span>
        ) : null}
        {kromme.overgeslagen > 0 ? (
          <span className="feit">
            <span className="feit-kop">Readings missing one of you</span>
            <span className="num feit-waarde">{kromme.overgeslagen}</span>
          </span>
        ) : null}
      </div>

      <details className="uitleg-fold">
        <summary>How this strip is drawn</summary>
        <p>
          {veld === "gold"
            ? // Riot's own word for the field, not ours. It is totalGold, and totalGold
              // counts the purse a champion spawns holding, so "earned" would be a
              // claim the reading does not carry. See Teamgoudkromme below, where the
              // same series is drawn for five seats a side and the figure is stated.
              "Both lines are Riot's total gold, one frame a minute out of match history"
            : "Both lines were read off the running game"}
          , and held flat between readings because what the number did in between was not observed.
          The worst stretch is one measured lead subtracted from another a minute earlier &mdash; the
          steepest fall, which is not the same thing as the widest gap: the widest gap is usually the
          end of a game that was decided ten minutes before.
        </p>
        {gemetenDuel ? (
          <p>
            The two of you were paired on where you actually stood in minutes 2 to 10 rather than on
            the lane the match record names &mdash; those labels put two players on one lane in{" "}
            <span className="num">58%</span> of the games in this database, and pairing on them
            quietly hands back the wrong man.
          </p>
        ) : null}
        {kromme.vanaf > 0 ? (
          <p>
            Measurement starts at <span className="num">{klok(kromme.vanaf)}</span>: the app began
            watching after the game had started, and nothing fills the opening in.
          </p>
        ) : null}
        {/* Why this source and not the other, moved off the caption above. On
            creep score it carries the figure behind the choice, so it belongs
            behind a fold rather than nowhere. */}
        {bron.herkomst[veld]?.nuance ? <p>{bron.herkomst[veld]?.nuance}</p> : null}
      </details>
    </div>
  );
}

/**
 * The gold curve of both teams, and the gap between them.
 *
 * ── Why this is here and not a new file ─────────────────────────────────────
 *
 * It is the same drawing. `stapPad` and `voorsprongPad` above build the two
 * lines and the signed area, `Kromme` is the same four fields, and the x
 * mapping is the parent's, so there is exactly one time axis on the screen and
 * one implementation of a step path in the app. All that differs is the scope:
 * five seats a side instead of one. A second curve renderer for that would
 * guarantee the two drift -- different rounding, a differently floored maximum
 * -- and eventually two pictures of one game that disagree in ways nobody can
 * account for.
 *
 * ── Why it could not exist until now ────────────────────────────────────────
 *
 * The chart above this one has always had a gold axis, but it plots gold
 * *committed to items*: a reconstruction from things appearing in inventories,
 * which moves when somebody visits the shop rather than when they earn
 * anything. Tijdlijn.tsx says so itself and refuses to read it as a rate. Gold
 * earned, for all ten seats, minute by minute, exists only in the match-history
 * timeline -- the Live Client Data API reports gold for the seat at the
 * keyboard and for nobody else, and even that is gold in hand.
 *
 * So this is the first time the app can draw the one chart every competitor
 * shows, and it draws it for any game in the store rather than for the two this
 * machine happened to watch.
 */
export function Teamgoudkromme({
  bron,
  sporen,
  duur,
  moment,
  zetMoment,
  zweef,
  xVan,
  links,
  rechts,
  breedte,
  anker,
  venster,
}: {
  /** The same merge the strip below reads, so both charts share one seat order. */
  bron: Samenloop;
  sporen: Duelspoor[];
  duur: number;
  moment: number;
  /** Pin a second. Only a deliberate act calls this: a click, a key. */
  zetMoment: (t: number) => void;
  /** Point at a second, or at nothing when the pointer leaves. Never pins. */
  zweef: (t: number | null) => void;
  xVan: (t: number) => number;
  links: number;
  rechts: number;
  breedte: number;
  /** Whose side "ahead" is measured from. The player at the keyboard unless one is picked. */
  anker: number | null;
  venster: OmslagVenster | null;
}): JSX.Element | null {
  const zitplaats = anker ?? sporen.findIndex((s) => s.isYou);
  const kant = zitplaats >= 0 ? sporen[zitplaats]?.team : undefined;
  const mijnKant: "ORDER" | "CHAOS" = kant === "CHAOS" ? "CHAOS" : "ORDER";

  const ordeStoelen = useMemo(
    () => sporen.flatMap((s, i) => (s.team === "ORDER" ? [i] : [])),
    [sporen],
  );
  const chaosStoelen = useMemo(
    () => sporen.flatMap((s, i) => (s.team === "CHAOS" ? [i] : [])),
    [sporen],
  );

  const kromme = useMemo(
    () => krommeVoor(bron, ordeStoelen, chaosStoelen, "gold"),
    [bron, ordeStoelen, chaosStoelen],
  );

  const paden = useMemo(() => {
    if (kromme.punten.length === 0) return null;
    const eind = Math.max(duur, kromme.punten[kromme.punten.length - 1]?.t ?? duur);
    return {
      chaos: stapPad(kromme.punten, (p) => p.chaos, xVan, kromme.max, eind),
      orde: stapPad(kromme.punten, (p) => p.orde, xVan, kromme.max, eind),
      voorsprong: voorsprongPad(kromme.punten, mijnKant, xVan, kromme.maxVoorsprong, links, eind),
    };
  }, [kromme, mijnKant, xVan, links, duur]);

  // Silence rather than an empty frame, and the reason belongs upstream: the
  // panel that asked for the timeline knows whether the client was closed, the
  // game had none, or the request is still out, and it can name which. A
  // second, vaguer sentence here would compete with that one.
  if (paden === null || kromme.punten.length < 2) return null;

  const nu = puntOp(kromme.punten, moment);
  const voorsprong = voorsprongVan(nu, mijnKant);
  const mijnGoud = mijnKant === "ORDER" ? nu.orde : nu.chaos;
  const zijnGoud = mijnKant === "ORDER" ? nu.chaos : nu.orde;
  const x = xVan(moment);

  /**
   * What both sides are already holding at 0:00, read off the first frame.
   *
   * The series is Riot's `totalGold`, and that field counts the purse a champion
   * spawns with. Measured on every timeline this machine has fetched: frame 0
   * reads 475 on all ten seats of all four games, and it is still 475 at 1:00 --
   * it first moves at 2:00. So a five-seat side opens on 2,375 and the read-out
   * says 2.4k against 2.4k before a minion has died.
   *
   * That figure is stated rather than subtracted out. Taking it off would make
   * the curve disagree with the number the match record carries for the same
   * game, and a chart that quietly reports 2,375 less than the source it names
   * is worse than one that says where its floor comes from. It cancels out of
   * the lead band underneath either way: both sides carry the same purse.
   *
   * Null when the two sides do not open level, which no fetched game does, or
   * when the first frame is already past 0:00 -- then there is no floor to name
   * and a figure here would be an assumption rather than a reading.
   */
  const startpurse = (() => {
    const eerste = kromme.punten[0];
    if (!eerste || eerste.t > 0) return null;
    if (eerste.orde !== eerste.chaos || eerste.orde <= 0) return null;
    return eerste.orde;
  })();

  return (
    <div className="duel">
      <div className="duel-kop">
        <span className="duel-paar">
          <span className={mijnKant === "ORDER" ? "tijdlijn-blauw" : "tijdlijn-rood"}>
            {mijnKant === "ORDER" ? "Blue side" : "Red side"}
          </span>
          <span className="duel-tegen">vs</span>
          <span className={mijnKant === "ORDER" ? "tijdlijn-rood" : "tijdlijn-blauw"}>
            {mijnKant === "ORDER" ? "Red side" : "Blue side"}
          </span>
          {/* Not "earned". The series is Riot's totalGold and that field carries the
              spawn purse, so both sides open the game on 2,375 before either has
              earned anything. The figure is on the row below. */}
          <span className="duel-lane">total gold</span>
        </span>
      </div>

      <svg
        viewBox={`0 0 ${breedte} ${H + STRIP_H}`}
        className="duel-strip"
        role="img"
        aria-label="Total gold for each team, over the game"
        // A hover shows a second and lasts as long as the hover; see the strip
        // below, which had the same problem and carries the reasoning.
        onMouseMove={(e) => {
          const kader = e.currentTarget.getBoundingClientRect();
          if (kader.width <= 0) return;
          // The same hand-rolled undo of the viewBox scaling the strip below
          // uses, so both land the scrubber on the same second.
          const inStrip = ((e.clientX - kader.left) / kader.width) * breedte;
          const deel = (inStrip - links) / (breedte - links - rechts);
          zweef(Math.round(Math.min(1, Math.max(0, deel)) * duur));
        }}
        onMouseLeave={() => zweef(null)}
      >
        {venster ? (
          <rect
            x={xVan(venster.van)}
            y={0}
            width={Math.max(1, xVan(venster.tot) - xVan(venster.van))}
            height={H + STRIP_H}
            className="duel-val"
            onClick={() => zetMoment(venster.tot)}
          >
            <title>{`${klok(venster.van)}–${klok(venster.tot)} — the stretch named above the chart`}</title>
          </rect>
        ) : null}

        {[0, 0.5, 1].map((deel) => {
          const y = PAD_BOVEN + GRAF_H - deel * GRAF_H;
          return (
            <g key={deel}>
              <line
                x1={links}
                x2={breedte - rechts}
                y1={y}
                y2={y}
                className="tijdlijn-raster"
                vectorEffect="non-scaling-stroke"
              />
              <text x={links - 6} y={y + 3.5} textAnchor="end" className="tijdlijn-aslabel">
                {asWaarde("gold", kromme.max * deel)}
              </text>
            </g>
          );
        })}

        {/* The checkpoints as rules on the chart itself, so the numbers under it
            can be pointed at rather than only read. Only the ones the game
            actually reached: a line at 15:00 on a game that ended at 12:40 would
            be a mark where no reading exists. */}
        {IJKMINUTEN.filter((m) => m * 60 <= duur).map((m) => (
          <line
            key={m}
            x1={xVan(m * 60)}
            x2={xVan(m * 60)}
            y1={PAD_BOVEN}
            y2={H + STRIP_H}
            className="tijdlijn-raster"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path d={paden.chaos} className="tijdlijn-lijn tijdlijn-chaos" vectorEffect="non-scaling-stroke" />
        <path d={paden.orde} className="tijdlijn-lijn tijdlijn-orde" vectorEffect="non-scaling-stroke" />

        <g transform={`translate(0 ${H})`}>
          <line
            x1={links}
            x2={breedte - rechts}
            y1={STRIP_H / 2}
            y2={STRIP_H / 2}
            className="tijdlijn-raster"
            vectorEffect="non-scaling-stroke"
          />
          <path d={paden.voorsprong} className={voorsprong >= 0 ? "duel-voor" : "duel-achter"} />
        </g>

        <line
          x1={x}
          x2={x}
          y1={0}
          y2={H + STRIP_H}
          className="tijdlijn-scrubber"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="duel-afleeslat">
        <span className="num tijdlijn-klok">{klok(moment)}</span>
        <span className="num">{asWaarde("gold", mijnGoud)}</span>
        <span className="tijdlijn-scheiding">gold against</span>
        <span className="num">{asWaarde("gold", zijnGoud)}</span>
        <span className={`num ml-auto ${voorsprong >= 0 ? "duel-woord-voor" : "duel-woord-achter"}`}>
          {voorsprong === 0
            ? "level"
            : `${Math.abs(Math.round(voorsprong)).toLocaleString("en")} gold ${voorsprong > 0 ? "ahead" : "behind"}`}
        </span>
      </div>

      {/* ── The two figures this chart is worth reading against ──────────────
          The paragraph that used to sit here carried both of them in the middle
          of a sentence, which is precisely the arrangement the owner objected
          to: he wanted the statistics. So the two measured figures are cells,
          and the whole of the reasoning -- what "earned" means, why the band is
          signed the way it is, why a checkpoint is a reading rather than a
          result -- is a click below and word for word.

          Both figures are about the checkpoint lines drawn on the chart above,
          and they are deliberately printed together: 75% on its own reads as a
          rule, and it stops reading as one the moment the reader can also see
          that a quarter of those leads changed hands afterwards. */}
      <div className="feitenrij">
        <span className="feit">
          <span className="feit-kop">Read from</span>
          <span className="feit-waarde-stil">match history &middot; 1 frame/min</span>
        </span>
        {/* The floor of both lines, as a figure rather than as a footnote. Without
            it the read-out says 2.4k against 2.4k at 0:00 and the only available
            reading of that is that the chart is broken -- which is the reading it
            got. It is a measurement off frame 0 of this game, not a constant. */}
        {startpurse !== null ? (
          <span className="feit">
            <span
              className="feit-kop"
              title="Riot's totalGold counts the gold a champion spawns holding, so neither line starts at zero. Both sides carry the same amount, so it cancels out of the lead band."
            >
              Both sides start on
            </span>
            <span className="num feit-waarde">{startpurse.toLocaleString("en")}</span>
          </span>
        ) : null}
        <span className="feit">
          <span className="feit-kop">Ahead at 15:00 went on to win</span>
          <span className="num feit-waarde">75%</span>
        </span>
        <span className="feit">
          <span className="feit-kop">Lead changed hands after it</span>
          <span className="num feit-waarde">1 in 4</span>
        </span>
        <span className="feit">
          <span className="feit-kop">Games measured</span>
          <span className="num feit-waarde">120</span>
        </span>
      </div>

      <details className="uitleg-fold">
        <summary>How this curve is drawn</summary>
        <p>
          Riot&rsquo;s <span className="num">totalGold</span> per seat, summed per side, one frame a
          minute out of match history rather than out of a recording &mdash; which is why it exists
          for this game at all. It counts gold received rather than gold in hand, so it only ever
          goes up, and it includes the purse every champion spawns with: that is why neither line
          starts at nothing. The band underneath is the difference, signed from your side, and the
          starting purse cancels out of it.
        </p>
        <p>
          The two figures above were measured over <span className="num">120</span> games out of this
          database. They point opposite ways on purpose: the side ahead at fifteen minutes usually
          wins, and often enough to matter it does not, so a checkpoint on this chart is a reading
          and not a result.
        </p>
      </details>
    </div>
  );
}
