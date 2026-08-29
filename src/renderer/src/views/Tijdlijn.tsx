/**
 * A game as it happened, along the clock.
 *
 * ── What this can and cannot draw, and why ───────────────────────────────────
 *
 * This panel draws a game this app was running during, and only such a game.
 * The Live Client Data API hands over every player's inventory second by second
 * along with its whole event feed, and the watcher writes that to
 * buildorders.jsonl. That is where every line here comes from.
 *
 * It is not, as this comment used to claim, the only timeline that exists.
 * `/lol-match-history/v1/game-timelines/{gameId}` answers for Classic games,
 * including games this account never played -- see core/lcu/timeline.ts. What
 * that source cannot do is fill this panel: it samples once a minute where the
 * recording samples every few seconds, and it carries no item purchases and no
 * skill levels at all, so the purchase tracks below the chart and the build
 * walk have no counterpart in it. A game the crawler found still has no
 * purchase order and no first blood here, and that much is permanent; the
 * per-minute curve for such a game is merely unfetched.
 *
 * Every number on this screen is either a reading the game reported, a timestamp
 * it reported, or the catalogue price of an item somebody was seen to pick up.
 * The chart can be four different quantities and the caption changes with it,
 * because the four are not the same kind of thing: kills, creeps and levels are
 * readings taken along the clock, and gold committed to items is rebuilt
 * afterwards from inventories filling up. A curve you cannot account for is
 * decoration, so each one says which of the two it is.
 *
 * How often those readings were taken is not written into this file any more.
 * The first three come off shared/samenloop.ts, which answers out of a recording
 * at one cadence and out of a match-history timeline at another depending on
 * which source holds the measure for this game, so a fixed number here would be
 * a claim the drawing cannot keep. Herkomstregel states it under the chart, out
 * of the readings that were actually merged.
 */
import { useMemo, useState } from "react";
import { aankoopVerloop, bezitOp, bouwPad, goudOp, type Aankoop } from "../../../shared/build";
import type {
  BuildStep, ChampionSummary, GameDetailPlayer, GameTijdlijn, HistorieTijdlijn, HistorieUitslag,
  ItemSummary, LiveGameSnapshot, Position, SpelGebeurtenis, Verloop, VerloopKolommen,
} from "../../../shared/types";
import { samenloop, stoelenLangs, stoelenUitChampions } from "../../../shared/samenloop";
import type { OmslagVenster } from "../../../shared/omslag";
import { leesDekking, type Dekking } from "../../../shared/dekking";
import { asset, ChampionIcon, EmptyState, Panel, PositionIcon, SectionTitle } from "../ui";
import { Duelkromme, Teamgoudkromme } from "./Duelkromme";
import { Dekkingsregel } from "./Dekkingsregel";
import { Herkomstregel } from "./Herkomstregel";

const klok = (s: number): string =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

/**
 * One player's lane on the timeline, whatever the source.
 *
 * A finished recording and a running game describe the same ten people in two
 * different shapes; flattening both to this is what lets one chart serve the
 * post-game screen and the live screen without either of them knowing about the
 * other.
 */
export interface Spoor {
  sleutel: string;
  championId: number | null;
  championName: string;
  team: "ORDER" | "CHAOS" | "UNKNOWN";
  position: Position | null;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  build: BuildStep[];
  /** Only the seat at the keyboard has one, and only ever their own. */
  skillOrder?: string[];
  isYou: boolean;
}

/* ── Geometry ────────────────────────────────────────────────────────────────
   The chart is drawn in a fixed 1000-wide coordinate space and scaled by the
   viewBox, so the layout maths below is in one unit throughout and does not
   have to be redone on every resize. Strokes carry non-scaling-stroke so a
   hairline stays a hairline at any width. */
const W = 1000;
const H = 210;
const PAD = { boven: 14, onder: 26, links: 52, rechts: 14 };
const GRAF_B = W - PAD.links - PAD.rechts;
const GRAF_H = H - PAD.boven - PAD.onder;
/** The strip under the chart that carries the lead and the event ticks. */
const STRIP_H = 46;

const EVENT_LABEL: Record<SpelGebeurtenis["soort"], string> = {
  kill: "Kill",
  firstblood: "First blood",
  dragon: "Dragon",
  baron: "Baron",
  turret: "Turret",
  inhibitor: "Inhibitor",
};

/** Which events are big enough to earn a tick on the axis rather than a dot. */
const GROOT = new Set<SpelGebeurtenis["soort"]>(["dragon", "baron", "inhibitor", "firstblood"]);

/* ── What the chart can be a chart of ────────────────────────────────────────

   Gold committed to items was the only answer for as long as the watcher threw
   every poll away and kept the last one. It no longer is: the recorder samples
   all ten scorelines every ten seconds and stores them as OpnameRecord.verloop,
   and shared/samenloop.ts serves the same three measures out of a match-history
   timeline for a game nobody watched. Either way kills, creeps and levels are
   readings taken during the game rather than a total read off the end of it.

   That distinction is the whole reason for the switch rather than a second
   chart. Committed gold is a reconstruction -- it moves when somebody visits
   the shop, not when they earn anything, which is why it can be read at a
   moment but should never be read as a rate. The other three are measurements.
   Putting them on the same axis with the same scrubber lets one be checked
   against another, and the caption says which kind each one is. */
type Grootheid = "goud" | keyof VerloopKolommen;

/** One reading of a quantity for both sides, which is what the chart plots. */
interface Voorsprongpunt {
  /** Game time in seconds, off the recording's own axis and never an index. */
  t: number;
  orde: number;
  chaos: number;
  /** Blue minus red, so a positive number always means blue. */
  voorsprong: number;
}

interface Grootheidsuitleg {
  sleutel: Grootheid;
  /** The word on the button and in the read-out. */
  naam: string;
  /** The heading when this is the only quantity on offer and there is no switch. */
  titel: string;
  /** Whether it was measured during the game or rebuilt afterwards. */
  gemeten: boolean;
  uitleg: JSX.Element;
}

/** Thousands for gold, plain counts for everything that is a count. */
const toonWaarde = (grootheid: Grootheid, waarde: number): string =>
  grootheid === "goud" ? `${(waarde / 1000).toFixed(1)}k` : String(Math.round(waarde));

/* The cadence is deliberately not written into any of these four sentences.
   The same chart is now drawn off two sources with different clocks -- a
   recording polls every ten seconds, a match-history frame lands once a minute
   -- and which one answers depends on the game and on the measure, so a fixed
   "every fifteen seconds" here is a claim the drawing cannot keep. That number
   is stated under the chart instead, by Herkomstregel, out of the readings that
   were actually merged. What stays here is what does not change with the
   source: whether the quantity was measured or reconstructed, and what it does
   and does not mean. */
const GROOTHEDEN: readonly Grootheidsuitleg[] = [
  {
    sleutel: "goud",
    naam: "Item gold",
    titel: "Gold committed to items",
    gemeten: false,
    uitleg: (
      <>
        Every purchase was watched appearing in an inventory and stamped with the game clock. The
        line is the catalogue price of what a side had bought by then, minus the components it
        swallowed, so an Infinity Edge is not counted three times.{" "}
        <span className="tijdlijn-nadruk">It is not a gold lead:</span> gold still in a pocket, and
        gold spent on the trinket, are not in it. The running game reports gold only for the player
        at the keyboard, which is why nobody can draw the real curve &mdash; and why this one is a
        standing at a moment rather than a rate over a minute.
      </>
    ),
  },
  {
    sleutel: "kills",
    naam: "Kills",
    titel: "Kills",
    gemeten: true,
    uitleg: (
      <>
        The kills on each side, added up as the game was read.{" "}
        <span className="tijdlijn-nadruk">This is a measurement, not a reconstruction:</span> the
        step up is the moment it happened, not the moment somebody got round to buying something.
      </>
    ),
  },
  {
    sleutel: "cs",
    naam: "Creep score",
    titel: "Creep score",
    gemeten: true,
    uitleg: (
      <>
        Both sides&rsquo; creeps added up. This is the closest thing to a gold curve that exists
        for all ten players at once, and it is the one that shows a lane going quiet: farm stops
        before a scoreline does.
      </>
    ),
  },
  {
    sleutel: "level",
    naam: "Levels",
    titel: "Levels",
    gemeten: true,
    uitleg: (
      <>
        The five levels on each side, added up. Levels move slowly and never go backwards, so a
        level lead that stops growing is a side that stopped getting experience &mdash; which is
        what being pushed off a lane looks like before it looks like anything else.
      </>
    ),
  },
];

