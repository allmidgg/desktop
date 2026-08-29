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

/**
 * One line of a verdict as three aligned cells rather than as a clause.
 *
 * The screen prints a verdict as a table: the quantity, your figure, what it was
 * held against, and the distance between the two. The sentence is still written
 * and still says the same thing -- it moves behind the row's own fold, where a
 * reader who wants the claim spelled out can have it -- but the open surface is
 * numbers in columns, which is what the owner asked for and what the rest of this
 * app already is.
 *
 * Nothing here is a new measurement. Every cell is built from the same variables
 * the sentence beside it is built from, in the same function, so the table and
 * the sentence cannot come to disagree.
 *
 * The cells are strings because the producer is the only thing that knows how
 * many decimals its figure honestly carries -- 0.62 kills a minute and 147 CS are
 * not the same kind of number -- and a renderer that rounded them again would be
 * a second opinion about precision.
 */
export interface Meting {
  /** The quantity, in the small-caps label voice the app uses: "CS / min". */
  maat: string;
  /** Your figure. */
  jij: string;
  /**
   * What your figure is held against: a norm, an opponent, or the median gap.
   *
   * Null when nothing measures this. Damage and vision have no average anywhere
   * and never will, and an empty cell says that far more honestly than a filled
   * one -- a column that is blank on exactly the rows nothing measures is the
   * absence made visible instead of explained.
   */
  norm: string | null;
  /** The distance between the two, signed. Null when there is nothing to subtract. */
  verschil: string | null;
}

export interface Uitspraak {
  sleutel: OordeelSleutel;
  /** The heading the row carries: Farming, Fights, Dying, Lane. */
  gebied: string;
  /** Green when this went your way, red when it did not, grey when neither. */
  toon: "goed" | "slecht" | "vlak";
  /**
   * The row on the open surface: one to four lines of figures in columns.
   *
   * This is what the screen draws. `zin`, `cijfers`, `band` and `grond` are the
   * same finding written out, and they sit behind the fold on the row.
   */
  metingen: Meting[];
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

/**
 * A difference with its sign in front, for the column that is a difference.
 *
 * Every formatter above takes an absolute value, because the sentences put the
 * direction in words -- "48 CS behind". A table column has no room for a word, so
 * the sign has to carry it, and it is the typographic minus the rest of the app
 * uses rather than a hyphen.
 *
 * A figure that rounded to zero never gets a sign. "−0" claims a direction that
 * the rounding has just thrown away, and it is the one output of this function a
 * reader would be right to call a bug.
 */
export const gemerkt = (n: number, toon: (waarde: number) => string = heel): string => {
  const cijfer = toon(n);
  if (/^[0.,]*$/.test(cijfer)) return cijfer;
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${cijfer}`;
};

/**
 * The gap between two figures, at the precision the two figures are printed at.
 *
 * Subtracting the raw values and rounding the answer is the obvious way to do
 * this and it is wrong on a screen. A game at 0.606 deaths a minute against a
 * norm of 2.204 prints as 0.61 and 2.20, and the exact gap of 1.598 prints as
 * 1.60 -- so the reader subtracts the two numbers in front of him, gets 1.59,
 * and has caught the app out in an arithmetic error it did not make. Rounding
 * both sides first costs a thousandth of a death and buys a column that adds up.
 *
 * `decimalen` is the wider of the two cells' precisions, because that is the
 * precision the reader is subtracting at: 4 deaths against 6.0 is a gap of 2.0
 * and not of 2.
 */
export const gemerktVerschil = (jij: number, norm: number, decimalen: number): string => {
  const factor = 10 ** decimalen;
  const gat = Math.round(jij * factor) / factor - Math.round(norm * factor) / factor;
  return gemerkt(gat, (n) => komma(Math.abs(n), decimalen));
};

/** mm:ss, from a count of seconds. */
export const klok = (seconden: number): string =>
  `${Math.floor(Math.max(0, seconden) / 60)}:${String(Math.floor(Math.max(0, seconden) % 60)).padStart(2, "0")}`;
