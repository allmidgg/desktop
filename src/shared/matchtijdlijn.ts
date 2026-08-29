/**
 * The two things the match-history timeline can settle that nothing else here
 * could: how much gold each side had at each minute, and who was actually
 * standing opposite whom.
 *
 * ── What this file is for, next to the ones beside it ────────────────────────
 *
 * core/services/historieTijdlijn.ts turns a timeline into the shapes the
 * existing screens already read -- a Verloop and a per-seat gold series. This
 * file is what those shapes are then asked. It is pure and imports only types,
 * the same rule shared/meting.ts follows, so the renderer can reach it.
 *
 * Everything asserted below was measured against the running client. 120
 * gameIds were drawn in two independent stratified passes across the 126,278
 * non-bot games in data/matches.jsonl; all 120 answered 200 with frames,
 * including games this account never played. One fetch cost 6-41 ms and 41-112
 * KB, which is why fetching when somebody opens a game is affordable and a
 * backfill of 130,000 is not the point.
 *
 * ── 1. Gold, which is the chart everybody knows ──────────────────────────────
 *
 * Tijdlijn.tsx has only ever had *committed* gold -- gold reconstructed from
 * items appearing in an inventory, which moves when somebody visits the shop
 * rather than when they earn anything, and which that file's own comment
 * refuses to read as a rate. totalGold in a frame is the measurement, for all
 * ten seats, in every game in the store.
 *
 * ── 2. Lanes, which turn out to be the harder problem ────────────────────────
 *
 * The head-to-head strip pairs a player against the seat opposite him, and it
 * pairs on the position the stored match record carries. Those labels are bad.
 * Counted over all 126,278 non-bot games: 16,567 (13.12%) come back with every
 * position UNKNOWN, and positions are all-or-nothing -- not one game in the file
 * has a partial set. Worse, only 36,512 games (28.91%) have five distinct lanes
 * on *both* sides. In 73,199 games (57.97%) at least one side puts two players
 * under one label: TOP on 36,935 sides, JUNGLE on 35,921, MIDDLE on 18,533,
 * BOTTOM on 6,895 and SUPPORT on 814, out of 252,556 sides. `duelVan` in
 * meting.ts takes the first seat on the other side carrying the label, so in
 * most games it can hand back the wrong opponent and say nothing about it.
 *
 * The frames fix that, because they say where each player stood and they split
 * the creep score the stored record keeps as one number. Placing seats by
 * measurement instead of by label took the sampled games from 28.9% to 94.2%
 * with five distinct lanes on both sides (113 of 120), and every one of the 120
 * yielded at least one pairing.
 *
 * ── What is not in here ──────────────────────────────────────────────────────
 *
 * Purchases and skill levels. Counted across every event in all 120 games:
 * 4,104 CHAMPION_KILL, 963 BUILDING_KILL, 245 ELITE_MONSTER_KILL, nothing else.
 * No ITEM_PURCHASED and no SKILL_LEVEL_UP, so data/buildorders.jsonl stays the
 * only source for when an item was bought. Two sources side by side; neither
 * replaces the other.
 */
import { krommeVanReeksen, type Kromme } from "./meting";
import type { Position } from "./types";

/* ══ Where everyone stood ════════════════════════════════════════════════════

   Two measured discriminants, applied in that order, because they answer
   different questions and the first is the sharper one.

   Jungle share -- jungle camps as a fraction of a seat's whole creep score --
   separates a jungler from everybody else outright. Measured over 1,082 seats
   that carried a stored label, the median is 0.713 for JUNGLE against 0.019,
   0.009, 0.019 and 0.000 for TOP, MIDDLE, BOTTOM and SUPPORT. Not one TOP,
   MIDDLE or BOTTOM seat in the sample cleared 0.40, and 86.9% of JUNGLE seats
   did. The threshold sits in a gap with nothing in it rather than at a point
   chosen to balance two overlapping piles.

   For everyone else the map does it. x minus y is the diagonal of the Rift --
   observed extent x 676 to 15,075, y 638 to 14,801 -- so top lane runs strongly
   negative and bottom lane strongly positive. Measured medians over minutes 2
   to 10: TOP -9,389 (quartiles -9,615 and -8,989), MIDDLE +327 (deciles -23 and
   +663), BOTTOM +9,991, SUPPORT +9,960. Two bands nine thousand units apart
   with mid inside a few hundred of zero, so a cut at 2,500 is nowhere near
   anything.

   The whole rule, scored against Riot's own label on the sides where the store
   gave five distinct lanes and can therefore be trusted as ground truth: 637 of
   640 seats, 99.5%. The three misses were two TOP seats and one JUNGLE seat
   that spent the laning phase near mid, which is a roam and not a fault in the
   rule. */

