/**
 * Runs the post-game verdict rule over real stored games and prints what it
 * would say, without opening a window.
 *
 *   npm run oordeel-probe            twenty games at random
 *   npm run oordeel-probe -- 40      forty of them
 *
 * This exists because the rule it exercises is the one thing on the post-game
 * screen that speaks in sentences, and a sentence is much easier to get subtly
 * wrong than a bar. "18 CS behind" with the sign inverted still looks like a
 * finished feature. Running it over a few hundred real games and reading the
 * output is the only check available while League is closed.
 *
 * Every seat is treated as "you" in turn, because the store holds other people's
 * games almost exclusively -- the crawler collects match history, and isYou is
 * false on all ten in nearly every record. Pretending each seat is the local
 * player is what gives this probe anything to say at all, and it exercises the
 * exact same code path the screen uses.
 */
import { MatchStore, defaultStorePath, type StoredPlayer } from "../core/services/matchStore";
import { JadeStats } from "../core/services/stats";
import { leesNaspel } from "../shared/naspel";
import { leesOordeel, type Meting } from "../shared/oordeel";
import type { GameDetail, PerformanceBaseline, SpelerIjklijn } from "../shared/types";

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m",
};

/**
 * The same two builders the main process runs, copied in shape rather than
 * imported: service.ts owns them as private methods on a class that needs a
 * League client to construct. Any drift between these and the originals shows up
 * as this probe disagreeing with the screen, which is a failure mode worth
 * having.
 */
function ijklijnVoor(stats: JadeStats, speler: StoredPlayer): SpelerIjklijn | null {
  const lane =
    speler.position === "UNKNOWN" ? null : stats.baseline(speler.championId, speler.position);
  const ijk = lane ?? stats.championBaseline(speler.championId);
  if (!ijk || !(ijk.minutes > 0)) return null;
  return {
    games: ijk.games,
    csPerMin: ijk.csPerMin,
    goldPerMin: ijk.goldPerMin,
    kaPerMin: (ijk.kills + ijk.assists) / ijk.minutes,
    kda: ijk.kda,
    bron: lane ? "lane" : "champion",
  };
}

function baselineVoor(
  stats: JadeStats,
  jij: StoredPlayer,
  duration: number,
): PerformanceBaseline | null {
  const gemiddelde = stats.baseline(jij.championId, jij.position);
  if (!gemiddelde) return null;
  const minuten = duration / 60;
  if (minuten <= 0) return null;
  return {
    championId: jij.championId,
    position: jij.position,
    games: gemiddelde.games,
    averageMinutes: gemiddelde.minutes,
    yourMinutes: minuten,
    csPerMin: { you: jij.cs / minuten, average: gemiddelde.csPerMin },
    goldPerMin: { you: jij.gold / minuten, average: gemiddelde.goldPerMin },
    kda: {
      you: jij.deaths === 0 ? jij.kills + jij.assists : (jij.kills + jij.assists) / jij.deaths,
      average: gemiddelde.kda,
    },
    kills: { you: jij.kills, average: gemiddelde.kills },
    deaths: { you: jij.deaths, average: gemiddelde.deaths },
    assists: { you: jij.assists, average: gemiddelde.assists },
    source: "local",
  };
}

/**
 * One measurement row in the four columns the screen draws it in.
 *
 * The widths are the terminal's own and not the stylesheet's; what is being
 * checked here is the content of the cells and their signs, which is the part a
 * screenshot cannot check quickly over three hundred games.
 */
function meetregel(m: Meting): string {
  return (
    `${c.dim}${m.maat.padEnd(26)}${c.reset}` +
    `${m.jij.padStart(10)}` +
    `${c.dim}${(m.norm ?? "").padStart(14)}${c.reset}` +
    `${(m.verschil ?? "").padStart(10)}`
  );
}

