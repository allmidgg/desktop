/**
 * AllMid live -- kijkt mee tijdens een lopende game.
 *
 * Twee doelen. Eerst: uitzoeken wat de Live Client API precies prijsgeeft voor
 * League Classic -- geeft hij van alle tien de spelers hun runes, of alleen van
 * jou? Dat weten we pas als er echt een game draait.
 *
 * En daarnaast: de skill-volgorde vastleggen. Die staat nergens in de
 * matchhistorie, dus dit is de enige manier om er ooit data over te krijgen.
 *
 *   npm run live
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LiveClient, SkillOrderRecorder, type LiveGameData } from "../core/lcu/liveClient";

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  jade: "\x1b[36m", gold: "\x1b[33m", green: "\x1b[32m", red: "\x1b[31m",
};

const POLL_MS = 2_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Eenmalig rapporteren wat er in de data zit, zodat we weten wat mogelijk is. */
function reportAvailability(data: LiveGameData): void {
  console.log(`\n${c.bold}Wat deze API prijsgeeft${c.reset}`);
  console.log(`  gameMode      ${data.gameData?.gameMode} op map ${data.gameData?.mapNumber} (${data.gameData?.mapName})`);
  console.log(`  spelers       ${data.allPlayers?.length ?? 0}`);
  console.log(`  eigen skills  ${Object.keys(data.activePlayer?.abilities ?? {}).join(", ") || "geen"}`);

  const withRunes = (data.allPlayers ?? []).filter((p) => p.runes && Object.keys(p.runes).length > 0);
  console.log(
    `  runes         ${withRunes.length} van de ${data.allPlayers?.length ?? 0} spelers` +
      (withRunes.length > 1
        ? `  ${c.green}<- van meerdere spelers, dat is goud waard${c.reset}`
        : `  ${c.gold}<- alleen van jezelf${c.reset}`),
  );
  const first = data.allPlayers?.[0];
  if (first) {
    console.log(`  per speler    ${Object.keys(first).join(", ")}`);
    if (first.runes) console.log(`  rune-velden   ${Object.keys(first.runes).join(", ")}`);
  }
  console.log();
}

/** Gedeeld met de afsluit-handler, zodat Ctrl+C bewaart wat we gezien hebben. */
const session = { champion: "", recorder: new SkillOrderRecorder() };

async function main(): Promise<void> {
  const live = new LiveClient();
  const recorder = session.recorder;
  let reported = false;
  let champion = "";
  let waiting = false;

  console.log(`\n${c.bold}AllMid live${c.reset}`);
  console.log(`${c.dim}wacht op een game... (Ctrl+C om te stoppen)${c.reset}`);

  for (;;) {
    const data = await live.allGameData();
    if (!data) {
      if (!waiting) {
        waiting = true;
        process.stdout.write(`\r${c.dim}geen game actief, blijft kijken...${c.reset}      `);
      }
      await sleep(POLL_MS);
      continue;
    }
    waiting = false;

    if (!reported) {
      reported = true;
      champion =
        data.allPlayers?.find((p) => p.summonerName === data.activePlayer?.summonerName)?.championName ??
        "onbekend";
      session.champion = champion;
      console.log(`\n${c.jade}game gevonden${c.reset} -- jij speelt ${c.bold}${champion}${c.reset}`);
      reportAvailability(data);
    }

    const added = recorder.observe(data.activePlayer?.abilities);
    if (added.length > 0) {
      const minutes = Math.floor((data.gameData?.gameTime ?? 0) / 60);
      console.log(
        `  ${String(minutes).padStart(2)}min  +${added.join("+")}   ` +
          `${c.dim}volgorde: ${recorder.summary(18)}${c.reset}`,
      );
    }
    await sleep(POLL_MS);
  }
}

/** Bij afsluiten bewaren we wat we gezien hebben. */
async function save(champion: string, order: string[]): Promise<void> {
  if (order.length === 0) return;
  const dir = join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, "skillorders.jsonl"),
    JSON.stringify({ champion, order, at: new Date().toISOString() }) + "\n",
    "utf8",
  );
  console.log(`\n  opgeslagen in data/skillorders.jsonl: ${order.join(" ")}`);
}

process.on("SIGINT", () => {
  void save(session.champion, session.recorder.skillOrder).finally(() => process.exit(0));
});

main().catch((err) => {
  console.error(`\n${c.red}${(err as Error).message}${c.reset}`);
  process.exitCode = 1;
});
