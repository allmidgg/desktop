/**
 * What a finished game adds up to.
 *
 * This lives in shared for the same reason build.ts does: the renderer is the
 * only consumer, and everything under core/services drags the League client and
 * undici into the bundle behind it. There is nothing here but arithmetic on a
 * GameDetail, so it belongs where both sides can reach it for free.
 *
 * The reason it is a module at all rather than a few lines inside the view: a
 * score whose recipe lives nowhere is decoration. NASPEL_FACTOREN is the rule,
 * it is what gets applied, and it is the same object the screen prints when you
 * ask how the number was reached -- so the explanation cannot drift away from
 * the arithmetic the way a hand-written caption would.
 *
 * Every factor is measured against what this player's own champion normally does
 * in this player's own lane. That baseline arrives per player as
 * GameDetailPlayer.ijklijn and is built in the main process out of the same
 * tallies the tier list stands on. That is the whole design, and it replaces a
 * rule that measured all ten against the highest figure in the lobby. Over the
 * 130,086 stored games the old rule handed the badge to 0.51% of winning support
 * slots against 30.48% of winning bot slots -- not because supports never carry,
 * but because a yardstick made of the top laner's 236 CS has nothing to say
 * about a support's 11. Against a support's own norm of 0.78 CS per minute, 11
 * CS in a 34-minute game is simply a normal support game, and the badge lands on
 * the support in 15.64% of the games he wins.
 *
 * Nothing here invents a number. Every factor reads a field that is on every
 * record in the store -- kills, deaths, assists, CS, gold and the game length --
 * which is why a score means the same thing on a game saved last year and one
 * saved today. The five per-player extras (damage, damage taken, vision, wards,
 * level) were added to the store recently, no backfill is coming, and scoring on
 * them would mean two different rules on one screen. They are still drawn where
 * they exist; they are deliberately not part of the badge.
 */
import type { GameDetail, GameDetailPlayer, Position, SpelerIjklijn } from "./types";

export type FactorSleutel = "kda" | "kp" | "kpIjk" | "cs" | "gold";

export interface NaspelFactor {
  sleutel: FactorSleutel;
  /** The label the screen prints, so rule and drawing say the same words. */
  naam: string;
  /** Share of the score. The five add up to 1. */
  gewicht: number;
  /** Why it counts, in the sentence the screen shows. */
  uitleg: string;
}

/**
 * The whole rule, in order of weight.
 *
 * Fighting is 70% of it and farming 30%, and that split is the point: farm still
 * counts, but only against what this champion normally farms in this lane, so it
 * can no longer work as a tax on whoever was assigned the lane without minions.
 *
 * Kill participation is in here twice, on purpose, and it is the one place where
 * the measurement argued against the obvious design. Raw participation needs no
 * baseline -- it is already a share of your own team -- but it is not neutral
 * between lanes: over every stored game the average winning top laner is in on
 * 39.3% of his team's kills and the average winning support on 49.3%. Leaning on
 * it alone moves the unfairness rather than removing it (top falls to 14.98%,
 * support rises to 18.02%). Measuring participation against the champion's own
 * norm instead has the mirrored fault (support 13.02%, top 21.42%). Half the
 * weight on each lands top at 17.68% and support at 15.64%, which is the
 * flattest of the three, and each half is a real question: were you in your
 * team's fights, and were you in more of them than this champion usually is.
 */
export const NASPEL_FACTOREN: readonly NaspelFactor[] = [
  {
    sleutel: "kda",
    naam: "Kills, deaths and assists",
    gewicht: 0.25,
    uitleg: "Your KDA against what this champion normally manages in this lane.",
  },
  {
    sleutel: "kp",
    naam: "Kill participation",
    gewicht: 0.225,
    uitleg:
      "Kills and assists as a share of everything your team killed. Already a share, so it is taken as it stands.",
  },
  {
    sleutel: "kpIjk",
    naam: "Fights joined against normal",
    gewicht: 0.225,
    uitleg: "Kills and assists per minute against what this champion normally gets in this lane.",
  },
  {
    sleutel: "cs",
    naam: "Creep score",
    gewicht: 0.15,
    uitleg: "CS per minute against what this champion normally farms in this lane.",
  },
  {
    sleutel: "gold",
    naam: "Gold earned",
    gewicht: 0.15,
    uitleg: "Gold per minute against what this champion normally earns in this lane.",
  },
];

