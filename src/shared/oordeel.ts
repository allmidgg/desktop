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
import { leesTijdvak, type NaamVan } from "./tijdvak";
import {
  type Band, type Meting, type OordeelSleutel, type Tier, type Uitspraak, type Zwijgen,
  gemerkt, gemerktVerschil, heel, klok, komma, procent, tierVan, verschil,
} from "./uitspraak";

/* The vocabulary these verdicts are written in -- Band, Tier, Uitspraak and the
   rule that turns a gap into one of three tiers -- moved to shared/uitspraak.ts
   when shared/tijdvak.ts started producing verdicts of its own. Two copies of
   `tierVan` would have been two definitions of "unusual" on one screen, drifting
   apart the first time either was touched, with nothing to tell the reader that
   the block's two halves were being scored by different rules.

   Re-exported from here because IjkBlok.tsx and everything else already import
   them from this file, and moving a type is not a reason to make every consumer
   learn a new path. */
export type { Band, Meting, OordeelSleutel, Tier, Uitspraak, Zwijgen };

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

/**
 * Where every band in this file comes from, in one clause the screen prints.
 *
 * On the row beside a cut point because this block now stands beside verdicts
 * from shared/tijdvak.ts, whose bands rest on a few hundred observations fetched
 * from the client rather than on a million read off the disk. Both are honest
 * and they are not the same strength of claim, so each says which it is instead
 * of letting the reader assume they match.
 */
const STORE_HERKOMST = "player slots in 126,246 non-bot games from the local match store";
const LANE_HERKOMST = "paired lanes in 126,246 non-bot games from the local match store";

type RatioSleutel = "cs" | "goud" | "gevechten" | "sterven";

