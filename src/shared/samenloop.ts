/**
 * Two sources, one time axis.
 *
 * A game can now be described by two different things, and GameDetail carries
 * both side by side. `tijdlijn` is the recording this app made while the game
 * ran: a sample every ten seconds, every purchase with a timestamp, a ward
 * score, and the only knowledge of which seat was at the keyboard. `historie` is
 * the match-history timeline, one frame a minute, served for every game on disk
 * including the 130,086 nobody watched, and carrying gold per seat, which a
 * running game will not reveal for anyone but you.
 *
 * core/services/historieTijdlijn.ts fetches the second one and puts it in the
 * shape of the first. This file decides what happens when both are present: what
 * goes on the axis, which source each number came from, and what the screen says
 * underneath. It is pure and imports only types plus meting.ts, the rule
 * shared/meting.ts and shared/dekking.ts already follow.
 *
 * ── They disagree, and the disagreement was measured ────────────────────────
 *
 * The one ten-seat recording on disk, `recordedAt: 1787937075727` in
 * data/buildorders.jsonl, is gameId 7965097532. Its final creep scores against
 * the same ten seats in that game's last timeline frame:
 *
 *     timeline  268  271  298  258   13  257  160  274  266   37
 *     recording 230  140  280  240   10  250  160  270  260   30
 *     off by     38  131   18   18    3    7    0    4    6    7
 *
 * The recording is lower on nine of ten seats and never higher, and all ten of
 * its values are multiples of ten while none of the timeline's ten is. Kills,
 * deaths, assists and level agreed exactly on all ten seats of the same game, so
 * this is a property of the creep score the client reports for a seat rather
 * than of the recording being stale or having stopped early.
 *
 * The timeline's side of that is not simply the other opinion. Across twelve
 * games sampled from over the whole of data/matches.jsonl plus this one, the
 * last frame's totalGold and minionsKilled + jungleMinionsKilled equalled the
 * stored match record on all ten seats of all thirteen, difference zero
 * throughout. Match history is already what core/services/tijdlijn.ts checks a
 * recording against before it will accept that the recording is that game. So on
 * creep score the recording holds a rounded copy of a figure the timeline holds
 * exactly, and VOLGORDE below follows from that rather than from a preference.
 *
 * ── Which means a recording is not a reason to skip the fetch ───────────────
 *
 * `HistorieUitslag` used to carry an `"opname"` state, meaning the timeline was
 * not fetched because a recording already existed and "the better source is next
 * door". On the numbers above that is the one case where it costs something: the
 * seat that came out 131 creeps low is a seat whose lane the screen would report
 * wrongly, and the recording has no gold at all for the other nine seats. The
 * two sources are complementary per field rather than ranked per game, so a game
 * with a recording is exactly the game where having both is worth most. That
 * state is gone and main/service.ts now fetches for every game, which costs two
 * extra requests in the life of this install because two recordings exist.
 *
 * ── What is deliberately not done ───────────────────────────────────────────
 *
 * The recording samples six times as often. It is tempting to take the
 * timeline's values and the recording's shape -- draw the minute curve, then
 * bend it through the ten-second points. That invents five readings out of every
 * six, and it is the same thing meting.ts refuses when it holds a value flat
 * between two samples instead of sloping across the gap. Nothing is blended
 * here. Each measurable belongs to one source, and where that source said
 * nothing the column is null.
 *
 * ── One axis, two cadences ──────────────────────────────────────────────────
 *
 * Verloop has a single `tijden`, so the merge runs on the union of both clocks.
 * A measure taken from the timeline carries a value on the minute marks and null
 * in between; one taken from the recording carries a value every ten seconds and
 * null at any minute mark the sampler missed. Nothing is lost by that: krommeVan
 * already reads a null as "the number was at least what it last was", which is
 * the correct reading of a counter that only goes up, and puntOp already holds
 * flat rather than interpolating. So two cadences sit on one clock and every
 * step drawn is a step something actually measured.
 *
 * The union is only legal because the two clocks share a zero, and they do.
 * Measured on 7965097532: the recording reports a game length of 2667s, the
 * timeline's last frame lands at 2665.164s, and the recording's purchases run
 * from 5s to 2647s. Under two seconds apart across forty-four minutes, so a
 * purchase at second N plots against the frames without correction.
 */