/**
 * Which yardstick a game could be scored against.
 *
 * "lane" is the rule as designed. "champion" is the same rule with the lanes
 * pooled, for a game whose positions Riot never resolved -- 20,342 of the
 * 130,086 stored games, and always all ten players at once, never a stray one.
 * "lobby" is the last resort for a store too small to hold any baseline at all;
 * it is lane-blind, it is unkind to supports, and it fires on none of the stored
 * games. The screen names which one was used, because a badge computed three
 * different ways without saying so is a badge nobody can check.
 */
export type NaspelIjk = "lane" | "champion" | "lobby";

/** One ingredient of one player's score, with the numbers it was built from. */
export interface NaspelDeel {
  factor: NaspelFactor;
  /** The player's own figure: a rate per minute, a ratio, or a share. */
  waarde: number;
  /** What that figure normally is. Null for kill participation, which has no norm. */
  normaal: number | null;
  /** 0-1 after measuring against the norm. Exactly 0.5 means a dead average game. */
  aandeel: number;
  /** The weight applied, straight from the factor. */
  gewicht: number;
}

export interface NaspelSpeler {
  speler: GameDetailPlayer;
  /** 0-100, where 50 is a completely average game for this champion in this lane. */
  score: number;
  /** Share of their own team's kills this player was part of, 0-1. */
  killDeelname: number;
  /** Share of their own team's damage to champions, 0-1. Null when unrecorded. */
  damageAandeel: number | null;
  delen: NaspelDeel[];
  /** Highest score on the winning side. */
  isMvp: boolean;
  /** Highest score on the losing side. */
  isAce: boolean;
}

export interface NaspelTeam {
  teamId: number;
  win: boolean;
  spelers: NaspelSpeler[];
  kills: number;
  deaths: number;
  assists: number;
  gold: number;
  cs: number;
  /** Null when this game did not record damage for everyone in it. */
  damage: number | null;
}

/** One lane, both sides of it, and the gap between them. */
export interface NaspelLane {
  position: Position;
  blauw: NaspelSpeler;
  rood: NaspelSpeler;
  /** Blue minus red, so a positive number always means blue was ahead. */
  goudVerschil: number;
  csVerschil: number;
  damageVerschil: number | null;
}

export interface Naspel {
  teams: NaspelTeam[];
  spelers: NaspelSpeler[];
  lanes: NaspelLane[];
  /** Which yardstick this game could be scored against. */
  ijk: NaspelIjk;
  /** How many recorded games the thinnest baseline in this game stands on. */
  ijkGames: number | null;
  /** Which field the vision figure came from, or null when neither was kept. */
  visieBron: "vision" | "wards" | null;
  /** Highest in the game, for drawing bars. Null when the field is missing. */
  maxDamage: number | null;
  maxDamageTaken: number | null;
  maxGold: number;
  maxCs: number;
}

const LANE_VOLGORDE: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];

/**
 * How sharply being above normal is rewarded.
 *
 * The shape is r^h / (r^h + 1) on the ratio r of what you did to what is normal,
 * which is a logistic curve on the logarithm of that ratio. Three properties are
 * the reason it is this and not something simpler. Exactly normal is exactly
 * 0.5, so a score of 50 has a meaning that can be written on the screen. Twice
 * normal and half normal sit the same distance either side of it, because
 * doubling and halving are the same size of difference and a plain ratio
 * pretends they are not. And it cannot run away: a support with three times his
 * usual CS gets 0.84 on that factor, not three times someone else's, so one
 * freak number in one factor can never decide the badge on its own. At h = 1.5
 * the curve reads 0.5x -> 0.26, 0.75x -> 0.39, 1x -> 0.50, 1.4x -> 0.62,
 * 2x -> 0.74, 3x -> 0.84.
 *
 * The obvious alternative -- a ratio clamped at some ceiling -- was rejected
 * because a clamp makes everyone at or above the ceiling equal, and ties are how
 * a badge becomes arbitrary.
 */