/**
 * One sampled column, summed over a set of seats, at every second it was read.
 *
 * ── Why a null carries forward instead of counting as zero ───────────────────
 *
 * A null means that seat had no reading at that moment, which happens when the
 * watcher starts on a game already in progress and the client has not listed
 * everybody yet. Counting it as zero would draw a side losing forty creeps the
 * instant one poll came back short and getting them all back on the next one --
 * a collapse and a recovery, neither of which happened. All six sampled numbers
 * are counters that only go up, so the last figure read is still true until a
 * newer one arrives, and a seat never yet seen contributes nothing.
 *
 * Only correct walked in ascending order, which is the order a recording is in.
 */
function kolomReeks(
  verloop: Verloop | undefined,
  stoelen: readonly number[],
  veld: keyof VerloopKolommen,
): Array<{ t: number; waarde: number }> {
  if (!verloop) return [];
  const bekend = new Map<number, number>();
  return verloop.tijden.map((t, i) => ({
    t,
    waarde: stoelen.reduce((totaal, stoel) => {
      const gelezen = verloop.spelers[stoel]?.[veld]?.[i];
      if (typeof gelezen === "number") bekend.set(stoel, gelezen);
      return totaal + (bekend.get(stoel) ?? 0);
    }, 0),
  }));
}

/* This file used to carry its own search for the steepest fall in the team
   lead, and a second copy of it lived in shared/meting.ts for the lane strip.
   Both are gone. The stretch is worked out once, in shared/omslag.ts, and
   arrives here as a prop -- see the `venster` parameter below.

   Beyond the plain duplication, the copy that lived here was wrong in a way
   that mattered. It floored its lookback at second zero rather than at the
   first reading actually taken, so for a recording that began mid-game the
   first sample was compared against a lead of nought. Any game where the other
   side happened to be ahead at the moment the app started watching therefore
   opened with a fall that never happened -- and, being the largest, it won. A
   recording that starts late already stamps everyone's inventory on its first
   second; pointing at that same second and calling it the moment the game
   turned would have made the app confidently wrong about its own weakest
   evidence. */

interface Reeks {
  spoor: Spoor;
  aankopen: Aankoop[];
}

/**
 * Everything the chart needs, worked out once.
 *
 * Kept out of the render path because it walks every purchase of every player
 * and the scrubber re-renders on every mouse move.
 *
 * `kromme` is the merged curve out of shared/samenloop.ts and not the
 * recording's own, which is what this used to be handed. The two differ on every
 * game but two. Measured on this machine: `OpnameRecord.verloop` is undefined on
 * all eleven lines in data/buildorders.jsonl, so for gameId 7965097532 the
 * sampled branch below was unreachable and for the 130,086 crawled games the
 * purchase branch had no purchase to walk -- two points, both zero, a max of 1
 * and five axis labels reading "0.0k". The merge already carries what those
 * games do have: 46 frames for 7965097532, 33 and 35 for the other two fetched
 * timelines, every one of them holding creeps, kills, deaths, assists and levels
 * for all ten seats in this panel's own seat order.
 */
function useTijdlijnData(
  sporen: Spoor[],
  items: Map<number, ItemSummary>,
  duur: number,
  kromme: Verloop | undefined,
  grootheid: Grootheid,
) {
  return useMemo(() => {
    const prijsVan = (id: number): number => items.get(id)?.price ?? 0;
    const onderdelenVan = (id: number): number[] => items.get(id)?.buildsFrom ?? [];

    // The purchase tracks under the chart are always purchases, whatever the
    // chart itself is showing, so this is computed regardless of the series.
    const reeksen: Reeks[] = sporen.map((spoor) => ({
      spoor,
      aankopen: aankoopVerloop(spoor.build, prijsVan, onderdelenVan),
    }));

    // Seat index is the same number in three places -- OpnameRecord.spelers,
    // OpnameRecord.verloop.spelers and this array -- because all three are built
    // by mapping the same list in order. That is what lets a side be a list of
    // indices rather than a lookup.
    const stoelenVan = (team: Spoor["team"]): number[] =>
      sporen.flatMap((spoor, i) => (spoor.team === team ? [i] : []));
    const ordeStoelen = stoelenVan("ORDER");
    const chaosStoelen = stoelenVan("CHAOS");

    // Whether anything at all was read along the clock, from either source.
    // Nothing is substituted when the answer is no: an empty curve would claim
    // the game was measured and found flat, which is the picture this panel was
    // drawing for every game the app did not watch.
    const gemeten = Boolean(kromme && kromme.tijden.length > 0);

    let punten: Voorsprongpunt[];
    if (grootheid === "goud" || !gemeten) {
      // Only the seconds something actually happened. A step function needs no
      // samples in between, and inventing a point per minute would suggest a
      // reading was taken then.
      const momenten = new Set<number>([0, Math.max(0, duur)]);
      for (const r of reeksen) for (const a of r.aankopen) momenten.add(a.stap.at);
      const totaalOp = (stoelen: number[], t: number): number =>
        stoelen.reduce((som, i) => som + goudOp(reeksen[i]?.aankopen ?? [], t), 0);

      punten = [...momenten]
        .sort((a, b) => a - b)
        .map((t) => {
          const orde = totaalOp(ordeStoelen, t);
          const chaos = totaalOp(chaosStoelen, t);
          return { t, orde, chaos, voorsprong: orde - chaos };
        });
    } else {
      // Both sides are read off the same readings, so the two series share an
      // index -- which is the only reason it is safe to subtract them position
      // by position rather than looking each one up by time.
      const orde = kolomReeks(kromme, ordeStoelen, grootheid);
      const chaos = kolomReeks(kromme, chaosStoelen, grootheid);
      punten = orde.map((meting, i) => {
        const tegen = chaos[i]?.waarde ?? 0;
        return { t: meting.t, orde: meting.waarde, chaos: tegen, voorsprong: meting.waarde - tegen };
      });
    }

    const max = Math.max(1, ...punten.map((p) => Math.max(p.orde, p.chaos)));
    const maxVoorsprong = Math.max(1, ...punten.map((p) => Math.abs(p.voorsprong)));

    return { reeksen, punten, max, maxVoorsprong, gemeten, verloop: kromme };
  }, [sporen, items, duur, kromme, grootheid]);
}

/** Seconds to an x in chart space, and back. */
const xVan = (t: number, duur: number): number =>
  PAD.links + (duur > 0 ? Math.min(1, Math.max(0, t / duur)) : 0) * GRAF_B;
const yVan = (waarde: number, max: number): number =>
  PAD.boven + GRAF_H - (max > 0 ? Math.min(1, waarde / max) : 0) * GRAF_H;

/**
 * A step path, not a smoothed one.
 *
 * Gold is committed the instant an item appears in the inventory. Sloping
 * between two purchases would draw a player spending continuously, which is a
 * picture of something that did not happen.
 */
function stapPad(
  punten: Array<{ t: number; waarde: number }>,
  duur: number,
  max: number,
): string {
  if (punten.length === 0) return "";
  const deel: string[] = [];
  punten.forEach((p, i) => {
    const x = xVan(p.t, duur);
    const y = yVan(p.waarde, max);
    if (i === 0) deel.push(`M ${x.toFixed(1)} ${y.toFixed(1)}`);
    else deel.push(`H ${x.toFixed(1)}`, `V ${y.toFixed(1)}`);
  });
  deel.push(`H ${xVan(duur, duur).toFixed(1)}`);
  return deel.join(" ");
}

