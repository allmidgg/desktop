/**
 * AllMid loadout -- toont je Classic mastery- en rune-pagina's.
 *
 * Alleen lezen. Het schrijven zit in de app achter een expliciete bevestiging.
 */
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { MasteryCatalog } from "../core/jade/masteries";
import { RuneCatalog, RUNE_SLOTS, type RuneKind } from "../core/jade/runes";
import { fetchAccountLoadout, readMasteryPages, readRunePages } from "../core/services/loadout";

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

const TREE_COLOR: Record<string, string> = { offense: c.red, defense: c.green, utility: c.cyan };

async function main(): Promise<void> {
  const client = await LcuClient.connect();
  const [masteries, runes, loadout] = await Promise.all([
    MasteryCatalog.load(client),
    RuneCatalog.load(client),
    fetchAccountLoadout(client),
  ]);

  console.log(`\n${c.bold}MASTERY-PAGINA'S${c.reset}`);
  for (const page of readMasteryPages(loadout, masteries)) {
    const marker = page.isActive ? `${c.green}>${c.reset}` : " ";
    const spent = page.isEmpty ? `${c.dim}leeg${c.reset}` : `${page.pointsSpent}/30 punten`;
    console.log(`\n ${marker} ${c.bold}${page.index}. ${page.name}${c.reset} ${c.dim}--${c.reset} ${spent}`);
    if (page.isEmpty) continue;

    const perTree = masteries.pointsPerTree(page.points);
    const spread = (["offense", "defense", "utility"] as const)
      .map((tree) => `${TREE_COLOR[tree]}${tree} ${perTree[tree]}${c.reset}`)
      .join(c.dim + " / " + c.reset);
    console.log(`     ${spread}`);

    const entries = [...page.points.entries()].sort((a, b) => a[0] - b[0]);
    for (const [id, points] of entries) {
      const mastery = masteries.get(id);
      const color = mastery ? TREE_COLOR[mastery.tree] : "";
      console.log(
        `     ${color}${(mastery?.name ?? String(id)).padEnd(22)}${c.reset} ` +
          `${points}/${mastery?.maxRank ?? "?"}  ${c.dim}${mastery?.description ?? ""}${c.reset}`,
      );
    }
    const errors = masteries.validate(page.points);
    for (const error of errors) console.log(`     ${c.yellow}! ${error}${c.reset}`);
  }

  console.log(`\n${c.bold}RUNE-PAGINA'S${c.reset}`);
  for (const page of readRunePages(loadout)) {
    const marker = page.isActive ? `${c.green}>${c.reset}` : " ";
    console.log(
      `\n ${marker} ${c.bold}${page.index}. ${page.name}${c.reset}` +
        (page.isEmpty ? ` ${c.dim}-- leeg${c.reset}` : ""),
    );
    if (page.isEmpty) continue;
    for (const kind of Object.keys(RUNE_SLOTS) as RuneKind[]) {
      const counts = new Map<number, number>();
      for (const id of page.slots[kind]) {
        if (id > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const filled = [...counts.entries()]
        .map(([id, n]) => `${n}x ${runes.title(id)}`)
        .join(c.dim + ", " + c.reset);
      const label = kind.padEnd(13);
      console.log(`     ${label}${filled || c.dim + "leeg" + c.reset}`);
    }
  }

  console.log(`\n${c.bold}RUNES IN BEZIT${c.reset}`);
  for (const kind of Object.keys(RUNE_SLOTS) as RuneKind[]) {
    const owned = runes.ownedRunes(kind);
    const total = RUNE_SLOTS[kind].count;
    const complete = owned.filter((o) => o.quantity >= total).length;
    console.log(
      `\n  ${c.bold}${kind}${c.reset} ${c.dim}(${total} slots, ${complete} volledige set${complete === 1 ? "" : "s"})${c.reset}`,
    );
    if (owned.length === 0) {
      console.log(`     ${c.dim}geen${c.reset}`);
      continue;
    }
    for (const { rune, quantity } of owned) {
      const enough = quantity >= total ? c.green : c.yellow;
      console.log(
        `     ${enough}${String(quantity).padStart(2)}x${c.reset} ${rune.title.padEnd(34)} ` +
          `${c.dim}${rune.tooltip}${c.reset}`,
      );
    }
  }
  console.log();
}

main().catch((err) => {
  if (err instanceof LcuNotRunningError) console.error(`\n${c.red}${err.message}${c.reset}`);
  else console.error(err);
  process.exitCode = 1;
});