const ratioBand = (helft: number, staart: number, slots: number): Band => ({
  helft, staart, maat: RATIO_MAAT, slots, ratio: true, herkomst: STORE_HERKOMST,
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

const laneBand = (
  helft: number, staart: number, csHelft: number, csStaart: number, slots: number,
): Band & { csHelft: number; csStaart: number } =>
  ({ helft, staart, csHelft, csStaart, maat: GOUD_MAAT, slots, ratio: false, herkomst: LANE_HERKOMST });

export const LANE_BANDEN: Record<string, Band & { csHelft: number; csStaart: number }> = {
  TOP: laneBand(2790, 6187, 45, 111, 51_437),
  JUNGLE: laneBand(2775, 6039, 35, 88, 74_539),
  MIDDLE: laneBand(2698, 5883, 38, 95, 76_938),
  BOTTOM: laneBand(3031, 6540, 48, 146, 95_841),
  SUPPORT: laneBand(2011, 4167, 16, 53, 64_538),
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
  /**
   * The row as the screen draws it: the same two figures in columns.
   *
   * Built by the caller from the same variables the sentence is built from,
   * which is the only reason the table and the fold behind it can be trusted to
   * agree.
   */
  metingen: Meting[];
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
    metingen: opts.metingen,
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
  /**
   * How a champion id becomes a name, for the sentences that have to name your
   * lane opponent.
   *
   * Optional so every existing caller still compiles, and when it is left out
   * the timeline verdicts still appear -- they simply say "the enemy in your
   * lane" where they would have said "Nasus". A missing catalogue is a reason to
   * word a sentence differently, not a reason to withhold a finding.
   */
  naamVan: NaamVan = () => null,
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
      // Two lines and not one. The rate is what the verdict was decided on and
      // the total is what the reader remembers playing, and neither can be
      // recovered from the other without knowing the length of the game.
      metingen: [
        {
          maat: "CS / min",
          jij: komma(baseline.csPerMin.you, 1),
          norm: komma(baseline.csPerMin.average, 1),
          verschil: gemerktVerschil(baseline.csPerMin.you, baseline.csPerMin.average, 1),
        },
        {
          maat: "CS this game",
          jij: heel(jij.cs),
          norm: heel(verwachtCs),
          verschil: gemerktVerschil(jij.cs, verwachtCs, 0),
        },
      ],
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
      metingen: [
        {
          maat: "Gold / min",
          jij: heel(baseline.goldPerMin.you),
          norm: heel(baseline.goldPerMin.average),
          verschil: gemerktVerschil(baseline.goldPerMin.you, baseline.goldPerMin.average, 0),
        },
        {
          maat: "Gold this game",
          jij: heel(jij.gold),
          norm: heel(verwachtGoud),
          verschil: gemerktVerschil(jij.gold, verwachtGoud, 0),
        },
      ],
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
      // The third line has an empty middle cell on purpose. Kill participation
      // is already a share of your own lobby, so there is nothing anywhere to
      // hold it against, and a blank column says that where a filled one would
      // quietly invent a norm.
      metingen: [
        {
          maat: "Kills + assists / min",
          jij: komma(jijGevechtenPerMin, 2),
          norm: komma(normGevechtenPerMin, 2),
          verschil: gemerktVerschil(jijGevechtenPerMin, normGevechtenPerMin, 2),
        },
        {
          maat: "Kills + assists",
          jij: heel(jij.kills + jij.assists),
          norm: heel(verwachtGevechten),
          verschil: gemerktVerschil(jij.kills + jij.assists, verwachtGevechten, 0),
        },
        {
          maat: "Share of team kills",
          jij: procent(jijNaspel.killDeelname),
          norm: null,
          verschil: null,
        },
      ],
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
      // Per ten minutes rather than per minute, because deaths per minute is
      // 0.09 against 0.11 and two figures that differ in the second decimal read
      // as the same number however true the difference is.
      metingen: [
        {
          maat: "Deaths / 10 min",
          jij: komma(jijSterftePerMin * 10, 2),
          norm: komma(normSterftePerMin * 10, 2),
          verschil: gemerktVerschil(jijSterftePerMin * 10, normSterftePerMin * 10, 2),
        },
        {
          maat: "Deaths this game",
          jij: heel(jij.deaths),
          norm: komma(verwachtSterfte, 1),
          // One decimal and not zero: the norm cell carries one, so that is the
          // precision the reader is subtracting at.
          verschil: gemerktVerschil(jij.deaths, verwachtSterfte, 1),
        },
      ],
      // One decimal on the gap, matching the norm it is a gap from. The row
      // above this sentence prints 11 against 8.1 and a gap of 2.9; a sentence
      // saying "3 more deaths" directly under that is the same finding rounded
      // two different ways in two adjacent lines, which reads as a mistake even
      // though both numbers are right.
      zin: (_gat, boven) =>
        `${komma(Math.abs(jij.deaths - verwachtSterfte), 1)} ${boven ? "more" : "fewer"} deaths than ${wie} ${overDeze} — ${heel(jij.deaths)} against ${komma(verwachtSterfte, 1)}.`,
      cijfers: `${komma(jijSterftePerMin * 10, 2)} against ${komma(normSterftePerMin * 10, 2)} deaths per 10 min`,
      grond:
        "Deaths per minute on both sides, so a long game is not counted as a worse one. The norm is total deaths over total game time for this pick, which is the per-game average above divided by the average game length.",
    }),
    laneUit,
  ];

  // The verdicts that need a clock. Merged into the same list rather than given
  // a block of their own, because "you fell behind in the laning phase" and "you
  // farmed less than normal" are answers to one question and the reader should
  // see them ranked against each other. Each row already carries the sample
  // behind its own cut point, so a finding standing on 194 lane slots cannot be
  // mistaken for one standing on 228,759.
  const overTijd =
    detail.historie.staat === "gevonden"
      ? leesTijdvak(detail.historie.tijdlijn, detail, naamVan)
      : { uitspraken: [], altijd: [], zwijgt: [tijdlijnZwijgen(detail)] };

  const tegenDatabase = [
    ...[...kandidaten, ...overTijd.uitspraken].filter(
      (u): u is Uitspraak => u !== null && u.tier !== "binnen",
    ),
    // Rows that describe rather than judge, which a band cannot filter -- see
    // TijdvakUit.altijd for the one case and why it is not a loophole.
    ...overTijd.altijd,
  ].sort((a, b) => (b.luidheid ?? 0) - (a.luidheid ?? 0));

  const gewoon = [...kandidaten, ...overTijd.uitspraken]
    .filter((u): u is Uitspraak => u !== null && u.tier === "binnen")
    .map((u) => u.gebied.toLowerCase());

  const binnenDezeGame: Uitspraak[] = [];
  const zwijgt: Zwijgen[] = [...overTijd.zwijgt];

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
 * Why there are no verdicts with a clock on them, in the reason's own words.
 *
 * Four genuinely different situations wear the same blank space on screen, and
 * only one of them is anybody's fault. "League is closed" is a thing the reader
 * can fix in thirty seconds; "this game has no timeline" is a permanent fact
 * about that one game; "still fetching" resolves on its own. Collapsing them
 * into "no data" would tell a reader with League closed that his history is
 * missing, which is both wrong and discouraging.
 */