/**
 * The lead, as a closed area against its own zero line.
 *
 * Drawn in the strip's own coordinates rather than by squashing the chart path,
 * because the strip has a different zero and a different scale and pretending
 * otherwise is how a graph ends up lying by a factor.
 */
function voorsprongPad(
  punten: Array<{ t: number; orde: number; chaos: number }>,
  duur: number,
  maxVoorsprong: number,
): string {
  if (punten.length === 0) return "";
  const midden = STRIP_H / 2;
  const y = (verschil: number): number =>
    midden - (maxVoorsprong > 0 ? Math.max(-1, Math.min(1, verschil / maxVoorsprong)) : 0) * (midden - 6);

  const deel: string[] = [`M ${PAD.links.toFixed(1)} ${midden.toFixed(1)}`];
  punten.forEach((p) => {
    deel.push(`H ${xVan(p.t, duur).toFixed(1)}`, `V ${y(p.orde - p.chaos).toFixed(1)}`);
  });
  deel.push(`H ${xVan(duur, duur).toFixed(1)}`, `V ${midden.toFixed(1)}`, "Z");
  return deel.join(" ");
}

/**
 * The one chart, plus its scrubber.
 *
 * Everything is clickable on purpose: the axis moves the scrubber, an event tick
 * jumps to that second, and a purchase in the tracks below does the same. The
 * point of a timeline is being able to ask "what did it look like right then",
 * and that question is asked by pointing at the moment.
 */
