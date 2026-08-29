/**
 * What you did well and what you did badly, now that there is a clock.
 *
 * ── Why this is a separate file from oordeel.ts ──────────────────────────────
 *
 * oordeel.ts scores a game off its final scoreline. Every verdict in it is a
 * total divided by a duration, held against the same ratio over the database:
 * "18 CS behind a normal Nasus TOP over these 34 minutes". That is a true
 * sentence and it is also a flat one. It cannot say when the 18 went, so a
 * player who was 40 ahead at fifteen minutes and 58 behind after it gets exactly
 * the same sentence as one who drifted 18 behind and stayed there.
 *
 * Those are not the same game, and match history has been carrying the
 * difference the whole time. Everything below is a question that needs the
 * per-minute frames and cannot be asked without them:
 *
 *   1. The laning phase on its own, and what happened after it, as two verdicts
 *      rather than one average of both.
 *   2. Where your side's gold lead peaked, where it went, and what the events
 *      say was happening while it went.
 *   3. Whether that fall was one moment or a slow slide. Those two call for
 *      different things next time and only the curve tells them apart.
 *
 * ── What this file is not ───────────────────────────────────────────────────
 *
 * It is not a second timeline reader. core/services/historieTijdlijn.ts fetches
 * and converts; shared/matchtijdlijn.ts works out where everyone stood and what
 * a lane looks like at minute 15. This file only asks questions of what those
 * two produced, which is why it imports types and one norm and nothing else.
 *
 * In particular the fifteen-minute gap is read against LAANNORM_15 from
 * matchtijdlijn.ts rather than against a second table measured here. A separate
 * measurement of mine over 97 games landed within about 15% of it on every lane
 * -- 894 against 1,249 in top, 989 against 1,002 in mid, 769 against 673 on
 * support -- which is worth having as corroboration and is not worth having as a
 * rival constant. Two tables saying "unusual" slightly differently is how a
 * screen ends up scoring its own two halves by different rules.
 *
 * ── The three things this file measured for itself ──────────────────────────
 *
 * Measured by fetching timelines from the running client: 99 games, 19 of them
 * this account's own and 80 crawled strangers', drawn across the whole of
 * data/matches.jsonl from line 20 to line 126,817. All 99 requests returned
 * frames, strangers' games included.
 *
 *   NA_LAANNORM_15   the gold two lane opponents make AFTER 15:00, which nothing
 *                    else here had. 943 paired lane slots.
 *   INSTORTING_BAND  how much a side gives back when it loses a lead. 29 sides.
 *   MOMENT_BAND      how much of that fall lands in its single worst minute.
 *                    26 lost leads of six minutes or more.
 *
 * Those samples are hundreds, where the bands in oordeel.ts stand on 1,096,820
 * player slots. That gap is deliberate and it is printed: every Band carries a
 * `herkomst` string, and the screen shows it, so two claims of very different
 * strength never wear the same clothes. The honest way to firm these up is to
 * keep the per-minute readings of games as they are opened and recount -- not to
 * widen the bands by guessing.
 */
import { LAANNORM_15, banenVan } from "./matchtijdlijn";
import type { GameDetail, HistorieTijdlijn, Position, SpelGebeurtenis } from "./types";
import {
  type Band, type Uitspraak, type Zwijgen,
  gemerkt, gemerktVerschil, heel, klok, procent, tierVan,
} from "./uitspraak";

/**
 * Where the laning phase is cut off.
 *
 * Fifteen minutes is a convention -- the game announces no phase change -- and
 * what makes it defensible here is that the two sides of the cut behave like
 * different games. Over the 943 paired lane slots measured, the median gold gap
 * between two laners is under 1,100 at 15:00 in every lane and the median gold
 * gap opened *after* 15:00 is between 1,570 and 2,348. The end-of-game figure
 * oordeel.ts already reports is therefore mostly a report on what happened after
 * laning, with laning folded invisibly into it.
 *
 * The sharper number is the one in NA_LAANNORM_15's comment: in 29.9% of those
 * slots the sign flips. For nearly a third of all lanes, the existing "finished
 * N gold ahead" verdict does not merely lose detail -- it points the wrong way.
 */
export const LAAN_EINDE_MINUUT = 15;

/**
 * How near a frame has to sit to a whole minute before it may answer for it.
 *
 * Thirty seconds, matching ijkpuntVan in matchtijdlijn.ts so the two never
 * disagree about which frame is "15:00". Index alone would very nearly work --
 * across 3,261 non-final frames in the 99 timelines measured here, not one sat
 * more than 1.5 seconds off its minute -- but the final frame is the game's end
 * clock rather than a round minute, so an index walk off the end of a short game
 * would report the scoreline at the final horn and label it 15:00.
 */
const MINUUT_SPELING = 30;