const HELLING = 1.5;

/**
 * A figure against what that figure normally is, as a share between 0 and 1.
 *
 * A missing or nonsensical norm answers 0.5 rather than 0: not knowing what is
 * normal is not evidence that the player was bad, and 0.5 is the one value that
 * leaves the factor unable to move the ranking.
 */
function tegenNormaal(waarde: number, normaal: number): number {
  if (!Number.isFinite(waarde) || !Number.isFinite(normaal) || normaal <= 0) return 0.5;
  if (waarde <= 0) return 0;
  const verhouding = Math.pow(waarde / normaal, HELLING);
  return verhouding / (verhouding + 1);
}

/**
 * KDA with the same rule on both sides of every comparison it takes part in.
 *
 * A player who did not die is given kills plus assists, which is what the tier
 * list and the baseline in the main process both do. Two definitions of KDA on
 * one screen would be the app arguing with itself in front of the user.
 */
function kdaVan(p: GameDetailPlayer): number {
  return p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;
}

/** What one player is measured against. */
interface Meetlat {
  csPerMin: number;
  goldPerMin: number;
  kaPerMin: number;
  kda: number;
}

function mediaan(waarden: number[]): number {
  if (waarden.length === 0) return 0;
  const gesorteerd = [...waarden].sort((a, b) => a - b);
  const midden = gesorteerd.length >> 1;
  return gesorteerd.length % 2 === 0
    ? ((gesorteerd[midden - 1] as number) + (gesorteerd[midden] as number)) / 2
    : (gesorteerd[midden] as number);
}

/**
 * A yardstick for every player, and the honest name of where it came from.
 *
 * All ten or none, the same principle the old rule applied to its optional
 * fields: half a lobby scored against its own champions and half against the
 * middle of the room would be two rules in one game, and the player scored the
 * harder way would lose the badge for a reason that has nothing to do with him.
 */
function meetlatten(
  spelers: readonly GameDetailPlayer[],
  minuten: number,
): { latten: Meetlat[]; ijk: NaspelIjk; games: number | null } {
  const ijklijnen: Array<SpelerIjklijn | null> = spelers.map((p) => p.ijklijn ?? null);
  const compleet = (lijst: Array<SpelerIjklijn | null>): lijst is SpelerIjklijn[] =>
    lijst.length > 0 && lijst.every((i) => i !== null);

  if (minuten > 0 && compleet(ijklijnen)) {
    return {
      latten: ijklijnen.map((i) => ({
        csPerMin: i.csPerMin,
        goldPerMin: i.goldPerMin,
        kaPerMin: i.kaPerMin,
        kda: i.kda,
      })),
      // One player scored against a pooled champion norm is enough to make the
      // whole game's scores pooled, because that is the coarsest measurement in
      // it and the screen should claim no better.
      ijk: ijklijnen.every((i) => i.bron === "lane") ? "lane" : "champion",
      games: Math.min(...ijklijnen.map((i) => i.games)),
    };
  }

  // Last resort: the middle of this lobby. The median rather than the highest,
  // because one 20-kill game should not flatten the other nine players, but it
  // is still a lane-blind yardstick and it is still unfair to a support -- over
  // the stored games it would hand him 3.1% of the badges he could win. It
  // exists so a store too small to have baselines still shows something, and the
  // screen says out loud that this is what happened.
  const perMinuut = (waarde: number): number => (minuten > 0 ? waarde / minuten : 0);
  const midden: Meetlat = {
    csPerMin: mediaan(spelers.map((p) => perMinuut(p.cs))),
    goldPerMin: mediaan(spelers.map((p) => perMinuut(p.gold))),
    kaPerMin: mediaan(spelers.map((p) => perMinuut(p.kills + p.assists))),
    kda: mediaan(spelers.map(kdaVan)),
  };
  return { latten: spelers.map(() => midden), ijk: "lobby", games: null };
}