async function main(): Promise<void> {
  const hoeveel = Number(process.argv[2] ?? 20) || 20;
  const store = new MatchStore(defaultStorePath(process.cwd()));
  await store.load();
  if (store.size === 0) {
    console.error("Nog geen games verzameld. Draai eerst: npm run crawl");
    process.exitCode = 1;
    return;
  }

  const alle = store.all();
  const stats = JadeStats.from(alle);
  console.log(`${c.dim}${alle.length.toLocaleString("en-GB")} games, ${hoeveel} sampled${c.reset}\n`);

  let getoond = 0;
  let geenBaseline = 0;
  const tellen = new Map<string, number>();
  const stiltes = new Map<string, number>();

  for (let poging = 0; poging < hoeveel * 50 && getoond < hoeveel; poging++) {
    const match = alle[Math.floor(Math.random() * alle.length)];
    if (!match) continue;
    const stoel = Math.floor(Math.random() * match.players.length);
    const jij = match.players[stoel];
    if (!jij) continue;

    const baseline = baselineVoor(stats, jij, match.duration);
    if (!baseline) {
      geenBaseline++;
      continue;
    }

    const detail: GameDetail = {
      gameId: match.gameId,
      createdAt: match.createdAt,
      durationSeconds: match.duration,
      queueId: match.queueId,
      patch: match.patch,
      surrendered: match.surrendered,
      baseline,
      tijdlijn: null,
      // This probe reads matches straight off disk with no client anywhere, so
      // there is no history timeline to be had and saying so is the honest
      // answer rather than a stand-in.
      historie: { staat: "geen-client" },
      players: match.players.map((p, i) => ({
        championId: p.championId,
        team: p.teamId,
        position: p.position,
        win: p.win,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        cs: p.cs,
        gold: p.gold,
        items: p.items,
        spells: p.spells,
        damage: p.damage,
        damageTaken: p.damageTaken,
        vision: p.vision,
        wards: p.wards,
        level: p.level,
        ijklijn: ijklijnVoor(stats, p),
        isYou: i === stoel,
      })),
    };

    const naspel = leesNaspel(detail);
    const oordeel = leesOordeel(
      detail,
      naspel,
      baseline,
      String(jij.championId),
      jij.position,
    );

    getoond++;
    console.log(
      `${c.bold}${jij.championId} ${jij.position}${c.reset} ${c.dim}` +
        `${jij.kills}/${jij.deaths}/${jij.assists}, ${jij.cs} cs, ` +
        `${(match.duration / 60).toFixed(1)} min, game ${match.gameId}${c.reset}`,
    );
    for (const u of oordeel.tegenDatabase) {
      const kleur = u.toon === "goed" ? c.green : u.toon === "slecht" ? c.red : c.reset;
      const ster = u.tier === "ver" ? `${c.yellow}*${c.reset}` : " ";
      const luid = u.luidheid === null ? "  --" : `${u.luidheid.toFixed(1)}x`;
      console.log(`  ${ster}${kleur}${u.gebied.padEnd(24)}${c.reset}${c.dim} ${luid}${c.reset}`);
      // The table the screen actually draws, in the same four columns. Printed
      // rather than only the sentence, because the sentence is now behind a fold
      // and this probe is the only place either of them can be read side by side
      // over real games -- a sign inverted in one and not the other would
      // otherwise reach the screen looking finished.
      for (const m of u.metingen) console.log(`     ${meetregel(m)}`);
      console.log(`     ${c.dim}${u.zin}${c.reset}`);
      tellen.set(u.sleutel, (tellen.get(u.sleutel) ?? 0) + 1);
    }
    for (const u of oordeel.binnenDezeGame) {
      console.log(`  ${c.cyan}${u.gebied}${c.reset}`);
      for (const m of u.metingen) console.log(`     ${meetregel(m)}`);
    }
    if (oordeel.gewoon.length > 0) {
      console.log(`  ${c.dim}normal: ${oordeel.gewoon.join(", ")}${c.reset}`);
    }
    for (const z of oordeel.zwijgt) {
      stiltes.set(z.onderwerp, (stiltes.get(z.onderwerp) ?? 0) + 1);
    }
    console.log();
  }

  console.log(`${c.bold}Statements fired${c.reset}`);
  for (const [sleutel, n] of [...tellen].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sleutel.padEnd(12)} ${n} of ${getoond} seats`);
  }
  console.log(`${c.bold}Silences${c.reset}`);
  for (const [onderwerp, n] of [...stiltes].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${onderwerp.padEnd(22)} ${n} of ${getoond} seats`);
  }
  if (geenBaseline > 0) {
    console.log(
      `${c.dim}${geenBaseline} seats skipped: no baseline, which means an unresolved lane${c.reset}`,
    );
  }
}

void main();
