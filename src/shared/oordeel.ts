/**
 * The other half of the post-game question: what went well, and what did not.
 *
 * IjkBlok already draws your line beside the champion's normal line in that
 * lane. It draws it as six measuring sticks, which is the right shape for
 * checking a number and the wrong shape for being told something. "2.4 against
 * 3.1 CS per minute" is a reading; "18 CS behind a normal Nasus TOP over these
 * 34 minutes" is the same fact with the stake put back in, and the stake is what
 * the owner asked for.
 *
 * So this module says the sentences and IjkBlok keeps the sticks. Nothing here
 * invents a comparison the block above does not already make: the four verdicts
 * that carry a database norm read csPerMin, goldPerMin, kills, deaths and
 * assists straight off the same PerformanceBaseline, and no new field crosses
 * IPC for any of it. The per-minute norms the block above does not print --
 * kills-plus-assists per minute, deaths per minute -- fall out of the per-game
 * averages divided by averageMinutes, which is exactly the ratio of the totals
 * the tally holds, because both sides were divided by the same game count.
 *
 * KDA is deliberately not a sentence here. It is kills, deaths and assists a
 * second time, and a verdict list that says "you died a lot" and then "your KDA
 * was low" is one observation wearing two hats.
 *
 * ── Why every verdict carries a band ─────────────────────────────────────────
 *
 * A gap is only worth a sentence if it is bigger than the gap an ordinary game
 * produces, and that size is different for every figure and for every lane.
 * Measured over matches.jsonl the way the app itself measures -- bot queue
 * dropped, players with no resolved position dropped, each slot against its own
 * champion-lane baseline -- the median |yours / normal - 1| is 0.128 on gold in
 * the toplane and 0.391 on CS as a support. One threshold across all of it would
 * call half of every support's farming remarkable while calling almost nothing
 * about anyone's gold worth mentioning. Each figure in each lane gets its own two
 * cut points instead, both printed on screen beside the sentence they let
 * through, so the reader can see what the app means by "unusual" before deciding
 * to believe it.
 *
 * ── What this refuses to say ─────────────────────────────────────────────────
 *
 * Damage, damage taken, vision and wards are optional on StoredPlayer, and not
 * one of the 130,095 games in matches.jsonl carries any of them -- the string
 * "damage" does not occur in the file at all. There is consequently no damage
 * average anywhere to compare against, today or after any amount of crawling,
 * and there never will be for the games already stored. So damage and vision are
 * printed as bare figures with no verdict attached and no colour, and when they
 * are missing the block says so out loud rather than leaving a gap the reader
 * has to notice.
 */
import type {
  GameDetail, GameDetailPlayer, GameTijdlijn, PerformanceBaseline, Position,
} from "./types";
import type { Naspel, NaspelSpeler } from "./naspel";

export type OordeelSleutel =
  | "cs" | "goud" | "gevechten" | "sterven" | "lane" | "schade" | "visie" | "venster";

/**
 * The two cut points a gap is read against, and the sample behind them.
 *
 * `helft` is the median gap and `staart` the ninetieth percentile, both over the
 * same population the app scores: 1,096,820 player slots in 126,246 non-bot
 * games from matches.jsonl, each measured against its own champion-in-lane
 * baseline under the 30-game floor MIN_BASELINE_GAMES sets. All 315 champion-
 * lane pairs in that file clear the floor, so nothing was dropped for thinness.
 *
 * `maat` travels with the numbers because the four figures below are measured as
 * fractions of a norm and the lane duel is measured in gold, and a cut point
 * whose unit is not on screen is a number the reader has no way to check.
 */