function tijdlijnZwijgen(detail: GameDetail): Zwijgen {
  const onderwerp = "The minute-by-minute reading";
  switch (detail.historie.staat) {
    case "bezig":
      return { onderwerp, reden: "The per-minute timeline for this game is being fetched from the client now. Open it again in a moment." };
    case "geen-client":
      return {
        onderwerp,
        reden:
          "League is not running. The per-minute timeline comes from the client's own match-history endpoint, so with the client closed there is no way to ask for it — for this game or any other. Start League and open this game again and the laning phase, the peak of the lead and the shape of its fall all appear.",
      };
    case "geen-tijdlijn":
      return {
        onderwerp,
        reden:
          "The client answered that this game has no timeline. That is a fact about this game rather than a failure, and it will not change: nothing will ever write one after the fact.",
      };
    case "mislukt":
      return { onderwerp, reden: `Fetching the per-minute timeline failed: ${detail.historie.reden}. Opening this game again is a fresh attempt.` };
    default:
      return { onderwerp, reden: "There is no per-minute timeline for this game." };
  }
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
    // This row is a gap rather than a level, so the first column holds your gap
    // and the second holds the gap an ordinary lane in this position ends on.
    // Subtracting those two would be a difference between two differences, which
    // is a number nobody can picture, so the third column stays empty.
    metingen: [
      {
        maat: "Gold gap at the end",
        jij: gemerkt(goud),
        // Named as a median, because on every other row of this table the
        // middle column is somebody's actual figure and here it is the middle
        // of the spread of gaps this lane produces.
        norm: `${heel(band.helft)} median`,
        verschil: null,
      },
      {
        maat: "CS gap at the end",
        jij: gemerkt(cs),
        norm: `${heel(band.csHelft)} median`,
        verschil: null,
      },
    ],
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
    // Both middle cells empty, and that is the finding. Nothing stored holds a
    // damage average, so there is no figure that belongs in the column -- and an
    // even five-way split being 20% is a fact about the number five rather than
    // about League, which is why it is written under the fold and not printed
    // here where it would be read as a target.
    metingen: [
      { maat: "Share of team damage", jij: procent(aandeel), norm: null, verschil: null },
      { maat: "Damage to champions", jij: heel(jijNaspel.speler.damage ?? 0), norm: null, verschil: null },
    ],
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
    // A rank and a highest, which are facts about these ten players. The middle
    // column holds the best figure in the game rather than a norm, because a
    // norm for vision does not exist in any stored game and printing the lobby's
    // best where an average belongs would be the app inventing one.
    metingen: [
      {
        maat: label === "vision score" ? "Vision score" : "Wards placed",
        jij: heel(mijn),
        norm: `${heel(Math.max(...alle))} best`,
        verschil: null,
      },
      {
        maat: "Rank in the game",
        jij: `${plaats} of 10`,
        norm: `${plaatsTeam} of 5 your side`,
        verschil: null,
      },
    ],
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
      onderwerp: "Your deaths to the second",
      reden:
        "This app was not running while this game was played, so nothing here holds the second a death happened on. The per-minute timeline fetched from match history does place your deaths, but to the minute rather than the second — see the rows above, which use it. This one row wants seconds and only a recording has those.",
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
    // The clock is a measurement too, and it is the one the reader came for, so
    // it gets a row rather than being folded into a caption.
    metingen: [
      {
        maat: "Worst 5 minutes",
        jij: `${klok(van)}–${klok(van + VENSTER_SECONDEN)}`,
        norm: null,
        verschil: null,
      },
      {
        maat: "Deaths in it",
        jij: `${aantal} of ${doden.length}`,
        norm: `${komma(gelijk, 1)} even`,
        verschil: gemerktVerschil(aantal, gelijk, 1),
      },
    ],
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