function Grafiek({
  data,
  duur,
  gebeurtenissen,
  sporen,
  moment,
  zetMoment,
  zweef,
  gekozen,
  grootheid,
  venster,
}: {
  data: ReturnType<typeof useTijdlijnData>;
  duur: number;
  gebeurtenissen: SpelGebeurtenis[];
  sporen: Spoor[];
  moment: number;
  /** Pin a second. Only a deliberate act calls this: a click, a tick, a key. */
  zetMoment: (t: number) => void;
  /** Point at a second, or at nothing when the pointer leaves. Never pins. */
  zweef: (t: number | null) => void;
  gekozen: string | null;
  grootheid: Grootheid;
  /** The stretch the panel above named, shaded here. Never found again locally. */
  venster: OmslagVenster | null;
}): JSX.Element {
  const { punten, max, maxVoorsprong, reeksen, gemeten, verloop } = data;

  const secondeVan = (clientX: number, doel: SVGSVGElement): number | null => {
    const kader = doel.getBoundingClientRect();
    if (kader.width <= 0) return null;
    // Back out of the viewBox scaling by hand rather than trusting a CTM: the
    // chart is width-100% and the browser has already scaled it.
    const inChart = ((clientX - kader.left) / kader.width) * W;
    const deel = (inChart - PAD.links) / GRAF_B;
    return Math.round(Math.min(1, Math.max(0, deel)) * duur);
  };

  const gekozenStoel = sporen.findIndex((s) => s.sleutel === gekozen);
  const gekozenReeks = gekozenStoel === -1 ? null : (reeksen[gekozenStoel] ?? null);

  /**
   * The selected player's own curve, in whichever quantity is being shown.
   *
   * For gold it is his purchase walk; for a sampled series it is his own column
   * out of the recording. Both are the same player measured the same way as the
   * side he is drawn against, which is the only reason it is safe to put them on
   * one axis.
   */
  const gekozenPunten: Array<{ t: number; waarde: number }> =
    gekozenStoel === -1
      ? []
      : grootheid === "goud" || !gemeten
        ? [
            { t: 0, waarde: 0 },
            ...(gekozenReeks?.aankopen ?? []).map((a) => ({ t: a.stap.at, waarde: a.totaal })),
          ]
        : kolomReeks(verloop, [gekozenStoel], grootheid);

  const minuutStap = duur > 2400 ? 300 : duur > 900 ? 180 : 60;
  const ticks: number[] = [];
  for (let t = 0; t <= duur; t += minuutStap) ticks.push(t);

  const x = xVan(moment, duur);
  const nu = punten.reduce<Voorsprongpunt>(
    (best, p) => (p.t <= moment ? p : best),
    { t: 0, orde: 0, chaos: 0, voorsprong: 0 },
  );
  const voorsprong = nu.voorsprong;

  return (
    <div className="tijdlijn-grafiek">
      <svg
        viewBox={`0 0 ${W} ${H + STRIP_H}`}
        className="w-full"
        role="img"
        aria-label={`${
          GROOTHEDEN.find((g) => g.sleutel === grootheid)?.titel ?? "Gold committed to items"
        } over time`}
        // Moving over the chart shows a second; leaving it puts the second back.
        // Only the click keeps it, which is why the two go to different setters.
        onMouseMove={(e) => zweef(secondeVan(e.clientX, e.currentTarget))}
        onMouseLeave={() => zweef(null)}
        onClick={(e) => {
          const t = secondeVan(e.clientX, e.currentTarget);
          if (t !== null) zetMoment(t);
        }}
      >
        {/* Four rules, labelled in thousands. Any more and the grid competes
            with the two lines it is there to make readable. */}
        {[0, 0.25, 0.5, 0.75, 1].map((deel) => {
          const y = yVan(max * deel, max);
          return (
            <g key={deel}>
              <line
                x1={PAD.links}
                x2={W - PAD.rechts}
                y1={y}
                y2={y}
                className="tijdlijn-raster"
                vectorEffect="non-scaling-stroke"
              />
              <text x={PAD.links - 8} y={y + 4} textAnchor="end" className="tijdlijn-aslabel">
                {toonWaarde(grootheid, max * deel)}
              </text>
            </g>
          );
        })}

        {ticks.map((t) => (
          <text key={t} x={xVan(t, duur)} y={H - 8} textAnchor="middle" className="tijdlijn-aslabel">
            {klok(t)}
          </text>
        ))}

        {/* The stretch the sentence above the chart named, shaded behind the
            lines rather than drawn over them: it is an answer, and an answer
            belongs under the evidence rather than on top of it. Not searched for
            here -- it arrives as a prop, so the band and the sentence are the
            same finding and cannot drift apart. */}
        {venster ? (
          <rect
            x={xVan(venster.van, duur)}
            y={PAD.boven}
            width={Math.max(1, xVan(venster.tot, duur) - xVan(venster.van, duur))}
            height={GRAF_H}
            className="tijdlijn-val"
          >
            <title>
              {`${klok(venster.van)}–${klok(venster.tot)} — the stretch named above the chart`}
            </title>
          </rect>
        ) : null}

        <path
          d={stapPad(punten.map((p) => ({ t: p.t, waarde: p.chaos })), duur, max)}
          className="tijdlijn-lijn tijdlijn-chaos"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={stapPad(punten.map((p) => ({ t: p.t, waarde: p.orde })), duur, max)}
          className="tijdlijn-lijn tijdlijn-orde"
          vectorEffect="non-scaling-stroke"
        />

        {/* One player picked out in gold. The accent is reserved for the thing
            that is selected, which is exactly what this is. */}
        {gekozenPunten.length > 0 ? (
          <path
            d={stapPad(gekozenPunten, duur, max)}
            className="tijdlijn-lijn tijdlijn-gekozen"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* ── The lead strip ──────────────────────────────────────────────
            The difference between the two lines, against its own zero. Two
            curves close together hide a lead that swung twice; this shows it,
            and it is the same arithmetic, not a second claim. */}
        <g transform={`translate(0 ${H})`}>
          <line
            x1={PAD.links}
            x2={W - PAD.rechts}
            y1={STRIP_H / 2}
            y2={STRIP_H / 2}
            className="tijdlijn-raster"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={voorsprongPad(punten, duur, maxVoorsprong)}
            className={voorsprong >= 0 ? "tijdlijn-voorsprong-orde" : "tijdlijn-voorsprong-chaos"}
          />

          {/* Kills as ticks along the bottom of the strip, tinted by the side
              that got them. Individually they are noise; the clusters are the
              teamfights, and that is what a timeline is for. */}
          {gebeurtenissen
            .filter((g) => g.soort === "kill")
            .map((g, i) => {
              const team = g.door === null ? null : (sporen[g.door]?.team ?? null);
              return (
                <line
                  key={`k-${i}`}
                  x1={xVan(g.at, duur)}
                  x2={xVan(g.at, duur)}
                  y1={STRIP_H - 12}
                  y2={STRIP_H - 2}
                  vectorEffect="non-scaling-stroke"
                  className={
                    team === "ORDER"
                      ? "tijdlijn-kill-orde"
                      : team === "CHAOS"
                        ? "tijdlijn-kill-chaos"
                        : "tijdlijn-kill-onbekend"
                  }
                >
                  <title>{`${klok(g.at)} — ${
                    g.door === null ? "a kill" : `${sporen[g.door]?.championName ?? "?"} killed ${
                      g.aan === null ? "somebody" : (sporen[g.aan]?.championName ?? "?")
                    }`
                  }`}</title>
                </line>
              );
            })}
        </g>

        {/* Objectives get a labelled tick on the axis itself: they are the
            events people actually remember a game by. */}
        {gebeurtenissen
          .filter((g) => GROOT.has(g.soort))
          .map((g, i) => (
            <g
              key={`o-${i}`}
              className="tijdlijn-baken"
              onClick={(e) => {
                e.stopPropagation();
                zetMoment(g.at);
              }}
            >
              <line
                x1={xVan(g.at, duur)}
                x2={xVan(g.at, duur)}
                y1={PAD.boven}
                y2={PAD.boven + GRAF_H}
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={xVan(g.at, duur)} cy={PAD.boven} r={3.5} />
              <title>
                {`${klok(g.at)} — ${EVENT_LABEL[g.soort]}${g.detail ? ` (${g.detail})` : ""}${
                  g.gestolen ? ", stolen" : ""
                }`}
              </title>
            </g>
          ))}

        {/* The scrubber. Drawn last so it is never behind a line. */}
        <line
          x1={x}
          x2={x}
          y1={PAD.boven - 6}
          y2={H + STRIP_H - 2}
          className="tijdlijn-scrubber"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={x} cy={yVan(nu.orde, max)} r={4} className="tijdlijn-punt-orde" />
        <circle cx={x} cy={yVan(nu.chaos, max)} r={4} className="tijdlijn-punt-chaos" />
      </svg>

      <div className="tijdlijn-afleeslat">
        <span className="num tijdlijn-klok">{klok(moment)}</span>
        <span className="num tijdlijn-blauw">{toonWaarde(grootheid, nu.orde)}</span>
        <span className="tijdlijn-scheiding">
          {GROOTHEDEN.find((g) => g.sleutel === grootheid)?.naam.toLowerCase() ?? ""}
        </span>
        <span className="num tijdlijn-rood">{toonWaarde(grootheid, nu.chaos)}</span>
        <span className={`num ml-auto ${voorsprong >= 0 ? "tijdlijn-blauw" : "tijdlijn-rood"}`}>
          {voorsprong === 0
            ? "level"
            : `${voorsprong > 0 ? "Blue" : "Red"} +${toonWaarde(grootheid, Math.abs(voorsprong))}`}
        </span>
      </div>
    </div>
  );
}

/** One player's purchases laid out along the same clock as the chart above. */
function Spoorregel({
  reeks,
  duur,
  items,
  champions,
  moment,
  zetMoment,
  gekozen,
  kies,
}: {
  reeks: Reeks;
  duur: number;
  items: Map<number, ItemSummary>;
  champions: Map<number, ChampionSummary>;
  moment: number;
  zetMoment: (t: number) => void;
  gekozen: string | null;
  kies: (sleutel: string | null) => void;
}): JSX.Element {
  const { spoor, aankopen } = reeks;
  const champion = spoor.championId === null ? undefined : champions.get(spoor.championId);
  const aan = gekozen === spoor.sleutel;
  const bezit = bezitOp(aankopen, moment);
  const goud = goudOp(aankopen, moment);

  const groepen = useMemo(
    () => bouwPad(spoor.build, (id) => items.get(id)?.buildsFrom ?? []),
    [spoor.build, items],
  );

  return (
    <div className={`tijdlijn-spoor ${aan ? "tijdlijn-spoor-aan" : ""} ${spoor.isYou ? "tijdlijn-spoor-jij" : ""}`}>
      <button
        type="button"
        onClick={() => kies(aan ? null : spoor.sleutel)}
        aria-expanded={aan}
        className="tijdlijn-spoor-kop"
      >
        <ChampionIcon iconPath={champion?.iconPath} name={spoor.championName} size={26} />
        <span className="tijdlijn-spoor-naam">
          {champion?.name ?? spoor.championName}
          {spoor.position ? (
            <span className="tijdlijn-spoor-lane">
              <PositionIcon position={spoor.position} size={12} />
            </span>
          ) : null}
        </span>
        <span className="num tijdlijn-spoor-kda">
          {spoor.kills}/{spoor.deaths}/{spoor.assists}
        </span>
        {/* What this player was carrying at the scrubbed second, not at the end.
            The whole reason to have a clock -- and the reason the number has a
            tooltip: a bare 7.3k next to a name is unreadable if you cannot see
            which second it was read at. At rest that second is the last one of
            the game, so this is the finished build's cost. */}
        <span
          className="num tijdlijn-spoor-goud"
          title={`Gold committed to items by ${klok(moment)}`}
        >
          {(goud / 1000).toFixed(1)}k
        </span>
      </button>

      <div className="tijdlijn-baan">
        {aankopen.map((a, i) => {
          const item = items.get(a.stap.itemId);
          const gehad = a.stap.at <= moment;
          const draagt = bezit.includes(a.stap.itemId);
          return (
            <button
              key={`${a.stap.itemId}-${i}`}
              type="button"
              onClick={() => zetMoment(a.stap.at)}
              className={`tijdlijn-koop ${gehad ? "" : "tijdlijn-koop-later"} ${
                draagt ? "tijdlijn-koop-in-bezit" : ""
              }`}
              // Dezelfde afbeelding als de grafiek, niet een tweede. xVan rekent
              // in de 1000-brede viewBox mét de linkermarge voor de aslabels;
              // een percentage van de baan sloeg die marge over en zette elk
              // icoon tot 49px links van de seconde die de grafiek eronder
              // tekent. Hoort samen met `.tijdlijn-baan { margin: 0 0 4px; }`.
              style={{ left: `${(xVan(a.stap.at, duur) / W) * 100}%` }}
              // The last clause is why a faded icon is faded. It only appears on
              // the faded ones, so the tooltip stays a fact about the purchase
              // for every icon that is not asking a question of the reader.
              title={`${item?.name ?? "Unknown item"} — ${klok(a.stap.at)}${
                a.bijbetaling > 0 ? `, ${a.bijbetaling}g` : ""
              }${a.verbruikt.length > 0 ? `, built from ${a.verbruikt.length}` : ""}${
                gehad ? "" : ` — bought after ${klok(moment)}, where the timeline is standing`
              }`}
            >
              {item ? <img src={asset(item.iconPath)} alt={item.name} /> : <span />}
            </button>
          );
        })}
      </div>

      {aan ? (
        <div className="tijdlijn-uitklap">
          {groepen.length === 0 ? (
            <p className="tijdlijn-uitleg">Nothing was seen being bought.</p>
          ) : (
            <ol className="tijdlijn-pad">
              {groepen.map((groep, i) => (
                <li key={`${groep.af.itemId}-${i}`}>
                  <span className="num tijdlijn-pad-tijd">{klok(groep.af.at)}</span>
                  {groep.weg.map((stap, j) => (
                    <span key={`w-${j}`} className="tijdlijn-pad-deel">
                      {items.get(stap.itemId) ? (
                        <img
                          src={asset(items.get(stap.itemId)!.iconPath)}
                          alt={items.get(stap.itemId)!.name}
                          title={`${items.get(stap.itemId)!.name} — ${klok(stap.at)}`}
                        />
                      ) : null}
                    </span>
                  ))}
                  {groep.weg.length > 0 ? <span className="tijdlijn-pad-pijl">&rsaquo;</span> : null}
                  <span className="tijdlijn-pad-af">
                    {items.get(groep.af.itemId) ? (
                      <img
                        src={asset(items.get(groep.af.itemId)!.iconPath)}
                        alt={items.get(groep.af.itemId)!.name}
                      />
                    ) : null}
                    <span>{items.get(groep.af.itemId)?.name ?? groep.af.itemId}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {/* A label and its value, and the reason it is on one row only moves to
              the tooltip. The clause was three quarters of the line's length and
              said the same thing on every game. */}
          {spoor.skillOrder && spoor.skillOrder.length > 0 ? (
            <p
              className="feit"
              title="Only the seat at the keyboard has one: the client reveals nobody else's abilities."
            >
              <span className="feit-kop">Skill order</span>
              <span className="num feit-waarde">{spoor.skillOrder.join(" ")}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The timeline itself, source-agnostic.
 *
 * `herkomst` is not decoration. Everything drawn here comes from one recording
 * made by this machine, and a screen that does not say so invites the reader to
 * assume it came from Riot -- which for Classic would be false.
 */
export function Tijdlijn({
  sporen,
  duur,
  gebeurtenissen,
  items,
  champions,
  herkomst,
  verloop,
  historie,
  stoelen,
  venster,
  dekking,
}: {
  sporen: Spoor[];
  duur: number;
  gebeurtenissen: SpelGebeurtenis[];
  items: Map<number, ItemSummary>;
  champions: Map<number, ChampionSummary>;
  herkomst: JSX.Element;
  /** The sampled scorelines, on recordings taken after the sampler landed. */
  verloop?: Verloop;
  /**
   * The per-minute timeline match history serves for this game, when the client
   * was there to be asked.
   *
   * The one thing a recording cannot supply and the reason two of the curves
   * below exist at all: total gold earned for all ten seats, and the map
   * positions that say who was standing opposite whom. Optional and left out on
   * the live panel, where the game has no match-history entry yet.
   */
  historie?: HistorieTijdlijn | null;
  /**
   * Which seat of `sporen` is which seat of `historie`, or null when they agree.
   *
   * The two sources do not count their seats the same way and neither of them
   * promises to. `historie` is indexed by participantId, which is
   * StoredMatch.players order -- checked exactly on 220 seats. `sporen` on this
   * panel comes from the recording, whose order is the running client's, and
   * core/services/liveGame.ts states outright that the client does not promise
   * it; data/live-sample.json shows the active player hoisted to the front while
   * the stored match has that same player ninth. Lining the two up by index
   * would draw one player's gold under another player's name, which is a wrong
   * chart rather than a missing one, and nothing on screen would look wrong.
   *
   * Null when `sporen` was itself built from the match, which is every crawled
   * game -- then the orders are the same array and there is nothing to map.
   */
  stoelen?: Array<number | null> | null;
  /**
   * The stretch named in the panel above, shaded on the chart and on the lane
   * strip. Handed down rather than looked for, so one game has one answer.
   */
  venster?: OmslagVenster | null;
  /** How much of the game the recording actually covers, when that is known. */
  dekking?: Dekking | null;
}): JSX.Element {
  /**
   * The second somebody deliberately chose, or null when nobody has chosen one.
   *
   * Only a click, a keypress on the slider or a click on an event tick writes
   * here. See `rustpunt` below for what null resolves to.
   */
  const [gekozenMoment, zetGekozenMoment] = useState<number | null>(null);
  /**
   * The second the pointer is over right now, or null when it is over no chart.
   *
   * Held apart from the chosen second because pointing at a chart and choosing a
   * second are not the same act, and this panel used to treat them as one. All
   * three charts scrubbed on mousemove, none of them released on mouseleave, and
   * the pinned second is what every row below reads -- so a pointer that merely
   * crossed a chart on its way down the page left the whole panel parked on that
   * second for as long as it stayed open, with no control showing that anything
   * had been moved.
   *
   * That is the "why are only the first eight items in colour" report, and the
   * arithmetic matches it exactly. Re-run over the one recording on disk (game
   * 7965097532, 2667s, ten builds of 18 to 25 purchases): at the resting second
   * every purchase is in colour, and a pointer left between a quarter and a
   * third of the chart's width leaves 3 to 11 of them in colour and dims the
   * rest -- eight in colour lands at 25% to 36% of the width, seat by seat. The
   * dimming was never wrong, it was answering a question nobody had asked.
   *
   * A hover now lasts exactly as long as the hover. A click still pins.
   */
  const [zweefMoment, zetZweefMoment] = useState<number | null>(null);
  /**
   * Where the scrubber sits when nobody is pointing at anything.
   *
   * Null means "follow the end of the game", which is the only sensible resting
   * place for a live one: duur grows every poll, so a scrubber parked on the
   * second this component first rendered would sit there while the game ran on
   * without it. It becomes a number the moment somebody points at a second, and
   * then it stays where they put it.
   */
  const rustpunt = gekozenMoment === null ? duur : Math.min(gekozenMoment, duur);
  const moment = zweefMoment === null ? rustpunt : Math.min(zweefMoment, duur);
  const zetMoment = (t: number): void => zetGekozenMoment(Math.max(0, Math.min(duur, t)));
  /** A pointer passing over a chart. Null when it leaves, which puts it back. */
  const zweef = (t: number | null): void =>
    zetZweefMoment(t === null ? null : Math.max(0, Math.min(duur, t)));
  const losMoment = (): void => {
    zetGekozenMoment(null);
    zetZweefMoment(null);
  };
  const [gekozen, kies] = useState<string | null>(null);

  /**
   * What the reader last asked for, which is not always what can be drawn.
   *
   * Held as the request rather than as the answer: a game with a recording opens
   * on item gold, and the same button pressed on the next game -- one nobody
   * watched, where no purchase has a timestamp anywhere -- has to fall through
   * to a quantity that was measured instead of drawing a line at zero. That
   * fall-through is `actief` below, and `beschikbaar` is what it falls through
   * to.
   */
  const [grootheid, zetGrootheid] = useState<Grootheid>("goud");

  /**
   * The two sources on one clock, worked out once for both charts below.
   *
   * Built here rather than in each chart so that the team gold curve, the lane
   * strip and the caption under it can never disagree about which source a
   * number came from or which seat it belongs to. shared/samenloop.ts holds the
   * table of who owns which measure and the measurement behind it.
   */
  const bron = useMemo(
    () => samenloop(verloop, historie, stoelen ?? null),
    [verloop, historie, stoelen],
  );
  /**
   * Where each seat stood, put in the same seat order as everything else.
   *
   * Null per seat when the timeline had no counterpart for it, so the lane strip
   * falls back to the stored label for that seat instead of borrowing the lane
   * of whoever happened to sit at the same index.
   */
  const laanmetingen = useMemo(
    () => (historie ? stoelenLangs(historie.laanmetingen, stoelen ?? null) : null),
    [historie, stoelen],
  );

  /**
   * Which of the four the sources can actually draw, decided per quantity.
   *
   * Item gold needs a purchase to have been seen, which only ever happens for a
   * game this app was running during -- two of the 130,088 on this machine. The
   * other three need a reading along the clock, and `bron.herkomst` is non-null
   * for exactly the measures one of the two sources produced readings for, so
   * this asks the merge rather than guessing from which source existed.
   *
   * A quantity that is not in here would draw a line at zero across the whole
   * game. That is what the panel was doing: on gameId 7959569696 and 7957444528
   * -- crawled games with a fetched timeline and no recording -- the only button
   * on offer was the one quantity with nothing behind it, so the chart came out
   * flat with all five axis labels reading "0.0k" while a 33- and a 35-frame
   * timeline sat unread in the same component.
   */
  const heeftAankopen = useMemo(() => sporen.some((s) => s.build.length > 0), [sporen]);
  const beschikbaar = useMemo(
    () =>
      GROOTHEDEN.filter((g) =>
        g.sleutel === "goud" ? heeftAankopen : bron.herkomst[g.sleutel] !== null,
      ),
    [bron, heeftAankopen],
  );
  /**
   * What is drawn: what was asked for while it is on offer, and otherwise the
   * first thing that is. Item gold stays first in GROOTHEDEN and so stays the
   * opening view of every recorded game, which is the one it was chosen for.
   */
  const actief: Grootheid =
    beschikbaar.some((g) => g.sleutel === grootheid)
      ? grootheid
      : (beschikbaar[0]?.sleutel ?? "goud");
  const data = useTijdlijnData(sporen, items, duur, bron.verloop ?? undefined, actief);
  const uitleg = GROOTHEDEN.find((g) => g.sleutel === actief) ?? GROOTHEDEN[0];

  /**
   * Which seat the head-to-head is drawn around.
   *
   * The picked track when one is picked, and null otherwise so the strip falls
   * back to the seat at the keyboard. Written as an explicit -1 check because
   * findIndex answers 0 for the first seat, and `|| null` would quietly turn
   * blue side's top laner back into "nobody picked anything".
   */
  const gekozenStoel = gekozen === null ? -1 : sporen.findIndex((s) => s.sleutel === gekozen);
  const ankerStoel = gekozenStoel >= 0 ? gekozenStoel : null;

  const orde = data.reeksen.filter((r) => r.spoor.team === "ORDER");
  const chaos = data.reeksen.filter((r) => r.spoor.team === "CHAOS");
  const rest = data.reeksen.filter((r) => r.spoor.team === "UNKNOWN");

  const rij = (r: Reeks): JSX.Element => (
    <Spoorregel
      key={r.spoor.sleutel}
      reeks={r}
      duur={duur}
      items={items}
      champions={champions}
      moment={moment}
      zetMoment={zetMoment}
      gekozen={gekozen}
      kies={kies}
    />
  );

  return (
    <Panel className="tijdlijn">
      <div className="tijdlijn-kop">
        {/* Only the quantities something measured. A button that can only ever
            draw a flat line is an offer of a measurement nobody took, and the
            reader who presses it cannot tell that from a game in which nothing
            happened. One quantity gets its name rather than a switch. */}
        {beschikbaar.length > 1 ? (
          <div className="tijdlijn-keuze" role="group" aria-label="What the chart shows">
            {beschikbaar.map((g) => (
              <button
                key={g.sleutel}
                type="button"
                onClick={() => zetGrootheid(g.sleutel)}
                aria-pressed={g.sleutel === actief}
                className={g.sleutel === actief ? "tijdlijn-keuze-aan" : ""}
                // The one thing a reader has to know before believing a curve:
                // whether it was read off the game or rebuilt from side effects.
                title={g.gemeten ? "Sampled during the game" : "Rebuilt from purchases afterwards"}
              >
                {g.naam}
              </button>
            ))}
          </div>
        ) : (
          <p className="tijdlijn-titel">{uitleg?.titel ?? "Gold committed to items"}</p>
        )}
        {/* Arrow keys, because a scrubber you can only reach with a mouse is a
            scrubber half the people looking at this cannot use. */}
        <input
          type="range"
          min={0}
          max={Math.max(1, duur)}
          value={moment}
          onChange={(e) => zetMoment(Number(e.target.value))}
          aria-label="Move through the game"
          className="tijdlijn-schuif"
        />
        {/* Where the scrubber stands, in three words rather than in a sentence.
            Everything below reads `moment`, so when it is not at the end of the
            game the reader has to be able to see that in one glance and put it
            back in one click -- otherwise a dimmed item row is a bug report.
            The tooltip carries the reason the row dims; the label carries only
            the state, because a label nobody can read at a glance is a caption. */}
        {gekozenMoment === null ? (
          <span
            className={`tijdlijn-stand ${zweefMoment === null ? "" : "tijdlijn-stand-zweef"}`}
            title="Everything below is read at this second. Purchases made after it are faded."
          >
            {zweefMoment === null ? (
              "Whole game"
            ) : (
              <>
                At <span className="num">{klok(moment)}</span>
              </>
            )}
          </span>
        ) : (
          <button
            type="button"
            onClick={losMoment}
            className="tijdlijn-stand tijdlijn-stand-terug"
            title="Back to the end of the game. Purchases made after the pinned second are faded."
          >
            At <span className="num">{klok(moment)}</span>
            <span aria-hidden="true">&times;</span>
          </button>
        )}
      </div>

      {/* What this chart is allowed to claim, before the chart claims it.
          A curve drawn from a recording looks identical whether the recording
          covers the whole game or only its last eleven minutes, and the reader
          cannot tell those apart from the drawing -- so a partial recording says
          so here, in the accent colour, above the picture rather than under it.
          Silent on a game watched end to end: a disclaimer printed over every
          good game is one nobody reads by the time it matters. */}
      {dekking ? <Dekkingsregel dekking={dekking} /> : null}

      <Grafiek
        data={data}
        duur={duur}
        gebeurtenissen={gebeurtenissen}
        sporen={sporen}
        moment={moment}
        zetMoment={zetMoment}
        zweef={zweef}
        gekozen={gekozen}
        grootheid={actief}
        venster={venster ?? null}
      />

      {/* The same clock and the same scrubber, asked a narrower question. The
          chart above is ten players and answers whether the game was won, which
          is a fact about nine other people; this is the one player who had your
          job on the other side, which is the only fair thing to hold you
          against. It is handed xVan rather than computing its own, so the two
          cannot drift apart and there is still exactly one time axis on screen.
          It follows the selected track when there is one, so any lane can be
          read this way and not only yours. */}
      {/* The teams first, then the lane. Same order the question is asked in --
          did we win, and then what was I doing while we lost -- and the same
          drawing twice at two scopes rather than two drawings. Renders nothing
          when there is no history timeline, because the panel that fetched it
          already says why. */}
      <Teamgoudkromme
        bron={bron}
        sporen={sporen}
        duur={duur}
        moment={moment}
        zetMoment={zetMoment}
        zweef={zweef}
        xVan={(t) => xVan(t, duur)}
        links={PAD.links}
        rechts={PAD.rechts}
        breedte={W}
        anker={ankerStoel}
        venster={venster ?? null}
      />

      <Duelkromme
        sporen={sporen}
        bron={bron}
        laanmetingen={laanmetingen}
        duur={duur}
        moment={moment}
        zetMoment={zetMoment}
        zweef={zweef}
        champions={champions}
        xVan={(t) => xVan(t, duur)}
        links={PAD.links}
        rechts={PAD.rechts}
        breedte={W}
        anker={ankerStoel}
        venster={venster ?? null}
      />

      {/* No sentence here. The stretch is named once, in words, in the panel
          above this chart, and repeating it under the chart in different wording
          would read as two findings that happen to agree rather than as one. The
          band is this chart's share of that finding. */}
      {/* Which source drew this line and how often it looked. The chart can now
          be fed by the recording or by the match-history frames, and pressing a
          button that appears to change only the units can change the clock
          underneath -- so the cadence is stated here, from the readings that
          were merged, rather than asserted in the prose above. Nothing to say
          for item gold: it is not one of the merged measures, it is rebuilt from
          purchases, and the sentence under it already says so. */}
      {actief === "goud" ? null : <Herkomstregel herkomst={bron.herkomst[actief] ?? null} />}

      {/* ── What the chart is made of, counted ──────────────────────────────
          The paragraph that used to sit open here is an argument rather than a
          reading: it says whether the quantity was measured during the game or
          rebuilt from side effects afterwards, and what the curve therefore does
          and does not mean. That is worth every word and it is not worth reading
          twice, so it goes behind the fold and the countable part of it comes
          out onto the surface -- how many readings the line is drawn from, and
          which of the two kinds of number it is.

          The count is `data.punten` and not a constant: for item gold it is the
          number of seconds somebody was seen to shop, and for the three measured
          quantities it is the number of readings that were taken. Those are
          genuinely different figures and the reader is entitled to see which one
          he is looking at a curve of. */}
      <div className="feitenrij">
        <span className="feit">
          <span className="feit-kop">Readings</span>
          <span className="num feit-waarde">{data.punten.length}</span>
        </span>
        <span className="feit">
          <span className="feit-kop">Kind</span>
          <span className="feit-waarde-stil">
            {uitleg?.gemeten ? "measured during the game" : "rebuilt from purchases afterwards"}
          </span>
        </span>
        {gebeurtenissen.length > 0 ? (
          <span className="feit">
            <span className="feit-kop">Timed events</span>
            <span className="num feit-waarde">{gebeurtenissen.length}</span>
          </span>
        ) : null}
      </div>

      <details className="uitleg-fold">
        <summary>What this line is</summary>
        <p>{uitleg?.uitleg}</p>
        {/* Why this source and not the other one. It used to be appended to the
            caption above, on the open surface, where on creep score it ran to
            three sentences under the chart. The caption keeps the three readings
            -- source, cadence, window -- and the argument lands here, because on
            creep score it is also where the figure behind the choice lives. */}
        {actief !== "goud" && bron.herkomst[actief]?.nuance ? (
          <p>{bron.herkomst[actief]?.nuance}</p>
        ) : null}
      </details>

      <div className="tijdlijn-sporen">
        {orde.length > 0 ? (
          <div>
            <p className="tijdlijn-kant tijdlijn-kant-blauw">Blue side</p>
            {orde.map(rij)}
          </div>
        ) : null}
        {chaos.length > 0 ? (
          <div>
            <p className="tijdlijn-kant tijdlijn-kant-rood">Red side</p>
            {chaos.map(rij)}
          </div>
        ) : null}
        {rest.length > 0 ? (
          <div>
            <p className="tijdlijn-kant">Side not recorded</p>
            {rest.map(rij)}
          </div>
        ) : null}
      </div>

      {gebeurtenissen.length > 0 ? (
        <ol className="tijdlijn-gebeurtenissen">
          {gebeurtenissen
            .filter((g) => GROOT.has(g.soort))
            .map((g, i) => (
              <li key={i}>
                <button type="button" onClick={() => zetMoment(g.at)}>
                  <span className="num">{klok(g.at)}</span>
                  <span>{EVENT_LABEL[g.soort]}</span>
                  {/* Alleen het draketype is een woord. De inhibitor-detail is
                      de eigen mapnaam van de engine ("Barracks_T1_C1"), die de
                      Inzichtenbalk in LiveView.tsx al wegfiltert en die het
                      commentaar bij SOORT_VAN zelf "not information" noemt. */}
                  {g.detail && g.soort === "dragon" ? (
                    <span className="tijdlijn-detail">{g.detail}</span>
                  ) : null}
                  {g.door !== null && sporen[g.door] ? (
                    <span className="tijdlijn-detail">{sporen[g.door]?.championName}</span>
                  ) : null}
                  {g.gestolen ? <span className="tijdlijn-gestolen">stolen</span> : null}
                </button>
              </li>
            ))}
        </ol>
      ) : null}

      <div className="tijdlijn-herkomst">{herkomst}</div>
    </Panel>
  );
}


/**
 * Why there is no per-minute curve, in the words of whichever reason it is.
 *
 * Four situations wear the same blank space and only one of them is anybody's
 * fault. "League is closed" is fixable in thirty seconds; "this game has no
 * timeline" is a permanent fact about one game; "still fetching" resolves on its
 * own. Collapsing them into "no data" would tell a reader with League closed
 * that his history is missing, which is both wrong and discouraging.
 */
function historieReden(uitslag: HistorieUitslag): string {
  switch (uitslag.staat) {
    case "bezig":
      return "Fetching the per-minute timeline for this game from the client now. It lands in well under a second \u2014 open this game again in a moment.";
    case "geen-client":
      return "League is not running. The per-minute curve comes from the client's own match-history endpoint, so with the client closed there is no way to ask for it \u2014 for this game or for any other. Start League, open this game again, and the gold curve, the measured lane and the checkpoints all appear.";
    case "geen-tijdlijn":
      return "The client answered that this game has no timeline. That is a fact about this game rather than a failure, and it will not change: nothing writes one after the fact.";
    case "mislukt":
      return `The fetch failed: ${uitslag.reden}. Opening this game again is a fresh attempt.`;
    default:
      return "There is no per-minute timeline for this game.";
  }
}

/**
 * The timeline of a finished game, from whichever of the two sources exist.
 *
 * \u2500\u2500 Why this no longer requires a recording \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *
 * It used to return null unless this machine had watched the game, which is true
 * of two games out of 130,086. Match history serves a per-minute timeline for
 * the rest as well, including games belonging entirely to strangers, so this
 * panel now draws from a recording, from a fetched timeline, or from both. When
 * it has neither it says which of the reasons that is instead of disappearing,
 * because for most of those reasons the reader is one action away from having
 * the whole thing.
 *
 * \u2500\u2500 The seat order, which is what can go silently wrong \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *
 * The rows come from the recording when there is one, because only a recording
 * carries the build and the skill order that the rows draw. The timeline counts
 * its seats the other way, by participantId, which is the stored match's order.
 * So the two are lined up on champion here, once, and every chart below is
 * handed the result -- see stoelenUitChampions. Merging them by index instead
 * would draw one player's gold under another player's name, and nothing on the
 * screen would look wrong.
 */
export function Tijdlijnpaneel({
  tijdlijn,
  historie,
  spelers,
  items,
  champions,
  venster,
}: {
  tijdlijn: GameTijdlijn | null;
  /** The match-history timeline for the same game, or the reason there is none. */
  historie: HistorieUitslag;
  /**
   * The stored line-up, which is where the rows come from when there is no
   * recording. Same order as the timeline's seats -- both are the stored match
   * -- so a crawled game needs no seat mapping at all.
   */
  spelers: GameDetailPlayer[];
  items: Map<number, ItemSummary>;
  champions: Map<number, ChampionSummary>;
  /** The stretch the panel above named, shaded on the chart. Never found here. */
  venster?: OmslagVenster | null;
}): JSX.Element | null {
  const gevonden = historie.staat === "gevonden" ? historie.tijdlijn : null;

  // Neither source has anything. Say which, rather than vanishing.
  if (!tijdlijn && !gevonden) {
    return (
      <div className="space-y-3">
        <SectionTitle>What happened, over time</SectionTitle>
        <Panel className="p-4">
          <EmptyState title="No minute-by-minute reading" hint={historieReden(historie)} />
        </Panel>
      </div>
    );
  }

  const opname = tijdlijn?.opname ?? null;

  const sporen: Spoor[] = opname
    ? opname.spelers.map((s, i) => ({
        sleutel: `${i}`,
        championId: s.championId,
        championName: s.championName,
        team: s.team,
        position: s.position,
        kills: s.kills,
        deaths: s.deaths,
        assists: s.assists,
        cs: s.cs,
        build: s.build,
        ...(s.skillOrder ? { skillOrder: s.skillOrder } : {}),
        // The recording holds no names, so this is the only honest marker there
        // is: the client reveals nobody else's abilities, so exactly one seat
        // can carry a skill order, and that seat was the one at the keyboard.
        isYou: Boolean(s.skillOrder),
      }))
    : spelers.map((p, i) => ({
        sleutel: `${i}`,
        championId: p.championId,
        championName: champions.get(p.championId)?.name ?? String(p.championId),
        team: p.team === 100 ? ("ORDER" as const) : ("CHAOS" as const),
        position: p.position,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        cs: p.cs,
        // Empty rather than absent, and it is not a gap in the record. Nobody
        // was watching, and the frames carry no ITEM_PURCHASED event of any kind
        // -- counted over every event in 120 fetched games -- so no purchase in
        // this game has a timestamp anywhere and none ever will.
        build: [],
        isYou: p.isYou,
      }));

  // Lined up on champion when both sources exist, and left alone when the rows
  // already came from the match. See the block above this function.
  const stoelen =
    opname && gevonden
      ? stoelenUitChampions(
          opname.spelers.map((s) => s.championId),
          gevonden.verloop.spelers.map((_, i) => spelers[i]?.championId ?? null),
        )
      : null;

  /**
   * How long the game ran.
   *
   * The recording's own clock when there is one, because that is what its
   * purchases and events are stamped against. Otherwise the last frame of the
   * timeline, which carries the true end of the game rather than a round minute
   * -- measured within a second of the stored duration on every game checked.
   */
  const duur = Math.max(
    1,
    opname?.gameLengthSeconds ??
      gevonden?.verloop.tijden[gevonden.verloop.tijden.length - 1] ??
      1,
  );

  return (
    <div className="space-y-3">
      <SectionTitle hint={<span className="num">{klok(duur)}</span>}>What happened, over time</SectionTitle>
      <Tijdlijn
        sporen={sporen}
        duur={duur}
        // A recording is the only source of a stamped event feed for a game it
        // watched. Without one the frames answer instead, and they carry champion
        // kills, buildings and elite monsters -- and nothing else, counted over
        // every event in 120 games.
        gebeurtenissen={opname?.gebeurtenissen ?? gevonden?.gebeurtenissen ?? []}
        items={items}
        champions={champions}
        herkomst={
          tijdlijn ? (
            <Koppelregel koppeling={tijdlijn.koppeling} opname={tijdlijn.opname} />
          ) : (
            // The same shape as the join above it: the countable part on the
            // surface, the reason behind a summary. Both branches of this slot
            // are now a disclosure, so a game with a recording and a game
            // without one read the same way rather than one of them ending in a
            // paragraph and the other in a control.
            <details>
              <summary>
                Rebuilt from match history &mdash;{" "}
                <span className="num">{gevonden?.verloop.tijden.length ?? 0}</span> frames, one a
                minute
              </summary>
              <ul>
                <li>
                  Fetched from the League client the moment you opened this game, not stored
                  beforehand.
                </li>
                <li>
                  No purchases and no skill order: nobody was watching this game run, and the frames
                  carry no ITEM_PURCHASED event of any kind. Those exist only for games this app
                  recorded itself.
                </li>
              </ul>
            </details>
          )
        }
        // Absent on every recording written before the sampler landed, and the
        // panel draws itself without it rather than substituting an empty curve.
        verloop={opname?.verloop}
        historie={gevonden}
        stoelen={stoelen}
        venster={venster ?? null}
        // The joined match knows how long the game really ran, which is the only
        // way to tell "we stopped watching here" from "the game ended here".
        // Recovered rather than carried: the join already stores the live clock
        // minus match history's duration, so match history's duration is the
        // recording's own length less that difference. Same two numbers the join
        // was decided on, so this cannot disagree with it.
        //
        // Null without a recording, because coverage is a fact about a recording
        // and a game that has none has no coverage question to answer. The frames
        // run from the first minute to the last on every game measured.
        dekking={
          tijdlijn
            ? leesDekking(
                tijdlijn.opname,
                tijdlijn.opname.gameLengthSeconds - tijdlijn.koppeling.duurVerschilSeconden,
              )
            : null
        }
      />
    </div>
  );
}

/**
 * The join, written out.
 *
 * The recording carries no game id, because the Live Client Data API has none to
 * give. So it is matched to a stored game on what both of them describe, and the
 * rule goes on screen rather than staying in the source: a number whose
 * provenance you cannot check is not evidence.
 */
function Koppelregel({
  koppeling,
  opname,
}: {
  koppeling: GameTijdlijn["koppeling"];
  opname: GameTijdlijn["opname"];
}): JSX.Element {
  return (
    <details>
      <summary>
        Recorded by this app while you played &mdash; matched to game{" "}
        <span className="num">{koppeling.gameId}</span>
      </summary>
      <ul>
        <li>
          The same {koppeling.spelers} champions, which is the line-up of one specific game.
        </li>
        <li>
          Written{" "}
          <span className="num">
            {koppeling.naEindeSeconden >= 0 ? "" : "-"}
            {klok(Math.abs(koppeling.naEindeSeconden))}
          </span>{" "}
          after match history says the game ended.
        </li>
        <li>
          <span className="num">
            {koppeling.gelijkeScores}/{koppeling.spelers}
          </span>{" "}
          kill lines identical. The rest can differ by a kill: the last reading was taken a second or
          two before the game actually finished.
        </li>
        {/* Reported and never required. The client rounds another seat's creep
            score to whole tens, so this figure can read 1/10 on a join that is
            exact everywhere else -- which is why it is no longer part of the
            match key and is shown here as its own number instead. */}
        <li>
          <span className="num">
            {koppeling.gelijkeCs}/{koppeling.spelers}
          </span>{" "}
          creep scores identical. Usually far fewer, and that is the client rather than the join: it
          reports another player&rsquo;s creep score rounded down to a whole ten, so the recording
          holds a coarse copy of a number match history holds exactly.
        </li>
        <li>
          Live clock ran{" "}
          <span className="num">
            {koppeling.duurVerschilSeconden >= 0 ? "+" : ""}
            {koppeling.duurVerschilSeconden}s
          </span>{" "}
          against the duration match history reports &mdash; the two count from different zeros.
        </li>
        {koppeling.teamsUitMatch ? (
          <li>
            Sides came from match history: this recording predates the app keeping them, and array
            order was never a promise worth reading one out of.
          </li>
        ) : null}
        {opname.gebeurtenissen.length === 0 ? (
          <li>
            No events: this recording predates the app keeping the game&rsquo;s event feed, so there
            are no kills or objectives on the clock. Nothing fills that in afterwards.
          </li>
        ) : (
          <li>
            <span className="num">{opname.gebeurtenissen.length}</span> events, straight from the
            game&rsquo;s own feed &mdash; each one of them was on all ten screens when it happened.
          </li>
        )}
      </ul>
    </details>
  );
}

/**
 * The same timeline, for the game running right now.
 *
 * Identical arithmetic on identical fields, which is the point: what you watch
 * build up during the game is exactly what you get to read back afterwards.
 */
export function LiveTijdlijnpaneel({
  live,
  items,
  champions,
}: {
  live: LiveGameSnapshot;
  items: Map<number, ItemSummary>;
  champions: Map<number, ChampionSummary>;
}): JSX.Element | null {
  const gekocht = live.players.some((p) => p.build.length > 0);
  if (live.players.length === 0) return null;

  const sporen: Spoor[] = live.players.map((p, i) => ({
    sleutel: p.riotId ?? `${p.team}|${p.championName}|${i}`,
    championId: p.championId,
    championName: p.championName,
    team: p.team,
    position: p.position,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    cs: p.cs,
    build: p.build,
    ...(p.isYou ? { skillOrder: live.skillOrder } : {}),
    isYou: p.isYou,
  }));

  const duur = Math.max(1, live.gameTimeSeconds);

  if (!gekocht) {
    return (
      <Panel className="p-4">
        <EmptyState
          title="Nothing bought yet"
          hint="The timeline draws itself as the ten of you visit the shop."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <SectionTitle hint={<span className="num">{klok(duur)}</span>}>This game so far</SectionTitle>
      <Tijdlijn
        sporen={sporen}
        duur={duur}
        gebeurtenissen={live.gebeurtenissen}
        items={items}
        champions={champions}
        herkomst={
          <p>
            Being recorded now. When the game ends this is written to
            <span className="num"> buildorders.jsonl</span> and becomes the only timeline this game
            will ever have &mdash; Classic match history has none, so nothing can rebuild it later.
          </p>
        }
      />
    </div>
  );
}