import type { Kromme, MeetVeld } from "./meting";
import { krommeVan, krommeVanReeksen } from "./meting";
import type { HistorieTijdlijn, Verloop, VerloopKolommen } from "./types";

/**
 * What may go on the axis, which is one more thing than a recording can measure.
 *
 * Gold is not a `MeetVeld` and should not become one: historieTijdlijn.ts keeps
 * it in `goudPerStoel` beside the Verloop precisely so that widening
 * VerloopKolommen does not hang a permanently empty gold column on every
 * recording ever written. So it travels as its own case here, and `krommeVoor`
 * below is the single place that has to know the difference.
 *
 * Experience is deliberately absent. The frames do carry `xp` for all ten, and
 * it is the only measured quantity in either source that nothing routes to a
 * screen -- but no shape on GameDetail holds it today, and putting it on the
 * axis here would name a measure that no fetch fills.
 */
export type SamenloopVeld = MeetVeld | "gold";

export const SAMENLOOP_VELDEN: readonly SamenloopVeld[] = [
  "cs", "gold", "kills", "deaths", "assists", "level", "wards",
];

/** Which of the two produced the numbers under one measure. */
export type Bron =
  /** The recording this app made while the game ran. Ten-second cadence. */
  | "opname"
  /** Frames from match history. One a minute, and served for every game. */
  | "historie";

/**
 * Where one measure on the axis came from, for the caption under the chart.
 *
 * Carried per measure rather than per game, because the measure switch in
 * Duelkromme changes the source underneath it: creep score comes off a minute
 * frame, kills off a ten-second poll. A reader who does not know that will
 * compare a smooth curve against a jagged one and conclude that one player was
 * steadier, when the only thing that changed is how often somebody looked. That
 * is why `cadansSeconden` belongs in the sentence and not in a footnote.
 */
export interface Herkomst {
  veld: SamenloopVeld;
  bron: Bron;
  cadansSeconden: number;
  /** Readings actually carried on this measure, summed over all seats. */
  metingen: number;
  /** First and last second this measure was read at. */
  vanaf: number;
  tot: number;
  /** True when the other source could also have answered and was passed over. */
  andereBestond: boolean;
  /**
   * The caption itself: source, cadence, window. Nothing but readings.
   *
   * Kept to those three because it is drawn on the open surface under a chart,
   * and everything that sits there has to be a figure the reader can check
   * against the picture above it. Never a claim the numbers do not support.
   */
  zin: string;
  /**
   * Why this source and not the other one, for the fold under the caption.
   *
   * Split out of `zin` rather than dropped. It is the part that argues instead
   * of reporting, and on creep score it is also where the measurement behind the
   * choice lives -- our own recording came out low on nine of one game's ten
   * seats, by up to 131 -- so it cannot go anywhere except behind a fold that is
   * still on the page. Empty string when there is nothing to say, which is every
   * measure with only one possible source.
   */
  nuance: string;
}

