/**
 * Turning the recorded readings into something a chart can plot.
 *
 * The event feed answers "what was announced"; these readings answer the
 * different and harder question of what the numbers were doing between the
 * announcements. A dragon at 14:02 is on the feed. The two minutes of farming
 * that were given up setting it up are only in here.
 *
 * Lives in shared for the reason shared/build.ts gives -- the renderer needs it
 * and core/services drags the League client and undici into the bundle -- and it
 * imports nothing but a type.
 *
 * ── The one rule this file follows ───────────────────────────────────────────
 *
 * Everything returned is a number the game reported or a subtraction of two of
 * them. There is no composite "who is ahead", and that is a decision rather than
 * an omission. A single figure mixing creeps, kills and levels needs weights;
 * nothing measured anywhere in this repository supplies them; and an invented
 * weight produces a curve whose dips cannot be explained by the person reading
 * it -- which is the one thing this screen exists to let him do. So the axis
 * carries one measured quantity at a time, in its own unit, and says which.
 */
import type { Verloop, VerloopKolommen } from "./types";

/** The six the sampler keeps for all ten seats, and the only things that go on the axis. */
export type MeetVeld = keyof VerloopKolommen;

/** One reading of both sides at one second. The same shape the gold curve uses. */
export interface Punt {
  t: number;
  orde: number;
  chaos: number;
}

export interface Kromme {
  punten: Punt[];
  /** Highest either side reached, floored at 1 so a flat series still scales. */
  max: number;
  /** Widest the gap ever got, floored at 1 for the same reason. */
  maxVoorsprong: number;
  /**
   * The first second everything drawn here was actually being read.
   *
   * Not always zero. The sampler starts when the app starts watching, so joining
   * a game in progress -- or a reconnect -- leaves the opening minutes unmeasured
   * for some seats. The curve begins where the measurement begins and the screen
   * says so, because a line leaving zero at 0:00 for a player who was already on
   * forty creeps is a drawing of something that did not happen.
   */
  vanaf: number;
  /** Readings that were dropped because a seat had no value yet. Said out loud. */
  overgeslagen: number;
}

const LEEG: Kromme = { punten: [], max: 1, maxVoorsprong: 1, vanaf: 0, overgeslagen: 0 };

/**
 * Sums one field over a set of seats, at every second both sides were readable.
 *
 * Two rules, and both change what the picture claims.
 *
 * A seat missing from one reading is carried forward from its previous one
 * rather than counted as zero. All six of these are counters that only go up, so
 * a missed poll means the number was at least what it last was; carrying it is
 * the conservative reading, while a zero would draw a whole team dropping to
 * nothing for one sample and back, which is a spike nobody played.
 *
 * A seat with no previous reading is not filled at all and the whole sample is
 * skipped, for both sides at once. Before a seat's first reading its value is
 * unknown rather than zero, and summing the four that are known would draw a
 * team quietly missing a player. How many were skipped is returned, because a
 * curve that starts at 3:20 has to be able to say why.
 */
export function krommeVan(
  verloop: Verloop | null | undefined,
  orde: number[],
  chaos: number[],
  veld: MeetVeld,
): Kromme {
  if (!verloop || verloop.tijden.length === 0) return LEEG;
  if (orde.length === 0 || chaos.length === 0) return LEEG;

  const laatst = new Map<number, number>();
  const punten: Punt[] = [];
  let overgeslagen = 0;

  const som = (zitplaatsen: number[], i: number): number | null => {
    let totaal = 0;
    for (const zit of zitplaatsen) {
      const gelezen = verloop.spelers[zit]?.[veld]?.[i];
      if (typeof gelezen === "number") {
        laatst.set(zit, gelezen);
        totaal += gelezen;
      } else {
        const eerder = laatst.get(zit);
        if (eerder === undefined) return null;
        totaal += eerder;
      }
    }
    return totaal;
  };

  for (let i = 0; i < verloop.tijden.length; i++) {
    // Both sides are summed before either is accepted. A real total for one side
    // against a stale one for the other is a gap that was never measured.
    const o = som(orde, i);
    const c = som(chaos, i);
    if (o === null || c === null) {
      overgeslagen++;
      continue;
    }
    punten.push({ t: verloop.tijden[i] ?? 0, orde: o, chaos: c });
  }

  if (punten.length === 0) return { ...LEEG, overgeslagen };
  return {
    punten,
    max: Math.max(1, ...punten.map((p) => Math.max(p.orde, p.chaos))),
    maxVoorsprong: Math.max(1, ...punten.map((p) => Math.abs(p.orde - p.chaos))),
    vanaf: punten[0]?.t ?? 0,
    overgeslagen,
  };
}