/**
 * How large a lead has to get, and how much of it has to go, before the fall is
 * worth a sentence.
 *
 * Both sides of the test, both at 2,000 gold, which is the same figure
 * matchtijdlijn.ts measured as the width at which a lead starts predicting the
 * result (the leader won 89% of sampled games from 2,000 at either checkpoint).
 * A side that peaked at 400 never held a lead to lose; a side that gave back 400
 * of a 9,000 lead did not collapse. Naming either would be the app finding drama
 * in the ordinary rhythm of a game.
 *
 * Measured over the 198 sides of the 99 games: 121 had a peak followed by some
 * fall, 34 clear both thresholds, and 29 of those 34 went all the way from a real
 * lead into a deficit. Only those 29 get the row -- see voorsprongRegels, where
 * the difference between the 34 and the 29 is the whole point. So this verdict is
 * absent from roughly six games in seven, which is correct. Most games contain no
 * collapse to point at.
 */
export const INSTORTING_DREMPEL = 2000;

/**
 * The shortest fall whose shape may be described.
 *
 * Six minutes, and the floor is about the measurement rather than about League.
 * The frames land one a minute, so "was it one moment" is being asked of a
 * window holding one reading per minute -- and over a two-minute window the
 * worst minute carries at least half the fall by arithmetic alone, whatever
 * actually happened. The effect is plain in the sample: the median worst-minute
 * share is 0.642 over windows of two to five minutes, and 0.327, 0.247 and 0.284
 * over windows of 6-14, 15-24 and 25 minutes or more. Below six minutes the
 * figure is reporting the window length back at the reader, so below six minutes
 * this file says that instead of answering.
 */
export const INSTORTING_MINIMUM_MINUTEN = 6;

/**
 * How much game there has to be after 15:00 before "after laning" means anything.
 *
 * Five minutes. Found by the probe rather than reasoned out: a 15.6-minute game
 * produced the row "from 15:00 to the end you made 93 gold more than the enemy
 * in your lane", measured over thirty-seven seconds and then quietly filed under
 * "normal for this pick" because 93 sits inside every band there is. That is the
 * worst kind of wrong answer -- not visibly broken, just a false reassurance.
 *
 * The floor is set from the band's own sample: over the 98 games in it that
 * reach 15:00, the post-laning phase runs 17.5 minutes at the median and 7.5 at
 * the tenth percentile, and exactly one game sits under five minutes. So a game
 * with less than five minutes left is being read against a distribution made of
 * nothing that resembles it. Re-measured with the floor applied at two, three
 * and five minutes, NA_LAANNORM_15 does not move by a single gold piece in any
 * lane -- so this guard costs the band nothing and only stops the row appearing
 * where it cannot mean anything.
 */
export const NA_LAAN_MINIMUM_MINUTEN = 5;

/**
 * The sample behind every band in this file, phrased to follow a count.
 *
 * Band.herkomst is printed as "over {slots} {herkomst}", so each of these names
 * its own unit first. Getting that wrong is not cosmetic: "over 192 99 timelines
 * fetched from the client" is a row the reader cannot parse, and the whole point
 * of putting the sample on screen is that he can.
 */
const BRON = "in 99 timelines fetched from the client -- 19 of this account's own games and 80 crawled ones, drawn across the whole match store";

const goudBand = (helft: number, staart: number, slots: number, maat: string, herkomst: string): Band =>
  ({ helft, staart, maat, slots, ratio: false, herkomst });

/**
 * What two lane opponents normally make after fifteen minutes, per lane.
 *
 * The other half of LAANNORM_15, measured the same way and on the same games:
 * seats paired by the lane the map coordinates say they stood in rather than by
 * the stored position label, which is why there are 943 paired slots here out of
 * 970 rather than the 779 the labels manage. Pairing both halves identically is
 * not tidiness -- it is what lets the two rows on screen be about the same two
 * people, so a reader can subtract one from the other and get the end-of-game
 * gap.
 *
 * The finding that justifies printing both: in 282 of the 943 slots -- 29.9% --
 * the sign of the gap after 15:00 is opposite to the sign at 15:00. Nearly one
 * lane in three ended on the other side of the ledger from where laning left it.
 * Measured again with the stored position labels instead, on the smaller set
 * they can pair, it comes out 30.3%, so the finding does not depend on which
 * lane source is used.
 */
const NA_MAAT = "gold the two players in the lane made after 15:00";
const NA_BRON = `paired lane slots ${BRON}, seats paired by where the map says they stood`;

export const NA_LAANNORM_15: Readonly<Record<Exclude<Position, "UNKNOWN">, Band>> = {
  TOP: goudBand(2016, 4505, 194, NA_MAAT, NA_BRON),
  JUNGLE: goudBand(2180, 5019, 176, NA_MAAT, NA_BRON),
  MIDDLE: goudBand(2223, 4832, 195, NA_MAAT, NA_BRON),
  BOTTOM: goudBand(2348, 4722, 192, NA_MAAT, NA_BRON),
  SUPPORT: goudBand(1570, 3501, 186, NA_MAAT, NA_BRON),
};

/**
 * How much a side gives back when it loses a lead, against the ones that happen.
 *
 * Measured over the 29 sides that cleared INSTORTING_DREMPEL on both counts and
 * then actually fell behind. Twenty-nine is thin for a ninetieth percentile and
 * the row on screen says so;
 * what it is good enough for is telling a 3,000-gold wobble from a 16,000-gold
 * rout, which is the distinction the sentence makes.
 */