/**
 * The order each measure's sources are tried in, best first.
 *
 * Gold has exactly one possible source. `Verloop.goud` is the active player's
 * wallet -- gold in hand, which falls every time he spends -- for one seat;
 * `HistorieTijdlijn.goudPerStoel` is gold earned, for ten. Those are different
 * quantities and only the second one is a score.
 *
 * Creep score and level put the timeline first on the measurement quoted at the
 * top of this file. Level agreed on all ten seats there, so for level the order
 * only decides which cadence gets drawn and either would be truthful. Creep
 * score is the one where the choice changes the number, and it is also the
 * measure Duelkromme opens on.
 *
 * Kills, deaths and assists put the recording first for the opposite reason: the
 * two agreed exactly, so the finer cadence wins on cadence alone. The timeline
 * still answers them when there is no recording, which is the ordinary case, by
 * accumulating CHAMPION_KILL events -- see historieTijdlijn.ts, which checked
 * that accumulation against the stored scoreline on fifty seats.
 *
 * Ward score has one source and always will: `HistorieGemeten.wards` is
 * documented as always false, because the frames carry no vision figure at all.
 */
const VOLGORDE: Record<SamenloopVeld, Bron[]> = {
  gold: ["historie"],
  cs: ["historie", "opname"],
  level: ["historie", "opname"],
  kills: ["opname", "historie"],
  deaths: ["opname", "historie"],
  assists: ["opname", "historie"],
  wards: ["opname"],
};

/** Cadence of the match-history frames, as an intent and never as the axis. */
export const HISTORIE_CADANS = 60;

const klok = (s: number): string =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

const leegKolommen = (n: number): VerloopKolommen => ({
  kills: new Array<number | null>(n).fill(null),
  deaths: new Array<number | null>(n).fill(null),
  assists: new Array<number | null>(n).fill(null),
  cs: new Array<number | null>(n).fill(null),
  wards: new Array<number | null>(n).fill(null),
  level: new Array<number | null>(n).fill(null),
});

/**
 * Which seat of the recording is which seat of the history timeline.
 *
 * This is the one thing that has to be worked out rather than assumed, and both
 * sources say why. A frame carries no champion, no team and no puuid, only
 * participantId 1 to 10, so historieTijdlijn.ts indexes its seats positionally
 * against `GameDetail.players` -- which is right, and was checked on a hundred
 * seats. A recording is the case where the same assumption breaks:
 * core/services/liveGame.ts says at line 172 that "the client does not promise
 * the order of allPlayers", and data/live-sample.json shows the active player
 * hoisted to the front of that list while the stored match has that same player
 * ninth. Merging those two by index would draw one player's gold under another
 * player's name, which is a wrong chart rather than a missing one.
 *
 * So the two are lined up on champion, one seat consumed per match, which means
 * a lobby holding the same champion twice cannot hand both seats the same
 * frames. A seat whose champion cannot be matched comes back null and takes
 * nothing from the timeline at all.
 */
export function stoelenUitChampions(
  opnameChampions: Array<number | null>,
  historieChampions: Array<number | null>,
): Array<number | null> {
  const vrij = historieChampions.map((championId, stoel) => ({ championId, stoel }));
  return opnameChampions.map((championId) => {
    if (championId === null) return null;
    const i = vrij.findIndex((p) => p.championId === championId);
    if (i === -1) return null;
    const [gekozen] = vrij.splice(i, 1);
    return gekozen?.stoel ?? null;
  });
}

/**
 * Any per-seat array of the timeline's, re-indexed into the result's seat order.
 *
 * `samenloop` below already does this for the curve and for gold, because those
 * are the two it assembles itself. Lane measurements are the third thing the
 * timeline carries per seat and the one thing it hands over whole, so they need
 * the same treatment or the lane read off seat three's coordinates gets drawn
 * under seat seven's name -- which is the same wrong chart, arriving by a
 * different door.
 *
 * A seat with no counterpart in the timeline comes back null and every caller
 * has to be able to draw that. Pass `stoelen` as null when there is no recording
 * to line up against, in which case the timeline's own order is already the
 * result's order and this copies it through unchanged.
 */
export function stoelenLangs<T>(
  waarden: readonly T[],
  stoelen: Array<number | null> | null,
): Array<T | null> {
  if (!stoelen) return waarden.map((w) => w);
  return stoelen.map((bron) => (bron === null ? null : (waarden[bron] ?? null)));
}

