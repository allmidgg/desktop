/**
 * Bouwt site/index.html uit de datamomentopname.
 *
 * De pagina toont echte cijfers uit 114.000+ Classic-games. Die met de hand
 * bijhouden zou binnen een week fout gaan, dus wordt de HTML gegenereerd:
 *
 *   node site/build.mjs
 *
 * Invoer:
 *   site/data/champions.json         -- de bron voor alles wat over champions gaat:
 *                                       totalen, lanes, rangen, matchups, alle 63
 *   site/data/meta.json              -- alleen nog spelersaantal en verzamelperiode
 *   site/img/champions/manifest.json -- welk beeld er per champion is
 *
 * Die twee databestanden worden apart gegenereerd terwijl de crawler doordraait.
 * Genereer ze samen opnieuw voordat je publiceert; het script waarschuwt als ze
 * te ver uiteen zijn gelopen.
 *
 * Alles wordt statisch uitgeschreven. JavaScript maakt de pagina daarna
 * interactief, maar zonder JavaScript staat er nog steeds een volledige,
 * leesbare pagina met dezelfde cijfers erin.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));

const meta = read("data/meta.json");

// Het manifest heeft metadata op het hoogste niveau; de champions zitten eronder.
const roster = read("img/champions/manifest.json").champions;
const champions = read("data/champions.json");
const builds = read("data/builds.json");

/**
 * champions.json is de bron voor alles wat over champions gaat: aantallen, lanes,
 * rangen, matchups. Dat bestand is compleet (alle 63) en het nieuwst.
 *
 * meta.json levert alleen nog drie dingen die daar niet in staan: het aantal
 * unieke spelers, de verzamelperiode en de gemiddelde speelduur.
 *
 * De twee bestanden worden los van elkaar gemaakt terwijl de crawler doordraait,
 * dus ze lopen uiteen. Zolang dat verschil klein is, is dat onschadelijk -- de
 * spelerstelling is dan een ondergrens en de datums schuiven hooguit een dag op.
 * Wordt het groot, dan moet je ze opnieuw genereren voordat je publiceert.
 */
const CH = champions.totals;
const MT = meta.totals;
const drift = Math.abs(CH.games - MT.games) / CH.games;
if (drift > 0.1) {
  console.warn(
    `[build] LET OP: champions.json (${CH.games}) en meta.json (${MT.games}) lopen ` +
      `${(drift * 100).toFixed(1)}% uiteen. Genereer beide opnieuw voordat je publiceert.`,
  );
}

/* ── Kleine hulpjes ──────────────────────────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const n = (v) => Number(v).toLocaleString("en-US");
const pct = (v) => Number(v).toFixed(1);

const DATE = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const LANES = [
  { key: "TOP", label: "Top" },
  { key: "JUNGLE", label: "Jungle" },
  { key: "MIDDLE", label: "Mid" },
  { key: "BOTTOM", label: "Bot" },
  { key: "SUPPORT", label: "Support" },
];

const byId = new Map(Object.values(roster).map((c) => [c.baseId, c]));
const iconOf = (id) => byId.get(id)?.icon?.path ?? "";
const splashOf = (id) => byId.get(id)?.splash?.path ?? "";
const nameOf = (id) => byId.get(id)?.name ?? String(id);

/**
 * Winrates in een top-10 liggen allemaal tussen 54 en 61 procent. Meet je de
 * balk vanaf nul, dan zijn het tien even lange streepjes en zegt hij niets.
 * Vandaar dat 50% het nulpunt is: dan wordt het verschil wél zichtbaar.
 */
const bar = (wr, span = 12) => Math.max(2, Math.min(100, ((wr - 50) / span) * 100));

/** Alleen kleur waar hij iets betekent: boven of onder de helft. */
const wrClass = (wr) => (wr >= 54 ? "wr-hi" : wr >= 50 ? "wr-ok" : wr >= 46 ? "wr-lo" : "wr-bad");

/* ── De champion-verkenner ───────────────────────────────────────────────── */

/** Compacte vorm van champions.json, klein genoeg om in de pagina te zetten. */
function explorerData() {
  const out = {};
  for (const c of Object.values(roster)) {
    const full = champions.champions[String(c.baseId)];
    if (!full) throw new Error(`champions.json mist ${c.name} (${c.baseId})`);
    out[c.baseId] = {
      n: c.name,
      g: full.totalGames,
      w: full.winrate,
      // Niet-gekwalificeerde lanes gaan mee, maar zonder rang -- anders zou een
      // lane met 40 games er even hard uitzien als een met 8.000.
      l: full.lanes.map((x) => [x.lane, x.games, x.winrate, x.qualified ? x.rank : null]),
      b: full.beats.slice(0, 4).map((x) => [x.baseId, x.winrate, x.games]),
      d: full.losesTo.slice(0, 4).map((x) => [x.baseId, x.winrate, x.games]),
    };
  }
  return out;
}

/**
 * De tier-lijst per lane, afgeleid uit champions.json.
 *
 * Eerder kwam die uit meta.json, maar dan staan er twee jaargangen op één
 * pagina: meta.json is gemaakt bij 114.473 games en champions.json bij 120.032.
 * Eén bron betekent dat de tabel en het detailpaneel elkaar niet tegenspreken.
 */
function tierFor(lane) {
  return Object.values(champions.champions)
    .map((c) => ({ c, l: c.lanes.find((x) => x.lane === lane && x.qualified) }))
    .filter((x) => x.l)
    .sort((a, b) => b.l.winrate - a.l.winrate)
    .slice(0, 10)
    .map(({ c, l }) => ({
      baseId: c.baseId,
      naam: c.name,
      games: l.games,
      winrate: l.winrate,
      winrateRuw: l.winrateRaw,
      pickRate: l.pickRate,
    }));
}

/**
 * De builds in compacte vorm voor het script.
 *
 * Alleen wat getoond wordt, en als getallenrijtjes in plaats van objecten --
 * dit gaat als JSON de pagina in, dus elke veldnaam die je 63 keer herhaalt is
 * pure ballast.
 */
function buildsData() {
  const kort = (x) => [x.baseId, x.pickRate, x.winrate];
  const out = {};
  for (const c of Object.values(roster)) {
    const alle = buildsFor(c.baseId);
    if (!alle.length) continue;
    const lanes = {};
    for (const b of alle) {
      lanes[b.lane] = {
        g: b.games,
        w: b.winrate,
        i: b.items.map(kort),
        b: b.boots.map(kort),
        s: b.starters.map(kort),
        p: b.spells.map((x) => [x.spells[0], x.spells[1], x.pickRate, x.winrate]),
      };
    }
    out[c.baseId] = { best: hoofdLane(c.baseId), lanes };
  }
  return out;
}

/** Alleen de namen die ook echt in een build voorkomen. */
function naamTabellen() {
  const items = {};
  const spells = {};
  for (const c of Object.values(roster)) {
    for (const b of buildsFor(c.baseId)) {
      for (const lijst of [b.items, b.boots, b.starters]) {
        for (const x of lijst) items[x.baseId] = x.naam;
      }
      for (const s of b.spells) for (const id of s.spells) spells[id] = spellName(id);
    }
  }
  return { items, spells };
}

/** Namen en icoonpaden, zodat het script geen paden hoeft samen te stellen. */
function rosterData() {
  const out = {};
  for (const c of Object.values(roster)) out[c.baseId] = [c.name, c.icon.path, c.splash.path];
  return out;
}

/* ── Onderdelen ──────────────────────────────────────────────────────────── */

/** Het portretraster: 63 champions, op volle kleur. Geen sluier eroverheen. */
function explorerGrid() {
  return Object.values(roster)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (c) => `
        <button class="portrait" type="button" data-champ="${c.baseId}" aria-label="${esc(c.name)}">
          <img src="${c.icon.path}" alt="${esc(c.name)}" width="128" height="128" loading="lazy" />
          <span class="portrait-name">${esc(c.name)}</span>
        </button>`,
    )
    .join("");
}

/**
 * Het paneel onder de verkenner, vooraf gevuld met de sterkste champion.
 * Zonder JavaScript blijft dit staan en is het gewoon een goed datablok.
 */
/** De champion die het paneel bij het laden toont: de sterkste van het moment. */
const SEED = Object.values(champions.champions).sort((a, b) => b.winrate - a.winrate)[0].baseId;

