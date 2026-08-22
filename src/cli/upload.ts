/**
 * AllMid upload -- stuurt de lokaal verzamelde games naar de gedeelde server.
 *
 *   ALLMID_SERVER=https://jouwserver:8080 ALLMID_KEY=geheim npm run upload
 */
import { join } from "node:path";
import { MatchStore, defaultStorePath } from "../core/services/matchStore";
import { MatchUploader, defaultUploadStatePath } from "../core/services/uploader";

const c = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m" };

async function main(): Promise<void> {
  const server = process.env.ALLMID_SERVER ?? process.argv[2];
  const key = process.env.ALLMID_KEY ?? process.argv[3] ?? "";
  if (!server) {
    console.error(`\n${c.red}Geen serveradres.${c.reset}\n  npm run upload -- http://localhost:8080 sleutel\n`);
    process.exitCode = 1;
    return;
  }

  const store = new MatchStore(defaultStorePath(process.cwd()));
  await store.load();

  const uploader = new MatchUploader(server, key, store);
  await uploader.loadState(defaultUploadStatePath(process.cwd()));

  console.log(`\n${c.bold}AllMid upload${c.reset}`);
  console.log(`${c.dim}${store.size} games lokaal -> ${server}${c.reset}\n`);

  const result = await uploader.sync((done, total) => {
    process.stdout.write(`\r  ${done}/${total} verstuurd   `);
  });

  console.log();
  if (result.error) {
    console.error(`  ${c.red}mislukt: ${result.error}${c.reset}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${result.checked} gecontroleerd`);
  console.log(`  ${c.green}${result.uploaded} nieuw op de server${c.reset}`);
  if (result.rejected > 0) console.log(`  ${result.rejected} geweigerd`);
  if (result.serverTotal !== null) console.log(`  server heeft nu ${result.serverTotal} games\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