/** Jungle share above this is a jungler. Nothing else in the sample came near it. */
export const JUNGLE_DREMPEL = 0.4;
/** How far off the mid diagonal a seat must sit before it counts as a side lane. */
export const BAAN_DREMPEL = 2500;
/** Laning phase in minutes. After it lanes break up and a position stops meaning a lane. */
export const LAANMINUTEN = { van: 2, tot: 10 } as const;
/** The score behind the rule, so a screen can say how much to trust a placement. */
export const BAAN_JUISTHEID = { zitplaatsen: 640, juist: 637 } as const;

/** What one seat's frames say about where it was. */
export interface Laanmeting {
  /** Jungle camps over total creeps at the end of the game, 0-1. */
  jungleAandeel: number;
  /** Median of x - y over the laning phase, or null when the game was too short. */
  diagonaal: number | null;
  /** Lane minions only, at the end. Splits the bot pair; the store cannot. */
  laanCreeps: number;
}

/** The lane one seat was in, from its own frames rather than from a label. */
export function baanVan(meting: Laanmeting): Position {
  if (meting.jungleAandeel > JUNGLE_DREMPEL) return "JUNGLE";
  if (meting.diagonaal === null) return "UNKNOWN";
  if (meting.diagonaal < -BAAN_DREMPEL) return "TOP";
  if (meting.diagonaal > BAAN_DREMPEL) return "BOTTOM";
  return "MIDDLE";
}

/**
 * The minimum of a raw frame this file needs.
 *
 * Written out structurally rather than imported from core/lcu/timeline.ts so
 * that this stays a file the renderer can pull in without dragging the League
 * client behind it. The real GameTimeline satisfies it.
 */
export interface FrameVoorBaan {
  timestamp: number;
  participantFrames: Record<string, {
    minionsKilled: number;
    jungleMinionsKilled: number;
    position: { x: number; y: number };
  }>;
}

const mediaan = (waarden: number[]): number | null => {
  if (waarden.length === 0) return null;
  const gesorteerd = [...waarden].sort((a, b) => a - b);
  return gesorteerd[Math.floor(gesorteerd.length / 2)] ?? null;
};

/**
 * Reads the placement out of the frames, in the main process, and throws the
 * coordinates away.
 *
 * The map positions are the bulk of a 41-112 KB response and they answer
 * exactly one question. Keeping forty minutes of coordinates for ten players so
 * the renderer can compute a median it will never recompute would be paying the
 * whole payload for one word per seat.
 *
 * The median of the laning-phase diagonal, not the mean: one death walk across
 * the map drags a mean off its lane, and a lane is where somebody spent the
 * minutes rather than where they averaged.
 */
export function laanmetingenUit(frames: FrameVoorBaan[], aantalStoelen: number): Laanmeting[] {
  const metingen: Laanmeting[] = [];
  for (let stoel = 0; stoel < aantalStoelen; stoel++) {
    const sleutel = String(stoel + 1);
    const diagonalen: number[] = [];
    let laatste: { minionsKilled: number; jungleMinionsKilled: number } | null = null;
    for (const frame of frames) {
      const pf = frame.participantFrames[sleutel];
      if (!pf) continue;
      laatste = pf;
      const minuut = Math.round(frame.timestamp / 60000);
      if (pf.position && minuut >= LAANMINUTEN.van && minuut <= LAANMINUTEN.tot) {
        diagonalen.push(pf.position.x - pf.position.y);
      }
    }
    const totaal = laatste ? laatste.minionsKilled + laatste.jungleMinionsKilled : 0;
    metingen.push({
      jungleAandeel: totaal > 0 ? (laatste?.jungleMinionsKilled ?? 0) / totaal : 0,
      diagonaal: mediaan(diagonalen),
      laanCreeps: laatste?.minionsKilled ?? 0,
    });
  }
  return metingen;
}

/**
 * All ten lanes at once, which is the only level at which bot can be resolved.
 *
 * The marksman and the support stand in the same place, so the diagonal puts
 * both on BOTTOM and only the creeps can separate them: the one eating lane
 * minions is the carry. That is a comparison between two seats, not a property
 * of either, which is why this takes the whole side and baanVan does not.
 *
 * `kanten` is where each seat sits, so this does not have to assume the first
 * five are blue. (They are -- participants 1-5 were teamId 100 in all 120
 * sampled games -- but the caller already knows it and passing it costs
 * nothing.)
 */
