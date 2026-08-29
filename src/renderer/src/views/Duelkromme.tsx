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
import {
  duelVan, krommeVan, puntOp, voorsprongVan,
  type MeetVeld, type Punt,
} from "../../../shared/meting";
import type { OmslagVenster } from "../../../shared/omslag";
import type {
  ChampionSummary, Position, Verloop,
} from "../../../shared/types";
import { ChampionIcon, PositionIcon } from "../ui";

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

interface Grootheid {
  veld: MeetVeld;
  naam: string;
  /** Singular unit for the sentence, so "14 CS" and "2 levels" both read. */
  eenheid: (n: number) => string;
}

const GROOTHEDEN: readonly Grootheid[] = [
  { veld: "cs", naam: "CS", eenheid: (n) => `${n} CS` },
  { veld: "kills", naam: "Kills", eenheid: (n) => `${n} ${n === 1 ? "kill" : "kills"}` },
  { veld: "level", naam: "Level", eenheid: (n) => `${n} ${n === 1 ? "level" : "levels"}` },
  { veld: "wards", naam: "Vision", eenheid: (n) => `${n} ward score` },
];

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
  verloop,
  duur,
  moment,
  zetMoment,
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
  verloop: Verloop | null;
  duur: number;
  moment: number;
  zetMoment: (t: number) => void;
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
  const [veld, zetVeld] = useState<MeetVeld>("cs");

  const zitplaats = anker ?? sporen.findIndex((s) => s.isYou);
  const duel = useMemo(
    () => (zitplaats < 0 ? null : duelVan(sporen, zitplaats)),
    [sporen, zitplaats],
  );

  const kromme = useMemo(
    () => (duel === null ? null : krommeVan(verloop, [duel.orde], [duel.chaos], veld)),
    [verloop, duel, veld],
  );

  // Whose side the lead is signed from: the anchor's, so "behind" always means
  // behind for the person this strip was drawn for.
  const kant = zitplaats >= 0 ? sporen[zitplaats]?.team : undefined;
  const mijnKant: "ORDER" | "CHAOS" = kant === "CHAOS" ? "CHAOS" : "ORDER";

  const grootheid = GROOTHEDEN.find((g) => g.veld === veld) ?? GROOTHEDEN[0]!;

  /**
   * The three paths, built once per curve rather than once per mouse move.
   *
   * The scrubber changes on every pixel the cursor travels, and every one of
   * those is a re-render. Rebuilding a step path there means walking the whole
   * reading list three times to produce strings that did not change -- at the
   * sampler's fifteen-second cadence a median Classic game is 123 readings and
   * the cap is 320, so it is small either way, but it is also exactly the work
   * a memo exists to skip.
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
  if (!verloop || verloop.tijden.length === 0) {
    return (
      <p className="duel-leeg">
        This game has no readings along the clock. It was recorded before the app sampled the
        scoreboard, so the only numbers it kept are the ones it ended on, and nothing fills that in
        afterwards.
      </p>
    );
  }
  if (duel === null) {
    const mij = sporen[zitplaats];
    return (
      <p className="duel-leeg">
        {mij?.position
          ? `Nobody on the other side was recorded in ${mij.position.toLowerCase()}, so there is no opposite number to hold you against.`
          : "This recording has no positions, so it cannot say who was standing opposite you. Guessing would put a jungler's creep score against a support's and call it a lane."}
      </p>
    );
  }
  if (!kromme || paden === null || kromme.punten.length < 2) {
    return (
      <p className="duel-leeg">
        Only {kromme?.punten.length ?? 0} readings cover both of you, which is not a curve. The
        sampler starts when the app starts watching, so a game joined in progress has no measured
        opening.
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
            unit, which is why they are worded as nouns and not as toggles. */}
        <span className="duel-maten" role="group" aria-label="What the axis measures">
          {GROOTHEDEN.map((g) => (
            <button
              key={g.veld}
              type="button"
              onClick={() => zetVeld(g.veld)}
              aria-pressed={g.veld === veld}
              className={`duel-maat ${g.veld === veld ? "duel-maat-aan" : ""}`}
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
        onMouseMove={(e) => {
          const kader = e.currentTarget.getBoundingClientRect();
          if (kader.width <= 0) return;
          // Undo the viewBox scaling by hand rather than trusting a CTM: the svg
          // is width-100% and the browser has already scaled it. Same method the
          // chart above uses, so both land the scrubber on the same second.
          const inStrip = ((e.clientX - kader.left) / kader.width) * breedte;
          const deel = (inStrip - links) / (breedte - links - rechts);
          zetMoment(Math.round(Math.min(1, Math.max(0, deel)) * duur));
        }}
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
                {Math.round(kromme.max * deel)}
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
        <span className="num">{Math.round(mijnWaarde)}</span>
        <span className="tijdlijn-scheiding">{grootheid.naam} against</span>
        <span className="num">{Math.round(zijnWaarde)}</span>
        <span className={`num ml-auto ${voorsprong >= 0 ? "duel-woord-voor" : "duel-woord-achter"}`}>
          {voorsprong === 0
            ? "level"
            : `${grootheid.eenheid(Math.abs(Math.round(voorsprong)))} ${voorsprong > 0 ? "ahead" : "behind"}`}
        </span>
      </div>

      {/* No verdict sentence here either. The stretch is named once, at the top
          of the page, with the deaths and objectives that were in it; this strip
          shows what the two of you were doing across it. */}
      <p className="tijdlijn-uitleg">
        Both lines were read off the running game, seat {mijnSeat + 1} against seat{" "}
        {(mijnKant === "ORDER" ? duel.chaos : duel.orde) + 1}, and held flat between readings
        because what the number did in between was not observed. The worst stretch is one measured
        lead subtracted from another a minute earlier &mdash; the steepest fall, which is not the
        same thing as the widest gap: the widest gap is usually the end of a game that was decided
        ten minutes before.
        {kromme.vanaf > 0 ? (
          <>
            {" "}
            Measurement starts at <span className="num">{klok(kromme.vanaf)}</span>
            {kromme.overgeslagen > 0 ? (
              <>
                {" "}
                and <span className="num">{kromme.overgeslagen}</span> readings are missing one of
                you
              </>
            ) : null}
            ; the app began watching after the game had started, and nothing fills the opening in.
          </>
        ) : null}
      </p>
    </div>
  );
}
