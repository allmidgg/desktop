/**
 * jade.gg runes -- stelt de beste rune-pagina voor die je nu kunt maken.
 *
 *   npm run runes -- Ashe            voorstel voor Ashe
 *   npm run runes -- Ashe support    andere rolweging afdwingen
 *
 * Schrijft niets. Het toepassen zit in de app, achter een bevestiging.
 */
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { JadeCatalog } from "../core/jade/catalog";
import { RuneCatalog, RUNE_SLOTS } from "../core/jade/runes";
import { planRunes } from "../core/services/runeOptimizer";

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", red: "\x1b[31m",
};

async function main(): Promise<void> {
  const [championName, roleOverride] = process.argv.slice(2);
  const client = await LcuClient.connect();
  const [jade, runes] = await Promise.all([JadeCatalog.load(client), RuneCatalog.load(client)]);

  const champion = championName
    ? ([...jade.champions.values()].find(
        (ch) => ch.alias.toLowerCase() === championName.toLowerCase() ||
                ch.name.toLowerCase() === championName.toLowerCase(),
      ) ?? null)
    : null;

  if (championName && !champion) {
    console.error(`Champion "${championName}" bestaat niet in League Classic.`);
    console.error(`Beschikbaar: ${[...jade.champions.values()].map((ch) => ch.alias).sort().join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const plan = planRunes(runes, champion, roleOverride);
  const header = champion ? `${champion.name} (${plan.role})` : `algemeen (${plan.role})`;
  console.log(`\n${c.bold}Beste rune-pagina voor ${header}${c.reset}`);
  console.log(`${c.dim}Gekozen uit wat je bezit -- niet uit wat theoretisch bestaat.${c.reset}\n`);

  for (const kind of plan.kinds) {
    const label = `${kind.kind} (${kind.slots})`;
    console.log(`  ${c.bold}${label.padEnd(20)}${c.reset}`);
    if (kind.choices.length === 0) {
      console.log(`     ${c.red}geen bruikbare runes in bezit${c.reset}`);
    }
    for (const choice of kind.choices) {
      const stats = Object.entries(choice.rune.stats)
        .map(([stat, amount]) => `+${amount}${choice.rune.isPerLevel ? "/lvl" : ""} ${stat}`)
        .join(", ");
      console.log(
        `     ${c.green}${String(choice.count).padStart(2)}x${c.reset} ` +
          `${choice.rune.title.padEnd(34)} ${c.dim}${stats}${c.reset}`,
      );
    }
    if (kind.emptySlots > 0) {
      console.log(`     ${c.yellow}${kind.emptySlots} slot(s) blijven leeg -- te weinig runes${c.reset}`);
    }
    if (kind.upgrade) {
      const gap = kind.bestPossibleScore > 0
        ? Math.round((1 - kind.score / kind.bestPossibleScore) * 100)
        : 0;
      if (gap > 0) {
        console.log(
          `     ${c.cyan}kopen: ${RUNE_SLOTS[kind.kind].count}x ${kind.upgrade.title}${c.reset} ` +
            `${c.dim}(${gap}% sterker dan wat je nu hebt)${c.reset}`,
        );
      }
    }
    console.log();
  }

  console.log(`  ${c.bold}Totaal van deze pagina${c.reset}`);
  const stats = Object.entries(plan.totalStats).sort((a, b) => b[1] - a[1]);
  if (stats.length === 0) console.log(`     ${c.dim}niets -- je bezit nog geen bruikbare runes${c.reset}`);
  for (const [stat, amount] of stats) {
    console.log(`     ${c.dim}+${amount.toFixed(2).replace(/\.00$/, "")} ${stat}${c.reset}`);
  }
  console.log();
}

main().catch((err) => {
  if (err instanceof LcuNotRunningError) console.error(`\n${c.red}${err.message}${c.reset}`);
  else console.error(err);
  process.exitCode = 1;
});
