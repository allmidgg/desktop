/**
 * The catalogue of League of Legends itself: every champion and every item.
 *
 * Separate from the Classic pipeline on purpose. refresh.mjs turns played games
 * into statistics; this turns Riot's own published reference data into the list
 * of things those statistics can be about. One needs a client and a crawler,
 * the other needs nothing but a URL -- which is why the whole roster can exist
 * on the site long before there is a single standard-League game behind it.
 *
 * Data Dragon is Riot's static data CDN. It needs no API key and has no rate
 * limit, so nothing here is gated on the developer registration.
 *
 *   node site/data/catalogus.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = dirname(fileURLToPath(import.meta.url));
const SITE = join(HIER, "..");
const DD = "https://ddragon.leagueoflegends.com";

const haal = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} on ${url}`);
  return res.json();
};

/**
 * The newest patch Data Dragon has published.
 *
 * Pinned into the output rather than read again at render time: a catalogue and
 * the icons that go with it have to come from the same patch, or a champion
 * released this week gets a page with no portrait.
 */
async function nieuwsteVersie() {
  const versies = await haal(`${DD}/api/versions.json`);
  if (!Array.isArray(versies) || versies.length === 0) throw new Error("no versions published");
  return versies[0];
}

/** Champions, flattened to what a page actually needs. */
function champions(rauw) {
  return Object.values(rauw)
    .map((c) => ({
      // Data Dragon keeps the numeric id as a string; everything else here
      // counts in numbers, so convert once and be done with it.
      id: Number(c.key),
      alias: c.id,
      name: c.name,
      title: c.title,
      tags: c.tags ?? [],
      resource: c.partype || null,
      blurb: c.blurb ?? "",
      // Riot's own difficulty rating, 1-10. Worth keeping precisely because it
      // is theirs: it is the one judgement on this page we did not make.
      difficulty: c.info?.difficulty ?? null,
      // Base stats at level 1 and their growth per level. Facts rather than
      // opinions, and the only real content a champion page can carry before
      // anybody has played a recorded game on them.
      stats: {
        hp: c.stats?.hp ?? null,
        hpPerLevel: c.stats?.hpperlevel ?? null,
        armor: c.stats?.armor ?? null,
        armorPerLevel: c.stats?.armorperlevel ?? null,
        mr: c.stats?.spellblock ?? null,
        mrPerLevel: c.stats?.spellblockperlevel ?? null,
        ad: c.stats?.attackdamage ?? null,
        adPerLevel: c.stats?.attackdamageperlevel ?? null,
        moveSpeed: c.stats?.movespeed ?? null,
        range: c.stats?.attackrange ?? null,
      },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Items worth listing.
 *
 * Consumables and anything unpurchasable are dropped -- wards, trinkets and the
 * hundreds of internal entries Data Dragon carries for modes and events would
 * otherwise outnumber the real ones three to one.
 */
function items(rauw) {
  return Object.entries(rauw)
    .filter(([, v]) => v.gold?.purchasable && !v.consumed && (v.gold.total ?? 0) > 0)
    .map(([id, v]) => ({
      id: Number(id),
      name: v.name,
      plaintext: v.plaintext ?? "",
      gold: v.gold.total,
      tags: v.tags ?? [],
      buildsFrom: (v.from ?? []).map(Number),
      buildsInto: (v.into ?? []).map(Number),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const versie = await nieuwsteVersie();
const [rauweChampions, rauweItems] = await Promise.all([
  haal(`${DD}/cdn/${versie}/data/en_US/champion.json`),
  haal(`${DD}/cdn/${versie}/data/en_US/item.json`),
]);

const catalogus = {
  version: versie,
  generatedAt: Date.now(),
  champions: champions(rauweChampions.data),
  items: items(rauweItems.data),
};

mkdirSync(join(SITE, "data"), { recursive: true });
writeFileSync(join(SITE, "data", "lol-catalog.json"), JSON.stringify(catalogus), "utf8");
console.log(
  `[catalogus] patch ${versie} -- ${catalogus.champions.length} champions, ${catalogus.items.length} items`,
);

// ---- Portraits -------------------------------------------------------------
// Skipped when already on disk: this runs on every site build, and re-fetching
// 173 unchanged images each time would be rude to a CDN that costs us nothing.
const iconMap = join(SITE, "img", "lol-champions");
mkdirSync(iconMap, { recursive: true });

let gehaald = 0;
let overgeslagen = 0;
for (const c of catalogus.champions) {
  const doel = join(iconMap, `${c.alias.toLowerCase()}.png`);
  if (existsSync(doel)) {
    overgeslagen++;
    continue;
  }
  const res = await fetch(`${DD}/cdn/${versie}/img/champion/${c.alias}.png`);
  if (!res.ok) {
    console.warn(`[catalogus] no portrait for ${c.name} (${res.status})`);
    continue;
  }
  writeFileSync(doel, Buffer.from(await res.arrayBuffer()));
  gehaald++;
}
console.log(`[catalogus] portraits -- ${gehaald} fetched, ${overgeslagen} already there`);