export const INSTORTING_BAND = goudBand(
  10_418, 16_233, 29,
  "gold given back from the peak of a lead",
  `sides that lost a lead ${BRON}`,
);

/**
 * One moment, or a slow slide.
 *
 * The figure is the share of the whole fall that went in its single worst
 * minute, and the cut point is the middle of the measured spread: over the 26
 * lost leads lasting six minutes or more, half were more concentrated than 0.267
 * and half less. So "at once" here means exactly "more of this fall sat in one
 * minute than in half the falls measured" -- a claim the printed band lets the
 * reader check and disagree with.
 *
 * Note what it deliberately is not. A share of 0.27 is not a claim that one
 * teamfight decided the game; it is a claim about the shape of a curve. What the
 * shape was made of goes in the sentence as the events of that minute, so the
 * reader draws that conclusion himself or declines to.
 */
export const MOMENT_BAND: Band = {
  helft: 0.267,
  staart: 0.336,
  maat: "share of the fall that went in its single worst minute",
  slots: 26,
  ratio: true,
  herkomst: `lost leads lasting six minutes or more ${BRON}`,
};

export interface TijdvakUit {
  /**
   * Verdicts, loudest first, for the caller to filter against their bands the
   * way it filters every other verdict: a figure inside its band is normal and
   * does not earn a row.
   */
  uitspraken: Uitspraak[];
  /**
   * Rows that must appear whatever their band says.
   *
   * Exactly one thing lands here and it is not an exception dressed up as a
   * category. "One moment or a slow slide" is a description rather than a
   * verdict, and a slide that came out unremarkably spread is not a non-finding
   * -- it *is* the finding, and it is the one of the two answers the owner asked
   * for. Filtered on tier like the rest, it would be dropped into "normal for
   * this pick: one moment or a slow slide", which is not a sentence anybody can
   * read.
   */
  altijd: Uitspraak[];
  /** Questions the timeline still cannot answer, and why. */
  zwijgt: Zwijgen[];
}

/** How a champion id becomes a name for the sentence. Null when the catalogue has none. */
export type NaamVan = (championId: number) => string | null;

/**
 * Everything the per-minute frames can say about your own game.
 *
 * Answers with verdicts and silences together, and the silences are half the
 * output. A game under seventeen minutes has no laning phase to separate from
 * anything; a lane with two opponents in it has nobody to pair you against; five
 * games in six contain no collapse. Saying so is the point. From the outside,
 * "this did not happen" and "the app did not look" are the same blank space, and
 * only one of them is worth being annoyed about.
 */
export function leesTijdvak(
  historie: HistorieTijdlijn,
  detail: GameDetail,
  naamVan: NaamVan,
): TijdvakUit {
  const uitspraken: Uitspraak[] = [];
  const altijd: Uitspraak[] = [];
  const zwijgt: Zwijgen[] = [];

  // The seat the fetcher marked as yours, checked against the game it was
  // fetched for. A series carries no identity of its own, so a response paired
  // with the wrong match would produce ten confident curves out of another lobby.
  if (historie.gameId !== detail.gameId) {
    return {
      uitspraken: [], altijd: [],
      zwijgt: [{
        onderwerp: "The clock",
        reden: `The per-minute timeline on this screen was fetched for game ${historie.gameId}, not for this one. Nothing is read from it rather than reading somebody else's game as yours.`,
      }],
    };
  }

  const jij = historie.jouwStoel;
  if (jij === null || !detail.players[jij]?.isYou) {
    return {
      uitspraken: [], altijd: [],
      zwijgt: [{
        onderwerp: "The clock",
        reden:
          "This game holds no seat marked as yours, so the per-minute timeline has all ten curves in it and nobody to follow. That happens for a game the crawler collected rather than one you played.",
      }],
    };
  }

  laanRegels(historie, detail, jij, naamVan, uitspraken, zwijgt);
  voorsprongRegels(historie, detail, jij, uitspraken, altijd, zwijgt);

  // Ranked by how far past its own median each gap sits, which is the only scale
  // a gold gap and a share of a fall can both be read on. Without it the
  // 10,084-gold row would outrank the 0.31-share row every time, for no reason
  // beyond the unit each happens to be counted in.
  uitspraken.sort((a, b) => (b.luidheid ?? 0) - (a.luidheid ?? 0));
  return { uitspraken, altijd, zwijgt };
}

/** The frame index for a whole minute, or null when the series never got there. */
function minuutIndex(tijden: number[], minuut: number): number | null {
  const doel = minuut * 60;
  for (let i = 0; i < tijden.length - 1; i++) {
    if (Math.abs((tijden[i] ?? 0) - doel) <= MINUUT_SPELING) return i;
    if ((tijden[i] ?? 0) > doel + MINUUT_SPELING) return null;
  }
  return null;
}

const goudOp = (historie: HistorieTijdlijn, stoel: number, index: number): number =>
  historie.goudPerStoel[stoel]?.[index] ?? 0;

/**
 * The laning phase and everything after it, as two verdicts rather than one.
 *
 * Two rows and not one row with a clause, because they are two findings and
 * either can be the one that matters. A player who won his lane and lost
 * everything after it needs to read both sentences and see that they disagree;
 * folding them into a single "on balance" number is exactly how that
 * disagreement gets lost, and the disagreement is the thing worth knowing.
 */