function detailPanel() {
  const seedId = SEED;
  const c = champions.champions[String(seedId)];
  const lanes = c?.lanes ?? [];
  const beats = (c?.beats ?? []).slice(0, 4);
  const loses = (c?.losesTo ?? []).slice(0, 4);

  const laneRows = lanes.length
    ? lanes
        .map(
          (l) => `
          <tr>
            <th scope="row">${esc(LANES.find((x) => x.key === l.lane)?.label ?? l.lane)}</th>
            <td class="c-rank">${l.rank ? `#${l.rank}` : "&mdash;"}</td>
            <td class="c-bar"><span style="width:${bar(l.winrate).toFixed(1)}%"></span></td>
            <td class="c-wr ${wrClass(l.winrate)}">${pct(l.winrate)}<small>%</small></td>
            <td class="c-games">${n(l.games)}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="c-empty">No lane data yet.</td></tr>`;

  const matchup = (m, dir) => `
      <li>
        <img src="${iconOf(m.baseId)}" alt="" width="128" height="128" loading="lazy" />
        <span class="m-name">${esc(m.name ?? nameOf(m.baseId))}</span>
        <span class="m-games">${n(m.games)}g</span>
        <span class="m-wr ${dir === "up" ? "wr-hi" : "wr-bad"}">${pct(m.winrate)}<small>%</small></span>
      </li>`;

  return `
    <div class="detail" id="detail"
         data-seed="${seedId}"
         style="--splash:url('${splashOf(seedId)}')">
      <div class="detail-art">
        <img id="detail-splash" src="${splashOf(seedId)}" alt="" width="640" height="360" />
        <div class="detail-id">
          <img id="detail-icon" src="${iconOf(seedId)}" alt="" width="128" height="128" />
          <div>
            <h3 id="detail-name">${esc(nameOf(seedId))}</h3>
            <p id="detail-sub" class="mono">${c ? `${n(c.totalGames)} games &middot; ${pct(c.winrate)}% overall` : "&nbsp;"}</p>
          </div>
        </div>
      </div>

      <div class="detail-lanes">
        <p class="block-label">Lane performance <span>smoothed, 20-game prior</span></p>
        <table class="lane-table">
          <thead>
            <tr><th scope="col">Lane</th><th scope="col">Rank</th><th scope="col"></th><th scope="col">Win</th><th scope="col">Games</th></tr>
          </thead>
          <tbody id="detail-lane-rows">${laneRows}</tbody>
        </table>
      </div>

      <div class="detail-matchups">
        <div>
          <p class="block-label">Wins into</p>
          <ul class="matchups" id="detail-beats">${beats.map((m) => matchup(m, "up")).join("") || `<li class="c-empty">Not enough games.</li>`}</ul>
        </div>
        <div>
          <p class="block-label">Loses to</p>
          <ul class="matchups" id="detail-loses">${loses.map((m) => matchup(m, "down")).join("") || `<li class="c-empty">Not enough games.</li>`}</ul>
        </div>
      </div>
    </div>`;
}

/* ── Builds ──────────────────────────────────────────────────────────────── */

const itemIcon = (id) => `img/items/${id}.png`;
const spellIcon = (id) => `img/spells/${id}.png`;
const itemName = (id) => builds.itemtabel?.[String(id)]?.naam ?? `Item ${id}`;
const spellName = (id) => builds.spelltabel?.[String(id)] ?? `Spell ${id}`;

/**
 * Alle builds van een champion, één per lane.
 *
 * Een champion speelt vaak in meerdere lanes en die builds verschillen echt --
 * jungle Tryndamere koopt Feral Flare, top Tryndamere niet. Eén build tonen en
 * er "op jungle" bij zetten was eerlijk maar te weinig; nu kun je wisselen.
 *
 * De volgorde volgt de lanes zoals overal op de pagina, niet de volgorde in het
 * databestand: anders staat de schakelaar bij elke champion anders.
 */
function buildsFor(baseId) {
  const champ = builds.champions?.[String(baseId)];
  if (!champ?.lanes?.length) return [];

  const volgorde = LANES.map((l) => l.key);
  return [...champ.lanes]
    .sort((a, b) => volgorde.indexOf(a.lane) - volgorde.indexOf(b.lane))
    .map((l) => ({
      lane: l.lane,
      games: l.games,
      winrate: l.winrate,
      items: (l.items ?? []).slice(0, 6),
      boots: (l.boots ?? []).slice(0, 3),
      starters: (l.starters ?? []).slice(0, 3),
      spells: (l.spells ?? []).slice(0, 3),
    }));
}

/**
 * De lane waar de schakelaar op opent: de MEEST GESPEELDE, niet de sterkste.
 *
 * Op winrate openen leverde rare uitkomsten op. Annie opende op top, want daar
 * staat ze op 47,8% tegen 44,9% mid -- maar ze heeft 5.075 mid-games tegen 694
 * top. Wie een Annie-build opzoekt wil de build die mensen daadwerkelijk spelen,
 * niet de uitschieter met de kleinste steekproef.
 */
function hoofdLane(baseId) {
  const alle = buildsFor(baseId);
  if (!alle.length) return null;
  return [...alle].sort((a, b) => b.games - a.games)[0].lane;
}

/** De build van één lane, of de sterkste als er geen gekozen is. */
function buildFor(baseId, lane = null) {
  const alle = buildsFor(baseId);
  if (!alle.length) return null;
  return alle.find((b) => b.lane === lane) ?? alle.find((b) => b.lane === hoofdLane(baseId)) ?? alle[0];
}

/** Eén regel in een itemlijst: icoon, naam, hoe vaak, en hoe vaak gewonnen. */
const itemRow = (i) => `
      <li>
        <img src="${itemIcon(i.baseId)}" alt="" width="64" height="64" loading="lazy" />
        <span class="i-name">${esc(i.naam)}</span>
        <span class="i-pick">${pct(i.pickRate)}<small>%</small></span>
        <span class="i-wr ${wrClass(i.winrate)}">${pct(i.winrate)}<small>%</small></span>
      </li>`;

const spellRow = (s) => `
      <li>
        <span class="s-pair">
          <img src="${spellIcon(s.spells[0])}" alt="${esc(spellName(s.spells[0]))}" width="64" height="64" loading="lazy" />
          <img src="${spellIcon(s.spells[1])}" alt="${esc(spellName(s.spells[1]))}" width="64" height="64" loading="lazy" />
        </span>
        <span class="i-name">${esc(spellName(s.spells[0]))} + ${esc(spellName(s.spells[1]))}</span>
        <span class="i-pick">${pct(s.pickRate)}<small>%</small></span>
        <span class="i-wr ${wrClass(s.winrate)}">${pct(s.winrate)}<small>%</small></span>
      </li>`;

/** Het buildblok onder het detailpaneel, vooraf gevuld met de startchampion. */
function detailBuilds(seedId) {
  const b = buildFor(seedId);

  return `
    <div class="builds" id="builds">
      <div class="builds-head">
        <p class="block-label">Most built <span>over <b id="builds-games">${b ? n(b.games) : "0"}</b> games</span></p>
        <div class="build-lanes" id="build-lanes" role="tablist" aria-label="Lane">
          ${buildsFor(seedId)
            .map(
              (x) =>
                `<button type="button" role="tab" data-lane="${x.lane}" aria-selected="${x.lane === b?.lane}">` +
                `${esc(LANES.find((l) => l.key === x.lane)?.label ?? x.lane)}<span>${pct(x.winrate)}%</span></button>`,
            )
            .join("")}
        </div>
      </div>

      <div class="builds-cols">
        <div>
          <p class="col-label">Items</p>
          <ul class="itemlist" id="builds-items">${(b?.items ?? []).map(itemRow).join("")}</ul>
        </div>
        <div>
          <p class="col-label">Boots</p>
          <ul class="itemlist" id="builds-boots">${(b?.boots ?? []).map(itemRow).join("")}</ul>
          <p class="col-label" style="margin-top:1.1rem">Starting items</p>
          <ul class="itemlist" id="builds-starters">${(b?.starters ?? []).map(itemRow).join("")}</ul>
        </div>
        <div>
          <p class="col-label">Summoner spells</p>
          <ul class="itemlist" id="builds-spells">${(b?.spells ?? []).map(spellRow).join("")}</ul>
        </div>
      </div>

      <p class="builds-note">
        Held at the end of the game, not a build order &mdash; Classic match history has no timeline.
        First number: how often it was held. Second: the win rate of those games.
      </p>
    </div>`;
}

/**
 * De splash-achtergrond van de hero.
 *
 * Negen kolommen, licht gedraaid en opgeschaald zodat je nergens een tegelrand
 * ziet. De art wordt OPGELICHT, niet gedimd -- het donker komt van de sluier
 * eroverheen, en die is gevormd naar waar de tekst staat in plaats van er plat
 * overheen te liggen. Een egale sluier maakt van championart modder; dat was
 * precies wat er mis was aan de vorige poging.
 */
function mosaicTiles() {
  const all = Object.values(roster);
  const out = [];
  // 23 en 63 hebben geen gemene deler, dus dit loopt alle champions langs
  // zonder dat buren opeenvolgend zijn -- anders zie je de volgorde erin.
  for (let i = 0; i < 54; i++) {
    const c = all[(i * 23) % all.length];
    out.push(`<img src="${c.splash.path}" alt="" width="640" height="360" />`);
  }
  return out.join("");
}

/**
 * Hetzelfde splash-art, maar dan achter de hele pagina.
 *
 * Elke champion precies één keer, in dezelfde sprongen van 23 zodat buren geen
 * opeenvolgende id's zijn. Acht kolommen van 22vh vult ruim twee schermen, en
 * omdat de laag aan het scherm vastzit en niet aan het document is dat genoeg
 * hoe lang de pagina ook wordt.
 */
function paginaTiles() {
  const all = Object.values(roster);
  return all
    .map((_, i) => all[(i * 23) % all.length])
    .map((c) => `<img src="${c.splash.path}" alt="" width="640" height="360" loading="lazy" />`)
    .join("");
}

/** Alle 63 portretten, twee rijen, van rand tot rand, onverdund. */
function rosterStrip() {
  const all = Object.values(roster).sort((a, b) => a.baseId - b.baseId);
  const tile = (c) =>
    `<img src="${c.icon.path}" alt="${esc(c.name)}" title="${esc(c.name)}" width="128" height="128" loading="lazy" />`;
  const half = Math.ceil(all.length / 2);
  return `
    <div class="roster-row">${all.slice(0, half).map(tile).join("")}</div>
    <div class="roster-row">${all.slice(half).map(tile).join("")}</div>`;
}

/** De tier-lijsten. Alle vijf staan in de HTML; JavaScript wisselt alleen. */
function tierLists() {
  return LANES.map(({ key, label }, i) => {
    const rows = tierFor(key)
      .map(
        (e, idx) => `
        <tr>
          <td class="t-rank">${idx + 1}</td>
          <td class="t-champ">
            <img src="${iconOf(e.baseId)}" alt="" width="128" height="128" loading="lazy" />
            <span>${esc(e.naam)}</span>
          </td>
          <td class="t-bar"><span style="width:${bar(e.winrate).toFixed(1)}%"></span></td>
          <td class="t-wr ${wrClass(e.winrate)}">${pct(e.winrate)}<small>%</small></td>
          <td class="t-raw">${pct(e.winrateRuw)}</td>
          <td class="t-games">${n(e.games)}</td>
          <td class="t-pick">${pct(e.pickRate)}<small>%</small></td>
        </tr>`,
      )
      .join("");

    return `
      <div class="tier-pane${i === 0 ? " is-open" : ""}" id="lane-${key}" role="tabpanel" aria-labelledby="tab-${key}">
        <h3 class="pane-heading">${label}</h3>
        <div class="table-scroll">
          <table class="tier-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Champion</th>
                <th scope="col"></th>
                <th scope="col">Win rate</th>
                <th scope="col">Raw</th>
                <th scope="col">Games</th>
                <th scope="col">Pick</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="footnote">
          <span class="fn-mark">1</span>
          ${CH.laneQualifiers[key]} of 63 champions cleared the 100-game minimum for ${label}.
          <strong>Win rate</strong> is smoothed as <code>(wins + 10) / (games + 20)</code>, so a lucky
          40-game run cannot fake a 70%. <strong>Raw</strong> is the unsmoothed number, printed next to it
          so you can see exactly what the smoothing did.
        </p>
      </div>`;
  }).join("");
}

/**
 * Drie bevindingen, alle drie afgeleid uit champions.json.
 *
 * Ze staan hier niet als losse tekst maar worden berekend, zodat ze meeschuiven
 * met de data. Een bevinding die na de volgende crawl niet meer klopt is erger
 * dan geen bevinding.
 */
function findings() {
  const all = Object.values(champions.champions);
  const ranked = [...all].sort((a, b) => b.winrate - a.winrate);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  // In welke lanes haalt een champion de drempel van 100 games?
  const everywhere = all.filter((c) => c.lanes.filter((l) => l.qualified).length === 5);

  // De scheefste rechtstreekse matchup met een fatsoenlijke steekproef.
  let skew = null;
  for (const c of all) {
    for (const m of c.beats) {
      if (m.games >= 100 && (!skew || m.winrate > skew.winrate)) {
        skew = { winner: c, loser: m.name, loserId: m.baseId, winrate: m.winrate, games: m.games };
      }
    }
  }

  const items = [
    {
      id: best.baseId,
      t: `${best.name} is the strongest champion in Classic`,
      b:
        `He wins <strong>${pct(best.winrate)}%</strong> of ${n(best.totalGames)} games. The weakest, ` +
        `${esc(worst.name)}, sits at <strong>${pct(worst.winrate)}%</strong> over ${n(worst.totalGames)} ` +
        `games &mdash; a spread of ${pct(best.winrate - worst.winrate)} percentage points from top to bottom of the roster.`,
    },
    {
      id: everywhere[0]?.baseId ?? best.baseId,
      t: `${everywhere.length} of 63 champions are played in all five lanes`,
      b:
        `Not a handful of games &mdash; enough to clear the 100-game bar in <em>every single lane</em>. ` +
        `Classic has no role queue, so support Tryndamere and jungle Annie are not memes here, they are ` +
        `sample sizes. That is why a modern tier list tells you nothing about this mode.`,
    },
    skew && {
      id: skew.winner.baseId,
      t: `The most lopsided matchup is ${skew.winner.name} into ${skew.loser}`,
      b:
        `${esc(skew.winner.name)} takes <strong>${pct(skew.winrate)}%</strong> of ${n(skew.games)} ` +
        `head-to-head games. Of every matchup with at least 100 direct meetings, none sits further from even.`,
    },
  ].filter(Boolean);

  return items
    .map(
      (it, i) => `
        <article class="finding">
          <div class="finding-art"><img src="${splashOf(it.id)}" alt="" width="640" height="360" loading="lazy" /></div>
          <div class="finding-copy">
            <p class="f-num mono">Finding ${String(i + 1).padStart(2, "0")}</p>
            <h3>${esc(it.t)}</h3>
            <p>${it.b}</p>
          </div>
        </article>`,
    )
    .join("");
}

/* ── De pagina ───────────────────────────────────────────────────────────── */

/** Eén set cijfers voor de hele pagina, met per veld de bron erbij. */
const T = {
  games: CH.games, //            champions.json
  patches: CH.patches, //        champions.json
  laneQualifiers: CH.laneQualifiers,
  playerRows: CH.spelersloten,
  generatedAt: champions.generatedAt,
  players: MT.players, //        meta.json -- ondergrens
  eersteGame: MT.eersteGame, //  meta.json
  laatsteGame: MT.laatsteGame, // meta.json
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AllMid</title>
<meta name="description" content="Tier lists, counters, builds and one-click masteries for League of Legends Classic — built from ${n(T.games)} real Classic games. Free and open source." />

<meta property="og:type" content="website" />
<meta property="og:title" content="AllMid — stats for League of Legends Classic" />
<meta property="og:description" content="Every other tracker stops where Classic starts. AllMid collects the data itself: ${n(T.games)} games, ${n(T.players)} players, all 63 champions." />
<meta property="og:url" content="https://allmid.gg/" />
<meta property="og:image" content="https://allmid.gg/img/meta.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="theme-color" content="#06080c" />

<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" />

<style>
/* ───────────────────────────────────────────────────────────────────────────
   AllMid — allmid.gg

   Eén donker thema, bewust. Dit is een pagina voor een overlay bij een spel.

   De leidende regel na drie afgekeurde ontwerprichtingen: champion-art staat
   op VOLLE KLEUR in zijn eigen zone, en tekst staat op schone donkere grond.
   Art wegdimmen achter een kop levert modder op — dat is precies wat er mis
   was aan de vorige versie.
   ─────────────────────────────────────────────────────────────────────────── */

:root {
  --ground:   #070810;
  --surface:  #11141f;
  --raised:   #161a27;
  --raised-2: #1c2130;
  --line:     #232838;
  --line-lit: #2f3648;

  --ink:   #e9edf7;
  --muted: #9aa4bd;
  --dim:   #6d768f;

  /* Goud is de identiteit. De winratekleuren staan daar bewust los van: groen
     en rood betekenen iets, goud betekent niets. Haal je die door elkaar, dan
     lees je in een tabel niet meer of een kleur een waarde of een merk is. */
  --gold:     #e7c76e;
  --gold-lit: #f4e0a6;
  --gold-dim: #9a7f38;

  --wr-hi:  #3ad9a4;
  --wr-ok:  #8fc98a;
  --wr-lo:  #ffb454;
  --wr-bad: #ff5f72;

  --radius:   14px;
  --radius-s: 9px;
  --shadow:   0 18px 50px -18px rgba(0, 0, 0, 0.85);

  --display: "Archivo", "Segoe UI", system-ui, sans-serif;
  --body:    "Public Sans", "Segoe UI", system-ui, sans-serif;
  --mono:    "JetBrains Mono", ui-monospace, "Cascadia Mono", monospace;

  --gutter:  clamp(1.25rem, 5vw, 4.5rem);
  --max:     1320px;
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }

html { background: var(--ground); }
body {
  margin: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--body);
  font-size: clamp(1rem, 0.96rem + 0.2vw, 1.06rem);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

h1, h2, h3 {
  font-family: var(--display);
  font-weight: 800;
  font-stretch: 112%;
  line-height: 1.03;
  letter-spacing: -0.028em;
  text-wrap: balance;
  margin: 0;
}

a { color: inherit; }
img { max-width: 100%; display: block; }
table { border-collapse: collapse; width: 100%; }

:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; border-radius: 2px; }

.wrap { width: 100%; max-width: var(--max); margin-inline: auto; padding-inline: var(--gutter); }
.mono { font-family: var(--mono); }

.eyebrow {
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.17em;
  text-transform: uppercase;
  color: var(--gold);
  margin: 0 0 1.1rem;
}

.block-label {
  font-family: var(--mono);
  font-size: 0.66rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--dim);
  margin: 0 0 0.85rem;
}
.block-label span { color: var(--line-lit); text-transform: none; letter-spacing: 0.04em; }

/* ── Kop ───────────────────────────────────────────────────────────────── */
header {
  position: sticky; top: 0; z-index: 60;
  background: rgba(6, 8, 12, 0.9);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid transparent;
  transition: border-color 0.25s ease;
}
header.stuck { border-bottom-color: var(--line); }
header .wrap { display: flex; align-items: center; gap: 2rem; min-height: 66px; }

.brand {
  display: flex; align-items: center; gap: 0.6rem;
  font-family: var(--display); font-weight: 800; font-stretch: 112%;
  font-size: 1.18rem; letter-spacing: -0.02em; text-decoration: none; margin-right: auto;
}
.brand .mark { width: 22px; height: 22px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; flex: none; }
.brand .mark i { background: var(--line-lit); border-radius: 1px; }
.brand .mark i:nth-child(2), .brand .mark i:nth-child(4), .brand .mark i:nth-child(9) { background: var(--gold); }
.brand-name { white-space: nowrap; }
.brand em { font-style: normal; color: var(--gold); }

nav.links { display: flex; gap: 1.6rem; }
nav.links a { text-decoration: none; color: var(--muted); font-size: 0.9rem; font-weight: 500; transition: color 0.18s ease; }
nav.links a:hover { color: var(--ink); }
@media (max-width: 900px) { nav.links { display: none; } }

/* ── Knoppen ───────────────────────────────────────────────────────────── */
.btn {
  display: inline-flex; align-items: center; gap: 0.6rem;
  padding: 0.78rem 1.35rem; border-radius: 6px;
  font-family: var(--body); font-weight: 600; font-size: 0.94rem;
  text-decoration: none; border: 1px solid transparent; cursor: pointer; white-space: nowrap;
  transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease;
}
.btn:hover { transform: translateY(-1px); }
.btn-primary { background: var(--gold); color: #1a1405; }
.btn-primary:hover { background: var(--gold-lit); }
.btn-ghost { border-color: var(--line-lit); color: var(--ink); }
.btn-ghost:hover { border-color: var(--muted); background: var(--surface); }
.btn-sm { padding: 0.52rem 1rem; font-size: 0.86rem; }
.btn svg { width: 17px; height: 17px; flex: none; }
.cta-row { display: flex; flex-wrap: wrap; gap: 0.8rem; align-items: center; }

/* ── De knop aanwijzen vanuit de kop ──────────────────────────────────────
   Klikken op Download rechtsboven springt naar de eerste knop. Zonder markering
   land je daar en weet je niet waar je naar moet kijken; vandaar dat hij even
   oplicht met een pijl erboven. Alles verdwijnt vanzelf.
   ───────────────────────────────────────────────────────────────────────── */
@keyframes wijs-aan {
  0%, 100% { box-shadow: 0 0 0 0 rgba(231, 199, 110, 0); }
  50%      { box-shadow: 0 0 0 7px rgba(231, 199, 110, 0.28); }
}
@keyframes wijs-pijl {
  0%, 100% { transform: translate(-50%, 0); }
  50%      { transform: translate(-50%, 7px); }
}

.btn.aangewezen { animation: wijs-aan 1s ease-in-out 3; position: relative; }
.btn.aangewezen::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: calc(100% + 9px);
  width: 0;
  height: 0;
  border-left: 8px solid transparent;
  border-right: 8px solid transparent;
  border-top: 10px solid var(--gold);
  animation: wijs-pijl 1s ease-in-out 3;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .btn.aangewezen { animation: none; box-shadow: 0 0 0 4px rgba(231, 199, 110, 0.3); }
  .btn.aangewezen::after { animation: none; }
}

/* ── Hero ──────────────────────────────────────────────────────────────── */
.hero {
  position: relative;
  overflow: hidden;
  isolation: isolate;
  padding-block: clamp(3rem, 6vw, 5.5rem) clamp(2rem, 4vw, 3rem);
}

/* Splash-art achter de hero, opgelicht in plaats van gedimd.
   Het omhulsel bepaalt de begrenzing; het mozaiek mag daarbinnen zo groot zijn
   als het wil. De sluier hangt aan datzelfde omhulsel, zodat er geen strook meer
   kan ontstaan met wel art en geen sluier -- dat was precies wat er misging: de
   sluier eindigde 257 px boven de onderkant van de hero. */
.hero-bg {
  position: absolute; inset: 0; z-index: -1;
  overflow: hidden;
  pointer-events: none;
}
.mosaic {
  position: absolute; inset: -40px -3% -40px -3%;
  display: grid; grid-template-columns: repeat(9, 1fr); grid-auto-rows: 158px; gap: 6px;
  transform: rotate(-3deg) scale(1.12); transform-origin: 50% 0;
}
.mosaic img {
  width: 100%; height: 100%; object-fit: cover; border-radius: 5px;
  filter: saturate(1.1) contrast(1.02) brightness(1.22);
}

/* De sluier is gevormd: twee radiale vlekken staan precies onder de kop en
   onder de verkenner, zodat daar contrast is en de rest helder blijft. */
.hero-bg::after {
  content: "";
  position: absolute; inset: 0;
  background:
    linear-gradient(180deg, rgba(7, 8, 16, 0.55) 0%, rgba(7, 8, 16, 0.72) 34%, rgba(7, 8, 16, 0.86) 62%, rgba(7, 8, 16, 0.91) 88%),
    radial-gradient(90% 70% at 22% 34%, rgba(7, 8, 16, 0.86) 0%, rgba(7, 8, 16, 0.5) 46%, transparent 74%),
    radial-gradient(70% 60% at 78% 30%, rgba(7, 8, 16, 0.78) 0%, rgba(7, 8, 16, 0.35) 52%, transparent 80%);
}

/* Dezelfde splash-art loopt achter de hele pagina door, niet alleen achter de
   hero -- anders houdt het beeld halverwege het eerste scherm gewoon op.
   Vastgezet aan het scherm in plaats van aan het document: een pagina van acht
   schermen hoog zou anders honderden tegels nodig hebben, en nu glijden de
   panelen over een stilstaand beeld. De sluier is hier veel dieper dan bij de
   hero: het is achtergrond, geen onderwerp. */
.paginadek {
  position: fixed; inset: 0; z-index: -3;
  overflow: hidden; pointer-events: none;
}
.mosaic-pagina {
  inset: -10% -6%;
  grid-template-columns: repeat(8, 1fr);
  grid-auto-rows: 22vh;
  transform: rotate(-3deg) scale(1.05);
  transform-origin: 50% 40%;
}
/* Een vaste laag staat helemaal stil terwijl je scrolt; dat leest als
   vastgeplakt in plaats van doorlopend. Tien procent drift over de hele pagina
   is genoeg om het beeld bij de pagina te laten horen zonder dat het opvalt.
   scroll() heeft nog niet iedere browser, en zonder blijft het gewoon stilstaan
   -- dat is de bestaande toestand, dus er gaat nergens iets stuk. */
@media (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: scroll()) {
    .mosaic-pagina {
      animation: dekdrift linear both;
      animation-timeline: scroll(root block);
    }
  }
}
@keyframes dekdrift {
  from { transform: rotate(-3deg) scale(1.05) translateY(2%); }
  to { transform: rotate(-3deg) scale(1.05) translateY(-9%); }
}

.paginadek::after {
  content: "";
  position: absolute; inset: 0;
  background:
    linear-gradient(180deg, rgba(7, 8, 16, 0.9) 0%, rgba(7, 8, 16, 0.93) 100%),
    radial-gradient(115% 75% at 50% 45%, transparent 0%, rgba(7, 8, 16, 0.42) 62%, rgba(7, 8, 16, 0.72) 100%);
}

@media (max-width: 1040px) {
  .mosaic { grid-auto-rows: 120px; }
  .mosaic-pagina { grid-template-columns: repeat(5, 1fr); grid-auto-rows: 18vh; }
}

/* Het modelabel naast het merk. */
.badge {
  font-family: var(--mono); font-size: 0.58rem; letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--gold); border: 1px solid var(--gold-dim); background: rgba(231, 199, 110, 0.08);
  padding: 0.24rem 0.46rem; border-radius: 4px; flex: none; line-height: 1;
}
.hero .wrap {
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
  gap: clamp(2rem, 4vw, 3.5rem);
  align-items: center;
}
@media (max-width: 1040px) { .hero .wrap { grid-template-columns: 1fr; } }

.hero h1 { font-size: clamp(2.5rem, 5.4vw, 4.15rem); margin-bottom: 1.35rem; }
.hero h1 em { font-style: normal; color: var(--gold); }
.hero .lede { font-size: clamp(1.02rem, 0.98rem + 0.35vw, 1.16rem); color: var(--muted); max-width: 46ch; margin: 0 0 1.9rem; }
.hero .lede strong { color: var(--ink); font-weight: 600; }
.cta-note { font-family: var(--mono); font-size: 0.73rem; color: var(--dim); margin: 1.05rem 0 0; }

/* Dekking: het verkoopverhaal in één regel. */
.explorer-col { display: grid; gap: 1rem; align-content: start; }

.coverage {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem;
}
.coverage .cov-label {
  flex: none;
  margin-right: 0.15rem;
  font-family: var(--mono); font-size: 0.64rem; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--dim); width: 100%; margin: 0 0 0.7rem;
}
.coverage span {
  display: inline-flex; align-items: center; gap: 0.4rem;
  font-size: 0.84rem; font-weight: 600;
  padding: 0.34rem 0.7rem; border-radius: 5px;
  border: 1px solid var(--line); color: var(--dim);
}
.coverage span::before { content: "\\00d7"; color: var(--wr-bad); font-weight: 700; }
.coverage span.yes { color: var(--ink); border-color: var(--gold-dim); background: rgba(231, 199, 110, 0.08); }
.coverage span.yes::before { content: "\\2713"; color: var(--gold); }

/* ── Verkenner: portretten op volle kleur ──────────────────────────────── */
.explorer {
  border: 1px solid var(--line-lit); border-radius: var(--radius); background: var(--surface);
  overflow: hidden; box-shadow: var(--shadow);
}
.explorer-head {
  background: var(--raised);
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.85rem 1rem; border-bottom: 1px solid var(--line);
}
.explorer-head h2 { font-size: 0.95rem; font-weight: 700; font-stretch: 105%; letter-spacing: -0.01em; }
.explorer-head .count { margin-left: auto; font-family: var(--mono); font-size: 0.68rem; color: var(--dim); }

.explorer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
  gap: 4px; padding: 0.8rem;
}
.portrait {
  position: relative; padding: 0; border: 1px solid transparent; border-radius: 5px;
  background: none; cursor: pointer; overflow: hidden; line-height: 0;
  transition: border-color 0.14s ease, transform 0.14s ease;
}
.portrait img { width: 100%; height: auto; aspect-ratio: 1; object-fit: cover; }
.portrait:hover { transform: translateY(-2px); border-color: var(--line-lit); }
.portrait[aria-pressed="true"] { border-color: var(--gold); box-shadow: 0 0 0 1px var(--gold); }
.portrait-name {
  position: absolute; inset: auto 0 0 0;
  font-family: var(--mono); font-size: 0.52rem; line-height: 1.5;
  background: rgba(6, 8, 12, 0.86); color: var(--ink);
  opacity: 0; transition: opacity 0.14s ease;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px;
}
.portrait:hover .portrait-name, .portrait:focus-visible .portrait-name { opacity: 1; }

/* ── Detailpaneel ──────────────────────────────────────────────────────── */
/* Het detailpaneel en de builds eronder horen een geheel te zijn: het gaat over
   dezelfde champion. Ze stonden als twee losse kaders onder elkaar met een naad
   ertussen. Nu een omhulsel dat de rand draagt, met de twee delen erbinnen. */
.champpaneel {
  border: 1px solid var(--line-lit);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  background: var(--surface);
}

.detail {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.1fr) minmax(0, 1.05fr);
  gap: 1px; background: var(--line);
}
@media (max-width: 1040px) { .detail { grid-template-columns: 1fr; } }

.detail-art { position: relative; background: var(--raised); min-height: 232px; }
.detail-art > img { width: 100%; height: 100%; object-fit: cover; position: absolute; inset: 0; }
.detail-id {
  position: absolute; inset: auto 0 0 0; z-index: 1;
  display: flex; align-items: center; gap: 0.75rem; padding: 1rem;
  background: linear-gradient(180deg, transparent, rgba(6, 8, 12, 0.94) 62%);
}
.detail-id img { width: 46px; height: 46px; border-radius: 5px; border: 1px solid var(--line-lit); flex: none; }
.detail-id h3 { font-size: 1.25rem; }
.detail-id p { margin: 0.15rem 0 0; font-size: 0.7rem; color: var(--muted); }

.detail-lanes, .detail-matchups { background: var(--surface); padding: 1.3rem 1.2rem 1.2rem; }
.detail-matchups { display: grid; gap: 1.1rem; align-content: start; }

.lane-table th, .lane-table td { padding: 0.32rem 0; font-size: 0.83rem; }
.lane-table thead th {
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--dim); font-weight: 400; text-align: right; padding-bottom: 0.5rem;
}
.lane-table thead th:first-child { text-align: left; }
.lane-table tbody th { text-align: left; font-weight: 600; color: var(--ink); }
.c-rank, .c-wr, .c-games { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.c-rank { color: var(--gold); font-size: 0.74rem; }
.c-games { color: var(--dim); font-size: 0.74rem; }
.c-wr { font-weight: 700; }
.c-wr small, .t-wr small, .m-wr small { font-size: 0.68em; opacity: 0.62; margin-left: 1px; }
.c-bar { width: 34%; padding-inline: 0.6rem; }
.c-bar span, .t-bar span { display: block; height: 4px; border-radius: 2px; background: var(--wr-hi); opacity: 0.75; }
.c-empty { color: var(--dim); font-size: 0.8rem; font-style: italic; }

.matchups { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; }
.matchups li { display: grid; grid-template-columns: 26px 1fr auto auto; align-items: center; gap: 0.55rem; font-size: 0.82rem; }
.matchups img { width: 26px; height: 26px; border-radius: 4px; }
.m-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-games { font-family: var(--mono); font-size: 0.66rem; color: var(--dim); }
.m-wr { font-family: var(--mono); font-weight: 700; font-variant-numeric: tabular-nums; }

.wr-hi { color: var(--wr-hi); } .wr-ok { color: var(--wr-ok); }
.wr-lo { color: var(--wr-lo); } .wr-bad { color: var(--wr-bad); }

/* ── Builds onder het detailpaneel ─────────────────────────────────────── */
.builds {
  background: var(--surface);
  border-top: 1px solid var(--line);
  padding: 1.2rem 1.3rem 1.1rem;
}
.builds-head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem 1.2rem;
  margin-bottom: 1rem;
}

/* De laneschakelaar binnen het buildblok. Kleiner dan de tabs bij de tier-lijst,
   want dit is een keuze binnen een paneel en niet de kop van een sectie. */
.build-lanes { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-left: auto; }
.build-lanes button {
  display: inline-flex; align-items: baseline; gap: 0.35rem;
  font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.08em;
  text-transform: uppercase; cursor: pointer;
  padding: 0.32rem 0.6rem; border-radius: 5px;
  background: var(--raised); border: 1px solid var(--line); color: var(--muted);
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.build-lanes button span { font-size: 0.92em; color: var(--dim); }
.build-lanes button:hover { color: var(--ink); border-color: var(--line-lit); }
.build-lanes button[aria-selected="true"] {
  color: var(--gold); border-color: var(--gold-dim); background: rgba(231, 199, 110, 0.08);
}
.build-lanes button[aria-selected="true"] span { color: var(--gold-dim); }
.builds-head .block-label { margin: 0; }
.builds-head .block-label b { color: var(--gold); font-weight: 500; }

.builds-cols {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(1.2rem, 3vw, 2.4rem);
}
@media (max-width: 900px) { .builds-cols { grid-template-columns: 1fr; } }

.col-label {
  font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.13em;
  text-transform: uppercase; color: var(--dim); margin: 0 0 0.6rem;
}

.itemlist { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.34rem; }
.itemlist li {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.82rem;
}
.itemlist img { width: 30px; height: 30px; border-radius: 4px; border: 1px solid var(--line); }
.i-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.i-pick { font-family: var(--mono); font-size: 0.72rem; color: var(--dim); font-variant-numeric: tabular-nums; }
.i-wr { font-family: var(--mono); font-weight: 700; font-variant-numeric: tabular-nums; min-width: 4ch; text-align: right; }
.i-pick small, .i-wr small { font-size: 0.7em; opacity: 0.6; }

/* Twee spells naast elkaar in de breedte van een enkel itemicoon. */
.s-pair { display: flex; gap: 2px; }
.s-pair img { width: 14px; height: 14px; border-radius: 3px; }

.builds-note {
  margin: 1.1rem 0 0; padding-top: 0.9rem; border-top: 1px solid var(--line);
  font-size: 0.8rem; color: var(--dim); line-height: 1.6; max-width: 88ch;
}
.builds-note strong { color: var(--muted); font-weight: 600; }

/* ── Masthead: de herkomst van de cijfers, in één regel ────────────────── */
.masthead { border-block: 1px solid var(--line); background: var(--surface); }
.masthead .wrap {
  display: flex; flex-wrap: wrap; gap: 0.5rem 2.2rem;
  padding-block: 0.8rem;
  font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dim);
}
.masthead b { color: var(--muted); font-weight: 400; }
.masthead .v { color: var(--ink); }

/* ── Cijferband ────────────────────────────────────────────────────────── */
.figures { border-bottom: 1px solid var(--line); }
.figures .wrap { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: var(--line); padding-inline: 0; }
.figures .cell { background: var(--ground); padding: clamp(1.3rem, 2.6vw, 2rem) 1rem; text-align: center; }
.figures .n {
  font-family: var(--mono); font-weight: 700; letter-spacing: -0.02em;
  font-size: clamp(1.3rem, 1rem + 1.4vw, 2.05rem);
  font-variant-numeric: tabular-nums; line-height: 1.1;
}
.figures .n .unit { color: var(--gold); }
.figures .k { font-family: var(--mono); font-size: 0.63rem; letter-spacing: 0.13em; text-transform: uppercase; color: var(--dim); margin-top: 0.5rem; }
@media (max-width: 860px) { .figures .wrap { grid-template-columns: repeat(2, 1fr); } }

/* ── Roster: 63 portretten, volle breedte, volle kleur ─────────────────── */
.roster { padding-block: clamp(2.5rem, 5vw, 4rem); overflow: hidden; }
.roster .rl { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 1rem; margin: 0 0 1.1rem; }
.roster .rl b { font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold); font-weight: 500; }
.roster .rl span { font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.09em; text-transform: uppercase; color: var(--dim); }
.roster-row { display: flex; gap: 4px; margin-bottom: 4px; }
.roster-row img {
  width: calc((100vw - 4px * 31) / 32); min-width: 34px; height: auto; aspect-ratio: 1;
  border-radius: 4px; object-fit: cover; flex: 1 1 auto;
}
@media (max-width: 900px) { .roster-row { flex-wrap: wrap; } .roster-row img { width: 40px; flex: none; } }

/* ── Secties ───────────────────────────────────────────────────────────── */
.band { padding-block: clamp(3.5rem, 7vw, 6.5rem); }
.band + .band, .roster + .band { border-top: 1px solid var(--line); }
.section-head { max-width: 62ch; margin-bottom: clamp(2rem, 4vw, 3.2rem); }
.section-head h2 { font-size: clamp(1.8rem, 1.25rem + 2vw, 2.9rem); margin-bottom: 0.9rem; }
.section-head p { color: var(--muted); margin: 0; }

/* ── Tier-lijsten ──────────────────────────────────────────────────────── */
.lane-tabs { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1.6rem; }
.lane-tabs button {
  font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.09em; text-transform: uppercase;
  padding: 0.5rem 0.95rem; border-radius: 5px; cursor: pointer;
  background: var(--surface); border: 1px solid var(--line); color: var(--muted);
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.lane-tabs button:hover { color: var(--ink); border-color: var(--line-lit); }
.lane-tabs button[aria-selected="true"] { color: var(--gold); border-color: var(--gold-dim); background: rgba(231, 199, 110, 0.08); }

.table-scroll { overflow-x: auto; border: 1px solid var(--line-lit); border-radius: var(--radius-s); background: var(--surface); box-shadow: var(--shadow); }
.tier-table th, .tier-table td { padding: 0.6rem 0.85rem; text-align: right; white-space: nowrap; }
.tier-table thead th {
  background: var(--raised);
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.11em; text-transform: uppercase;
  color: var(--dim); font-weight: 400; border-bottom: 1px solid var(--line);
}
.tier-table tbody tr + tr td { border-top: 1px solid rgba(28, 36, 47, 0.7); }
.tier-table tbody tr:hover td { background: rgba(231, 199, 110, 0.04); }
.t-rank { font-family: var(--mono); color: var(--dim); font-size: 0.78rem; width: 1%; }
.t-champ { text-align: left; }
.t-champ { display: flex; align-items: center; gap: 0.6rem; font-weight: 600; }
.t-champ img { width: 30px; height: 30px; border-radius: 5px; flex: none; }
.t-bar { width: 22%; min-width: 90px; }
.t-wr { font-family: var(--mono); font-weight: 700; font-variant-numeric: tabular-nums; }
.t-raw, .t-games, .t-pick { font-family: var(--mono); font-size: 0.78rem; color: var(--dim); font-variant-numeric: tabular-nums; }
.pane-heading { display: none; }
.tier-pane { display: none; }
.tier-pane.is-open { display: block; }

.footnote { margin: 1rem 0 0; font-size: 0.83rem; color: var(--dim); max-width: 78ch; line-height: 1.65; }
.footnote strong { color: var(--muted); font-weight: 600; }
.footnote code { font-family: var(--mono); font-size: 0.9em; color: var(--muted); }
.fn-mark {
  display: inline-grid; place-items: center; width: 15px; height: 15px; margin-right: 0.35rem;
  border-radius: 3px; background: rgba(231, 199, 110, 0.14); color: var(--gold);
  font-family: var(--mono); font-size: 0.62rem; vertical-align: 1px;
}

/* ── Bevindingen ───────────────────────────────────────────────────────── */
.finding { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: clamp(1.5rem, 3.5vw, 3rem); align-items: center; }
.finding + .finding { margin-top: clamp(2.5rem, 5vw, 4rem); }
.finding:nth-child(even) .finding-art { order: 2; }
@media (max-width: 900px) { .finding { grid-template-columns: 1fr; } .finding:nth-child(even) .finding-art { order: 0; } }
.finding-art { border-radius: var(--radius-s); overflow: hidden; border: 1px solid var(--line); background: var(--raised); }
.finding-art img { width: 100%; height: auto; }
.f-num { font-size: 0.66rem; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gold); margin: 0 0 0.7rem; }
.finding-copy h3 { font-size: clamp(1.3rem, 1.05rem + 1vw, 1.75rem); margin-bottom: 0.8rem; }
.finding-copy p { color: var(--muted); margin: 0; max-width: 50ch; }
.finding-copy strong { color: var(--ink); font-weight: 700; font-family: var(--mono); }

/* ── Functies ──────────────────────────────────────────────────────────── */
.feature { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.25fr); gap: clamp(1.75rem, 4vw, 3.5rem); align-items: center; }
.feature + .feature { margin-top: clamp(3rem, 6vw, 5rem); }
.feature.flip > .feature-copy { order: 2; }
@media (max-width: 940px) { .feature { grid-template-columns: 1fr; } .feature.flip > .feature-copy { order: 0; } }
.feature-copy h3 { font-size: clamp(1.3rem, 1.05rem + 1vw, 1.8rem); margin-bottom: 0.85rem; }
.feature-copy > p { color: var(--muted); margin: 0 0 1.3rem; max-width: 48ch; }

.ticks { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.55rem; }
.ticks li {
  position: relative;
  padding-left: 1.6rem;
  font-size: 0.93rem;
  color: var(--muted);
}
.ticks li::before {
  content: "";
  position: absolute;
  left: 1px;
  top: 0.55em;
  width: 6px;
  height: 6px;
  background: var(--gold);
  border-radius: 1px;
  transform: rotate(45deg);
}
.ticks li b { color: var(--ink); font-weight: 600; }

/* Vensterlijst om de schermafbeeldingen, zodat ze niet in de pagina wegzakken. */
.window { border: 1px solid var(--line-lit); border-radius: var(--radius-s); overflow: hidden; background: var(--surface); box-shadow: 0 30px 70px -34px rgba(0, 0, 0, 0.95); }
.window figcaption {
  font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.13em; text-transform: uppercase;
  color: var(--dim); padding: 0.6rem 0.85rem; border-top: 1px solid var(--line); background: var(--ground);
}
.window img { width: 100%; height: auto; }

/* ── Keten ─────────────────────────────────────────────────────────────── */
.chain { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius-s); overflow: hidden; }
@media (max-width: 900px) { .chain { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 540px) { .chain { grid-template-columns: 1fr; } }
.step { background: var(--surface); padding: clamp(1.4rem, 2.6vw, 1.9rem); }
.step .num { display: block; font-family: var(--mono); font-size: 0.66rem; font-weight: 700; letter-spacing: 0.1em; color: var(--gold); margin-bottom: 0.9rem; }
.step h4 { font-family: var(--display); font-weight: 700; font-stretch: 108%; font-size: 1.02rem; letter-spacing: -0.015em; margin: 0 0 0.55rem; }
.step p { margin: 0; font-size: 0.88rem; color: var(--muted); line-height: 1.6; }

/* ── Veiligheid ────────────────────────────────────────────────────────── */
.trust { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 246px), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius-s); overflow: hidden; }
.trust .item { background: var(--surface); padding: clamp(1.3rem, 2.6vw, 1.8rem); }
.trust .item .top { font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.11em; text-transform: uppercase; margin: 0 0 0.7rem; }
.trust .no .top { color: var(--wr-bad); }
.trust .yes .top { color: var(--gold); }
.trust .item p { margin: 0; font-size: 0.9rem; color: var(--muted); }
.trust .item strong { color: var(--ink); font-weight: 600; }
.audit { margin: 1.5rem 0 0; font-size: 0.9rem; color: var(--muted); max-width: 66ch; }
.audit code { font-family: var(--mono); font-size: 0.87em; background: var(--raised); border: 1px solid var(--line); padding: 0.1em 0.4em; border-radius: 4px; color: var(--ink); }

/* ── Download: art op volle kleur aan één kant, één harde overgang ─────── */
.closing { position: relative; overflow: hidden; border-top: 1px solid var(--line); }
.closing-art { position: absolute; inset: 0 0 0 auto; width: 58%; z-index: 0; }
.closing-art img { width: 100%; height: 100%; object-fit: cover; }
.closing-art::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, var(--ground) 4%, rgba(6, 8, 12, 0.72) 48%, rgba(6, 8, 12, 0.35) 100%);
}
.closing .wrap { position: relative; z-index: 1; padding-block: clamp(3.5rem, 7vw, 6rem); }
.closing h2 { font-size: clamp(1.9rem, 1.35rem + 2.2vw, 3.1rem); margin-bottom: 1rem; max-width: 18ch; }
.closing > .wrap > p { color: var(--muted); max-width: 46ch; margin: 0 0 2rem; }
@media (max-width: 860px) { .closing-art { width: 100%; opacity: 0.4; } }

footer { border-top: 1px solid var(--line); padding-block: 2.5rem 3rem; font-size: 0.84rem; color: var(--dim); }
footer .wrap { display: flex; flex-wrap: wrap; gap: 1.4rem 2.5rem; align-items: baseline; }
footer .legal { max-width: 64ch; margin: 0; line-height: 1.6; }
footer nav { display: flex; gap: 1.4rem; margin-left: auto; }
footer a { color: var(--muted); text-decoration: none; }
footer a:hover { color: var(--ink); text-decoration: underline; }

/* ── Beweging ──────────────────────────────────────────────────────────────
   Zichtbaar is de grondtoestand. Verbergen gebeurt alleen onder .reveal, en
   die klasse zet het script in de <head> pas als het ook kan onthullen.
   Zonder JavaScript staat er dus een pagina en geen leeg scherm.
   ───────────────────────────────────────────────────────────────────────── */
.reveal .rise { opacity: 0; transform: translateY(16px); }
.reveal .rise.in { opacity: 1; transform: none; transition: opacity 0.6s ease, transform 0.6s cubic-bezier(0.22, 1, 0.36, 1); }
@media (prefers-reduced-motion: reduce) {
  .reveal .rise, .reveal .rise.in { opacity: 1; transform: none; transition: none; }
  .btn:hover, .portrait:hover { transform: none; }
}
</style>

<script>
  // Vóór de eerste tekening: alleen verbergen als we ook kunnen onthullen.
  if ("IntersectionObserver" in window) document.documentElement.classList.add("reveal");
</script>
</head>
<body>
  <div class="paginadek" aria-hidden="true">
    <div class="mosaic mosaic-pagina">${paginaTiles()}</div>
  </div>

<header id="top-bar">
  <div class="wrap">
    <a class="brand" href="#">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="brand-name">All<em>Mid</em></span>
      <span class="badge">Classic</span>
    </a>
    <nav class="links">
      <a href="#tiers">Tier lists</a>
      <a href="#findings">Findings</a>
      <a href="#app">The app</a>
      <a href="#data">The data</a>
      <a href="#safety">Safety</a>
    </nav>
    <a class="btn btn-primary btn-sm" id="nav-download" href="#get">Download</a>
  </div>
</header>

<!-- ── Hero ───────────────────────────────────────────────────────────── -->
<section class="hero">
  <div class="hero-bg" aria-hidden="true">
    <div class="mosaic">${mosaicTiles()}</div>
  </div>
  <div class="wrap">
    <div class="rise">
      <p class="eyebrow">Free &middot; Open source &middot; MIT &middot; Windows</p>
      <h1>The stats page League Classic <em>never got</em>.</h1>
      <p class="lede">
        Blitz, Porofessor, OP.GG and METAsrc all stop at the modern game &mdash; Classic has no public
        API, so nobody covers it. AllMid reads the Classic client&rsquo;s own local APIs and has built
        the dataset from scratch: <strong>${n(T.games)} games</strong> across
        <strong>${n(T.players)} players</strong> and all <strong>63 champions</strong>.
      </p>
      <div class="cta-row" id="get">
        <a class="btn btn-primary" id="hero-download" href="https://github.com/allmidgg/desktop/releases/latest/download/AllMid-Setup.exe">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></svg>
          Download for Windows
        </a>
        <a class="btn btn-ghost" href="https://github.com/allmidgg/desktop">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z" /></svg>
          View the source
        </a>
      </div>
      <p class="cta-note">Windows 10 &amp; 11 &middot; no account &middot; no telemetry</p>

    </div>

    <div class="explorer-col rise">
      <div class="coverage">
        <p class="cov-label">Classic coverage</p>
        <span>Blitz</span><span>Porofessor</span><span>OP.GG</span><span>METAsrc</span><span class="yes">AllMid</span>
      </div>
      <div class="explorer">
      <div class="explorer-head">
        <h2>Champion explorer</h2>
        <span class="count mono">${Object.keys(roster).length} champions &middot; click any portrait</span>
      </div>
        <div class="explorer-grid" id="explorer-grid">${explorerGrid()}</div>
      </div>
    </div>

  </div>
</section>

<!-- ── Detail ─────────────────────────────────────────────────────────── -->
<section class="band" style="padding-block:0 clamp(2.5rem,5vw,4rem);margin-top:-0.5rem">
  <div class="wrap rise">
    <div class="champpaneel">
      ${detailPanel()}
      ${detailBuilds(SEED)}
    </div>
  </div>
</section>

<!-- ── Masthead ───────────────────────────────────────────────────────── -->
<section class="masthead">
  <div class="wrap">
    <span><b>Data report</b> &middot; <span class="v">edition ${DATE(T.generatedAt)}</span></span>
    <span><b>Patches</b> <span class="v">${T.patches.join(" &amp; ")}</span></span>
    <span><b>Window</b> <span class="v">${DATE(T.eersteGame)} &ndash; ${DATE(T.laatsteGame)}</span></span>
    <span><b>Sample</b> <span class="v">${n(T.games)} games</span></span>
  </div>
</section>

<!-- ── Cijfers ────────────────────────────────────────────────────────── -->
<section class="figures">
  <div class="wrap">
    <div class="cell"><div class="n">${n(T.games)}</div><div class="k">Games recorded</div></div>
    <div class="cell"><div class="n">${n(T.players)}</div><div class="k">Players seen</div></div>
    <div class="cell"><div class="n">63<span class="unit">/63</span></div><div class="k">Champions</div></div>
    <div class="cell"><div class="n">${n(T.playerRows)}</div><div class="k">Player records</div></div>
    <div class="cell"><div class="n">5</div><div class="k">Lanes ranked</div></div>
  </div>
</section>

<!-- ── Roster: volle kleur, volle breedte ─────────────────────────────── -->
<section class="roster">
  <div class="wrap"><p class="rl"><b>The full Classic roster</b> <span>All 63 champions &middot; original season-3 artwork, straight from the Classic client</span></p></div>
  ${rosterStrip()}
</section>

<!-- ── Tier-lijsten ───────────────────────────────────────────────────── -->
<section class="band" id="tiers">
  <div class="wrap">
    <div class="section-head rise">
      <p class="eyebrow">Live tier list</p>
      <h2>The Classic meta, right here on the page.</h2>
      <p>
        Not a screenshot &mdash; this is the pooled dataset, computed by the same code the app runs.
        A fresh install starts empty and builds up its own; these are everyone&rsquo;s finds together.
        ${n(T.games)} games from patches ${T.patches.map((p) => esc(p)).join(" and ")}, collected between
        ${DATE(T.eersteGame)} and ${DATE(T.laatsteGame)}.
      </p>
    </div>
    <div class="rise">
      <div class="lane-tabs" role="tablist" aria-label="Lane">
        ${LANES.map(({ key, label }, i) => `<button type="button" role="tab" id="tab-${key}" aria-controls="lane-${key}" aria-selected="${i === 0}" data-lane="${key}">${label}</button>`).join("")}
      </div>
      ${tierLists()}
    </div>
  </div>
</section>

<!-- ── Bevindingen ────────────────────────────────────────────────────── -->
<section class="band" id="findings">
  <div class="wrap">
    <div class="section-head rise">
      <p class="eyebrow">What the data says</p>
      <h2>Three things ${n(T.games)} Classic games make obvious.</h2>
      <p>None of these are visible anywhere else, because nobody else has the games to see them.</p>
    </div>
    <div class="rise">${findings()}</div>
  </div>
</section>

<!-- ── De app ─────────────────────────────────────────────────────────── -->
<section class="band" id="app">
  <div class="wrap">
    <div class="section-head rise">
      <p class="eyebrow">What you get</p>
      <h2>Everything the modern overlays give you, for the mode they ignore.</h2>
      <p>Champion select scouting, masteries that set themselves, and builds behind every entry in that tier list.</p>
    </div>

    <div class="feature rise">
      <div class="feature-copy">
        <h3>Know the lobby before it locks</h3>
        <p>The moment champion select opens, AllMid reads it and tells you what you are walking into.</p>
        <ul class="ticks">
          <li><b>Who picked what</b>, on both teams, as it happens</li>
          <li><b>Likely role</b> for every player, based on what they actually play</li>
          <li><b>Counters</b> ranked by real matchup win rate, not gut feeling</li>
          <li><b>Team bans</b>, so you can see what got taken away</li>
        </ul>
      </div>
      <figure class="window" style="margin:0">
        <img src="img/champion-select.png" width="1216" height="708" loading="lazy" alt="AllMid champion select: both teams with picks, bans, likely roles and counter suggestions." />
        <figcaption>Champion select &mdash; both teams, scouted</figcaption>
      </figure>
    </div>

    <div class="feature flip rise">
      <div class="feature-copy">
        <h3>Masteries set themselves</h3>
        <p>
          Tick the box once. From then on, every time you change champion in select, your mastery page is
          rewritten to the best 30-point setup for that champion and role &mdash; well before the timer runs out.
        </p>
        <ul class="ticks">
          <li>Always a <b>legal page</b>: 30 points, every prerequisite respected</li>
          <li>Re-applies <b>on every champion change</b>, not just the first one</li>
          <li>Your existing pages are <b>backed up</b> before anything is touched</li>
        </ul>
      </div>
      <figure class="window" style="margin:0">
        <img src="img/app/allmid-main.png" width="1296" height="828" loading="lazy" alt="AllMid main window listing recent Classic games with champions, KDA, CS, gold and items." />
        <figcaption>Live &mdash; your Classic match history</figcaption>
      </figure>
    </div>

    <div class="feature rise">
      <div class="feature-copy">
        <h3>Builds behind every number</h3>
        <p>Open a champion in the app and you get the build the wins were actually played with.</p>
        <ul class="ticks">
          <li><b>Most-built items</b> with how often they were held and how often those games were won</li>
          <li><b>Summoner spells</b>, ranked by how often the pair was taken</li>
          <li><b>Matchups</b> &mdash; who beats it, who loses to it, and by how much</li>
          <li>Win rates <b>smoothed</b>, so a 3-game 100% never tops the list</li>
        </ul>
      </div>
      <figure class="window" style="margin:0">
        <img src="img/meta.png" width="1296" height="828" loading="lazy" alt="AllMid meta window: Classic tier list by lane with win rates, summoner spells and item builds." />
        <figcaption>Meta &mdash; tier lists, spells and builds</figcaption>
      </figure>
    </div>
  </div>
</section>

<!-- ── Data ───────────────────────────────────────────────────────────── -->
<section class="band" id="data">
  <div class="wrap">
    <div class="section-head rise">
      <p class="eyebrow">Where the numbers come from</p>
      <h2>There is no API for Classic. There is a way around it.</h2>
      <p>
        Riot&rsquo;s public API returns nothing usable here: every Classic match ID comes back forbidden and
        every Classic queue filter comes back empty. But your own game client knows everything about the
        games it can see.
      </p>
    </div>
    <div class="chain rise">
      <div class="step"><span class="num">STEP 1</span><h4>Your client already knows</h4><p>League runs two local APIs on your machine for its own interface to use. AllMid reads them &mdash; the same match history you can open yourself, just faster.</p></div>
      <div class="step"><span class="num">STEP 2</span><h4>It walks the graph</h4><p>Every match names ten players, and every player has a match history. Follow that outward and a handful of games becomes a hundred thousand.</p></div>
      <div class="step"><span class="num">STEP 3</span><h4>Finds get pooled</h4><p>Games are merged and deduplicated by ID. If ten people run into the same match it is stored once, so overlap between users costs nothing.</p></div>
      <div class="step"><span class="num">STEP 4</span><h4>Everyone gets it back</h4><p>The pooled numbers are what this page is built from. Every new person who runs the app makes the tier lists, counters and builds here sharper &mdash; the app itself still computes from what it has crawled locally.</p></div>
    </div>
    <p class="audit">
      <strong>Per player:</strong> the account identifier (puuid), champion, team, position, result,
      KDA, CS, gold, final items and summoner spells. <strong>Per game:</strong> id, timestamp, duration,
      queue and patch. No display names, no runes or masteries, and no purchase order &mdash; the match
      history does not carry one. The puuid is what makes deduplication and player lookup possible; it is
      the same identifier the client itself uses, and it is listed here because leaving it out would
      understate what leaves your machine.
    </p>
  </div>
</section>

<!-- ── Veiligheid ─────────────────────────────────────────────────────── -->
<section class="band" id="safety">
  <div class="wrap">
    <div class="section-head rise">
      <p class="eyebrow">Before you run it</p>
      <h2>You are about to run an .exe next to your game. Here is exactly what it does.</h2>
      <p>
        Overlays have a bad reputation, and often a deserved one. The honest answer to &ldquo;is this
        safe&rdquo; is not a promise &mdash; it is a description you can go and check, which is the whole
        reason the source is public.
      </p>
    </div>
    <div class="trust rise">
      <div class="item no"><p class="top">Does not</p><p><strong>Read or write game memory.</strong> No injection, no DLLs, no hooking into the game process.</p></div>
      <div class="item no"><p class="top">Does not</p><p><strong>Touch your credentials.</strong> No login, no account, no password field anywhere in the app.</p></div>
      <div class="item no"><p class="top">Does not</p><p><strong>Modify game files.</strong> Nothing in your League folder is written to or replaced.</p></div>
      <div class="item no"><p class="top">Does not</p><p><strong>Play for you.</strong> No in-game automation, no scripting, no input simulation.</p></div>
      <div class="item yes"><p class="top">Does</p><p><strong>Use the client&rsquo;s own local APIs</strong> &mdash; the interfaces League already runs on your machine for its own UI.</p></div>
      <div class="item yes"><p class="top">Does</p><p><strong>Write your mastery page</strong>, and only when you ask it to. Your existing pages are backed up first.</p></div>
      <div class="item yes"><p class="top">Does</p><p><strong>Send collected match data</strong> to the shared pool, so the stats improve for everyone. There is a switch in the title bar that turns it off, and it shows you what has been shared.</p></div>
      <div class="item yes"><p class="top">Does</p><p><strong>Build in the open.</strong> The installer comes out of a public CI run you can inspect, not off somebody&rsquo;s laptop.</p></div>
    </div>
    <p class="audit">
      Rather verify than trust? Clone the repository, then run <code>npm install</code> and <code>npm run build</code>.
      You get the same application, built from the source you just read.
    </p>
  </div>
</section>

<!-- ── Download ───────────────────────────────────────────────────────── -->
<section class="closing" id="download">
  <div class="closing-art" aria-hidden="true"><img src="${splashOf(SEED)}" alt="" width="640" height="360" /></div>
  <div class="wrap rise">
    <p class="eyebrow">Get AllMid</p>
    <h2>Install it before your next Classic queue.</h2>
    <p>Windows 10 and 11. It runs alongside the League client &mdash; start it whenever you like and it picks up from there. Free, and it stays free.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="https://github.com/allmidgg/desktop/releases/latest/download/AllMid-Setup.exe">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></svg>
        Download for Windows
      </a>
      <a class="btn btn-ghost" href="https://github.com/allmidgg/desktop">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z" /></svg>
        Build it yourself
      </a>
    </div>
    <p class="cta-note">Current data: patches ${T.patches.join(" &amp; ")} &middot; ${n(T.games)} games &middot; ${n(T.players)} players</p>
  </div>
</section>

<footer>
  <div class="wrap">
    <p class="legal">
      AllMid is an independent, open-source project released under the MIT licence. It is not endorsed by
      Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in
      producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered
      trademarks of Riot Games, Inc.
    </p>
    <nav>
      <a href="https://github.com/allmidgg/desktop">GitHub</a>
      <a href="https://github.com/allmidgg/desktop/blob/main/LICENSE">Licence</a>
      <a href="https://github.com/allmidgg/desktop/issues">Report a bug</a>
    </nav>
  </div>
</footer>

<script id="champ-data" type="application/json">${JSON.stringify({
  c: explorerData(),
  r: rosterData(),
  b: buildsData(),
  t: naamTabellen(),
})}</script>

<script>
(() => {
  "use strict";

  const LANE_LABEL = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", SUPPORT: "Support" };
  const LANE_ORDER = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];
  const data = JSON.parse(document.getElementById("champ-data").textContent);

  const num = (v) => Number(v).toLocaleString("en-US");
  const pct = (v) => Number(v).toFixed(1);
  const barW = (wr) => Math.max(2, Math.min(100, ((wr - 50) / 12) * 100));
  const wrClass = (wr) => (wr >= 54 ? "wr-hi" : wr >= 50 ? "wr-ok" : wr >= 46 ? "wr-lo" : "wr-bad");

  /* ── Randje onder de kop zodra je scrolt ── */
  const bar = document.getElementById("top-bar");
  const onScroll = () => bar.classList.toggle("stuck", window.scrollY > 8);
  onScroll();
  addEventListener("scroll", onScroll, { passive: true });

  /* ── Download rechtsboven wijst de echte knop aan ── */
  const navDownload = document.getElementById("nav-download");
  const heroDownload = document.getElementById("hero-download");

  if (navDownload && heroDownload) {
    navDownload.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("get")?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
      // Opnieuw starten als je twee keer klikt: de klasse moet er eerst af,
      // anders loopt de animatie niet nog een keer.
      heroDownload.classList.remove("aangewezen");
      void heroDownload.offsetWidth;
      heroDownload.classList.add("aangewezen");
      setTimeout(() => heroDownload.classList.remove("aangewezen"), 3200);
    });
  }

  /* ── Lane-tabs ── */
  const tabs = [...document.querySelectorAll(".lane-tabs button")];
  const panes = [...document.querySelectorAll(".tier-pane")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      panes.forEach((p) => p.classList.toggle("is-open", p.id === "lane-" + tab.dataset.lane));
    });
  });

  /* ── Champion-verkenner ── */
  const el = (id) => document.getElementById(id);
  const buttons = [...document.querySelectorAll(".portrait")];

  function matchupRow(entry, dir) {
    const [id, wr, games] = entry;
    const r = data.r[id];
    if (!r) return "";
    const li = document.createElement("li");
    li.innerHTML =
      '<img src="' + r[1] + '" alt="" width="128" height="128" loading="lazy" />' +
      '<span class="m-name"></span>' +
      '<span class="m-games">' + num(games) + "g</span>" +
      '<span class="m-wr ' + (dir === "up" ? "wr-hi" : "wr-bad") + '">' + pct(wr) + "<small>%</small></span>";
    li.querySelector(".m-name").textContent = r[0];
    return li.outerHTML;
  }

  /* ── De builds onder het detailpaneel ── */

  // Namen worden via textContent gezet en niet in de HTML geplakt: ze komen uit
  // Riots catalogus en bevatten apostrofs ("Doran's Blade"), die anders de
  // opmaak zouden breken.
  function regel(iconSrc, naam, pick, wr) {
    const li = document.createElement("li");
    li.innerHTML =
      iconSrc +
      '<span class="i-name"></span>' +
      '<span class="i-pick">' + pct(pick) + "<small>%</small></span>" +
      '<span class="i-wr ' + wrClass(wr) + '">' + pct(wr) + "<small>%</small></span>";
    li.querySelector(".i-name").textContent = naam;
    return li.outerHTML;
  }

  // Deze twee staan apart zodat een losse kopie van de pagina -- zonder img/-map
  // ernaast -- ze kan vervangen door ingesloten afbeeldingen.
  const itemSrc = (id) => "img/items/" + id + ".png";
  const spellSrc = (id) => "img/spells/" + id + ".png";

  const plaatje = (src) =>
    '<img src="' + src + '" alt="" width="64" height="64" loading="lazy" />';

  const itemRegel = ([id, pick, wr]) =>
    regel(plaatje(itemSrc(id)), data.t.items[id] || "Item " + id, pick, wr);

  const spellRegel = ([a, b, pick, wr]) =>
    regel('<span class="s-pair">' + plaatje(spellSrc(a)) + plaatje(spellSrc(b)) + "</span>",
          (data.t.spells[a] || a) + " + " + (data.t.spells[b] || b), pick, wr);

  // Welke champion en lane er nu getoond worden, zodat de laneknoppen weten
  // waar ze bij horen als je erop klikt.
  let huidigeChamp = el("detail")?.dataset.seed ?? null;

  function showBuild(id, lane) {
    const set = data.b[id];
    const leeg = '<li class="c-empty">Not enough games.</li>';
    huidigeChamp = id;

    if (!set) {
      el("builds-games").textContent = "0";
      el("build-lanes").innerHTML = "";
      for (const veld of ["items", "boots", "starters", "spells"]) el("builds-" + veld).innerHTML = leeg;
      return;
    }

    const gekozen = lane && set.lanes[lane] ? lane : set.best;
    const b = set.lanes[gekozen];

    // De knoppen alleen opnieuw opbouwen als het om een andere champion gaat;
    // bij het wisselen van lane hoeven ze alleen van stand te veranderen.
    // Let op de vergelijking: hij moet BEIDE kanten op kloppen. Met alleen
    // "staat elke bestaande knop ook in de nieuwe set" bleef een champion met
    // meer lanes de knoppen van de vorige houden. Soraka heeft vijf lanes en
    // 9.880 daarvan zijn support -- juist die knop ontbrak dan.
    const gewenst = LANE_ORDER.filter((l) => set.lanes[l]);
    const bestaande = [...el("build-lanes").querySelectorAll("button")];
    const zelfdeSet =
      bestaande.length === gewenst.length && bestaande.every((btn, i) => btn.dataset.lane === gewenst[i]);
    if (!zelfdeSet) {
      el("build-lanes").innerHTML = gewenst
        .map(
          (l) =>
            '<button type="button" role="tab" data-lane="' + l + '" aria-selected="' + (l === gekozen) + '">' +
            (LANE_LABEL[l] || l) + "<span>" + pct(set.lanes[l].w) + "%</span></button>",
        )
        .join("");
    } else {
      for (const btn of bestaande) btn.setAttribute("aria-selected", String(btn.dataset.lane === gekozen));
    }

    el("builds-games").textContent = num(b.g);
    el("builds-items").innerHTML = b.i.map(itemRegel).join("") || leeg;
    el("builds-boots").innerHTML = b.b.map(itemRegel).join("") || leeg;
    el("builds-starters").innerHTML = b.s.map(itemRegel).join("") || leeg;
    el("builds-spells").innerHTML = b.p.map(spellRegel).join("") || leeg;
  }

  // Eén luisteraar op de container: de knoppen worden opnieuw opgebouwd bij elke
  // championwissel, dus luisteraars per knop zouden telkens opnieuw moeten.
  el("build-lanes")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-lane]");
    if (btn && huidigeChamp !== null) showBuild(huidigeChamp, btn.dataset.lane);
  });

  function show(id) {
    const c = data.c[id];
    const r = data.r[id];
    if (!c || !r) return;

    el("detail-name").textContent = r[0];
    el("detail-icon").src = r[1];
    el("detail-splash").src = r[2];
    el("detail-sub").innerHTML =
      c.g ? num(c.g) + " games &middot; " + pct(c.w) + "% overall" : "&nbsp;";

    el("detail-lane-rows").innerHTML = c.l.length
      ? c.l
          .map(([lane, games, wr, rank]) =>
            "<tr><th scope=\\"row\\">" + (LANE_LABEL[lane] || lane) + "</th>" +
            '<td class="c-rank">' + (rank ? "#" + rank : "&mdash;") + "</td>" +
            '<td class="c-bar"><span style="width:' + barW(wr).toFixed(1) + '%"></span></td>' +
            '<td class="c-wr ' + wrClass(wr) + '">' + pct(wr) + "<small>%</small></td>" +
            '<td class="c-games">' + num(games) + "</td></tr>",
          )
          .join("")
      : '<tr><td colspan="5" class="c-empty">No lane data yet.</td></tr>';

    const none = '<li class="c-empty">Not enough games.</li>';
    el("detail-beats").innerHTML = c.b.map((m) => matchupRow(m, "up")).join("") || none;
    el("detail-loses").innerHTML = c.d.map((m) => matchupRow(m, "down")).join("") || none;

    showBuild(id);
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.champ === String(id))));
  }

  buttons.forEach((b) => b.addEventListener("click", () => show(b.dataset.champ)));
  const seed = el("detail")?.dataset.seed;
  if (seed) buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.champ === seed)));

  /* ── Opbouw ── */
  const risers = [...document.querySelectorAll(".rise")];
  const showAll = () => risers.forEach((r) => r.classList.add("in"));

  if (!document.documentElement.classList.contains("reveal")) {
    // Nooit verborgen, dus niets te onthullen.
  } else if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    showAll();
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
    );
    risers.forEach((r) => io.observe(r));
    // Vangnet: een animatie die niet afgaat mag nooit de tekst kosten.
    setTimeout(showAll, 3000);
  }
})();
</script>

</body>
</html>
`;

writeFileSync(join(HERE, "index.html"), html, "utf8");
console.log(
  `[build] index.html geschreven -- ${(html.length / 1024).toFixed(0)} KB, ` +
    `${Object.keys(roster).length} champions, ${n(T.games)} games` +
    (champions ? "" : "  (LET OP: zonder champions.json)"),
);