export interface Samenloop {
  /** One curve on one clock, each measure taken from whichever source owns it. */
  verloop: Verloop | null;
  /**
   * Gold earned per seat on that same clock, or null when no timeline was had.
   *
   * Kept beside the Verloop for the reason historieTijdlijn.ts gives, and
   * re-indexed and re-timed here so that `goudPerStoel[stoel][i]` lines up with
   * `verloop.tijden[i]` exactly as every column inside the Verloop does.
   */
  goudPerStoel: Array<Array<number | null>> | null;
  /** Per measure: which source, how often, and the sentence. Null if unmeasured. */
  herkomst: Record<SamenloopVeld, Herkomst | null>;
  /** True when both sources were present and the table above actually chose. */
  beide: boolean;
}

const GEEN_HERKOMST: Record<SamenloopVeld, Herkomst | null> = {
  cs: null, gold: null, kills: null, deaths: null, assists: null, level: null, wards: null,
};

/**
 * Lays the two sources on one axis, measure by measure.
 *
 * Pass whatever exists; both absent is a legitimate state and comes back as a
 * null verloop with every herkomst null. That is what a game looks like when
 * this app never watched it and League is not running to be asked, and nothing
 * here dresses that up as data which has not arrived yet.
 *
 * `stoelen` maps a seat of the recording to a seat of the history timeline, from
 * stoelenUitChampions above. Pass null when there is no recording, in which case
 * the timeline's own seat order is the result's seat order.
 */