function laanRegels(
  historie: HistorieTijdlijn,
  detail: GameDetail,
  jij: number,
  naamVan: NaamVan,
  uit: Uitspraak[],
  zwijgt: Zwijgen[],
): void {
  const tijden = historie.verloop.tijden;
  const index = minuutIndex(tijden, LAAN_EINDE_MINUUT);
  if (index === null) {
    zwijgt.push({
      onderwerp: "Laning phase",
      reden:
        `This game ran ${klok(detail.durationSeconds)}, so it has no fifteenth minute with a game after it. Splitting it there would put the whole match on one side of the line and nothing on the other.`,
    });
    return;
  }

  // Lanes as the map coordinates say they were, not as the stored record labels
  // them. matchtijdlijn.ts scores that rule at 637 of 640 seats against Riot's
  // own labels where those can be trusted, and it pairs 943 of 970 slots in the
  // sample where the labels manage 779 -- so this is both the more accurate
  // pairing and the one that is more often possible at all.
  const kanten: Array<"ORDER" | "CHAOS" | "UNKNOWN"> =
    detail.players.map((p) => (p.team === 100 ? "ORDER" : "CHAOS"));
  const banen = banenVan(historie.laanmetingen, kanten);
  const mijnBaan = banen[jij];
  if (!mijnBaan || mijnBaan === "UNKNOWN") {
    zwijgt.push({
      onderwerp: "Laning phase",
      reden:
        "The frames do not put your seat in any one lane during the laning phase, so there is no lane here to read. That is a statement about where you spent minutes two to ten, not about the data being missing.",
    });
    return;
  }
  const kandidaten = banen.flatMap((baan, i) =>
    i !== jij && kanten[i] !== kanten[jij] && baan === mijnBaan ? [i] : [],
  );
  if (kandidaten.length !== 1) {
    zwijgt.push({
      onderwerp: "Laning phase",
      reden:
        kandidaten.length === 0
          ? `Nobody on the other side spent the laning phase in your lane, so there is no opponent to measure fifteen minutes against.`
          : `${kandidaten.length} enemies spent the laning phase in your lane, so there is no single person you were standing opposite. Picking one of them would invent a duel that never happened.`,
    });
    return;
  }
  const tegen = kandidaten[0] as number;

  const norm = LAANNORM_15[mijnBaan];
  const naNorm = NA_LAANNORM_15[mijnBaan];
  const eind = tijden.length - 1;
  const naam = naamVan(detail.players[tegen]?.championId ?? 0) ?? `the enemy in your lane`;

  const mijnGoud15 = goudOp(historie, jij, index);
  const hunGoud15 = goudOp(historie, tegen, index);
  const goud15 = mijnGoud15 - hunGoud15;
  const mijnCs15 = historie.verloop.spelers[jij]?.cs[index] ?? 0;
  const hunCs15 = historie.verloop.spelers[tegen]?.cs[index] ?? 0;
  const cs15 = mijnCs15 - hunCs15;

  const mijnNa = goudOp(historie, jij, eind) - mijnGoud15;
  const hunNa = goudOp(historie, tegen, eind) - hunGoud15;
  const goudNa = mijnNa - hunNa;

  // LAANNORM_15 is not a Band -- it is matchtijdlijn.ts's own shape, measured
  // there. Dressed as one here rather than restated, so the two can never drift.
  const laanBand: Band = goudBand(
    norm.goud, norm.goudP90, norm.games,
    "gold between the two players in the lane at 15:00",
    "sampled games, measured in shared/matchtijdlijn.ts on seats paired by where the map says they stood",
  );
  const naMinuten = ((tijden[eind] ?? 0) - (tijden[index] ?? 0)) / 60;

  const laanGat = Math.abs(goud15);
  const laanTier = tierVan(laanGat, laanBand);
  uit.push({
    sleutel: "laning",
    gebied: "Laning phase",
    toon: laanTier === "binnen" ? "vlak" : goud15 >= 0 ? "goed" : "slecht",
    // The middle column here is a person and not a norm, which is the whole
    // point of the row: this is you against the man you were standing next to,
    // at one named minute. The lane's median gap goes under the fold with the
    // band, where every other cut point on this screen also sits.
    metingen: [
      { maat: "Gold at 15:00", jij: heel(mijnGoud15), norm: heel(hunGoud15), verschil: gemerktVerschil(mijnGoud15, hunGoud15, 0) },
      { maat: "CS at 15:00", jij: heel(mijnCs15), norm: heel(hunCs15), verschil: gemerktVerschil(mijnCs15, hunCs15, 0) },
    ],
    zin:
      `At 15:00 you were ${heel(goud15)} gold ${goud15 >= 0 ? "ahead of" : "behind"} ${naam}, ` +
      `and ${heel(cs15)} CS ${cs15 >= 0 ? "ahead" : "behind"}.`,
    cijfers:
      `${heel(mijnGoud15)} against ${heel(hunGoud15)} gold at 15:00 · ` +
      `${heel(mijnCs15)} against ${heel(hunCs15)} CS · ` +
      `the median CS gap at 15:00 in this lane is ${heel(norm.cs)}`,
    gat: laanGat,
    band: laanBand,
    tier: laanTier,
    luidheid: laanGat / Math.max(1, laanBand.helft),
    grond:
      "Both players' total gold at the fifteen-minute frame of the match-history timeline, subtracted. This is the laning phase and nothing else: not one gold piece from after 15:00 is in it, which is the whole reason it can disagree with the end-of-game figure. Riot's total-gold field counts the purse a champion spawns with, so both figures carry the same 475 and it cancels out of the gap.",
  });

  if (naMinuten < NA_LAAN_MINIMUM_MINUTEN) {
    zwijgt.push({
      onderwerp: "After laning",
      reden:
        `This game ended ${Math.round(naMinuten * 60)} seconds after the fifteen-minute mark, so there is no phase after laning to read. The cut points this row uses were measured over post-laning phases running 17.5 minutes at the median, and holding a few seconds against them would come back "normal" for the sole reason that nothing had time to happen.`,
    });
    return;
  }

  // The flip lives in this row rather than a third one. It is a statement about
  // the relationship between the two rows, and a row whose only job is to
  // comment on its neighbours reads as an apology for them.
  const draait = goud15 !== 0 && goudNa !== 0 && Math.sign(goud15) !== Math.sign(goudNa);
  const naGat = Math.abs(goudNa);
  const naTier = tierVan(naGat, naNorm);
  uit.push({
    sleutel: "naLaning",
    gebied: "After laning",
    toon: naTier === "binnen" ? "vlak" : goudNa >= 0 ? "goed" : "slecht",
    // The end-of-game line is on the row rather than only in the sentence,
    // because the two together are the finding: a lane that ended one way and a
    // game that ended the other is exactly what this row exists to show, and two
    // signed numbers in one column show it without a word.
    metingen: [
      { maat: "Gold after 15:00", jij: heel(mijnNa), norm: heel(hunNa), verschil: gemerktVerschil(mijnNa, hunNa, 0) },
      {
        maat: "Gold at the end",
        jij: heel(goudOp(historie, jij, eind)),
        norm: heel(goudOp(historie, tegen, eind)),
        verschil: gemerktVerschil(goudOp(historie, jij, eind), goudOp(historie, tegen, eind), 0),
      },
    ],
    zin: draait
      ? `Then it turned round. From 15:00 to the end you made ${heel(goudNa)} gold ${goudNa >= 0 ? "more than" : "less than"} ${naam} — the opposite way from the lane, so the end-of-game gap points away from how you actually laned.`
      : `From 15:00 to the end you made ${heel(goudNa)} gold ${goudNa >= 0 ? "more than" : "less than"} ${naam}, the same way the lane went.`,
    cijfers:
      `${heel(mijnNa)} against ${heel(hunNa)} gold after 15:00 · ` +
      `${heel(goudOp(historie, jij, eind))} against ${heel(goudOp(historie, tegen, eind))} at the final whistle`,
    gat: naGat,
    band: naNorm,
    tier: naTier,
    luidheid: naGat / Math.max(1, naNorm.helft),
    grond:
      "The same two curves, from the fifteen-minute frame to the last one. Worth reading against the row above it: over 943 paired lane slots measured this way, 282 of them — 29.9% — ended on the opposite side of the ledger from where laning left them, so an end-of-game gold gap on its own points the wrong way about once in three.",
  });
}