/**
 * A field is drawn only when every player in the game has it.
 *
 * Half a lobby with damage recorded and half without would still produce a
 * number, and it would be a lie. Nothing is scored on these any more, but the
 * screen still draws them, and it should draw all ten bars or none.
 */
function ledereenHeeft(
  spelers: readonly GameDetailPlayer[],
  lees: (p: GameDetailPlayer) => number | undefined,
): boolean {
  return spelers.length > 0 && spelers.every((p) => Number.isFinite(lees(p)));
}

function hoogste(spelers: readonly GameDetailPlayer[], lees: (p: GameDetailPlayer) => number | undefined): number {
  let max = 0;
  for (const p of spelers) {
    const v = lees(p);
    if (Number.isFinite(v) && (v as number) > max) max = v as number;
  }
  return max;
}

function som(spelers: readonly GameDetailPlayer[], lees: (p: GameDetailPlayer) => number): number {
  return spelers.reduce((totaal, p) => totaal + lees(p), 0);
}

/**
 * Scores one finished game.
 *
 * Everything is computed once, here, because half of it is needed twice -- the
 * team block draws a damage bar against the same maximum the score used, and a
 * screen that recomputes a maximum per row eventually draws two different bars
 * for the same number.
 */
export function leesNaspel(detail: GameDetail): Naspel {
  const spelers = detail.players;
  const minuten = detail.durationSeconds / 60;
  const { latten, ijk, games: ijkGames } = meetlatten(spelers, minuten);

  const heeftDamage = ledereenHeeft(spelers, (p) => p.damage);
  const heeftTaken = ledereenHeeft(spelers, (p) => p.damageTaken);
  const visieBron: "vision" | "wards" | null = ledereenHeeft(spelers, (p) => p.vision)
    ? "vision"
    : ledereenHeeft(spelers, (p) => p.wards)
      ? "wards"
      : null;

  const maxDamage = heeftDamage ? hoogste(spelers, (p) => p.damage) : null;
  const maxDamageTaken = heeftTaken ? hoogste(spelers, (p) => p.damageTaken) : null;
  const maxGold = hoogste(spelers, (p) => p.gold);
  const maxCs = hoogste(spelers, (p) => p.cs);

  const teamKills = new Map<number, number>();
  const teamDamage = new Map<number, number>();
  for (const p of spelers) {
    teamKills.set(p.team, (teamKills.get(p.team) ?? 0) + p.kills);
    if (heeftDamage) teamDamage.set(p.team, (teamDamage.get(p.team) ?? 0) + (p.damage ?? 0));
  }

  // A rate needs a length to be a rate. Nothing in the store has a duration of
  // zero, but a corrupted record must not turn every figure into Infinity and
  // then print it without complaint.
  const perMinuut = (waarde: number): number => (minuten > 0 ? waarde / minuten : 0);

  const gescoord: NaspelSpeler[] = spelers.map((speler, i) => {
    const lat = latten[i] as Meetlat;
    const kills = teamKills.get(speler.team) ?? 0;
    const killDeelname = kills > 0 ? Math.min(1, (speler.kills + speler.assists) / kills) : 0;
    const teamSchade = teamDamage.get(speler.team) ?? 0;

    const delen: NaspelDeel[] = NASPEL_FACTOREN.map((factor) => {
      const gewicht = factor.gewicht;
      switch (factor.sleutel) {
        case "kda": {
          const waarde = kdaVan(speler);
          return { factor, waarde, normaal: lat.kda, aandeel: tegenNormaal(waarde, lat.kda), gewicht };
        }
        case "kp":
          // The one figure that is already a share of something, so it is not
          // divided by anything: it is what fraction of his own team's kills
          // this player was there for.
          return { factor, waarde: killDeelname, normaal: null, aandeel: killDeelname, gewicht };
        case "kpIjk": {
          const waarde = perMinuut(speler.kills + speler.assists);
          return { factor, waarde, normaal: lat.kaPerMin, aandeel: tegenNormaal(waarde, lat.kaPerMin), gewicht };
        }
        case "cs": {
          const waarde = perMinuut(speler.cs);
          return { factor, waarde, normaal: lat.csPerMin, aandeel: tegenNormaal(waarde, lat.csPerMin), gewicht };
        }
        case "gold": {
          const waarde = perMinuut(speler.gold);
          return { factor, waarde, normaal: lat.goldPerMin, aandeel: tegenNormaal(waarde, lat.goldPerMin), gewicht };
        }
      }
    });

    const score = delen.reduce((t, deel) => t + deel.aandeel * deel.gewicht, 0) * 100;

    return {
      speler,
      score,
      killDeelname,
      damageAandeel: heeftDamage && teamSchade > 0 ? (speler.damage ?? 0) / teamSchade : null,
      delen,
      isMvp: false,
      isAce: false,
    };
  });

  // MVP for the winning side, ACE for the losing one -- the client's own words
  // for the same two badges. Splitting by outcome is also what lets the rule
  // stay free of a win bonus: the best game on a losing team is still the best
  // game on a losing team, and it does not have to out-score the winners to be
  // named.
  markeerBeste(gescoord.filter((s) => s.speler.win), "isMvp");
  markeerBeste(gescoord.filter((s) => !s.speler.win), "isAce");

  const teams: NaspelTeam[] = [...new Set(spelers.map((p) => p.team))]
    .sort((a, b) => a - b)
    .map((teamId) => {
      const leden = gescoord.filter((s) => s.speler.team === teamId);
      const rauw = leden.map((s) => s.speler);
      return {
        teamId,
        win: rauw[0]?.win ?? false,
        spelers: leden,
        kills: som(rauw, (p) => p.kills),
        deaths: som(rauw, (p) => p.deaths),
        assists: som(rauw, (p) => p.assists),
        gold: som(rauw, (p) => p.gold),
        cs: som(rauw, (p) => p.cs),
        damage: heeftDamage ? som(rauw, (p) => p.damage ?? 0) : null,
      };
    });

  return {
    teams,
    spelers: gescoord,
    lanes: leesLanes(gescoord, heeftDamage),
    ijk,
    ijkGames,
    visieBron,
    maxDamage,
    maxDamageTaken,
    maxGold,
    maxCs,
  };
}