export function samenloop(
  /**
   * The recording's curve, not the whole recording.
   *
   * Only the curve is ever read here, and taking just it keeps this file usable
   * from the live panel -- which has readings but no finished OpnameRecord to
   * wrap them in -- and out of the business of knowing what else a recording
   * holds.
   */
  opnameVerloop: Verloop | null | undefined,
  historie: HistorieTijdlijn | null | undefined,
  stoelen: Array<number | null> | null,
): Samenloop {
  const historieVerloop = historie?.verloop ?? null;
  if (!opnameVerloop && !historieVerloop) {
    return { verloop: null, goudPerStoel: null, herkomst: { ...GEEN_HERKOMST }, beide: false };
  }

  // Seat order of the result: the recording's when there is one, because that is
  // the order the naspel screen already draws its rows in; otherwise the
  // timeline's, which is GameDetail.players order.
  const stoelVanHistorie = (stoel: number): number | null =>
    stoelen ? (stoelen[stoel] ?? null) : stoel;
  /**
   * How many rows come out, and `stoelen` is the authority when it is given.
   *
   * Not the recording's curve, which is what this used to read. A recording in
   * the old per-player format has one seat and no curve at all, so that reading
   * fell through to the timeline's ten -- and then a ten-row result was indexed
   * with a one-entry seat map, which lines row 0 up correctly and hands rows 1
   * to 9 whatever sat at the same index in the other source. `stoelen` is built
   * by the caller from the rows it is actually going to draw, so its length is
   * the honest answer and a row it has no mapping for comes back empty rather
   * than borrowing somebody else's.
   */
  const zitplaatsen = stoelen
    ? stoelen.length
    : (opnameVerloop?.spelers.length ?? historieVerloop?.spelers.length ?? 0);

  // The union of both clocks. Two frames never land on the same second, but a
  // poll and a frame can, and one axis may not carry the same second twice.
  const tijden = [
    ...new Set([...(opnameVerloop?.tijden ?? []), ...(historieVerloop?.tijden ?? [])]),
  ].sort((a, b) => a - b);
  const plaatsVan = new Map(tijden.map((t, i) => [t, i]));
  const spelers = Array.from({ length: zitplaatsen }, () => leegKolommen(tijden.length));

  const herkomst = { ...GEEN_HERKOMST };

  /**
   * Copies one measure off one source onto the union axis, and writes down what
   * it copied. Returns false when the source turned out to carry no reading of
   * that measure at all, so the caller can fall through to the next one -- which
   * is what makes an old recording with a tijden array and no numbers under it
   * behave like an absent source rather than like a flat one.
   */
  const noteer = (
    veld: SamenloopVeld,
    bron: Bron,
    bronTijden: number[],
    lees: (stoel: number, i: number) => number | null | undefined,
    schrijf: (stoel: number, tijdIndex: number, waarde: number) => void,
  ): boolean => {
    let metingen = 0;
    let vanaf = Number.POSITIVE_INFINITY;
    let tot = 0;
    for (let stoel = 0; stoel < zitplaatsen; stoel++) {
      for (let i = 0; i < bronTijden.length; i++) {
        const waarde = lees(stoel, i);
        if (typeof waarde !== "number") continue;
        const t = bronTijden[i];
        if (t === undefined) continue;
        const j = plaatsVan.get(t);
        if (j === undefined) continue;
        schrijf(stoel, j, waarde);
        metingen++;
        if (t < vanaf) vanaf = t;
        if (t > tot) tot = t;
      }
    }
    if (metingen === 0) return false;
    const cadans = bron === "opname" ? (opnameVerloop?.interval ?? 10) : HISTORIE_CADANS;
    const van = vanaf === Number.POSITIVE_INFINITY ? 0 : vanaf;
    const andereBestond =
      VOLGORDE[veld].length > 1 && (bron === "opname" ? !!historieVerloop : !!opnameVerloop);
    herkomst[veld] = {
      veld, bron, cadansSeconden: cadans, metingen, vanaf: van, tot, andereBestond,
      zin: zinVoor(bron, cadans, van, tot),
      nuance: nuanceVoor(veld, bron, andereBestond),
    };
    return true;
  };

  for (const veld of SAMENLOOP_VELDEN) {
    // Gold lives outside VerloopKolommen and is handled after this loop.
    if (veld === "gold") continue;
    const kolomVeld = veld as MeetVeld;
    for (const bron of VOLGORDE[veld]) {
      let gelukt = false;
      if (bron === "opname" && opnameVerloop) {
        gelukt = noteer(
          veld, bron, opnameVerloop.tijden,
          (stoel, i) => opnameVerloop.spelers[stoel]?.[kolomVeld]?.[i],
          (stoel, j, w) => { spelers[stoel]![kolomVeld][j] = w; },
        );
      } else if (bron === "historie" && historieVerloop) {
        gelukt = noteer(
          veld, bron, historieVerloop.tijden,
          (stoel, i) => {
            const bronStoel = stoelVanHistorie(stoel);
            return bronStoel === null ? null : historieVerloop.spelers[bronStoel]?.[kolomVeld]?.[i];
          },
          (stoel, j, w) => { spelers[stoel]![kolomVeld][j] = w; },
        );
      }
      if (gelukt) break;
    }
  }

  // Gold, out of the sidecar, onto the same clock and the same seat order.
  let goudPerStoel: Array<Array<number | null>> | null = null;
  if (historie && historieVerloop) {
    const kolommen = Array.from(
      { length: zitplaatsen },
      () => new Array<number | null>(tijden.length).fill(null),
    );
    noteer(
      "gold", "historie", historieVerloop.tijden,
      (stoel, i) => {
        const bronStoel = stoelVanHistorie(stoel);
        return bronStoel === null ? null : historie.goudPerStoel[bronStoel]?.[i];
      },
      (stoel, j, w) => { kolommen[stoel]![j] = w; },
    );
    if (herkomst.gold) goudPerStoel = kolommen;
  }

  return {
    verloop: {
      // Doubly not the axis now, since it can only describe one of two cadences.
      // The finer one is kept so a reader of this field is never told the coarser
      // one was all there was; `tijden` remains the only truth about time.
      interval: Math.min(opnameVerloop?.interval ?? HISTORIE_CADANS, HISTORIE_CADANS),
      tijden,
      // Your wallet, from the recording only. The frames do carry currentGold for
      // all ten, but that is gold in hand rather than gold earned, and the curve
      // that answers "when did it go wrong" wants the one that only goes up --
      // which is goudPerStoel.
      goud: tijden.map((t) => {
        if (!opnameVerloop) return null;
        const i = opnameVerloop.tijden.indexOf(t);
        return i === -1 ? null : (opnameVerloop.goud[i] ?? null);
      }),
      spelers,
    },
    goudPerStoel,
    herkomst,
    beide: !!opnameVerloop && !!historieVerloop,
  };
}