/**
 * Your side's gold lead: where it peaked, where it went, and what went with it.
 *
 * The lead is a team figure and is labelled as one throughout. Your own line
 * through the same minutes is printed beside it so the row still says something
 * about the person reading it -- a five-man collapse you had no part in and one
 * you led look identical on the team curve, and the two numbers separate them
 * without the app having to claim which it was.
 */
function voorsprongRegels(
  historie: HistorieTijdlijn,
  detail: GameDetail,
  jij: number,
  uit: Uitspraak[],
  altijd: Uitspraak[],
  zwijgt: Zwijgen[],
): void {
  const mijnTeam = detail.players[jij]?.team;
  if (mijnTeam === undefined) return;
  const mijne = detail.players.flatMap((p, i) => (p.team === mijnTeam ? [i] : []));
  const hunne = detail.players.flatMap((p, i) => (p.team !== mijnTeam ? [i] : []));
  if (mijne.length === 0 || hunne.length === 0) return;

  const tijden = historie.verloop.tijden;
  const som = (zit: number[], k: number): number =>
    zit.reduce((t, i) => t + goudOp(historie, i, k), 0);
  const voorsprong = tijden.map((_, k) => som(mijne, k) - som(hunne, k));

  // The highest the lead ever got, and the lowest it reached after that. Not a
  // search over every local peak: the question asked was where *the* lead went,
  // and the lead is the largest one there was.
  let piek = Number.NEGATIVE_INFINITY;
  let piekAt = -1;
  voorsprong.forEach((v, k) => {
    if (v > piek) { piek = v; piekAt = k; }
  });
  let dal = Number.POSITIVE_INFINITY;
  let dalAt = -1;
  for (let k = piekAt + 1; k < voorsprong.length; k++) {
    const v = voorsprong[k] ?? 0;
    if (v < dal) { dal = v; dalAt = k; }
  }
  const val = piekAt >= 0 && dalAt > piekAt ? piek - dal : 0;

  // Three conditions, and the third one is the heading. A lead that peaked at
  // 7,420 and bottomed at 2,889 ahead did give back 4,531 gold, and calling that
  // "when the lead went" is simply false -- the side still held two thousand
  // when the game ended, and it won. Measured, this is not a corner: 5 of the 34
  // sides clearing the first two conditions never actually fell behind, and the
  // probe caught one of them announcing a collapse on a side that was winning
  // throughout. So the lead has to be gone, and the band is measured over the 29
  // sides where it was.
  if (
    piekAt < 0 || dalAt <= piekAt ||
    piek < INSTORTING_DREMPEL || val < INSTORTING_DREMPEL || dal > 0
  ) {
    zwijgt.push({
      onderwerp: "When the lead went",
      reden:
        piek < INSTORTING_DREMPEL
          ? `Your side never held a gold lead worth the name — the most it was ever ahead by was ${heel(Math.max(0, piek))}, against the ${heel(INSTORTING_DREMPEL)} this asks for. There was no lead here to lose, which is a different game from one that threw a lead away.`
          : dal > 0 && val >= INSTORTING_DREMPEL
            ? `Your side led by as much as ${heel(piek)} and gave back ${heel(val)} of it, but never lost it: the lowest it ever got to was ${heel(dal)} ahead, at ${klok(tijden[dalAt] ?? 0)}. A lead that narrowed is not a lead that went.`
            : `Your side led by as much as ${heel(piek)} and never gave back ${heel(INSTORTING_DREMPEL)} of it. Of the 198 sides measured this way only 29 lost a real lead, so most games hold no collapse to point at.`,
    });
    return;
  }

  const nulAt = eersteNul(voorsprong, piekAt, dalAt);
  const feiten = gebeurtenissenIn(historie, detail, jij, tijden[piekAt] ?? 0, tijden[dalAt] ?? 0);
  const tier = tierVan(val, INSTORTING_BAND);
  const eigenGroei = goudOp(historie, jij, dalAt) - goudOp(historie, jij, piekAt);
  const teamGroei = som(mijne, dalAt) - som(mijne, piekAt);
  const minuten = dalAt - piekAt;

  uit.push({
    sleutel: "voorsprong",
    gebied: "When the lead went",
    toon: "slecht",
    // The clock sits in the label rather than in a column of its own. Three
    // readings of one curve at three named minutes is the whole shape of this
    // finding, and it is a shape the reader can then go and point at on the
    // chart, which is the only claim this row makes.
    metingen: [
      { maat: `Lead peaked ${klok(tijden[piekAt] ?? 0)}`, jij: heel(piek), norm: null, verschil: null },
      // The clock is the value on this line and not the label, because the
      // reading at that frame is not zero -- zero is the threshold it crossed.
      // Printing "0" in the gold column would be the one invented number on a
      // screen whose whole claim is that it has none.
      { maat: "Lead gone by", jij: klok(tijden[nulAt ?? dalAt] ?? 0), norm: null, verschil: null },
      {
        maat: `Bottomed out ${klok(tijden[dalAt] ?? 0)}`,
        jij: dal < 0 ? gemerkt(dal) : "0",
        norm: null,
        verschil: null,
      },
      {
        maat: `Given back over ${minuten} min`,
        jij: heel(val),
        // Named as a median in the cell. A bare figure in the middle column
        // reads as the other side's number on every other row of this table,
        // and on this one it is the middle of a measured spread.
        norm: `${heel(INSTORTING_BAND.helft)} median`,
        verschil: null,
      },
      // Your own line through the same minutes, which is what separates a
      // collapse you led from one you had no part in. Held against your side's
      // total over those minutes rather than against a norm, because there is no
      // norm for "a share of a collapse" anywhere and there is not going to be.
      {
        maat: "Your gold in them",
        jij: heel(eigenGroei),
        norm: `${heel(teamGroei)} your side`,
        verschil: null,
      },
    ],
    zin:
      `Your side's gold lead peaked at ${heel(piek)} at ${klok(tijden[piekAt] ?? 0)}` +
      `, was gone by ${klok(tijden[nulAt ?? dalAt] ?? 0)}` +
      `, and bottomed out ${dal < 0 ? `${heel(dal)} behind` : "dead level"} at ${klok(tijden[dalAt] ?? 0)} — ` +
      `${heel(val)} gold given back over ${minuten} minutes.` +
      (feiten.length > 0 ? ` Over those minutes: ${feiten.join("; ")}.` : ""),
    cijfers:
      `${heel(piek)} ahead → ${dal < 0 ? `${heel(dal)} behind` : "level"} · ` +
      `your own gold over those minutes: ${heel(eigenGroei)} of your side's ${heel(teamGroei)}`,
    gat: val,
    band: INSTORTING_BAND,
    tier,
    luidheid: val / INSTORTING_BAND.helft,
    grond:
      "Both sides' total gold at every frame of the match-history timeline, subtracted. Five seats a side spawn holding 475 each, so the same 2,375 sits under both curves and cancels out of the lead this reads. The events named are the only ones the frames carry — champion kills, turrets, inhibitors, dragons and Baron. There are no item purchases and no skill levels in this feed at all, so nothing here can say what was bought while it happened.",
  });

  vormRegel(historie, detail, jij, voorsprong, piekAt, dalAt, val, altijd, zwijgt);
}

