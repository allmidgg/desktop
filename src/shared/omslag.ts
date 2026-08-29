/**
 * Which minute it went worse, said out loud.
 *
 * ── The question, and why a curve is not an answer to it ─────────────────────
 *
 * A chart hands the reader a shape and leaves them to go looking. What was
 * actually asked for is the answer: the stretch of the game where you came off
 * worst, how far behind you fell in it, and what was happening while it
 * happened. That is a sentence, not a picture, and this file produces the
 * sentence.
 *
 * It reads what the sampler in liveGame.ts writes -- OpnameRecord.verloop, the
 * scoreline every fifteen seconds -- together with the purchases and the event
 * feed that were already being recorded. Nothing here estimates or interpolates.
 * Every sentence it produces traces back to two readings and the events between
 * them, which is why it can be checked by scrubbing the timeline above it to the
 * two seconds it names.
 *
 * ── Why the stretch is not a fixed window ────────────────────────────────────
 *
 * The obvious build is to score every three-minute window and print the worst.
 * Two faults. Three minutes is a number nobody can defend, and a bad patch that
 * ran four and a half minutes comes back reported as three, understating it by a
 * third. So no length is chosen in advance: the stretch that lost the most is
 * found with the maximum-subarray rule over the per-interval differences, which
 * considers every contiguous stretch there is. The only thing left to fix is a
 * floor on how short an answer may be, and that floor is about measurement
 * rather than about the game -- see MINIMAAL_SECONDEN.
 *
 * ── What "behind" is measured against ────────────────────────────────────────
 *
 * Two references, because they answer different questions and both get asked.
 * Your lane opponent says whether you lost the lane. The champion's own norm in
 * that lane -- the same baseline the post-game badge is scored on -- says
 * whether you played badly, which is not the same thing: a mid laner can be 20
 * CS up on his opponent while both of them are 40 CS below what the pick
 * normally farms.
 *
 * The norm is also what decides whether a finding is worth printing. See
 * DREMPEL_MINUTEN.
 */
import { aankoopVerloop, goudOp } from "./build";
import type { BuildStep, OpnameRecord, SpelGebeurtenis, Verloop } from "./types";

/**
 * The shortest stretch this will report, in seconds.
 *
 * Not a claim about League. The sampler reads the scoreline every fifteen
 * seconds, so a two-interval answer rests on three readings and one poll that
 * landed late decides it. Two minutes is at least eight intervals at the
 * sampler's normal spacing, and it survives the halving that a very long game
 * triggers. It is also the shortest answer that can honestly be read out in
 * minutes, which is the form the question was asked in.
 */
export const MINIMAAL_SECONDEN = 120;

/**
 * How much has to be lost before it earns a sentence.
 *
 * Expressed in minutes of this champion's own normal output in this lane, and
 * that is the whole point of it. An absolute figure -- ten CS, five hundred
 * gold -- is a different demand depending on who is being measured. Measured
 * over every non-bot game in matches.jsonl, 126,287 of them, the median creep
 * score per minute is 5.78 in top, 5.43 bottom, 5.34 middle, 4.59 in the jungle
 * and 0.78 on support. So "ten CS behind" is under two minutes of farming for a
 * top laner and around thirteen for a support, and a fixed threshold would call
 * half of every support's game remarkable. Two minutes of your own normal output
 * is the same size of event for both, which is the principle the post-game badge
 * already runs on.
 *
 * Paired with the floor above it, a reported stretch means: over at least two
 * minutes, you lost at least two minutes' worth of what you normally produce.
 * Half your output or worse, for at least two minutes. That is a finding.
 */
export const DREMPEL_MINUTEN = 2;