export function banenVan(
  /**
   * Nullable per seat, because these arrive re-indexed. When a recording and a
   * timeline are lined up on champion (shared/samenloop.ts) a seat whose
   * champion could not be matched has no measurement at all, and the honest
   * answer for that seat is UNKNOWN rather than the lane of whichever seat
   * happened to sit at the same index in the other source.
   */
  metingen: Array<Laanmeting | null>,
  kanten: Array<"ORDER" | "CHAOS" | "UNKNOWN">,
): Position[] {
  const banen = metingen.map((m) => (m === null ? ("UNKNOWN" as Position) : baanVan(m)));
  for (const kant of ["ORDER", "CHAOS"] as const) {
    const bot = banen
      .map((baan, i) => ({ baan, i }))
      .filter(({ baan, i }) => baan === "BOTTOM" && kanten[i] === kant)
      .sort((a, b) => (metingen[b.i]?.laanCreeps ?? 0) - (metingen[a.i]?.laanCreeps ?? 0));
    for (const { i } of bot.slice(1)) banen[i] = "SUPPORT";
  }
  return banen;
}

/**
 * The seat directly opposite another one, by measured lane.
 *
 * Deliberately the same shape as `duelVan` in meting.ts so a caller can try
 * this first and fall back to that. The difference is only that this refuses to
 * guess where that one silently does: it answers when exactly one seat on the
 * other side shares the measured lane, and null when two do. Two opponents in
 * one lane is a real thing -- a lane swap, a bot lane that never split -- and
 * picking one of them is the guess this exists to avoid.
 */
export function duelUitBanen(
  banen: Position[],
  kanten: Array<"ORDER" | "CHAOS" | "UNKNOWN">,
  anker: number,
): { orde: number; chaos: number } | null {
  const mijnBaan = banen[anker];
  const mijnKant = kanten[anker];
  if (!mijnBaan || mijnBaan === "UNKNOWN" || !mijnKant || mijnKant === "UNKNOWN") return null;

  const anders = mijnKant === "ORDER" ? "CHAOS" : "ORDER";
  const kandidaten = banen.flatMap((baan, i) =>
    i !== anker && kanten[i] === anders && baan === mijnBaan ? [i] : [],
  );
  if (kandidaten.length !== 1) return null;
  const tegenover = kandidaten[0]!;

  return mijnKant === "ORDER" ? { orde: anker, chaos: tegenover } : { orde: tegenover, chaos: anker };
}

/**
 * What a lane normally looks like at minute 15, so a gap can be read.
 *
 * The median and ninth decile of the absolute gold and creep gap between a seat
 * and the seat measured opposite it, over the 117 sampled games where a pairing
 * could be made. A player forty creeps down wants to know whether forty is a
 * lot; these are the only numbers in this app that answer that out of Classic
 * games rather than out of folklore.
 */
export const LAANNORM_15: Readonly<
  Record<Exclude<Position, "UNKNOWN">, { games: number; goud: number; goudP90: number; cs: number; csP90: number }>
> = {
  TOP: { games: 114, goud: 1249, goudP90: 2895, cs: 26, csP90: 64 },
  JUNGLE: { games: 114, goud: 953, goudP90: 1915, cs: 12, csP90: 33 },
  MIDDLE: { games: 115, goud: 1002, goudP90: 2456, cs: 20, csP90: 45 },
  BOTTOM: { games: 117, goud: 1172, goudP90: 2415, cs: 16, csP90: 45 },
  SUPPORT: { games: 117, goud: 673, goudP90: 1662, cs: 6, csP90: 19 },
};

/* ══ The gold curve ══════════════════════════════════════════════════════════

   Hands back the same Kromme that shared/meting.ts defines and that
   Duelkromme.tsx already draws, so nothing here draws anything and there is no
   second curve renderer. The only difference from krommeVan is where the
   numbers came from: that one reads the recording this machine made, this one
   reads the gold series match history serves for every game. */

/**
 * Total gold for two sets of seats, at every minute both sets were readable.
 *
 * A one-line call, and deliberately so. It used to carry its own copy of
 * krommeVan's summing rule -- carry a seat's last value forward, skip the whole
 * sample while a seat has never been read -- which is the right rule for gold,
 * because total gold only goes up, so a missed frame means the number was at
 * least what it last was while a zero would draw a team briefly losing a player.
 * Being the right rule is precisely why it must not be written down twice. It
 * now lives once, in meting.ts, and this names what the numbers are.
 *
 * (Measured, the missing-seat branch never fires: all ten participantFrames were
 * present in every frame of all 120 sampled games. It matters anyway, because a
 * cumulative counter that appears to fall is the one artefact a reader cannot
 * tell apart from a real event.)
 *
 * `tijden` is the axis and is never reconstructed from the index. Over 1,987
 * gaps in the first sample only 27 were exactly 60,000 ms; the rest ran 60,002
 * to 60,028. More to the point, the last frame is not on a minute at all -- it
 * is the clock the game ended on, in 103 of 120 games -- and its totals are the
 * final totals.
 */
export function goudkromme(
  tijden: number[] | null | undefined,
  goudPerStoel: Array<Array<number | null>> | null | undefined,
  orde: number[],
  chaos: number[],
): Kromme {
  return krommeVanReeksen(tijden, goudPerStoel, orde, chaos);
}

