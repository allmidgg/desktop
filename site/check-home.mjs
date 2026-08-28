/**
 * Run after node site/build.mjs. Verify generated local references and real
 * data, not a second copy of the homepage's editorial wording.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const site = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(site, "index.html"), "utf8");
// Script strings can contain HTML templates; only inspect actual markup.
const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2");
const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "Duplicate IDs in the generated homepage");
for (const [, attribute, targets] of markup.matchAll(/\b(aria-controls|aria-labelledby)="([^"]+)"/g)) {
  for (const target of targets.trim().split(/\s+/)) {
    assert(ids.includes(target), "Missing " + attribute + " target: " + target);
  }
}

let checked = 0;
const stylesheets = new Set();
for (const [, target] of markup.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
  if (/^(?:[a-z]+:|\/\/)/i.test(target)) continue;
  const [path, hash] = target.split("#");
  const file = path ? resolve(site, path.split("?")[0]) : resolve(site, "index.html");
  assert(existsSync(file), "Missing local target: " + target);
  if (extname(file) === ".css") stylesheets.add(file);
  if (hash && (!path || extname(file) === ".html")) {
    const destination = !path ? html : readFileSync(file, "utf8");
    assert(destination.includes('id="' + hash + '"'), "Missing anchor: " + target);
  }
  checked++;
}
for (const file of stylesheets) {
  const css = readFileSync(file, "utf8");
  for (const [, target] of css.matchAll(/url\(["']?([^)"']+)["']?\)/g)) {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(target)) continue;
    assert(existsSync(resolve(dirname(file), target.split(/[?#]/)[0])), "Missing CSS asset: " + target);
  }
}
const data = JSON.parse(readFileSync(resolve(site, "data/champions.json"), "utf8"));
assert(html.includes(data.totals.games.toLocaleString("en-US")), "Homepage total differs from the dataset");
const leaders = Object.values(data.champions).sort((a, b) => b.winrate - a.winrate).slice(0, 3);
for (const champion of leaders) {
  const slug = champion.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  assert(html.includes('href="champion/' + slug + '.html"'), "Missing data-backed champion card: " + champion.name);
  assert(html.includes(champion.totalGames.toLocaleString("en-US")), "Missing champion sample size: " + champion.name);
}
console.log("Homepage checks passed: " + checked + " local references, unique IDs, ARIA targets, " + stylesheets.size + " stylesheets and data-backed cards.");
