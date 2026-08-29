/**
 * AllMid stats -- leest de verzamelde matches en rekent er statistiek op uit.
 * Crawlt niets; puur wat er al op schijf staat.
 *
 *   npm run stats              tierlijsten per positie
 *   npm run stats -- Ashe      alles wat we over een champion weten
 */
import { join } from "node:path";
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { GameCatalog, type CatalogView } from "../core/jade/catalog";
import { MatchStore, defaultStorePath, type Position } from "../core/services/matchStore";
import { JadeStats } from "../core/services/stats";

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m",
};

const POSITIONS: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];

/**
 * Hoeveel games een champion in een positie moet hebben voordat we hem in een
 * tierlijst zetten. Met een lagere drempel gaat de lijst over toeval: 9 van de
 * 11 gewonnen ziet eruit als 82% en zegt niets.
 */
const MIN_TIER_GAMES = 25;

function tone(winrate: number): string {
  return winrate >= 0.55 ? c.green : winrate <= 0.45 ? c.red : c.reset;
}

async function main(): Promise<void> {
  const store = new MatchStore(defaultStorePath(process.cwd()));
  await store.load();
  if (store.size === 0) {
    console.error("Nog geen games verzameld. Draai eerst: npm run crawl");
    process.exitCode = 1;
    return;
  }

  // Werkt ook met de client dicht: dan lezen we de championnamen uit de cache.
  const catalogus = await GameCatalog.loadOrCached(
    () => LcuClient.connect(),
    join(process.cwd(), "data", "catalog.json"),
  );
  // These are Classic tallies, so this reads the Classic names for them.
  const catalog = catalogus.for("lol:jade");
  const stats = JadeStats.from(store.all(), "lol:jade");
  const coverage = stats.coverage();

  console.log(`\n${c.bold}Database${c.reset}`);
  console.log(`  ${stats.totalMatches} games, ${store.knownPuuids.length} spelers`);
  console.log(`  ${coverage.usable} van de ${coverage.matchups} matchups heeft genoeg games\n`);

  const wanted = process.argv[2];
  if (wanted) return championReport(catalog, stats, wanted);

  for (const position of POSITIONS) {
    const tier = stats.tierList(position, MIN_TIER_GAMES);
    console.log(`${c.cyan}${position}${c.reset} ${c.dim}(minstens ${MIN_TIER_GAMES} games)${c.reset}`);
    if (tier.length === 0) {
      console.log(`   ${c.dim}nog geen champion met genoeg games${c.reset}\n`);
      continue;
    }
    for (const entry of tier.slice(0, 8)) {
      const kda =
        entry.avgDeaths === 0
          ? entry.avgKills + entry.avgAssists
          : (entry.avgKills + entry.avgAssists) / entry.avgDeaths;
      console.log(
        `   ${catalog.championName(entry.championId).padEnd(16)} ` +
          `${tone(entry.winrate)}${(entry.winrate * 100).toFixed(0)}%${c.reset}`.padEnd(14) +
          `${c.dim}${String(entry.games).padStart(4)} games  ` +
          `pick ${(entry.pickRate * 100).toFixed(1)}%  KDA ${kda.toFixed(2)}${c.reset}`,
      );
    }
    const shown = Math.min(8, tier.length);
    if (tier.length > shown) console.log(`   ${c.dim}... nog ${tier.length - shown} champions${c.reset}`);
    console.log();
  }
}

function championReport(catalog: CatalogView, stats: JadeStats, name: string): void {
  const champion = [...catalog.champions.values()].find(
    (ch) => ch.alias.toLowerCase() === name.toLowerCase() || ch.name.toLowerCase() === name.toLowerCase(),
  );
  if (!champion) {
    console.error(`Champion "${name}" bestaat niet in League Classic.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${c.bold}${champion.name}${c.reset}\n`);
  for (const position of POSITIONS) {
    const stat = stats.championStat(champion.id, position);
    if (!stat || stat.games < 5) continue;
    console.log(
      `${c.cyan}${position}${c.reset}  ${tone(stat.winrate)}${(stat.winrate * 100).toFixed(0)}%${c.reset} ` +
        `${c.dim}over ${stat.games} games, pick ${(stat.pickRate * 100).toFixed(1)}%${c.reset}`,
    );

    const counters = stats.countersFor(champion.id, position).filter((m) => m.winrate > 0.5);
    if (counters.length > 0) {
      console.log(`   ${c.dim}verliest van:${c.reset}`);
      for (const counter of counters.slice(0, 5)) {
        console.log(
          `      ${catalog.championName(counter.championId).padEnd(16)} ` +
            `${c.red}${(counter.winrate * 100).toFixed(0)}%${c.reset} ${c.dim}tegen jou (${counter.games} games)${c.reset}`,
        );
      }
    }
    console.log();
  }
}

main().catch((err) => {
  if (err instanceof LcuNotRunningError) console.error(`\n${c.red}${err.message}${c.reset}`);
  else console.error(err);
  process.exitCode = 1;
});