/* ── Gold diff at ten and at fifteen ─────────────────────────────────────────

   Both checkpoints are worth showing here, and the measurement is what says so
   rather than the convention.

   Length first, because a checkpoint past the end of most games is a checkpoint
   about nothing. Over all 126,278 non-bot games in the store the mean length is
   30.00 minutes and the median 30.42, quartiles 25.00 and 35.37, deciles 18.20
   and 40.08. (The figure passed around as "about 32" is a couple of minutes
   long.) 99.11% of games reach 10:00 and 97.99% reach 15:00, so both land
   inside almost every game; 86.89% reach 20:00, so a third checkpoint there
   would already be silent on one game in eight.

   Then whether the number separates anything. Over the 120 sampled timelines:

     minute 10   median side gold 14,126   median lead 1,562   leader won 72.5% (n=120)
     minute 15   median side gold 23,080   median lead 3,167   leader won 75.2% (n=117)

   Both intervals are wide at this sample size -- 63.9-79.7% and 66.7-82.2% at
   95% -- so the honest claim is "clearly better than a coin flip", not a
   decimal place. The sharper finding is that the width of the lead carries the
   signal and its sign alone does not:

     lead >= 2,000 at minute 10   leader won 89.6%  (n=48, 95% CI 77.8-95.5)
     lead >= 2,000 at minute 15   leader won 89.3%  (n=75, 95% CI 80.3-94.5)
     lead <  1,000 at minute 15   leader won 53.3%  (n=30)

   Which is exactly why the screen prints the number and a weight, never a
   verdict. A badge reading "ahead at 15" over a 700-gold lead would be a
   confident statement about a coin toss.

   One measured caution, and it is the reason the curve matters more than the
   checkpoint: the side leading at minute 15 was not the side leading at the
   final frame in 29 of 117 games (24.8%), and from minute 10 in 35 of 120
   (29.2%). Close to one game in four turns round after the number everybody
   quotes. */

/** The two checkpoints, in minutes. Twenty is deliberately not one; see above. */
export const IJKMINUTEN = [10, 15] as const;

/** Under this, a lead is not evidence. 30 sampled games sat here at 15 and split 16-14. */
export const NIETSZEGGEND_VERSCHIL = 1000;

/** From this, the leader won 89% of the sampled games at both checkpoints. */
export const BESLISSEND_VERSCHIL = 2000;

/** How near a frame has to sit to a whole minute before it may answer for it. */
const MINUUT_SPELING = 30;

export interface IJkpunt {
  minuut: number;
  /** Blue minus red, in gold. Positive always means blue. */
  verschil: number;
  ordeGoud: number;
  chaosGoud: number;
  /** False when the game ended before this minute. Then nothing else here means anything. */
  bereikt: boolean;
  /** What the measurement above licenses this lead to claim. */
  gewicht: "geen" | "smal" | "breed";
}

/**
 * The gold difference at a whole minute, or an honest "never got there".
 *
 * Looks the minute up on the clock and not by index. Index would very nearly
 * work -- every non-final frame in the sample sat within a second of its minute,
 * 3,686 of 3,686 -- but the final frame is the game's end clock, so an index
 * walk off the end of a short game would report the scoreline at the final horn
 * as "at 15" and look exactly like a real reading.
 */
export function ijkpuntVan(
  tijden: number[] | null | undefined,
  goudPerStoel: Array<Array<number | null>> | null | undefined,
  orde: number[],
  chaos: number[],
  minuut: number,
): IJkpunt {
  const leeg: IJkpunt = {
    minuut, verschil: 0, ordeGoud: 0, chaosGoud: 0, bereikt: false, gewicht: "geen",
  };
  if (!tijden || !goudPerStoel) return leeg;

  const doel = minuut * 60;
  let index = -1;
  for (let i = 0; i < tijden.length; i++) {
    if (Math.abs((tijden[i] ?? 0) - doel) <= MINUUT_SPELING) index = i;
    if ((tijden[i] ?? 0) > doel + MINUUT_SPELING) break;
  }
  if (index < 0) return leeg;

  const kromme = goudkromme(tijden.slice(0, index + 1), goudPerStoel, orde, chaos);
  const punt = kromme.punten[kromme.punten.length - 1];
  if (!punt || punt.t !== tijden[index]) return leeg;

  const verschil = punt.orde - punt.chaos;
  const breed = Math.abs(verschil);
  return {
    minuut,
    verschil,
    ordeGoud: punt.orde,
    chaosGoud: punt.chaos,
    bereikt: true,
    gewicht: breed < NIETSZEGGEND_VERSCHIL ? "geen" : breed < BESLISSEND_VERSCHIL ? "smal" : "breed",
  };
}