function markeerBeste(kandidaten: NaspelSpeler[], veld: "isMvp" | "isAce"): void {
  let beste: NaspelSpeler | null = null;
  for (const kandidaat of kandidaten) {
    if (!beste || kandidaat.score > beste.score) beste = kandidaat;
  }
  if (beste) beste[veld] = true;
}

/**
 * The five lane duels, where the record supports calling them duels.
 *
 * Position comes from Riot's lane plus role, and in a blind-pick lobby it is
 * regularly UNKNOWN -- 20,340 of the 130,086 stored games have no positions at
 * all. A lane is therefore only paired when exactly one player per side claims
 * it; anything else would be pairing two people who never met, and a made-up
 * matchup is worse than no matchup section at all.
 */
function leesLanes(gescoord: readonly NaspelSpeler[], heeftDamage: boolean): NaspelLane[] {
  const lanes: NaspelLane[] = [];
  for (const position of LANE_VOLGORDE) {
    const blauw = gescoord.filter((s) => s.speler.position === position && s.speler.team === 100);
    const rood = gescoord.filter((s) => s.speler.position === position && s.speler.team !== 100);
    const b = blauw.length === 1 ? blauw[0] : undefined;
    const r = rood.length === 1 ? rood[0] : undefined;
    if (!b || !r) continue;
    lanes.push({
      position,
      blauw: b,
      rood: r,
      goudVerschil: b.speler.gold - r.speler.gold,
      csVerschil: b.speler.cs - r.speler.cs,
      damageVerschil: heeftDamage ? (b.speler.damage ?? 0) - (r.speler.damage ?? 0) : null,
    });
  }
  return lanes;
}
