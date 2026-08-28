/**
 * A game as it happened, along the clock.
 *
 * ── What this can and cannot draw, and why ───────────────────────────────────
 *
 * Classic match history has no timeline. That is not this app being lazy: the
 * LCU's Participant type carries `timeline?: { lane, role }` -- lane assignment,
 * not frames -- and the crawler has exactly two endpoints to ask, both of which
 * answer with end-of-game totals. So for the 130,000-odd games collected from
 * other people there is no gold curve, no first blood, no minute 14, and there
 * never will be.
 *
 * For a game this app was running during, there is all of it. The Live Client
 * Data API hands over every player's inventory second by second and its whole
 * event feed with timestamps, and the watcher has been writing that down to
 * buildorders.jsonl since the day it landed. Nothing ever read that file. This
 * is what it says.
 *
 * Every number on this screen is either a timestamp the game reported or the
 * catalogue price of an item somebody was seen to pick up. The one derived
 * figure -- gold committed to items -- states its own rule on screen, because a
 * curve you cannot account for is decoration.
 */
import { useMemo, useState } from "react";
import { aankoopVerloop, bezitOp, bouwPad, goudOp, type Aankoop } from "../../../shared/build";
import type {
  BuildStep, ChampionSummary, GameTijdlijn, ItemSummary, LiveGameSnapshot, Position,
  SpelGebeurtenis,
} from "../../../shared/types";
import { asset, ChampionIcon, EmptyState, Panel, PositionIcon, SectionTitle } from "../ui";

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

interface Reeks {
  spoor: Spoor;
  aankopen: Aankoop[];
}

/**
 * Everything the chart needs, worked out once.
 *
 * Kept out of the render path because it walks every purchase of every player
 * and the scrubber re-renders on every mouse move.
 */