/**
 * How far below the reference a minute has to run before it counts as bad.
 *
 * This is the constant that makes the answer a stretch of a game rather than
 * the game. Maximum-subarray maximises a total, and a total rewards length: a
 * player running one percent under the norm for forty minutes accumulates a
 * bigger deficit than one who lost three minutes catastrophically, so the rule
 * without this returns the whole match every time. That is not a hypothesis.
 * Run against a curve that farmed exactly at the norm apart from a planted
 * three-minute stall from 11:00 to 14:00, the first version of this file
 * answered "between 0:00 and 44:15" -- technically the largest total, and
 * useless as an answer to which minute it went worse.
 *
 * So every minute is charged half of what this champion normally produces
 * before it is allowed to count against you, and a stretch only accumulates
 * while it is doing worse than that. What a reported stretch then means is
 * plain enough to print: over this stretch you produced less than half of your
 * own normal output, compared to the reference. The same figure mirrored finds
 * the good stretch -- half again your normal output or better.
 *
 * A half is a choice, and it is the one place in this file that is. It is the
 * midpoint of the only range the figure can take against the norm: nothing at
 * all is your whole rate below normal, and dead average is zero below it.
 */
export const TOL_AANDEEL = 0.5;

/** mm:ss. Exported so the sentences and the screen read the clock identically. */
export const klokTekst = (seconden: number): string => {
  const s = Math.max(0, Math.round(seconden));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export type OmslagSoort = "cs-tegenstander" | "cs-normaal" | "goud-normaal";

/**
 * What this champion normally does in this lane.
 *
 * The same four figures SpelerIjklijn carries, and that is deliberate: this
 * file is handed the baseline the rest of the post-game screen is already
 * measured against, so the two can never disagree about what normal is.
 */
export interface OmslagIjk {
  csPerMin: number;
  goldPerMin: number;
  /** Recorded games behind the averages. Never dropped: it is what makes them readable. */
  games: number;
  /** Whether the norm is this lane's or the champion's lanes pooled. */
  bron: "lane" | "champion";
}

/** One thing that was going on inside a stretch, and when. */
export interface OmslagFeit {
  soort: "dood" | "kill" | "objectief" | "level" | "goud";
  /** Game time in seconds, or null when the fact is about the whole stretch. */
  at: number | null;
  tekst: string;
}

/** One stretch of the game, and everything that puts it on screen. */
export interface OmslagVenster {
  soort: OmslagSoort;
  richting: "achter" | "voor";
  /** Game time of the reading the stretch starts on. */
  van: number;
  /** Game time of the reading it ends on. */
  tot: number;
  /** How much was lost or gained over the stretch. Always positive. */
  verschil: number;
  eenheid: "CS" | "gold";
  /** The same figure in minutes of this champion's normal output; what ranks it. */
  minutenNormaal: number;
  /** What it had to clear, so the screen can print the bar rather than assert it. */
  drempel: number;
  /** Your rate inside the stretch, per minute. */
  jouwTempo: number;
  /** The reference's rate over the same stretch, per minute. */
  ijkTempo: number;
  /** The opponent's champion, or the word used for the norm. */
  ijkNaam: string;
  feiten: OmslagFeit[];
  /** The finding as one sentence, with the fact that explains it attached. */
  zin: string;
}

export interface Omslag {
  /** Seat in OpnameRecord.spelers that was at the keyboard. */
  jij: number;
  /** The seat opposite you in your lane, or null when the recording cannot pair one. */
  tegenstander: number | null;
  ijk: OmslagIjk;
  /** Readings the answer stands on. */
  metingen: number;
  /** Seconds between readings, measured off the time axis rather than assumed. */
  intervalSeconden: number;
  /** Game seconds the readings actually cover, which is not always the whole game. */
  dekking: { van: number; tot: number };
  ergste: OmslagVenster | null;
  beste: OmslagVenster | null;
  /** Findings from the other comparisons, strongest first. */
  overig: OmslagVenster[];
  /** Why nothing stood out, when nothing did. Null when something did. */
  geenReden: string | null;
}

/**
 * Why there is no analysis at all, which is not the same as nothing to report.
 *
 * "geen-verloop" is every recording written before the sampler existed and every
 * game the crawler collected, which is almost all of them.
 */
export type OmslagGeen = "geen-verloop" | "te-kort" | "geen-jij" | "geen-ijk";

export interface OmslagUit {
  omslag: Omslag | null;
  /** Set exactly when omslag is null. */
  geen: OmslagGeen | null;
}

const EVENT_LABEL: Record<SpelGebeurtenis["soort"], string> = {
  kill: "A kill",
  firstblood: "First blood",
  dragon: "Dragon",
  baron: "Baron",
  turret: "A turret",
  inhibitor: "An inhibitor",
};

/** Events worth naming inside a stretch. A single kill is covered separately. */
const OBJECTIEF = new Set<SpelGebeurtenis["soort"]>(["dragon", "baron", "inhibitor", "turret"]);

/** Whole numbers: a CS is a countable thing and gold is quoted whole. */
const heel = (n: number): string => String(Math.round(n));

/** "11:40", "11:40 and 13:02", "11:40, 13:02 and 14:10". */
function lijst(delen: string[]): string {
  if (delen.length <= 1) return delen[0] ?? "";
  return `${delen.slice(0, -1).join(", ")} and ${delen[delen.length - 1]}`;
}

/** One contiguous stretch of readings and what it came to. */
interface Bereik {
  i: number;
  j: number;
  som: number;
}

/**
 * The stretch with the largest total, of at least a given length in seconds.
 *
 * Maximum-subarray with a minimum-length constraint, over prefix sums: the total
 * from reading i to reading j is P[j] - P[i], so for each end j the best start is
 * the smallest P[i] among the starts far enough back. The pointer only ever
 * moves forward, because the readings are in time order, which makes this one
 * pass over the game rather than one pass per candidate stretch.
 *
 * Handed negated differences it finds the worst stretch instead. One function
 * and not two, so the best and the worst can never be found by rules that drifted
 * apart.
 */
function grootsteBereik(tijden: number[], verschillen: number[], minLengte: number): Bereik | null {
  const prefix: number[] = [0];
  for (const d of verschillen) prefix.push((prefix[prefix.length - 1] ?? 0) + d);

  let start = 0;
  let laagsteIndex = -1;
  let laagste = Number.POSITIVE_INFINITY;
  let beste: Bereik | null = null;

  for (let j = 1; j < tijden.length; j++) {
    const eind = tijden[j];
    if (eind === undefined) continue;
    const grens = eind - minLengte;
    while (start < j) {
      const t = tijden[start];
      if (t === undefined || t > grens) break;
      const waarde = prefix[start] ?? 0;
      if (waarde < laagste) {
        laagste = waarde;
        laagsteIndex = start;
      }
      start++;
    }
    if (laagsteIndex < 0) continue;
    const som = (prefix[j] ?? 0) - laagste;
    if (!beste || som > beste.som) beste = { i: laagsteIndex, j, som };
  }

  return beste;
}

/**
 * The longest run of readings where every one of these columns has a number.
 *
 * The sampler writes null for a seat a poll did not list, which is what happens
 * when the app starts watching a game already in progress, and null for your
 * gold while spectating. Those are honest gaps and they must not be read as
 * zeroes, so a comparison is made over the longest unbroken run it has and the
 * screen is told what that run covered. Dropping the whole game over two missing
 * readings at the front would throw away the answer to keep the tidiness.
 */
function langsteRun(kolommen: Array<Array<number | null>>): { van: number; tot: number } | null {
  const lengte = Math.min(...kolommen.map((k) => k.length));
  if (!Number.isFinite(lengte) || lengte <= 0) return null;

  let beste: { van: number; tot: number } | null = null;
  let begin = -1;
  for (let i = 0; i < lengte; i++) {
    const compleet = kolommen.every((k) => typeof k[i] === "number");
    if (compleet) {
      if (begin < 0) begin = i;
      const nu = { van: begin, tot: i };
      if (!beste || nu.tot - nu.van > beste.tot - beste.van) beste = nu;
    } else {
      begin = -1;
    }
  }
  return beste && beste.tot > beste.van ? beste : null;
}

/** Reads a column over a run, with the nulls already ruled out by langsteRun. */
const snij = (kolom: Array<number | null>, van: number, tot: number): number[] =>
  kolom.slice(van, tot + 1).map((w) => (typeof w === "number" ? w : 0));

/** One reference to measure your own line against, already cut to its own run. */
interface Vergelijking {
  soort: OmslagSoort;
  eenheid: OmslagVenster["eenheid"];
  ijkNaam: string;
  /** The champion's normal rate, which sets both the threshold and the wording. */
  perMin: number;
  /** Index into Verloop.tijden of the first reading used, so facts can look back. */
  offset: number;
  tijden: number[];
  /** Your running total at each reading in the run. */
  jouw: number[];
  /**
   * The reference's running total, or null for a flat rate.
   *
   * An opponent is a real series with his own bad minutes in it. The norm is a
   * straight line, because a straight line is exactly what an average per minute
   * is, and pretending otherwise would be inventing a shape for it.
   */
  ijkReeks: number[] | null;
}

/** The seat opposite you: same lane, other side, and exactly one of them. */
function tegenstanderVan(opname: OpnameRecord, jij: number): number | null {
  const ik = opname.spelers[jij];
  if (!ik || ik.position === null || ik.team === "UNKNOWN") return null;
  let gevonden: number | null = null;
  opname.spelers.forEach((s, i) => {
    if (i === jij || s.position !== ik.position || s.team === "UNKNOWN" || s.team === ik.team) return;
    // A second candidate means the lane cannot be paired at all. Pairing two
    // people who never stood in the same lane is worse than pairing nobody.
    gevonden = gevonden === null ? i : -1;
  });
  return gevonden === -1 ? null : gevonden;
}

/**
 * What was going on during a stretch.
 *
 * Every entry is read straight off the recording. The deaths are the difference
 * between two readings, so they include the ones the event feed never mentions:
 * the feed reports champion kills, and a player executed by a turret is not one.
 * Where the feed does name them, the seconds come from there, because those are
 * exact and a reading is only accurate to the sampling interval.
 */
function feitenVoor(
  opname: OpnameRecord,
  verloop: Verloop,
  jij: number,
  tegenstander: number | null,
  ijk: OmslagIjk,
  jouwAankopen: BuildStep[],
  van: number,
  tot: number,
  /** Absolute indices into verloop.tijden of the two ends. */
  indexVan: number,
  indexTot: number,
  richting: OmslagVenster["richting"],
): OmslagFeit[] {
  const ik = opname.spelers[jij];
  const mijn = verloop.spelers[jij];
  const feiten: OmslagFeit[] = [];

  // Half-open, matching the readings: a change between two readings happened
  // after the first and no later than the second. An event exactly on a boundary
  // belongs to the stretch whose numbers it moved.
  const inVenster = (g: SpelGebeurtenis): boolean => g.at > van && g.at <= tot;

  const doodBegin = mijn?.deaths[indexVan];
  const doodEind = mijn?.deaths[indexTot];
  const doden =
    typeof doodBegin === "number" && typeof doodEind === "number" ? doodEind - doodBegin : 0;
  if (doden > 0) {
    const genoemd = opname.gebeurtenissen
      .filter((g) => g.soort === "kill" && g.aan === jij && inVenster(g))
      .map((g) => g.at)
      .sort((a, b) => a - b);
    const ongenoemd = doden - genoemd.length;
    const tekst =
      genoemd.length === 0
        ? `You died ${doden === 1 ? "once" : `${doden} times`}, and the feed names neither moment: it reports champion kills, so a death to a turret or a minion leaves no event.`
        : `You died at ${lijst(genoemd.map(klokTekst))}` +
          (ongenoemd > 0
            ? `, and ${ongenoemd} more time${ongenoemd === 1 ? "" : "s"} the feed does not name -- it only reports champion kills.`
            : ".");
    feiten.push({ soort: "dood", at: genoemd[0] ?? null, tekst });
  }

  const jouwKills = opname.gebeurtenissen.filter(
    (g) => g.soort === "kill" && inVenster(g) && (g.door === jij || g.assists.includes(jij)),
  );
  if (jouwKills.length > 0) {
    feiten.push({
      soort: "kill",
      at: jouwKills[0]?.at ?? null,
      tekst: `You were in ${jouwKills.length === 1 ? "a kill" : `${jouwKills.length} kills`}, at ${lijst(
        jouwKills.map((g) => klokTekst(g.at)),
      )}.`,
    });
  }

  for (const g of opname.gebeurtenissen) {
    if (!OBJECTIEF.has(g.soort) || !inVenster(g)) continue;
    const doorTeam = g.door === null ? null : (opname.spelers[g.door]?.team ?? null);
    // Only ever "yours" or "theirs" relative to the seat at the keyboard. The
    // recording holds no names and the sides are ORDER and CHAOS, which mean
    // nothing to the person reading their own game back.
    const kant =
      doorTeam === null || doorTeam === "UNKNOWN" || !ik || ik.team === "UNKNOWN"
        ? ""
        : doorTeam === ik.team
          ? ", to your side"
          : ", to theirs";
    const wat =
      g.soort === "dragon" && g.detail ? `${EVENT_LABEL[g.soort]} (${g.detail})` : EVENT_LABEL[g.soort];
    feiten.push({
      soort: "objectief",
      at: g.at,
      tekst: `${wat} at ${klokTekst(g.at)}${kant}${g.gestolen ? ", stolen" : ""}.`,
    });
  }

  // Gold in a pocket is only worth mentioning when it sat there. A purchase
  // inside the stretch means the shop was reached, and then a high reading is
  // just the moment before spending it.
  if (!jouwAankopen.some((s) => s.at > van && s.at <= tot)) {
    let hoogste = -1;
    let hoogsteOp = van;
    for (let k = indexVan; k <= indexTot; k++) {
      const goud = verloop.goud[k];
      if (typeof goud !== "number") continue;
      if (goud > hoogste) {
        hoogste = goud;
        hoogsteOp = verloop.tijden[k] ?? van;
      }
    }
    // The same yardstick as everything else here: two minutes of what this
    // champion normally earns. Carrying that much without spending it is the
    // shape of a recall that did not happen -- which is a thing the reader can
    // conclude, and not a thing this sentence claims.
    if (hoogste >= ijk.goldPerMin * DREMPEL_MINUTEN) {
      const volgende = jouwAankopen.find((s) => s.at > tot);
      feiten.push({
        soort: "goud",
        at: hoogsteOp,
        tekst:
          `You were carrying ${heel(hoogste)} gold unspent at ${klokTekst(hoogsteOp)} and bought nothing in this stretch` +
          (volgende ? `; your next purchase was at ${klokTekst(volgende.at)}.` : `; you never bought again.`),
      });
    }
  }

  if (tegenstander !== null) {
    const hun = verloop.spelers[tegenstander];
    const mijnBegin = mijn?.level[indexVan];
    const mijnEind = mijn?.level[indexTot];
    const hunBegin = hun?.level[indexVan];
    const hunEind = hun?.level[indexTot];
    if (
      typeof mijnBegin === "number" && typeof mijnEind === "number" &&
      typeof hunBegin === "number" && typeof hunEind === "number" &&
      mijnEind - mijnBegin !== hunEind - hunBegin
    ) {
      const mij = mijnEind - mijnBegin;
      const zij = hunEind - hunBegin;
      feiten.push({
        soort: "level",
        at: null,
        tekst: `You gained ${mij} level${mij === 1 ? "" : "s"} to their ${zij}, ending the stretch at ${mijnEind} against ${hunEind}.`,
      });
    }
  }

  // Deaths explain a bad stretch and kills explain a good one, so whichever of
  // the two fits the direction leads the list; the rest keep the order they
  // happened in. Only the first one goes in the sentence.
  const rang = (f: OmslagFeit): number =>
    richting === "achter"
      ? f.soort === "dood" ? 0 : f.soort === "goud" ? 1 : 2
      : f.soort === "kill" ? 0 : f.soort === "objectief" ? 1 : 2;
  return feiten.sort((a, b) => rang(a) - rang(b) || (a.at ?? Infinity) - (b.at ?? Infinity));
}

/** The headline, with the one fact that explains it attached. */
function zinVoor(venster: Omit<OmslagVenster, "zin">): string {
  const wanneer = `Between ${klokTekst(venster.van)} and ${klokTekst(venster.tot)}`;
  const hoeveel = heel(venster.verschil);
  const kop =
    venster.soort === "cs-tegenstander"
      ? venster.richting === "achter"
        ? `${wanneer} you fell ${hoeveel} CS behind ${venster.ijkNaam}.`
        : `${wanneer} you took ${hoeveel} CS more than ${venster.ijkNaam}.`
      : venster.soort === "cs-normaal"
        ? venster.richting === "achter"
          ? `${wanneer} you farmed ${hoeveel} CS less than this champion normally does in this lane.`
          : `${wanneer} you farmed ${hoeveel} CS more than this champion normally does in this lane.`
        : venster.richting === "achter"
          ? `${wanneer} you took ${hoeveel} gold less out of the game than this champion normally does in this lane.`
          : `${wanneer} you took ${hoeveel} gold more out of the game than this champion normally does in this lane.`;

  // One fact in the sentence and the rest under it. The sentence has to survive
  // being read out loud, and four clauses does not.
  const eerste = venster.feiten[0];
  return eerste ? `${kop} ${eerste.tekst}` : kop;
}

/**
 * The finding for one comparison in one direction, or nothing.
 *
 * Nothing is the ordinary answer: a stretch has to be long enough to name and
 * large enough to matter before it earns a sentence, and plenty of games hold
 * neither in either direction.
 */
function vensterVan(
  opname: OpnameRecord,
  verloop: Verloop,
  jij: number,
  tegenstander: number | null,
  ijk: OmslagIjk,
  jouwAankopen: BuildStep[],
  vergelijking: Vergelijking,
  verschillen: number[],
  richting: OmslagVenster["richting"],
): OmslagVenster | null {
  const teken = richting === "achter" ? -1 : 1;
  const drempel = vergelijking.perMin * DREMPEL_MINUTEN;
  if (!(drempel > 0)) return null;

  // Every minute is charged the toll before it may count. See TOL_AANDEEL: this
  // is what stops a game spent one percent under the norm from being reported as
  // one forty-minute disaster.
  const tol = vergelijking.perMin * TOL_AANDEEL;
  const gescoord = verschillen.map((d, k) => {
    const t0 = vergelijking.tijden[k];
    const t1 = vergelijking.tijden[k + 1];
    const minuten = t0 === undefined || t1 === undefined ? 0 : (t1 - t0) / 60;
    return d * teken - tol * minuten;
  });

  const bereik = grootsteBereik(vergelijking.tijden, gescoord, MINIMAAL_SECONDEN);
  if (!bereik || !(bereik.som > 0)) return null;

  const van = vergelijking.tijden[bereik.i];
  const tot = vergelijking.tijden[bereik.j];
  if (van === undefined || tot === undefined) return null;
  const minuten = (tot - van) / 60;
  if (!(minuten > 0)) return null;

  const jouwStart = vergelijking.jouw[bereik.i] ?? 0;
  const jouwEind = vergelijking.jouw[bereik.j] ?? 0;
  const ijkGroei = vergelijking.ijkReeks
    ? (vergelijking.ijkReeks[bereik.j] ?? 0) - (vergelijking.ijkReeks[bereik.i] ?? 0)
    : vergelijking.perMin * minuten;
  const ijkTempo = ijkGroei / minuten;

  // What goes on screen is the plain difference over the stretch, never the
  // tolled score that found it. The toll decides where to look; the sentence has
  // to say how far behind you actually were, or it cannot be checked against the
  // chart underneath it.
  const ruw = (jouwEind - jouwStart - ijkGroei) * teken;
  if (!(ruw >= drempel)) return null;

  const zonderZin: Omit<OmslagVenster, "zin"> = {
    soort: vergelijking.soort,
    richting,
    van,
    tot,
    verschil: ruw,
    eenheid: vergelijking.eenheid,
    minutenNormaal: ruw / vergelijking.perMin,
    drempel,
    jouwTempo: (jouwEind - jouwStart) / minuten,
    ijkTempo,
    ijkNaam: vergelijking.ijkNaam,
    feiten: feitenVoor(
      opname, verloop, jij, tegenstander, ijk, jouwAankopen, van, tot,
      vergelijking.offset + bereik.i, vergelijking.offset + bereik.j, richting,
    ),
  };
  return { ...zonderZin, zin: zinVoor(zonderZin) };
}

/** Per-interval differences between your line and the reference's. */
function verschillenVan(vergelijking: Vergelijking): number[] {
  const uit: number[] = [];
  for (let k = 0; k + 1 < vergelijking.tijden.length; k++) {
    const t0 = vergelijking.tijden[k];
    const t1 = vergelijking.tijden[k + 1];
    if (t0 === undefined || t1 === undefined) continue;
    const jouwGroei = (vergelijking.jouw[k + 1] ?? 0) - (vergelijking.jouw[k] ?? 0);
    const ijkGroei = vergelijking.ijkReeks
      ? (vergelijking.ijkReeks[k + 1] ?? 0) - (vergelijking.ijkReeks[k] ?? 0)
      : (vergelijking.perMin * (t1 - t0)) / 60;
    uit.push(jouwGroei - ijkGroei);
  }
  return uit;
}

/**
 * Reads a recording as an answer to "which minute did it go worse".
 *
 * Answers with no analysis at all -- rather than an empty one -- for a recording
 * that cannot carry one: written before the sampler existed, too short to hold a
 * stretch, missing the seat that was at the keyboard, or of a champion the store
 * has no norm for yet. The screen then draws nothing, because a panel
 * apologising for its own existence is worse than no panel.
 *
 * `prijsVan` and `onderdelenVan` come from the item catalogue and are used for
 * your own line only: gold committed to items plus the gold in your pocket is
 * the closest thing to gold earned that a running game ever reveals, and it is
 * revealed for you alone.
 */
export function leesOmslag(
  opname: OpnameRecord,
  ijk: OmslagIjk | null,
  prijsVan: (itemId: number) => number,
  onderdelenVan: (itemId: number) => number[],
): OmslagUit {
  const verloop = opname.verloop;
  if (!verloop || verloop.tijden.length < 2) return { omslag: null, geen: "geen-verloop" };

  const eerste = verloop.tijden[0];
  const laatste = verloop.tijden[verloop.tijden.length - 1];
  if (eerste === undefined || laatste === undefined) return { omslag: null, geen: "geen-verloop" };
  if (laatste - eerste < MINIMAAL_SECONDEN) return { omslag: null, geen: "te-kort" };

  // The seat carrying a skill order is the seat that was at the keyboard: the
  // client reveals nobody else's abilities, so exactly one seat can have one.
  // The recording holds no names, and this is the only marker there is.
  const jij = opname.spelers.findIndex((s) => s.skillOrder !== undefined && s.skillOrder.length > 0);
  if (jij < 0) return { omslag: null, geen: "geen-jij" };
  if (!ijk || !(ijk.csPerMin > 0) || !(ijk.goldPerMin > 0)) return { omslag: null, geen: "geen-ijk" };

  const mijn = verloop.spelers[jij];
  if (!mijn) return { omslag: null, geen: "geen-verloop" };

  const tegenstander = tegenstanderVan(opname, jij);
  const jouwAankopen = opname.spelers[jij]?.build ?? [];
  const vergelijkingen: Vergelijking[] = [];

  // Each comparison gets its own run of readings, because they need different
  // columns and those columns have different holes in them. A missing gold
  // reading must not cost the CS answer.
  if (tegenstander !== null) {
    const hun = verloop.spelers[tegenstander];
    const naam = opname.spelers[tegenstander]?.championName;
    const run = hun ? langsteRun([mijn.cs, hun.cs]) : null;
    if (hun && naam && run) {
      vergelijkingen.push({
        soort: "cs-tegenstander",
        eenheid: "CS",
        ijkNaam: naam,
        perMin: ijk.csPerMin,
        offset: run.van,
        tijden: verloop.tijden.slice(run.van, run.tot + 1),
        jouw: snij(mijn.cs, run.van, run.tot),
        ijkReeks: snij(hun.cs, run.van, run.tot),
      });
    }
  }

  const eigenRun = langsteRun([mijn.cs]);
  if (eigenRun) {
    vergelijkingen.push({
      soort: "cs-normaal",
      eenheid: "CS",
      ijkNaam: "normal",
      perMin: ijk.csPerMin,
      offset: eigenRun.van,
      tijden: verloop.tijden.slice(eigenRun.van, eigenRun.tot + 1),
      jouw: snij(mijn.cs, eigenRun.van, eigenRun.tot),
      ijkReeks: null,
    });
  }

  // Your own gold, and only ever yours: the running game reports currentGold for
  // the player at the keyboard and for nobody else. Committed plus in hand is
  // not exactly gold earned -- an item sold hands back gold that was never
  // counted going out, and anything bought before the app started watching was
  // never seen at all -- but both of those are a constant offset, and every
  // figure below is a difference between two readings, where a constant offset
  // cancels. That is what makes this fit to measure a stretch with and unfit to
  // quote as a total, and the screen says exactly that.
  const goudRun = langsteRun([mijn.cs, verloop.goud]);
  if (goudRun) {
    const aankopen = aankoopVerloop(jouwAankopen, prijsVan, onderdelenVan);
    const tijden = verloop.tijden.slice(goudRun.van, goudRun.tot + 1);
    const zak = snij(verloop.goud, goudRun.van, goudRun.tot);
    vergelijkingen.push({
      soort: "goud-normaal",
      eenheid: "gold",
      ijkNaam: "normal",
      perMin: ijk.goldPerMin,
      offset: goudRun.van,
      tijden,
      jouw: tijden.map((t, i) => goudOp(aankopen, t) + (zak[i] ?? 0)),
      ijkReeks: null,
    });
  }

  const gevonden: OmslagVenster[] = [];
  for (const vergelijking of vergelijkingen) {
    const verschillen = verschillenVan(vergelijking);
    for (const richting of ["achter", "voor"] as const) {
      const venster = vensterVan(
        opname, verloop, jij, tegenstander, ijk, jouwAankopen, vergelijking, verschillen, richting,
      );
      if (venster) gevonden.push(venster);
    }
  }

  // Ranked in minutes of normal output, which is the one scale CS and gold can
  // both be read on. Without it a gold finding of 900 would outrank a CS finding
  // of 30 every time, for no reason beyond the unit each happens to be counted
  // in.
  const achter = gevonden.filter((v) => v.richting === "achter").sort((a, b) => b.minutenNormaal - a.minutenNormaal);
  const voor = gevonden.filter((v) => v.richting === "voor").sort((a, b) => b.minutenNormaal - a.minutenNormaal);
  const ergste = achter[0] ?? null;
  const beste = voor[0] ?? null;

  // The gaps between readings are what everything above is measured over, so the
  // screen is given the spacing that actually happened rather than the spacing
  // the sampler was aiming for.
  const gaten = verloop.tijden
    .slice(1)
    .map((t, i) => t - (verloop.tijden[i] ?? t))
    .sort((a, b) => a - b);

  return {
    omslag: {
      jij,
      tegenstander,
      ijk,
      metingen: verloop.tijden.length,
      intervalSeconden: gaten[gaten.length >> 1] ?? verloop.interval,
      // The span your own seat was actually measured over, which is not always
      // the span the sampler was running for: a game the app joined late has
      // readings whose seats are empty, and claiming those as coverage would
      // overstate what every finding above rests on.
      dekking: {
        van: (eigenRun ? verloop.tijden[eigenRun.van] : eerste) ?? eerste,
        tot: (eigenRun ? verloop.tijden[eigenRun.tot] : laatste) ?? laatste,
      },
      ergste,
      beste,
      overig: [...achter.slice(1), ...voor.slice(1)].sort((a, b) => b.minutenNormaal - a.minutenNormaal),
      geenReden:
        ergste || beste
          ? null
          : `Nothing stood out. There is no stretch of ${klokTekst(MINIMAAL_SECONDEN)} or longer in which you ` +
            `ran at under half your normal output and lost more than ` +
            `${heel(ijk.csPerMin * DREMPEL_MINUTEN)} CS or ${heel(ijk.goldPerMin * DREMPEL_MINUTEN)} gold by it ` +
            `-- two minutes of what this champion does in this lane over ${ijk.games} recorded games. ` +
            `The game had its ups and downs; none of them lasted long enough or ran deep enough to name.`,
    },
    geen: null,
  };
}
