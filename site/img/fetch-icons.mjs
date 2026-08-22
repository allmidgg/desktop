/**
 * Haalt de ontbrekende icoontjes op bij Community Dragon.
 *
 * Dit script bestond niet, en daardoor liep de map stilletjes achter: de site
 * toonde per champion+lane zes items, dus alleen díe iconen waren ooit een keer
 * met de hand binnengehaald. Zodra de guidepagina's ook de core-combinaties en
 * de volle itemlijst lieten zien, verwezen achttien plaatjes naar niets.
 *
 * Draaien vanuit de repo-wortel:  node site/img/fetch-icons.mjs
 * Alleen wat ontbreekt wordt opgehaald, dus opnieuw draaien is gratis.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = dirname(fileURLToPath(import.meta.url));
const CD = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/";
const ITEM_OFFSET = 770_000;
const SPELL_PREFIX = "7";

const lezen = (p) => JSON.parse(readFileSync(join(HIER, "..", p), "utf8"));
const builds = lezen("data/builds.json");

/** Elk item dat ergens in builds.json voorkomt, ook in de core-combinaties. */
const items = new Set();
for (const c of Object.values(builds.champions)) {
  for (const l of c.lanes) {
    for (const veld of ["items", "boots", "starters"]) for (const x of l[veld] ?? []) items.add(x.baseId);
    for (const r of l.core ?? []) for (const id of r.items) items.add(id);
  }
}
const spells = new Set();
for (const c of Object.values(builds.champions)) {
  for (const l of c.lanes) for (const s of l.spells ?? []) for (const id of s.spells) spells.add(id);
}

const url = (iconPath) => CD + String(iconPath).toLowerCase().replace("/lol-game-data/assets/", "");

async function haal(catalogusPad, sleutel, map, wanted, jadeId) {
  const catalogus = await (await fetch(CD + "v1/" + catalogusPad)).json();
  const perId = new Map(catalogus.map((x) => [x[sleutel], x]));
  mkdirSync(join(HIER, map), { recursive: true });

  let gehaald = 0, aanwezig = 0;
  const mist = [];
  for (const base of [...wanted].sort((a, b) => a - b)) {
    const doel = join(HIER, map, `${base}.png`);
    if (existsSync(doel)) { aanwezig++; continue; }
    const regel = perId.get(jadeId(base));
    if (!regel?.iconPath) { mist.push(base); continue; }
    const res = await fetch(url(regel.iconPath));
    if (!res.ok) { mist.push(base); continue; }
    writeFileSync(doel, Buffer.from(await res.arrayBuffer()));
    gehaald++;
  }
  console.log(`${map.padEnd(8)} ${aanwezig} al aanwezig, ${gehaald} opgehaald${mist.length ? `, NIET GEVONDEN: ${mist.join(", ")}` : ""}`);
  return mist.length;
}

const ontbreekt =
  (await haal("items.json", "id", "items", items, (b) => ITEM_OFFSET + b)) +
  (await haal("summoner-spells.json", "id", "spells", spells, (b) => Number(SPELL_PREFIX + b)));

if (ontbreekt) {
  console.error(`\n${ontbreekt} icoon(en) niet gevonden bij Community Dragon.`);
  process.exit(1);
}
