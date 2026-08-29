/**
 * AllMid crawl -- vult de lokale matchdatabase.
 *
 *   npm run crawl             blijft doorlopen tot je Ctrl+C geeft
 *   npm run crawl -- 200      stopt na 200 spelers
 *
 * Begint bij jezelf en volgt van daaruit iedereen die je tegenkomt: elke game
 * levert tien spelers op, en elke speler levert weer games op. Alleen Classic.
 */
import { join } from "node:path";
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { GameCatalog } from "../core/jade/catalog";
import { MatchStores } from "../core/services/matchStore";
import { MatchCrawler } from "../core/services/crawler";
import { JadeStats, MIN_MATCHUP_GAMES } from "../core/services/stats";
import { fetchCurrentSummoner } from "../core/services/player";

const c = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", jade: "\x1b[36m", red: "\x1b[31m" };

async function main(): Promise<void> {
  const arg = process.argv[2];
  const maxPlayers = arg ? Number(arg) : Number.POSITIVE_INFINITY;

  const client = await LcuClient.connect();
  const catalogus = await GameCatalog.load(client);
  await catalogus.save(join(process.cwd(), "data", "catalog.json"));
  // A Classic crawler reads Classic names. Said out loud rather than left to
  // whichever index a shared lookup would have reached first.
  const catalog = catalogus.for("lol:jade");

  // The router, and only the Classic file opened. The crawler writes through
  // MatchStores now, which is what decides where a game goes; loading Classic
  // alone is still right here because that is the only mode it may crawl, and
  // MatchStores.add() opens any other store itself before writing to it.
  const stores = new MatchStores(process.cwd());
  await stores.load("lol:jade");
  const store = stores.for("lol:jade");

  console.log(`\n${c.bold}AllMid crawler${c.reset}`);
  console.log(`${c.dim}database: ${store.size} games, ${store.knownPuuids.length} spelers bekend${c.reset}`);
  console.log(
    maxPlayers === Number.POSITIVE_INFINITY
      ? `${c.dim}onbeperkt aan het verzamelen -- Ctrl+C om te stoppen${c.reset}\n`
      : `${c.dim}maximaal ${maxPlayers} spelers deze ronde${c.reset}\n`,
  );

  const me = await fetchCurrentSummoner(client);
  const crawler = new MatchCrawler(
    client,
    stores,
    (progress) => {
      process.stdout.write(
        `\r  ${progress.visitedPlayers} spelers bezocht, ${progress.queuedPlayers} in de rij` +
          `  |  ${progress.storedMatches} games (+${progress.newThisRun})` +
          `  |  ${progress.gamesPerMinute.toFixed(0)}/min      `,
      );
    },
    (paused) => {
      console.log(paused ? "\n  [pauze] je speelt -- crawler wacht" : "\n  [hervat]");
    },
  );

  // Verdergaan waar de vorige ronde ophield in plaats van het begin over te doen.
  await crawler.loadState(join(process.cwd(), "data", "crawler-state.json"));
  // Achterstevoren: de laatst ontdekte spelers komen uit de nieuwste games en zijn
  // dus het minst waarschijnlijk al bezocht. Vooraan beginnen levert vooral
  // spelers op die we allang gehad hebben.
  crawler.seed([me.puuid, ...store.knownPuuids.reverse()]);

  // Ctrl+C mag geen werk kosten: eerst opslaan, dan pas stoppen.
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\n  stoppen, staat wordt opgeslagen...");
    crawler.stop();
  });

  await crawler.run(maxPlayers);
  console.log("\n");

  const stats = JadeStats.from(store.all(), "lol:jade");
  const coverage = stats.coverage();
  console.log(`${c.bold}Database${c.reset}`);
  console.log(`  ${stats.totalMatches} games`);
  console.log(
    `  ${coverage.usable} van de ${coverage.matchups} matchups heeft ${MIN_MATCHUP_GAMES}+ games\n`,
  );

  for (const position of ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"] as const) {
    const tier = stats.tierList(position, 25).slice(0, 5);
    if (tier.length === 0) continue;
    console.log(`${c.jade}${position}${c.reset}`);
    for (const entry of tier) {
      console.log(
        `   ${catalog.championName(entry.championId).padEnd(16)} ` +
          `${(entry.winrate * 100).toFixed(0)}% ${c.dim}(${entry.games} games, ` +
          `pick ${(entry.pickRate * 100).toFixed(1)}%)${c.reset}`,
      );
    }
    console.log();
  }
}

main().catch((err) => {
  if (err instanceof LcuNotRunningError) console.error(`\n${c.red}${err.message}${c.reset}`);
  else console.error(err);
  process.exitCode = 1;
});