/**
 * The same curve, for a series that does not live in a Verloop.
 *
 * Gold is the one measured quantity in this app that is kept beside the readings
 * rather than inside them -- see HistorieTijdlijn.goudPerStoel and the reason it
 * is not a VerloopKolommen column -- so it would otherwise need its own summing
 * loop. It had one, in shared/matchtijdlijn.ts, and it was a line-for-line copy
 * of krommeVan: carry a seat's last value forward, skip the whole sample while a
 * seat has never been read. Two copies of that rule is exactly what the note at
 * the foot of this file describes going stale in silence, so the series is
 * projected into a throwaway Verloop and the one implementation reads it.
 *
 * The projection is into `cs` for no reason other than that it is a column that
 * exists; nothing downstream sees the throwaway.
 */
export function krommeVanReeksen(
  tijden: number[] | null | undefined,
  perStoel: Array<Array<number | null>> | null | undefined,
  orde: number[],
  chaos: number[],
): Kromme {
  if (!tijden || tijden.length === 0 || !perStoel) return LEEG;
  const leeg = (n: number): Array<number | null> => new Array<number | null>(n).fill(null);
  const verloop: Verloop = {
    interval: 0,
    tijden,
    goud: leeg(tijden.length),
    spelers: perStoel.map((kolom) => ({
      kills: leeg(kolom.length),
      deaths: leeg(kolom.length),
      assists: leeg(kolom.length),
      cs: kolom,
      wards: leeg(kolom.length),
      level: leeg(kolom.length),
    })),
  };
  return krommeVan(verloop, orde, chaos, "cs");
}

/**
 * The reading in force at a second: the last one taken at or before it.
 *
 * Held flat rather than interpolated, on purpose. Between two readings nobody
 * knows what the number was, and sloping across the gap draws a measurement that
 * was never taken. It is the same argument stapPad already makes about purchases
 * in the chart above, applied to the thing that is sampled instead of watched.
 */
export function puntOp(punten: Punt[], seconde: number): Punt {
  let uit: Punt = { t: 0, orde: 0, chaos: 0 };
  for (const p of punten) {
    if (p.t > seconde) break;
    uit = p;
  }
  return uit;
}

/** Blue minus red, from the side asking. Positive means that side is ahead. */
export const voorsprongVan = (p: Punt, kant: "ORDER" | "CHAOS"): number =>
  kant === "ORDER" ? p.orde - p.chaos : p.chaos - p.orde;

/** Two seats facing each other, by side. */
export interface Duel {
  orde: number;
  chaos: number;
}

/**
 * The seat directly opposite another one.
 *
 * This is the comparison a player actually wants, and the reason the recording
 * keeps positions at all. "My team fell behind" is a fact about nine other
 * people; "I was forty creeps down on the man I was standing next to" is a fact
 * about the person reading the screen.
 *
 * Returns nothing when it cannot be answered honestly. The anchor needs a side
 * and a lane, and exactly one player on the other side has to be in that lane.
 * Positions do go missing, and often: of the 126,287 non-bot games in
 * data/matches.jsonl, 16,569 -- 13.12% -- came back with every position on
 * UNKNOWN. Always all ten seats at once, never a stray one: counted over the
 * whole file, the number of games with a partial set of positions is zero. So
 * this is a property of the record rather than of a player, and a recording made
 * from a client that reported no position is the same case. Guessing an opponent
 * there would put a jungler's creep score against a support's and call it a lane.
 */
export function duelVan(
  zitplaatsen: Array<{ team: "ORDER" | "CHAOS" | "UNKNOWN"; position: string | null }>,
  anker: number,
): Duel | null {
  const mij = zitplaatsen[anker];
  if (!mij || mij.team === "UNKNOWN" || !mij.position) return null;

  const anders = mij.team === "ORDER" ? "CHAOS" : "ORDER";
  const tegenover = zitplaatsen.findIndex(
    (z, i) => i !== anker && z.team === anders && z.position === mij.position,
  );
  if (tegenover === -1) return null;

  return mij.team === "ORDER" ? { orde: anker, chaos: tegenover } : { orde: tegenover, chaos: anker };
}

/* The search for the worst stretch used to live here as `ergsteVal`, and a
   second copy of it lived inside Tijdlijn.tsx. Both are gone: shared/omslag.ts
   does it once, against the champion's own norm, and the answer is passed to
   whatever wants to draw it.

   Keeping a second one here was not merely redundant. This one measured a fall
   in the lead and nothing else, so it answered on every game -- a lead that
   drifted down by two creeps over a quiet minute came back as a finding, in the
   same words and the same red as a lane that collapsed. omslag.ts charges every
   minute half of what the champion normally produces before it may count, which
   is what makes a reported stretch mean something a reader can act on. */