/**
 * The curve for one measure, including the one that does not live in a Verloop.
 *
 * Everything routes through meting.krommeVan, gold included. Gold is projected
 * into the `cs` column of a throwaway Verloop rather than getting a summing loop
 * of its own, because the two rules krommeVan applies -- carry a seat's last
 * value forward, and skip the whole sample when a seat has no value yet -- are
 * exactly the rules gold needs, and a second copy of them is precisely the thing
 * meting.ts's closing comment describes going stale in silence.
 */
export function krommeVoor(
  bron: Samenloop,
  orde: number[],
  chaos: number[],
  veld: SamenloopVeld,
): Kromme {
  if (veld !== "gold") return krommeVan(bron.verloop, orde, chaos, veld);
  return krommeVanReeksen(bron.verloop?.tijden, bron.goudPerStoel, orde, chaos);
}

/**
 * The caption, in the numbers behind it rather than in a label.
 *
 * Exactly three things: where the line came from, how often it was read, and
 * between which two seconds. All three are readings, all three can be checked
 * against the chart above the caption, and none of them is an argument.
 *
 * Everything that is an argument moved to `nuanceVoor` below. It used to be
 * appended here, which put up to three sentences of reasoning on the open
 * surface directly under a chart -- the arrangement the owner objected to. It is
 * not shortened, only relocated.
 */
function zinVoor(bron: Bron, cadans: number, vanaf: number, tot: number): string {
  const venster = `${klok(vanaf)} to ${klok(tot)}`;
  return bron === "historie"
    ? `Match history, one frame a minute, ${venster}.`
    : `Our own recording, every ${cadans}s, ${venster}.`;
}

/**
 * Why this source and not the other, for the fold under the caption.
 *
 * Said only when it changes what the reader should believe. On creep score it
 * quotes by how much the source that was not drawn was measured to be off,
 * because that is the one case where the choice moves the line rather than only
 * its cadence -- so this string carries a measurement and has to stay on the
 * page even though it is prose.
 */
function nuanceVoor(
  veld: SamenloopVeld,
  bron: Bron,
  andereBestond: boolean,
): string {
  if (bron === "historie") {
    const gepasseerd = !andereBestond
      ? ""
      : veld === "cs"
        ? " Our own recording of this game also holds a creep score and it is not drawn:" +
          " against this game's ten seats it came out low on nine of them, by up to 131," +
          " and every value in it is a multiple of ten."
        : " Our own recording reads this more often and agreed with these frames, so either" +
          " would have been truthful; the frames are drawn because they cover the whole game.";
    return (
      `Served for every game, including games this app never saw run.${gepasseerd}`
    );
  }
  const alleen =
    veld === "wards"
      ? "The frames carry no ward or vision figure of any kind, so there is no second source for this one."
      : andereBestond
        ? "Match history could answer this too, once a minute; ours is drawn because it is six" +
          " times finer and the two agreed exactly on the one game we could check."
        : "";
  const grof =
    veld === "cs"
      ? "Read off the client's own scoreboard, which reports another seat's creep score in whole" +
        " tens -- checked against one game's match history it was low by up to 131. There is no" +
        " timeline for this game to correct it against."
      : "";
  return [alleen, grof].filter((s) => s !== "").join(" ");
}