export interface Band {
  helft: number;
  staart: number;
  maat: string;
  slots: number;
  /**
   * True when the two cut points are fractions of the norm rather than a count.
   *
   * The screen has to print 0.174 as "17.4%" and 2,790 as "2,790 gold", and a
   * renderer deciding that from the key would have to know which keys are which.
   */
  ratio: boolean;
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
  /** Your figure and the norm, in the units the sentence used. */
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

export interface Oordeel {
  /** Verdicts against the database, loudest first. */
  tegenDatabase: Uitspraak[];
  /** Figures with no database norm behind them. Never coloured, never a verdict. */
  binnenDezeGame: Uitspraak[];
  /** Areas that came out inside their band, named rather than drawn as rows. */
  gewoon: string[];
  zwijgt: Zwijgen[];
}

/**
 * The bands, measured rather than chosen, and split by lane because one of them
 * had to be.
 *
 * Produced by streaming data/matches.jsonl and mirroring JadeStats.ingest
 * exactly: queue 4320 skipped, position UNKNOWN skipped (165,640 slots), totals
 * summed per champion-lane and divided at the end. Then a second pass measuring
 * every remaining slot against that table. Recomputing these at runtime would
 * cost two passes over the whole store every time a game is opened, for cut
 * points that move in the third decimal as games are added; they are constants
 * with their derivation written down instead.
 *
 * Splitting by lane is not symmetry for its own sake. Gold, fights and deaths
 * barely move between lanes -- the median gold gap is 0.127 in mid and 0.136 in
 * bot -- but CS does not behave at all: 0.158 in the jungle against 0.391 on
 * support, because a support's normal farm is under one creep a minute and
 * everything divided by a small number swings. A single pooled CS cut point
 * called an ordinary support game remarkable, which is the same failure the MVP
 * rule in naspel.ts was rebuilt to get rid of, arriving through a different
 * door.
 */
const RATIO_MAAT = "|yours ÷ normal − 1|";

type RatioSleutel = "cs" | "goud" | "gevechten" | "sterven";

const ratioBand = (helft: number, staart: number, slots: number): Band => ({
  helft, staart, maat: RATIO_MAAT, slots, ratio: true,
});

export const BANDEN: Record<string, Record<RatioSleutel, Band>> = {
  TOP: {
    cs: ratioBand(0.174, 0.492, 228_759),
    goud: ratioBand(0.128, 0.308, 228_759),
    gevechten: ratioBand(0.322, 0.757, 228_759),
    sterven: ratioBand(0.312, 0.769, 228_759),
  },
  JUNGLE: {
    cs: ratioBand(0.158, 0.397, 254_729),
    goud: ratioBand(0.128, 0.306, 254_729),
    gevechten: ratioBand(0.298, 0.707, 254_729),
    sterven: ratioBand(0.344, 0.808, 254_729),
  },
  MIDDLE: {
    cs: ratioBand(0.169, 0.455, 224_231),
    goud: ratioBand(0.127, 0.302, 224_231),
    gevechten: ratioBand(0.303, 0.715, 224_231),
    sterven: ratioBand(0.308, 0.756, 224_231),
  },
  BOTTOM: {
    cs: ratioBand(0.182, 0.521, 218_809),
    goud: ratioBand(0.136, 0.322, 218_809),
    gevechten: ratioBand(0.311, 0.726, 218_809),
    sterven: ratioBand(0.306, 0.740, 218_809),
  },
  SUPPORT: {
    cs: ratioBand(0.391, 0.861, 170_292),
    goud: ratioBand(0.128, 0.305, 170_292),
    gevechten: ratioBand(0.295, 0.694, 170_292),
    sterven: ratioBand(0.325, 0.786, 170_292),
  },
};

/**
 * The lane duel, per lane, because pooling them would be wrong.
 *
 * The gold between two laners is a different size of number in every lane: the
 * median gap is 3,031 in the botlane and 2,011 on support, and a single pooled
 * cut point would call ordinary botlanes remarkable and remarkable supports
 * ordinary. Same file, same exclusions; the sample is the count of paired lanes,
 * which is two slots each. Only 57.55% of non-bot player slots sit in a lane
 * that resolves to exactly one player per side, which is why this verdict is the
 * one that most often simply does not appear.
 */
const GOUD_MAAT = "gold between the two players in the lane";

export const LANE_BANDEN: Record<string, Band & { csHelft: number; csStaart: number }> = {
  TOP: { helft: 2790, staart: 6187, csHelft: 45, csStaart: 111, maat: GOUD_MAAT, slots: 51_437, ratio: false },
  JUNGLE: { helft: 2775, staart: 6039, csHelft: 35, csStaart: 88, maat: GOUD_MAAT, slots: 74_539, ratio: false },
  MIDDLE: { helft: 2698, staart: 5883, csHelft: 38, csStaart: 95, maat: GOUD_MAAT, slots: 76_938, ratio: false },
  BOTTOM: { helft: 3031, staart: 6540, csHelft: 48, csStaart: 146, maat: GOUD_MAAT, slots: 95_841, ratio: false },
  SUPPORT: { helft: 2011, staart: 4167, csHelft: 16, csStaart: 53, maat: GOUD_MAAT, slots: 64_538, ratio: false },
};

/**
 * How long a block of the game is when naming the patch that went worst.
 *
 * Five minutes, and the length is doing real work. The median non-bot game in
 * the store runs 1,825 seconds, so five minutes cuts it into six blocks, and the
 * median player dies six times -- one death per block is the ordinary rhythm. A
 * block holding three is unmistakably a bad patch rather than the rhythm, which
 * is why the rule below asks for both a multiple of the game's own even spread
 * and a floor of three.
 */
const VENSTER_SECONDEN = 300;

/**
 * How far past the game's own even spread a block has to sit to be named.
 *
 * Deliberately measured against this game rather than against the store: a
 * player who died twice has no bad patch to name, and a player who died twenty
 * times has a bad patch in every block. Doubling is the smallest multiple that
 * cannot be reached by the ordinary rhythm, since two blocks at double the
 * average already account for more deaths than half the game.
 */
const VENSTER_FACTOR = 2;
const VENSTER_MINIMUM = 3;

const heel = (n: number): string => Math.round(Math.abs(n)).toLocaleString("en-GB");
const komma = (n: number, d: number): string =>
  n.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * A gap, rounded, but never rounded to nothing.
 *
 * A short game against a champion that normally dies four times can clear the
 * band on a difference of half a death, and "0 fewer deaths than normal" is the
 * sentence a rounding bug writes. Under one, the decimal stays.
 */
const verschil = (n: number): string =>
  Math.abs(n) >= 1 ? heel(n) : komma(Math.abs(n), 1);
const procent = (deel: number): string => `${Math.round(deel * 100)}%`;
const klok = (seconden: number): string =>
  `${Math.floor(seconden / 60)}:${String(Math.floor(seconden % 60)).padStart(2, "0")}`;

/** Where a gap sits against its band. */
function tierVan(gat: number, band: Band): Tier {
  if (gat < band.helft) return "binnen";
  return gat < band.staart ? "buiten" : "ver";
}

/**
 * One figure against its norm, turned into a row.
 *
 * `beterIsHoger` is the whole reason this takes a direction: dying less than
 * normal and farming less than normal are the same arithmetic and opposite news,
 * and a block that painted both red would be reading the sign and not the game.
 */
function tegenNorm(opts: {
  sleutel: RatioSleutel;
  gebied: string;
  position: Position;
  jij: number;
  norm: number;
  beterIsHoger: boolean;
  /** The sentence, given the absolute gap and which way it went. */
  zin: (gat: number, boven: boolean) => string;
  cijfers: string;
  grond: string;
}): Uitspraak | null {
  const { jij, norm } = opts;
  if (!(norm > 0) || !Number.isFinite(jij)) return null;

  // No band means a lane the cut points were never measured for, which today is
  // only UNKNOWN -- and UNKNOWN never gets this far, because a game without a
  // resolved position has no PerformanceBaseline and the whole block is absent.
  const band = BANDEN[opts.position]?.[opts.sleutel];
  if (!band) return null;

  const verhouding = jij / norm;
  const gat = Math.abs(verhouding - 1);
  const boven = jij > norm;
  const tier = tierVan(gat, band);

  return {
    sleutel: opts.sleutel,
    gebied: opts.gebied,
    toon: tier === "binnen" ? "vlak" : boven === opts.beterIsHoger ? "goed" : "slecht",
    zin: opts.zin(gat, boven),
    cijfers: opts.cijfers,
    gat,
    band,
    tier,
    luidheid: gat / band.helft,
    grond: opts.grond,
  };
}

/**
 * Everything this game can be told about your own play.
 *
 * Takes the baseline separately rather than reading detail.baseline, because the
 * caller has already decided this block is being drawn at all -- and it only is
 * when the baseline exists. Passing it in makes that a type rather than a
 * comment.
 */
export function leesOordeel(
  detail: GameDetail,
  naspel: Naspel,
  baseline: PerformanceBaseline,
  naam: string,
  laneLabel: string,
): Oordeel {
  const jij = detail.players.find((p) => p.isYou);
  const jijNaspel = naspel.spelers.find((s) => s.speler.isYou);
  if (!jij || !jijNaspel) {
    return {
      tegenDatabase: [],
      binnenDezeGame: [],
      gewoon: [],
      zwijgt: [
        {
          onderwerp: "Everything",
          reden:
            "This game holds no seat marked as yours, so there is nobody in it to judge. That happens when the app has never seen your summoner, not when the game is unusual.",
        },
      ],
    };
  }

  const minuten = baseline.yourMinutes;
  const wie = `a normal ${naam} ${laneLabel}`;
  const overDeze = `over these ${komma(minuten, 1)} minutes`;

  // The two per-minute norms IjkBlok does not print. Both averages above the
  // line were divided by the same game count the minutes below it were, so this
  // is the ratio of the underlying totals and not an average of per-game rates.
  const normGevechtenPerMin =
    baseline.averageMinutes > 0
      ? (baseline.kills.average + baseline.assists.average) / baseline.averageMinutes
      : 0;
  const normSterftePerMin =
    baseline.averageMinutes > 0 ? baseline.deaths.average / baseline.averageMinutes : 0;

  const jijGevechtenPerMin = minuten > 0 ? (jij.kills + jij.assists) / minuten : 0;
  const jijSterftePerMin = minuten > 0 ? jij.deaths / minuten : 0;

  const verwachtCs = baseline.csPerMin.average * minuten;
  const verwachtGoud = baseline.goldPerMin.average * minuten;
  const verwachtGevechten = normGevechtenPerMin * minuten;
  const verwachtSterfte = normSterftePerMin * minuten;

  const laneUit = laneDuel(naspel, baseline.position, laneLabel);

  const kandidaten: Array<Uitspraak | null> = [
    tegenNorm({
      sleutel: "cs",
      gebied: "Farming",
      position: baseline.position,
      jij: baseline.csPerMin.you,
      norm: baseline.csPerMin.average,
      beterIsHoger: true,
      zin: (_gat, boven) =>
        `${heel(jij.cs - verwachtCs)} CS ${boven ? "ahead of" : "behind"} ${wie} ${overDeze}.`,
      cijfers: `${komma(baseline.csPerMin.you, 1)} against ${komma(baseline.csPerMin.average, 1)} CS/min · ${heel(jij.cs)} against ${heel(verwachtCs)} CS`,
      grond:
        "Your CS divided by this game's length, against all CS divided by all game time over every recorded game of this pick, multiplied back out to this game's length.",
    }),
    tegenNorm({
      sleutel: "goud",
      gebied: "Gold",
      position: baseline.position,
      jij: baseline.goldPerMin.you,
      norm: baseline.goldPerMin.average,
      beterIsHoger: true,
      zin: (_gat, boven) =>
        `${heel(jij.gold - verwachtGoud)} gold ${boven ? "more than" : "less than"} ${wie} ${overDeze}.`,
      cijfers: `${heel(baseline.goldPerMin.you)} against ${heel(baseline.goldPerMin.average)} gold/min · ${heel(jij.gold)} against ${heel(verwachtGoud)} gold`,
      grond:
        "Gold earned divided by this game's length, against the same ratio of totals over every recorded game of this pick.",
    }),
    tegenNorm({
      sleutel: "gevechten",
      gebied: "Fights joined",
      position: baseline.position,
      jij: jijGevechtenPerMin,
      norm: normGevechtenPerMin,
      beterIsHoger: true,
      zin: (_gat, boven) =>
        `In on ${verschil(jij.kills + jij.assists - verwachtGevechten)} ${boven ? "more" : "fewer"} kills and assists than ${wie} ${overDeze} — ${heel(jij.kills + jij.assists)} against ${heel(verwachtGevechten)}.`,
      cijfers: `${komma(jijGevechtenPerMin, 2)} against ${komma(normGevechtenPerMin, 2)} kills+assists/min · ${procent(jijNaspel.killDeelname)} of your team's kills`,
      grond:
        "Your kills plus assists per minute against the same figure over every recorded game of this pick. The share of your team's kills sits beside it as context; it has no norm here, because it is already a share of your own lobby.",
    }),
    tegenNorm({
      sleutel: "sterven",
      gebied: "Dying",
      position: baseline.position,
      jij: jijSterftePerMin,
      norm: normSterftePerMin,
      beterIsHoger: false,
      zin: (_gat, boven) =>
        `${verschil(jij.deaths - verwachtSterfte)} ${boven ? "more" : "fewer"} deaths than ${wie} ${overDeze} — ${heel(jij.deaths)} against ${komma(verwachtSterfte, 1)}.`,
      cijfers: `${komma(jijSterftePerMin * 10, 2)} against ${komma(normSterftePerMin * 10, 2)} deaths per 10 min`,
      grond:
        "Deaths per minute on both sides, so a long game is not counted as a worse one. The norm is total deaths over total game time for this pick, which is the per-game average above divided by the average game length.",
    }),
    laneUit,
  ];

  const tegenDatabase = kandidaten
    .filter((u): u is Uitspraak => u !== null && u.tier !== "binnen")
    .sort((a, b) => (b.luidheid ?? 0) - (a.luidheid ?? 0));

  const gewoon = kandidaten
    .filter((u): u is Uitspraak => u !== null && u.tier === "binnen")
    .map((u) => u.gebied.toLowerCase());

  const binnenDezeGame: Uitspraak[] = [];
  const zwijgt: Zwijgen[] = [];

  schadeRegel(naspel, jijNaspel, binnenDezeGame, zwijgt);
  visieRegel(naspel, jij, binnenDezeGame, zwijgt);
  vensterRegel(detail.tijdlijn, jij, binnenDezeGame, zwijgt);

  if (laneUit === null) {
    zwijgt.push({
      onderwerp: "Your lane opponent",
      reden:
        "This game does not resolve into exactly one player per side in your lane, so there is nobody in it who was standing opposite you. Pairing the nearest name instead would invent a duel that never happened.",
    });
  }

  return { tegenDatabase, binnenDezeGame, gewoon, zwijgt };
}

/**
 * You against the player who stood opposite you, in gold.
 *
 * Gold rather than CS as the verdict because CS is not the same question in
 * every lane -- a support out-farming a support says almost nothing -- while
 * gold counts farm, kills and assists in one number that means the same thing in
 * all five. CS rides along in the figures line, where it can be read by whoever
 * it means something to.
 */
function laneDuel(
  naspel: Naspel,
  position: Position,
  laneLabel: string,
): Uitspraak | null {
  const lane = naspel.lanes.find(
    (l) => l.blauw.speler.isYou || l.rood.speler.isYou,
  );
  if (!lane) return null;
  const band = LANE_BANDEN[position];
  if (!band) return null;

  // The stored differences always run blue minus red, so they have to be turned
  // around for a player on the red side or every sentence about him is inverted.
  const teken = lane.blauw.speler.isYou ? 1 : -1;
  const goud = lane.goudVerschil * teken;
  const cs = lane.csVerschil * teken;
  const gat = Math.abs(goud);
  const tier: Tier = gat < band.helft ? "binnen" : gat < band.staart ? "buiten" : "ver";
  const voor = goud >= 0;

  return {
    sleutel: "lane",
    gebied: "Your lane",
    toon: tier === "binnen" ? "vlak" : voor ? "goed" : "slecht",
    zin: `Finished ${heel(goud)} gold ${voor ? "ahead of" : "behind"} the enemy ${laneLabel}.`,
    cijfers: `${heel(cs)} CS ${cs >= 0 ? "ahead" : "behind"} · median gap in this lane is ${heel(band.helft)} gold`,
    gat,
    band,
    tier,
    luidheid: gat / band.helft,
    grond:
      "End-of-game gold for both players, which is the only thing match history reports for either. It says who ended ahead, not who won the laning phase — nothing stored says when the gap opened.",
  };
}

/**
 * Your share of your team's damage, with no verdict attached.
 *
 * Deliberately never coloured. There is no damage average to compare against and
 * there is not going to be one: no stored game carries the field, so nothing can
 * say whether 14% is a poor game or an ordinary support game. An even five-way
 * split is 20%, and that is a fact about the number five rather than about
 * League, which is exactly why it is safe to print and unsafe to judge.
 */
function schadeRegel(
  naspel: Naspel,
  jijNaspel: NaspelSpeler,
  uit: Uitspraak[],
  zwijgt: Zwijgen[],
): void {
  const aandeel = jijNaspel.damageAandeel;
  if (aandeel === null || naspel.maxDamage === null) {
    zwijgt.push({
      onderwerp: "Damage",
      reden:
        "Damage was not recorded for all ten players in this game. The client sends it and the store keeps it from today onwards, with no backfill, so “you did too little damage” cannot be said about a game saved before that.",
    });
    return;
  }
  uit.push({
    sleutel: "schade",
    gebied: "Damage",
    toon: "vlak",
    zin: `${procent(aandeel)} of your team's damage to champions.`,
    cijfers: `${heel(jijNaspel.speler.damage ?? 0)} damage · an even five-way split is 20%`,
    gat: null,
    band: null,
    tier: null,
    luidheid: null,
    grond:
      "Your damage to champions divided by your own team's. No verdict: nothing stored holds a damage average for this champion, so there is no way to tell a poor game from an ordinary one for the role.",
  });
}

/**
 * Where your vision sat among the ten, and nothing more.
 *
 * A rank inside one game rather than a comparison to anything, for the same
 * reason as damage: the field exists on new records only and no average has ever
 * been counted from it. A rank at least cannot be wrong -- it is a fact about
 * these ten players -- as long as the block does not dress it up as a verdict.
 */
function visieRegel(
  naspel: Naspel,
  jij: GameDetailPlayer,
  uit: Uitspraak[],
  zwijgt: Zwijgen[],
): void {
  const bron = naspel.visieBron;
  if (bron === null) {
    zwijgt.push({
      onderwerp: "Vision",
      reden:
        "Neither vision score nor wards placed was recorded for all ten players in this game, so there is nothing to say about vision at all — not that it was poor, and not that it was fine.",
    });
    return;
  }

  const lees = (p: GameDetailPlayer): number => (bron === "vision" ? (p.vision ?? 0) : (p.wards ?? 0));
  const mijn = lees(jij);
  const alle = naspel.spelers.map((s) => lees(s.speler));
  const eigenTeam = naspel.spelers
    .filter((s) => s.speler.team === jij.team)
    .map((s) => lees(s.speler));
  const plaats = 1 + alle.filter((v) => v > mijn).length;
  const plaatsTeam = 1 + eigenTeam.filter((v) => v > mijn).length;
  const label = bron === "vision" ? "vision score" : "wards placed";

  uit.push({
    sleutel: "visie",
    gebied: "Vision",
    toon: "vlak",
    zin: `${plaats}${achtervoegsel(plaats)} of the ten on ${label}, ${plaatsTeam}${achtervoegsel(plaatsTeam)} on your own side.`,
    cijfers: `${heel(mijn)} ${label} · highest in the game was ${heel(Math.max(...alle))}`,
    gat: null,
    band: null,
    tier: null,
    luidheid: null,
    grond:
      "A rank among the ten players in this game and nothing else. No stored game holds vision or wards, so there is no average anywhere to say what a normal number would have been.",
  });
}

const achtervoegsel = (n: number): string =>
  n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";

/**
 * The five minutes of this game that went worst for you.
 *
 * The one row in the block that can name a moment, and it exists only for the
 * games this app was running during -- the recording is the sole place in the
 * whole store where an event carries a timestamp. Match history hands over the
 * final line and nothing else, so for a crawled game this row is not missing
 * data, it is data that was never created.
 *
 * Deaths are counted from kill events only. A first blood is announced twice in
 * the live feed, once as FirstBlood naming its recipient and once as the
 * ChampionKill that caused it, and the FirstBlood row carries no victim at all
 * -- so counting kill rows is both complete and free of doubles.
 */
function vensterRegel(
  tijdlijn: GameTijdlijn | null,
  jij: GameDetailPlayer,
  uit: Uitspraak[],
  zwijgt: Zwijgen[],
): void {
  if (!tijdlijn) {
    zwijgt.push({
      onderwerp: "When it went wrong",
      reden:
        "This app was not running while this game was played, so no minute of it was written down here. Match history does hold a per-minute timeline for Classic games, which nothing in this app fetches yet -- so this is pending rather than permanent, and it would give minutes rather than the seconds a recording gives.",
    });
    return;
  }

  const { opname } = tijdlijn;
  if (opname.gebeurtenissen.length === 0) {
    zwijgt.push({
      onderwerp: "When it went wrong",
      reden:
        "This game was recorded before the app kept the event feed, so it has timestamps for every item bought and none for anything that happened.",
    });
    return;
  }

  // The seat that was at the keyboard is the one carrying a skill order: the
  // client reveals nobody else's abilities, so exactly one seat can have it.
  // This is the same rule the timeline panel identifies you by.
  const stoel = opname.spelers.findIndex((s) => (s.skillOrder?.length ?? 0) > 0);
  if (stoel < 0) {
    zwijgt.push({
      onderwerp: "When it went wrong",
      reden:
        "The recording of this game does not mark which of the ten seats was yours, so the deaths in it cannot be attributed to you.",
    });
    return;
  }

  const doden = opname.gebeurtenissen
    .filter((g) => g.soort === "kill" && g.aan === stoel)
    .map((g) => g.at)
    .sort((a, b) => a - b);

  // The recording must account for every death match history reports, or the
  // worst block is being chosen out of an incomplete list and could be the wrong
  // one. A poll that missed a window loses events silently, so this is checked
  // rather than assumed.
  if (doden.length !== jij.deaths) {
    zwijgt.push({
      onderwerp: "When it went wrong",
      reden: `The recording holds ${doden.length} of your ${jij.deaths} deaths as timed events, so the five minutes that went worst would be picked from an incomplete list.`,
    });
    return;
  }
  if (doden.length === 0) return;

  const lengte = Math.max(opname.gameLengthSeconds, doden[doden.length - 1] ?? 0);
  const blokken = Math.max(1, Math.ceil(lengte / VENSTER_SECONDEN));
  const tellen = new Array<number>(blokken).fill(0);
  for (const at of doden) {
    const i = Math.min(blokken - 1, Math.floor(at / VENSTER_SECONDEN));
    tellen[i] = (tellen[i] ?? 0) + 1;
  }

  let beste = 0;
  for (let i = 1; i < blokken; i++) if ((tellen[i] ?? 0) > (tellen[beste] ?? 0)) beste = i;
  const aantal = tellen[beste] ?? 0;
  const gelijk = doden.length / blokken;

  if (aantal < VENSTER_MINIMUM || aantal < gelijk * VENSTER_FACTOR) {
    zwijgt.push({
      onderwerp: "When it went wrong",
      reden: `Your ${doden.length} deaths are spread evenly enough over the game's ${blokken} five-minute blocks that no single one of them is the bad patch. The worst held ${aantal}, against ${komma(gelijk, 1)} for an even spread.`,
    });
    return;
  }

  const van = beste * VENSTER_SECONDEN;
  uit.push({
    sleutel: "venster",
    gebied: "When it went wrong",
    toon: "vlak",
    zin: `${aantal} of your ${doden.length} deaths fell between ${klok(van)} and ${klok(van + VENSTER_SECONDEN)}.`,
    cijfers: `an even spread over this game's ${blokken} blocks would be ${komma(gelijk, 1)} per block`,
    gat: null,
    band: null,
    tier: null,
    luidheid: null,
    grond:
      "Counted from the kill events this app recorded while the game ran, split into five-minute blocks from the opening whistle. Named only when one block holds at least three deaths and at least twice the game's own even spread.",
  });
}
