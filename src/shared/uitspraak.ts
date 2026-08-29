/**
 * The vocabulary a verdict is written in, shared by everything that writes one.
 *
 * This file holds no judgements of its own. It exists because oordeel.ts and
 * tijdvak.ts both turn a measured gap into a sentence with a printed cut point
 * underneath it, and they must agree on what "past the halfway mark" means down
 * to the comparison operator. Two copies of `tierVan` would be two definitions
 * of "unusual" that drift apart the first time either is touched, and the reader
 * would have no way to see that the two blocks on his screen were scored by
 * different rules.
 *
 * It is also what keeps the two modules from importing each other. oordeel.ts
 * calls into tijdvak.ts; if tijdvak.ts had to reach back for `Band` and
 * `tierVan`, the two would form a cycle that works today and breaks the moment
 * either one does something at module-evaluation time. The vocabulary sits
 * below both instead.
 */

export type OordeelSleutel =
  | "cs" | "goud" | "gevechten" | "sterven" | "lane" | "schade" | "visie" | "venster"
  // The four that only exist once a per-minute timeline is on hand. Each is a
  // question end-of-game totals cannot be asked at all -- see tijdvak.ts.
  | "laning" | "naLaning" | "voorsprong" | "instorting";

/**
 * The two cut points a gap is read against, and the sample behind them.
 *
 * `helft` is the median gap in the sample and `staart` the ninetieth percentile.
 * `maat` travels with the numbers because some cut points are fractions and some
 * are counts of gold, and a cut point whose unit is not on screen is a number
 * the reader has no way to check.
 */
export interface Band {
  helft: number;
  staart: number;
  maat: string;
  slots: number;
  /**
   * True when the two cut points are fractions rather than a count.
   *
   * The screen has to print 0.174 as "17.4%" and 2,790 as "2,790", and a
   * renderer deciding that from the key would have to know which keys are which.
   */
  ratio: boolean;
  /**
   * What `slots` counts and where it came from, as the noun phrase that follows
   * the number: the screen prints "over {slots} {herkomst}".
   *
   * So it must begin with the unit -- "player slots in 126,246 non-bot games
   * from the local match store" -- and must never begin with a figure of its
   * own, or the row reads "over 192 99 timelines".
   *
   * Not decoration. The bands in oordeel.ts stand on 1,096,820 player slots read
   * off the local match store; the bands in tijdvak.ts stand on a few hundred
   * observations read out of timelines fetched from the client. Those are not
   * the same strength of claim, and the reader is entitled to see which one he
   * is looking at before believing a sentence built on it.
   */
  herkomst: string;
}

/** Where a gap fell relative to its band. Named, because the screen prints it. */
export type Tier = "binnen" | "buiten" | "ver";

export interface Uitspraak {
  sleutel: OordeelSleutel;
  /** The heading the row carries: Farming, Fights, Dying, Lane. */
  gebied: string;
  /** Green when this went your way, red when it did not, grey when neither. */
  toon: "goed" | "slecht" | "vlak";
  /** The sentence itself, already carrying its own numbers. */
  zin: string;
  /** Your figure and the reference, in the units the sentence used. */
  cijfers: string;
  /** The gap, in the band's unit. Null for the rows that have no band. */
  gat: number | null;
  band: Band | null;
  tier: Tier | null;
  /**
   * Gap divided by the band's median, so figures with different natural spreads
   * can be ordered against each other. A jungler 0.158 off on CS and one 0.344
   * off on deaths both come out at 1.0, which is right: each is exactly the gap
   * an ordinary game produces on that figure in that lane.
   */
  luidheid: number | null;
  /** Where both numbers came from, in one sentence. */
  grond: string;
}

/** One thing this game cannot be asked, and the reason it cannot. */
export interface Zwijgen {
  onderwerp: string;
  reden: string;
}

/** Where a gap sits against its band. The one definition of "unusual" there is. */
export function tierVan(gat: number, band: Band): Tier {
  if (gat < band.helft) return "binnen";
  return gat < band.staart ? "buiten" : "ver";
}

export const heel = (n: number): string => Math.round(Math.abs(n)).toLocaleString("en-GB");

export const komma = (n: number, d: number): string =>
  n.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * A gap, rounded, but never rounded to nothing.
 *
 * A short game against a champion that normally dies four times can clear the
 * band on a difference of half a death, and "0 fewer deaths than normal" is the
 * sentence a rounding bug writes. Under one, the decimal stays.
 */
export const verschil = (n: number): string =>
  Math.abs(n) >= 1 ? heel(n) : komma(Math.abs(n), 1);

export const procent = (deel: number): string => `${Math.round(deel * 100)}%`;

/** mm:ss, from a count of seconds. */
export const klok = (seconden: number): string =>
  `${Math.floor(Math.max(0, seconden) / 60)}:${String(Math.floor(Math.max(0, seconden) % 60)).padStart(2, "0")}`;