/**
 * The first frame after the peak where the lead was gone.
 *
 * Cannot return null for any window the caller actually reports, because that
 * caller refuses to report one whose trough is still ahead -- if the lead ended
 * at or below zero it crossed zero somewhere. The nullable return is kept so the
 * function is honest on its own terms rather than relying on its one caller's
 * guard, and the caller falls back to the trough.
 */
function eersteNul(voorsprong: number[], piekAt: number, dalAt: number): number | null {
  for (let k = piekAt + 1; k <= dalAt; k++) {
    if ((voorsprong[k] ?? 0) <= 0) return k;
  }
  return null;
}

/**
 * One moment, or a slow slide.
 *
 * The whole verdict rests on one subtraction the reader can redo on the chart
 * above it: the largest single-minute fall inside the window, against the size
 * of the whole fall. Both go in the sentence, and so do the events of that one
 * minute, so what the shape was made of is on screen rather than left to the
 * word "collapse" to carry.
 */
function vormRegel(
  historie: HistorieTijdlijn,
  detail: GameDetail,
  jij: number,
  voorsprong: number[],
  piekAt: number,
  dalAt: number,
  val: number,
  uit: Uitspraak[],
  zwijgt: Zwijgen[],
): void {
  const minuten = dalAt - piekAt;
  if (minuten < INSTORTING_MINIMUM_MINUTEN) {
    zwijgt.push({
      onderwerp: "One moment or a slow slide",
      reden:
        `The lead went over ${minuten} minutes, and this timeline holds one reading a minute. Over a window that short the worst minute carries most of the fall by arithmetic alone — the median worst-minute share is 0.642 over windows of two to five minutes against 0.270 over longer ones — so an answer here would be reporting the window length back at you.`,
    });
    return;
  }

  const tijden = historie.verloop.tijden;
  let ergste = 0;
  let ergsteAt = -1;
  let verliezend = 0;
  for (let k = piekAt + 1; k <= dalAt; k++) {
    const daling = (voorsprong[k - 1] ?? 0) - (voorsprong[k] ?? 0);
    if (daling > 0) verliezend++;
    if (daling > ergste) { ergste = daling; ergsteAt = k; }
  }
  if (ergsteAt < 0 || !(val > 0)) return;

  const aandeel = ergste / val;
  const eenMoment = aandeel >= MOMENT_BAND.helft;
  const van = tijden[ergsteAt - 1] ?? 0;
  const tot = tijden[ergsteAt] ?? 0;
  const feiten = gebeurtenissenIn(historie, detail, jij, van, tot);

  // The last frame of a game is its end clock, not a round minute -- true of 56
  // of the 59 games first measured -- so the final interval is routinely a
  // fragment. Calling a 32-second nexus fight "the worst minute" would be a
  // small lie in the one place the reader is most likely to check it against the
  // chart, so the sentence uses the span it actually measured. The band is not
  // affected: it was measured over these same raw frame-to-frame drops, partial
  // last intervals included, so the figure and its cut point count the same
  // thing.
  const spanne = Math.round(tot - van);
  const eenheid = Math.abs(spanne - 60) <= 2 ? "minute" : `${spanne}-second stretch`;

  uit.push({
    sleutel: "instorting",
    gebied: "One moment or a slow slide",
    // Never coloured. This row does not say the game went well or badly -- the
    // row above it already said that -- it says what shape the going took, and
    // painting a shape red would be the block holding the same opinion twice.
    toon: "vlak",
    // The one subtraction this verdict rests on, laid beside the even slide it
    // is being called uneven against. The events of that worst minute stay in
    // the sentence under the fold: they are the only part of this row that
    // cannot be a number.
    metingen: [
      {
        maat: `Worst ${eenheid}, ${klok(van)}–${klok(tot)}`,
        jij: heel(ergste),
        norm: `${heel(val / minuten)} even`,
        verschil: gemerktVerschil(ergste, val / minuten, 0),
      },
      {
        maat: "Share of the whole fall",
        jij: procent(aandeel),
        norm: `${procent(MOMENT_BAND.helft)} median`,
        verschil: null,
      },
      {
        maat: "Readings that lost ground",
        jij: `${verliezend} of ${minuten}`,
        norm: null,
        verschil: null,
      },
    ],
    zin: eenMoment
      ? `It went at once rather than slowly: ${heel(ergste)} of the ${heel(val)} came between ${klok(van)} and ${klok(tot)}, ${procent(aandeel)} of the whole fall in one ${eenheid}.` +
        (feiten.length > 0
          ? ` In it: ${feiten.join("; ")}.`
          : ` The frames name no kill, building or objective in it, so the gold moved on farming rather than on anything this feed reports.`)
      : `It went slowly rather than at once: the worst single ${eenheid} cost ${heel(ergste)} of the ${heel(val)}, ${procent(aandeel)}, and ${verliezend} of the ${minuten} readings lost ground.` +
        (feiten.length > 0 ? ` The worst of them, ${klok(van)} to ${klok(tot)}: ${feiten.join("; ")}.` : ""),
    cijfers:
      `worst ${eenheid} ${heel(ergste)} (${procent(aandeel)}), ${klok(van)} to ${klok(tot)} · ` +
      `an even slide over ${minuten} minutes would be ${heel(val / minuten)} a minute · ` +
      `${verliezend} of ${minuten} readings lost ground`,
    gat: aandeel,
    band: MOMENT_BAND,
    tier: tierVan(aandeel, MOMENT_BAND),
    luidheid: aandeel / MOMENT_BAND.helft,
    grond:
      "The lead's fall from one frame to the next, over the window in the row above. \"At once\" means literally what the band says: more of this fall sat in one minute than did in half the falls measured.",
  });
}