function useTijdlijnData(sporen: Spoor[], items: Map<number, ItemSummary>, duur: number) {
  return useMemo(() => {
    const prijsVan = (id: number): number => items.get(id)?.price ?? 0;
    const onderdelenVan = (id: number): number[] => items.get(id)?.buildsFrom ?? [];

    const reeksen: Reeks[] = sporen.map((spoor) => ({
      spoor,
      aankopen: aankoopVerloop(spoor.build, prijsVan, onderdelenVan),
    }));

    // Only the seconds something actually happened. A step function needs no
    // samples in between, and inventing a point per minute would suggest a
    // reading was taken then.
    const momenten = new Set<number>([0, Math.max(0, duur)]);
    for (const r of reeksen) for (const a of r.aankopen) momenten.add(a.stap.at);
    const tijden = [...momenten].sort((a, b) => a - b);

    const kant = (team: Spoor["team"]) => reeksen.filter((r) => r.spoor.team === team);
    const totaalOp = (rs: Reeks[], t: number): number =>
      rs.reduce((som, r) => som + goudOp(r.aankopen, t), 0);

    const orde = kant("ORDER");
    const chaos = kant("CHAOS");
    const punten = tijden.map((t) => ({
      t,
      orde: totaalOp(orde, t),
      chaos: totaalOp(chaos, t),
    }));

    const max = Math.max(1, ...punten.map((p) => Math.max(p.orde, p.chaos)));
    const maxVoorsprong = Math.max(1, ...punten.map((p) => Math.abs(p.orde - p.chaos)));

    return { reeksen, punten, max, maxVoorsprong };
  }, [sporen, items, duur]);
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
  gekozen,
}: {
  data: ReturnType<typeof useTijdlijnData>;
  duur: number;
  gebeurtenissen: SpelGebeurtenis[];
  sporen: Spoor[];
  moment: number;
  zetMoment: (t: number) => void;
  gekozen: string | null;
}): JSX.Element {
  const { punten, max, maxVoorsprong, reeksen } = data;

  const uitVoorval = (clientX: number, doel: SVGSVGElement): void => {
    const kader = doel.getBoundingClientRect();
    if (kader.width <= 0) return;
    // Back out of the viewBox scaling by hand rather than trusting a CTM: the
    // chart is width-100% and the browser has already scaled it.
    const inChart = ((clientX - kader.left) / kader.width) * W;
    const deel = (inChart - PAD.links) / GRAF_B;
    zetMoment(Math.round(Math.min(1, Math.max(0, deel)) * duur));
  };

  const gekozenReeks = reeksen.find((r) => r.spoor.sleutel === gekozen) ?? null;
  const minuutStap = duur > 2400 ? 300 : duur > 900 ? 180 : 60;
  const ticks: number[] = [];
  for (let t = 0; t <= duur; t += minuutStap) ticks.push(t);

  const x = xVan(moment, duur);
  const nu = punten.reduce(
    (best, p) => (p.t <= moment ? p : best),
    { t: 0, orde: 0, chaos: 0 },
  );
  const voorsprong = nu.orde - nu.chaos;

  return (
    <div className="tijdlijn-grafiek">
      <svg
        viewBox={`0 0 ${W} ${H + STRIP_H}`}
        className="w-full"
        role="img"
        aria-label="Gold committed to items over time"
        onMouseMove={(e) => uitVoorval(e.clientX, e.currentTarget)}
        onClick={(e) => uitVoorval(e.clientX, e.currentTarget)}
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
                {((max * deel) / 1000).toFixed(1)}k
              </text>
            </g>
          );
        })}

        {ticks.map((t) => (
          <text key={t} x={xVan(t, duur)} y={H - 8} textAnchor="middle" className="tijdlijn-aslabel">
            {klok(t)}
          </text>
        ))}

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
        {gekozenReeks ? (
          <path
            d={stapPad(
              [
                { t: 0, waarde: 0 },
                ...gekozenReeks.aankopen.map((a) => ({ t: a.stap.at, waarde: a.totaal })),
              ],
              duur,
              max,
            )}
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
        <span className="num tijdlijn-blauw">{(nu.orde / 1000).toFixed(1)}k</span>
        <span className="tijdlijn-scheiding">committed to items</span>
        <span className="num tijdlijn-rood">{(nu.chaos / 1000).toFixed(1)}k</span>
        <span className={`num ml-auto ${voorsprong >= 0 ? "tijdlijn-blauw" : "tijdlijn-rood"}`}>
          {voorsprong === 0
            ? "level"
            : `${voorsprong > 0 ? "Blue" : "Red"} +${(Math.abs(voorsprong) / 1000).toFixed(1)}k`}
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
            The whole reason to have a clock. */}
        <span className="num tijdlijn-spoor-goud">{(goud / 1000).toFixed(1)}k</span>
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
              title={`${item?.name ?? "Unknown item"} — ${klok(a.stap.at)}${
                a.bijbetaling > 0 ? `, ${a.bijbetaling}g` : ""
              }${a.verbruikt.length > 0 ? `, built from ${a.verbruikt.length}` : ""}`}
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
          {spoor.skillOrder && spoor.skillOrder.length > 0 ? (
            <p className="tijdlijn-uitleg">
              Skill order: <span className="num">{spoor.skillOrder.join(" ")}</span> &mdash; yours only,
              because the client reveals nobody else&rsquo;s abilities.
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
}: {
  sporen: Spoor[];
  duur: number;
  gebeurtenissen: SpelGebeurtenis[];
  items: Map<number, ItemSummary>;
  champions: Map<number, ChampionSummary>;
  herkomst: JSX.Element;
}): JSX.Element {
  /**
   * Null means "follow the end of the game", which is the only sensible resting
   * place for a live one: duur grows every poll, so a scrubber parked on the
   * second this component first rendered would sit there while the game ran on
   * without it. It becomes a number the moment somebody points at a second, and
   * then it stays where they put it.
   */
  const [gekozenMoment, zetGekozenMoment] = useState<number | null>(null);
  const moment = gekozenMoment === null ? duur : Math.min(gekozenMoment, duur);
  const zetMoment = (t: number): void => zetGekozenMoment(Math.max(0, Math.min(duur, t)));
  const [gekozen, kies] = useState<string | null>(null);
  const data = useTijdlijnData(sporen, items, duur);

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
        <p className="tijdlijn-titel">Gold committed to items</p>
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
      </div>

      <Grafiek
        data={data}
        duur={duur}
        gebeurtenissen={gebeurtenissen}
        sporen={sporen}
        moment={moment}
        zetMoment={zetMoment}
        gekozen={gekozen}
      />

      <p className="tijdlijn-uitleg">
        Every purchase was watched appearing in an inventory and stamped with the game clock. The
        line is the catalogue price of what a side had bought by then, minus the components it
        swallowed, so an Infinity Edge is not counted three times.{" "}
        <span className="tijdlijn-nadruk">It is not a gold lead:</span> gold still in a pocket, and
        gold spent on the trinket, are not in it. The running game reports gold only for the player
        at the keyboard, which is why nobody can draw the real curve.
      </p>

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
                      inzichtenbalk op LiveView.tsx:997 al wegfiltert en die het
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
 * The timeline of a finished game, if this machine happened to watch it.
 *
 * Renders nothing at all when it did not, which is the ordinary case: the
 * crawler collects other people's matches by the ten thousand and nobody was
 * watching any of them. An empty frame promising a graph that will never arrive
 * would be worse than silence.
 */
export function Tijdlijnpaneel({
  tijdlijn,
  items,
  champions,
}: {
  tijdlijn: GameTijdlijn | null;
  items: Map<number, ItemSummary>;
  champions: Map<number, ChampionSummary>;
}): JSX.Element | null {
  if (!tijdlijn) return null;
  const { opname, koppeling } = tijdlijn;

  const sporen: Spoor[] = opname.spelers.map((s, i) => ({
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
    // The recording holds no names, so this is the only honest marker there is:
    // the client reveals nobody else's abilities, so exactly one seat can carry
    // a skill order, and that seat was the one at the keyboard.
    isYou: Boolean(s.skillOrder),
  }));

  const duur = Math.max(1, opname.gameLengthSeconds);

  return (
    <div className="space-y-3">
      <SectionTitle hint={<span className="num">{klok(duur)}</span>}>What happened, over time</SectionTitle>
      <Tijdlijn
        sporen={sporen}
        duur={duur}
        gebeurtenissen={opname.gebeurtenissen}
        items={items}
        champions={champions}
        herkomst={<Koppelregel koppeling={koppeling} opname={opname} />}
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
          scorelines identical. The rest can differ by a kill: the last reading was taken a second or
          two before the game actually finished.
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