/** "11:40", "11:40 and 13:02", "11:40, 13:02 and 14:10". */
function lijst(delen: string[]): string {
  if (delen.length <= 1) return delen[0] ?? "";
  return `${delen.slice(0, -1).join(", ")} and ${delen[delen.length - 1]}`;
}

const MEERVOUD: Record<SpelGebeurtenis["soort"], [string, string]> = {
  kill: ["a kill", "kills"],
  firstblood: ["first blood", "first bloods"],
  turret: ["a turret", "turrets"],
  inhibitor: ["an inhibitor", "inhibitors"],
  dragon: ["a dragon", "dragons"],
  baron: ["Baron", "Barons"],
};

/**
 * What the frames say was happening between two seconds, told from your side.
 *
 * Half-open on purpose, matching the frames: a change between two readings
 * happened after the first and no later than the second, so an event landing
 * exactly on a boundary belongs to the window whose numbers it moved.
 *
 * Sides come from the killer's seat, and for buildings that is a known hole
 * rather than an oversight. gebeurtenissenUitTimeline drops the wire's `teamId`,
 * which on a BUILDING_KILL is the side that OWNED the building and is filled on
 * every one of them -- while `killerId` is 0 in 156 of the 1,545 buildings
 * measured here, because a minion took the tower. So roughly one building in ten
 * cannot be attributed to a side from what crosses IPC today, and this counts it
 * under neither rather than guessing. Champion kills and elite monsters have the
 * opposite shape: their teamId is always 0, so the killer is the only source
 * there is, and it is missing on 57 of 6,513 kills and 1 of 410 monsters.
 */
function gebeurtenissenIn(
  historie: HistorieTijdlijn,
  detail: GameDetail,
  jij: number,
  van: number,
  tot: number,
): string[] {
  const mijnTeam = detail.players[jij]?.team;
  const binnen = historie.gebeurtenissen.filter((g) => g.at > van && g.at <= tot);
  const uit: string[] = [];

  const mijnDoden = binnen.filter((g) => g.soort === "kill" && g.aan === jij);
  if (mijnDoden.length > 0) uit.push(`you died at ${lijst(mijnDoden.map((g) => klok(g.at)))}`);

  const mijnKills = binnen.filter(
    (g) => g.soort === "kill" && (g.door === jij || g.assists.includes(jij)),
  );
  if (mijnKills.length > 0) {
    uit.push(`you were in ${mijnKills.length} kill${mijnKills.length === 1 ? "" : "s"}`);
  }

  const kantVan = (g: SpelGebeurtenis): "ons" | "hun" | null => {
    if (mijnTeam === undefined || g.door === null) return null;
    const team = detail.players[g.door]?.team;
    return team === undefined ? null : team === mijnTeam ? "ons" : "hun";
  };
  const objectieven = binnen.filter((g) => g.soort !== "kill" && g.soort !== "firstblood");
  const tel = (lijstje: SpelGebeurtenis[]): string => {
    const per = new Map<SpelGebeurtenis["soort"], number>();
    for (const g of lijstje) per.set(g.soort, (per.get(g.soort) ?? 0) + 1);
    return [...per]
      .map(([soort, n]) => (n === 1 ? MEERVOUD[soort][0] : `${n} ${MEERVOUD[soort][1]}`))
      .join(", ");
  };
  const hun = objectieven.filter((g) => kantVan(g) === "hun");
  const ons = objectieven.filter((g) => kantVan(g) === "ons");
  const naamloos = objectieven.filter((g) => kantVan(g) === null);
  if (hun.length > 0) uit.push(`they took ${tel(hun)}`);
  if (ons.length > 0) uit.push(`you took ${tel(ons)}`);
  if (naamloos.length > 0) {
    uit.push(`${tel(naamloos)} fell to nobody the feed names, so neither side is credited`);
  }

  const alleDoden = binnen.filter((g) => g.soort === "kill").length;
  if (alleDoden > 0 && mijnDoden.length === 0 && mijnKills.length === 0) {
    uit.push(`${alleDoden} champion${alleDoden === 1 ? "" : "s"} died, none of them you and none of them to you`);
  }
  return uit;
}
