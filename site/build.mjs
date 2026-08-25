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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

/**
 * De vijf lanes van een champion, altijd alle vijf en altijd in dezelfde volgorde.
 *
 * champions.json sorteert ze op aantal games, en dan verspringen de regels bij
 * elke champion die je aanklikt: bij Soraka begint de tabel met Support, bij
 * Tryndamere met Top. Je kunt dan niets vergelijken zonder elke keer opnieuw te
 * lezen waar je naar kijkt.
 */
function laneLijst(full) {
  const per = new Map((full?.lanes ?? []).map((x) => [x.lane, x]));
  return LANES.map(({ key, label }) => {
    const x = per.get(key);
    return {
      lane: key,
      label,
      games: x?.games ?? 0,
      winrate: x?.winrate ?? null,
      rank: x?.qualified ? (x.rank ?? null) : null,
      rankOf: x?.rankOf ?? null,
      pickRate: x?.pickRate ?? 0,
      qualified: Boolean(x?.qualified),
      beats: x?.beats ?? [],
      losesTo: x?.losesTo ?? [],
    };
  });
}

/** De lane waar de champion het vaakst staat. Puur op aantal games. */
function vaakstGespeeld(full) {
  const rijen = laneLijst(full).filter((r) => r.games > 0);
  if (!rijen.length) return null;
  return rijen.reduce((a, b) => (b.games > a.games ? b : a)).lane;
}

/**
 * De lane waarop het paneel opent: de meest gespeelde, maar alleen als die de
 * drempel haalt. Anders de zwaarste die hem wel haalt -- op een lane met veertig
 * games valt niets te zeggen en dan hoeft hij ook niet open te staan.
 */
function openLane(full) {
  const rijen = laneLijst(full);
  const gekwalificeerd = rijen.filter((r) => r.qualified);
  const bron = gekwalificeerd.length ? gekwalificeerd : rijen.filter((r) => r.games > 0);
  if (!bron.length) return null;
  return bron.reduce((a, b) => (b.games > a.games ? b : a)).lane;
}

/** Compacte vorm van champions.json, klein genoeg om in de pagina te zetten. */
function explorerData() {
  const kort = (rij) => (rij ?? []).slice(0, 4).map((x) => [x.baseId, x.winrate, x.games]);
  const out = {};
  for (const c of Object.values(roster)) {
    const full = champions.champions[String(c.baseId)];
    if (!full) throw new Error(`champions.json mist ${c.name} (${c.baseId})`);

    // Matchups per lane. Dit is de kern van de wijziging: gepoold over alle
    // lanes kwam Kog'Maw eruit met Skarner, Malphite, Garen en Nidalee als beste
    // matchups, terwijl geen van die vier ooit tegenover een botlane-ADC staat.
    const m = {};
    for (const rij of laneLijst(full)) {
      if (!rij.games) continue;
      m[rij.lane] = { b: kort(rij.beats), d: kort(rij.losesTo) };
    }

    out[c.baseId] = {
      n: c.name,
      g: full.totalGames,
      w: full.winrate,
      // Vaste volgorde, alle vijf de lanes, met een expliciete vlag of de lane
      // de drempel haalt. Niet-gekwalificeerde lanes gaan mee maar zonder rang:
      // een lane met 40 games hoort er niet even hard uit te zien als een met 8.000.
      l: laneLijst(full).map((x) => [x.lane, x.games, x.winrate, x.rank, x.qualified ? 1 : 0]),
      h: vaakstGespeeld(full),
      o: openLane(full),
      m,
      b: kort(full.beats),
      d: kort(full.losesTo),
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
  for (const c of Object.values(roster)) out[c.baseId] = [c.name, c.icon.path, c.splash.path, slugVan(c.name)];
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
  const rijen = laneLijst(c);
  const vaakst = vaakstGespeeld(c);
  const open = openLane(c);
  const openRij = rijen.find((x) => x.lane === open);

  // De matchups van de lane waarop het paneel opent, niet de gepoolde. Zie de
  // toelichting bij explorerData.
  const beats = (openRij?.beats ?? []).slice(0, 4);
  const loses = (openRij?.losesTo ?? []).slice(0, 4);

  const laneRows = rijen
    .map((l) => {
      // Alleen lanes die de drempel halen zijn aanklikbaar. Bij de rest valt er
      // niets te tonen, dus een klik zou op een leeg paneel uitkomen.
      const naam = l.qualified
        ? `<button type="button" class="lane-knop" data-lane="${l.lane}">${esc(l.label)}</button>`
        : `<span class="lane-knop is-stil">${esc(l.label)}</span>`;
      const tag = l.lane === vaakst ? ` <span class="lane-tag">most played</span>` : "";
      return `
          <tr data-lane="${l.lane}"${l.lane === vaakst ? ' class="is-vaakst"' : ""} aria-selected="${l.lane === open}">
            <th scope="row">${naam}${tag}</th>
            <td class="c-rank">${l.rank ? `#${l.rank}` : "&mdash;"}</td>
            <td class="c-bar">${l.winrate === null ? "" : `<span style="width:${bar(l.winrate).toFixed(1)}%"></span>`}</td>
            <td class="c-wr ${l.winrate === null ? "" : wrClass(l.winrate)}">${l.winrate === null ? "&mdash;" : `${pct(l.winrate)}<small>%</small>`}</td>
            <td class="c-games">${l.games ? n(l.games) : "&mdash;"}</td>
          </tr>`;
    })
    .join("");

  /**
   * "Not enough games" is niet hetzelfde als "wint van niemand".
   *
   * Tryndamere staat op 58% in top en verliest van geen enkele tegenstander die
   * hij regelmatig tegenkomt -- 19 stuks halen de eis, alle 19 boven de 50%. Daar
   * "Not enough games" onder zetten is gewoon onwaar: er zijn 12.372 games. Alleen
   * als er aan BEIDE kanten niets staat is er echt te weinig.
   */
  const leegTekst = (dezeKant, andereKant) =>
    `<li class="c-empty">${
      andereKant.length ? `No ${dezeKant} matchup in this lane.` : "Not enough games."
    }</li>`;

  const matchup = (m, dir) => `
      <li>
        <img src="${iconOf(m.baseId)}" alt="" width="128" height="128" loading="lazy" />
        <span class="m-name">${esc(m.name ?? nameOf(m.baseId))}</span>
        <span class="m-games">${n(m.games)}g</span>
        <span class="m-wr ${dir === "up" ? "wr-hi" : "wr-bad"}">${pct(m.winrate)}<small>%</small></span>
      </li>`;

  return `
    <div class="detail" id="detail"
         data-seed="${seedId}" data-lane="${open ?? ""}"
         style="--splash:url('${splashOf(seedId)}')">
      <div class="detail-art">
        <img id="detail-splash" src="${splashOf(seedId)}" alt="" width="640" height="360" />
        <div class="detail-id">
          <img id="detail-icon" src="${iconOf(seedId)}" alt="" width="128" height="128" />
          <div>
            <h3 id="detail-name">${esc(nameOf(seedId))}</h3>
            <p id="detail-sub" class="mono">${c ? `${n(c.totalGames)} games &middot; ${pct(c.winrate)}% overall` : "&nbsp;"}</p>
          </div>
          <a class="btn btn-ghost btn-sm guide-link" id="detail-guide" href="champion/${slugVan(nameOf(seedId))}.html">Full build</a>
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
        <div class="mu-kop">
          <p class="block-label">Matchups <span id="mu-uitleg">${open ? "in lane" : "all lanes"}</span></p>
          <div class="build-lanes mu-schakel" id="mu-schakel" role="tablist" aria-label="Matchup scope">
            <button type="button" role="tab" data-mu="lane" aria-selected="true" id="mu-lane"${open ? "" : " hidden"}>${esc(rijen.find((x) => x.lane === open)?.label ?? "Lane")}</button>
            <button type="button" role="tab" data-mu="overall" aria-selected="false">Overall</button>
          </div>
        </div>
        <div>
          <p class="block-label">Wins into</p>
          <ul class="matchups" id="detail-beats">${beats.map((m) => matchup(m, "up")).join("") || leegTekst("winning", loses)}</ul>
        </div>
        <div>
          <p class="block-label">Loses to</p>
          <ul class="matchups" id="detail-loses">${loses.map((m) => matchup(m, "down")).join("") || leegTekst("losing", beats)}</ul>
        </div>
        <p class="mu-note">Opponents holding at least 1% of this lane, so these are picks you actually run into.</p>
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


/* ── Guidepagina per champion ─────────────────────────────────────────────── */

/**
 * Eén pagina per champion, op champion/<naam>.html.
 *
 * Aparte bestanden en geen uitklap op de voorpagina, om één reden: hier hoort een
 * adres bij dat je kunt delen en dat een zoekmachine kan indexeren. Iemand zoekt
 * "nasus classic build", en dan wil je dat allmid.gg/champion/nasus bestaat. Een
 * uitklap heeft geen adres.
 *
 * De pagina's staan een map dieper, dus alles wat ze opvragen krijgt ../ mee.
 */
const slugVan = (naam) => naam.toLowerCase().replace(/[^a-z0-9]+/g, "");
const G = (pad) => "../" + pad;

/** Een getal met het lane-gemiddelde eronder, want los zegt "206 CS" niets. */
function cijfer(label, waarde, ijk, cijfers = 0) {
  const toon = (x) => (cijfers ? x.toFixed(cijfers) : n(Math.round(x)));
  let staart = "&nbsp;";
  if (ijk) {
    const pct = ((waarde - ijk) / ijk) * 100;
    const klasse = Math.abs(pct) < 1.5 ? "tov-gelijk" : pct > 0 ? "tov-hoog" : "tov-laag";
    const teken = pct > 0 ? "+" : "";
    staart = `lane ${toon(ijk)} <span class="${klasse}">${teken}${pct.toFixed(0)}%</span>`;
  }
  return `
        <div class="cijfer">
          <span class="cijfer-label">${esc(label)}</span>
          <span class="cijfer-waarde">${toon(waarde)}</span>
          <span class="cijfer-ijk">${staart}</span>
        </div>`;
}

const gItemRij = (i) => `
        <li>
          <img src="${G(itemIcon(i.baseId))}" alt="" width="64" height="64" loading="lazy" />
          <span class="i-name">${esc(i.naam)}</span>
          <span class="i-pick">${pct(i.pickRate)}<small>%</small></span>
          <span class="i-wr ${wrClass(i.winrate)}">${pct(i.winrate)}<small>%</small></span>
        </li>`;

const gSpelRij = (sp) => `
        <li>
          <span class="s-pair">
            <img src="${G(spellIcon(sp.spells[0]))}" alt="" width="64" height="64" loading="lazy" />
            <img src="${G(spellIcon(sp.spells[1]))}" alt="" width="64" height="64" loading="lazy" />
          </span>
          <span class="i-name">${esc(spellName(sp.spells[0]))} + ${esc(spellName(sp.spells[1]))}</span>
          <span class="i-pick">${pct(sp.pickRate)}<small>%</small></span>
          <span class="i-wr ${wrClass(sp.winrate)}">${pct(sp.winrate)}<small>%</small></span>
        </li>`;

const gMatchupRij = (m, op) => `
        <li>
          <img src="${G(iconOf(m.baseId))}" alt="" width="128" height="128" loading="lazy" />
          <span class="m-name">${esc(m.name ?? nameOf(m.baseId))}</span>
          <span class="m-games">${n(m.games)}g</span>
          <span class="m-wr ${op ? "wr-hi" : "wr-bad"}">${pct(m.winrate)}<small>%</small></span>
        </li>`;

/** Eén lane op de guidepagina: cijfers, core, items, spells en matchups. */
function guideLane(laneRegel, buildRegel, ijk, isOpen) {
  const L = LANES.find((x) => x.key === laneRegel.lane);
  const leeg = `<li class="c-empty">Not enough games.</li>`;
  const kda = buildRegel?.kda;
  const farm = buildRegel?.farm;

  const core = (buildRegel?.core ?? []).map(
    (r) => `
        <li>
          <span class="core-items">${r.items
            .map((id) => `<img src="${G(itemIcon(id))}" alt="${esc(itemName(id))}" title="${esc(itemName(id))}" width="64" height="64" loading="lazy" />`)
            .join("")}</span>
          <span class="i-pick">${pct(r.pickRate)}<small>%</small></span>
          <span class="i-wr ${wrClass(r.winrate)}">${pct(r.winrate)}<small>%</small></span>
          <span class="m-games">${n(r.games)}g</span>
        </li>`,
  );

  return `
    <section class="guide-lane${isOpen ? " is-open" : ""}" data-lane="${laneRegel.lane}">
      <div class="guide-lane-kop">
        <h2>${esc(L?.label ?? laneRegel.lane)}</h2>
        <p class="mono">
          ${laneRegel.rank ? `Rank #${laneRegel.rank} of ${laneRegel.rankOf} &middot; ` : ""}
          <span class="${wrClass(laneRegel.winrate)}">${pct(laneRegel.winrate)}% win</span> &middot;
          ${pct(laneRegel.pickRate)}% pick &middot; ${n(laneRegel.games)} games
        </p>
      </div>

      <div class="cijfers">
        ${kda ? cijfer("Kills", kda.kills, ijk?.kills, 1) : ""}
        ${kda ? cijfer("Deaths", kda.deaths, ijk?.deaths, 1) : ""}
        ${kda ? cijfer("Assists", kda.assists, ijk?.assists, 1) : ""}
        ${farm ? cijfer("CS", farm.cs, ijk?.cs, 1) : ""}
        ${farm ? cijfer("Gold", farm.gold, ijk?.gold) : ""}
        ${farm ? cijfer("Game length", farm.minuten, ijk?.minuten, 1) : ""}
      </div>

      <div class="guide-kolommen">
        <div>
          <p class="block-label">Most held together <span>three items, end of game</span></p>
          <ul class="corelijst">${core.join("") || leeg}</ul>

          <p class="block-label">Items</p>
          <ul class="itemlist">${(buildRegel?.items ?? []).map(gItemRij).join("") || leeg}</ul>
        </div>

        <div>
          <p class="block-label">Boots</p>
          <ul class="itemlist">${(buildRegel?.boots ?? []).map(gItemRij).join("") || leeg}</ul>

          <p class="block-label">Starting items</p>
          <ul class="itemlist">${(buildRegel?.starters ?? []).map(gItemRij).join("") || leeg}</ul>

          <p class="block-label">Summoner spells</p>
          <ul class="itemlist">${(buildRegel?.spells ?? []).map(gSpelRij).join("") || leeg}</ul>
        </div>

        <div>
          <p class="block-label">Wins into</p>
          <ul class="matchups">${(laneRegel.beats ?? []).map((m) => gMatchupRij(m, true)).join("") ||
            `<li class="c-empty">${(laneRegel.losesTo ?? []).length ? "No winning matchup in this lane." : "Not enough games."}</li>`}</ul>

          <p class="block-label">Loses to</p>
          <ul class="matchups">${(laneRegel.losesTo ?? []).map((m) => gMatchupRij(m, false)).join("") ||
            `<li class="c-empty">${(laneRegel.beats ?? []).length ? "No losing matchup in this lane." : "Not enough games."}</li>`}</ul>

          <p class="mu-note">Opponents holding at least 1% of this lane.</p>
        </div>
      </div>
    </section>`;
}


/** De hele guidepagina van één champion. */
/**
 * A champion page for somebody we have no games on.
 *
 * Two thirds of League never existed in Season 3, so two thirds of the roster
 * can never have a Classic statistic. Leaving those pages out would make the
 * site look like it covers 63 champions; inventing numbers for them would make
 * it worthless. So the page exists, carries what is actually known -- Riot's
 * own published base stats, which are facts rather than opinions -- and says
 * plainly why there is no win rate on it.
 */
/**
 * Every champion in League, on one searchable page.
 *
 * The site had 173 champion pages and no way to reach them: the home page
 * explorer only ever showed the 63 with Classic data. This is the index that
 * makes the rest of the roster more than a URL somebody has to guess.
 *
 * Search and filtering are client-side over markup that is already complete,
 * so the page works with the script switched off -- it just shows everybody.
 */
/**
 * A page that is wired up before its data exists.
 *
 * The point of these is the plumbing: real nav, real header, real footer, the
 * exact place every future row will slot into, and honest copy about why it is
 * empty. When the numbers land, the empty state is replaced by a table -- the
 * page, its URL and its link from the nav do not move. `scaffold` renders the
 * shared skeleton so tiers.html and app/overlay share one shape.
 */
function paginaGeraamte({ hier, titel, eyebrow, kop, lede, inhoud }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(titel)} &middot; AllMid</title>
<meta name="description" content="${esc(lede.replace(/<[^>]+>/g, ""))}" />
<meta name="theme-color" content="#06080c" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" />
<link rel="stylesheet" href="${CSS_PAD}" />
</head>
<body>

${toolbalk(hier)}

<main class="wrap geraamte">
  <div class="sectiekop rise">
    <p class="eyebrow">${esc(eyebrow)}</p>
    <h1>${esc(kop)}</h1>
    <p class="sectielede">${lede}</p>
  </div>
  ${inhoud}
</main>

<footer>
  <div class="wrap">
    <p class="legal">
      AllMid is an independent, open-source project released under the MIT licence. It is not endorsed by
      Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in
      producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered
      trademarks of Riot Games, Inc.
    </p>
    <nav>
      <a href="index.html">Home</a>
      <a href="classic.html">Classic</a>
      <a href="https://github.com/allmidgg/desktop">GitHub</a>
    </nav>
  </div>
</footer>

${zoekIndex()}
${ZOEK_SCRIPT}
</body>
</html>`;
}

/** A labelled "waiting for data" panel with the real column headers already in place. */
function wachtPaneel({ kolommen, uitleg, cta }) {
  const koppen = kolommen.map((k) => `<span>${esc(k)}</span>`).join("");
  return `<div class="wacht">
    <div class="wacht-kop">${koppen}</div>
    <div class="wacht-rijen">
      ${[0, 1, 2, 3, 4]
        .map(
          () => `<div class="wacht-rij">
        <span class="wacht-blok w-portret"></span>
        <span class="wacht-blok w-lang"></span>
        <span class="wacht-blok w-kort"></span>
        <span class="wacht-blok w-kort"></span>
      </div>`,
        )
        .join("")}
    </div>
    <div class="wacht-uitleg">
      ${existsSync(join(HERE, "img/leeg.png")) ? `<img class="wacht-beeld" src="img/leeg.png" alt="" width="200" height="133" loading="lazy" />` : ""}
      <div class="wacht-uitleg-tekst">
        <p>${uitleg}</p>
        ${cta ? `<a class="btn btn-ghost btn-sm" href="${cta.href}">${esc(cta.tekst)}</a>` : ""}
      </div>
    </div>
  </div>`;
}

/**
 * The standalone Tier list page.
 *
 * Standard League has no games yet, so this is a queue picker over empty
 * panels -- except Classic, which links straight to the live tier list that
 * already exists on classic.html. That is the pattern for the whole site:
 * wired now, filled per queue as the data arrives.
 */
function tiersPagina() {
  const wachtrijen = [
    { naam: "Ranked Solo/Duo", live: false },
    { naam: "Flex", live: false },
    { naam: "Normal Draft", live: false },
    { naam: "ARAM", live: false },
  ];

  const keuze = `<div class="tier-keuze">
    <a class="tier-optie aan" href="classic.html#tiers">
      <span class="to-naam">Classic</span>
      <span class="to-merk">${n(T.games)} games</span>
    </a>
    ${wachtrijen
      .map(
        (q) =>
          `<span class="tier-optie soon">
        <span class="to-naam">${esc(q.naam)}</span>
        <span class="to-merk">no data yet</span>
      </span>`,
      )
      .join("")}
  </div>`;

  const paneel = wachtPaneel({
    kolommen: ["Rank", "Champion", "Win rate", "Games"],
    uitleg:
      "Standard-queue tier lists land here the moment there is a real sample behind them. " +
      "Classic is live now &mdash; it is built from recorded games and updates itself.",
    cta: { href: "classic.html#tiers", tekst: "See the Classic tier list" },
  });

  return paginaGeraamte({
    hier: "tiers",
    titel: "Tier list",
    eyebrow: "Tier list",
    kop: "Every queue, ranked the same way",
    lede:
      "One method across all of them: win rate with the sample size attached, per lane, nothing " +
      "editorialised. The queue that has data today is Classic; the rest are wired and waiting.",
    inhoud: `${keuze}${paneel}`,
  });
}

/** The app page: what it is, until there is a gallery of screenshots to show. */
function appPagina() {
  const blokken = KENMERKEN.map(kenmerkBlok).join("");
  return paginaGeraamte({
    hier: "app",
    titel: "The app",
    eyebrow: "The desktop app",
    kop: "AllMid on your machine, reading your own client",
    lede:
      "No injection, no memory reading, no DLL in the game process &mdash; just the local APIs " +
      "Riot already ships with the client. Below is what it does; each one is a feature that " +
      "runs today.",
    inhoud: `<div class="kenmerken">${blokken}</div>
      <div class="geraamte-cta rise">
        <a class="btn btn-primary" href="https://github.com/allmidgg/desktop/releases/latest/download/AllMid-Setup.exe">Download for Windows</a>
        <a class="btn btn-ghost" href="https://github.com/allmidgg/desktop">Read the source</a>
      </div>`,
  });
}

/** The overlay page: the yes/no split, promoted from a section to its own page. */
function overlayPagina() {
  const luik = `<div class="tweeluik">
    <div class="tl-kolom tl-ja">
      <h3>On the panel</h3>
      <ul>
        <li>Objective respawn timers, counted from a kill the whole lobby watched</li>
        <li>The gold difference in items on the field</li>
        <li>Your own skill order, as you level it</li>
        <li>A nudge when your trinket slot is sitting empty</li>
      </ul>
    </div>
    <div class="tl-kolom tl-nee">
      <h3>Never on it</h3>
      <ul>
        <li>Enemy ability cooldowns</li>
        <li>Ultimate timers on portraits</li>
        <li>Ward positions</li>
        <li>Anything the game did not already show both teams</li>
      </ul>
      <p class="tl-waarom">
        Not because we could not build it &mdash; because Riot&rsquo;s third-party rules forbid
        exactly this, and a tool that gets you banned is not a tool.
      </p>
    </div>
  </div>`;

  return paginaGeraamte({
    hier: "overlay",
    titel: "The overlay",
    eyebrow: "The in-game overlay",
    kop: "On top of the game, and only what the game already shows",
    lede:
      "A small panel that sits over a running game in borderless or windowed mode. It carries " +
      "arithmetic on things both teams can already see &mdash; and deliberately nothing else.",
    inhoud: `${luik}
      <div class="geraamte-cta rise">
        <a class="btn btn-primary" href="https://github.com/allmidgg/desktop/releases/latest/download/AllMid-Setup.exe">Download for Windows</a>
      </div>`,
  });
}

/**
 * The front page: League of Legends, and what AllMid does with it.
 *
 * Deliberately not the Classic page. Classic is the queue we have data for
 * today and it keeps its own page and its own place in the nav; the front of
 * the site is about the app, the roster and the method, because those hold
 * whichever queue the numbers eventually come from.
 */
function leaguePagina() {
  const voorbeeld = catalogus.champions
    .filter((c) => IN_CLASSIC.has(c.id))
    .slice(0, 14)
    .map(
      (c) =>
        `<a href="champion/${slugVan(c.name)}.html" title="${esc(c.name)}">
          <img src="${iconOf(c.id)}" alt="${esc(c.name)}" width="56" height="56" loading="lazy" />
        </a>`,
    )
    .join("");

  const heldBeeld = existsSync(join(HERE, "img/app/allmid-main.png"))
    ? `<img src="img/app/allmid-main.png" alt="The AllMid desktop app" />`
    : `<span class="kenmerk-wacht">The app</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AllMid &mdash; League of Legends stats and overlay</title>
<meta name="description" content="A free, open-source League of Legends companion: builds, counters and an in-game overlay, with the sample size on every number. ${n(T.games)} games recorded so far." />
<link rel="canonical" href="https://allmid.gg/" />
<meta property="og:type" content="website" />
<meta property="og:title" content="AllMid &mdash; League of Legends stats and overlay" />
<meta property="og:description" content="Builds, counters and an in-game overlay for League of Legends. Free, open source, and every number carries the sample size it came from." />
<meta property="og:url" content="https://allmid.gg/" />
<meta property="og:image" content="https://allmid.gg/img/meta.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="theme-color" content="#06080c" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" />
<link rel="stylesheet" href="${CSS_PAD}" />
<script>
  if ("IntersectionObserver" in window) document.documentElement.classList.add("reveal");
</script>
</head>
<body>

${toolbalk("home")}

<section class="lol-held">
  <div class="lol-held-dek" aria-hidden="true">
    ${existsSync(join(HERE, "img/hero-bg.png")) ? `<img class="held-foto" src="img/hero-bg.png" alt="" />` : ""}
    <div class="mosaic">${mosaicTiles()}</div>
  </div>
  <div class="wrap">
    <div class="rise">
      <p class="eyebrow">Free &middot; Open source &middot; MIT &middot; Windows</p>
      <h1>Everything you need <em>mid-game</em>, and nothing you have to take on faith.</h1>
      <p class="lede">
        A League of Legends companion that reads your own client, sets your masteries before the
        timer runs out, and puts objective timers on top of the game. Every figure it shows carries
        the number of games behind it &mdash; because a win rate without a sample size is just a
        number that looks like an answer.
      </p>
      <div class="cta-row">
        <a class="btn btn-primary" href="https://github.com/allmidgg/desktop/releases/latest/download/AllMid-Setup.exe">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></svg>
          Download for Windows
        </a>
        <a class="btn btn-ghost" href="champions.html">Browse ${catalogus.champions.length} champions</a>
      </div>
      <p class="cta-note">Windows 10 &amp; 11 &middot; no account &middot; no telemetry</p>
    </div>
    <div class="lol-held-beeld rise">${heldBeeld}</div>
  </div>
</section>

${modusBalk()}

<section class="band" id="app">
  <div class="wrap">
    <div class="sectiekop rise">
      <p class="eyebrow">The app</p>
      <h2>Six things it does &mdash; all of them from the client you already have</h2>
      <p class="sectielede">
        No injection, no memory reading, no DLL in the game process. It talks to the same local
        APIs Riot ships with the client, which is why it is safe to run and why it can never show
        you anything the game did not already tell everybody.
      </p>
    </div>
    <div class="kenmerken">${KENMERKEN.map(kenmerkBlok).join("")}</div>
  </div>
</section>

<section class="band alt" id="roster">
  <div class="wrap rise">
    <div class="sectiekop">
      <p class="eyebrow">Champions</p>
      <h2>All ${catalogus.champions.length}, and we tell you which ones we have numbers for</h2>
      <p class="sectielede">
        ${Object.keys(roster).length} champions carry win rates, builds and lane matchups from
        ${n(T.games)} recorded games. The rest have a page too &mdash; with Riot&rsquo;s published
        base stats and a straight answer about why there is no percentage on it yet.
      </p>
    </div>
    <div class="rosterstrip">${voorbeeld}</div>
    <a class="btn btn-ghost" href="champions.html">Open the champion list</a>
  </div>
</section>

<section class="band" id="classic-spot">
  <div class="wrap rise">
    <div class="spot">
      <div class="spot-tekst">
        <p class="eyebrow">Where the data comes from</p>
        <h2>Nobody covers League Classic. So we counted it ourselves.</h2>
        <p>
          Riot&rsquo;s public API does not carry Classic &mdash; its map and its queues are absent
          from their own published lists, and its match history is deliberately not exposed. So the
          numbers had to come from somewhere else: the client&rsquo;s own local APIs, and players
          who chose to share the games they played.
        </p>
        <p>
          <strong>${n(T.games)} games</strong> across <strong>${n(T.players)} players</strong>,
          all 63 champions, split by lane, with every sample size attached.
        </p>
        <a class="btn btn-primary btn-sm" href="classic.html">See the Classic data</a>
      </div>
      <div class="spotcijfers">
        <div><b>${n(T.games)}</b><span>Games recorded</span></div>
        <div><b>${n(T.players)}</b><span>Players seen</span></div>
        <div><b>63</b><span>Champions covered</span></div>
        <div><b>5</b><span>Lanes ranked</span></div>
      </div>
    </div>
  </div>
</section>

<section class="band alt" id="overlay">
  <div class="wrap rise">
    <div class="sectiekop">
      <p class="eyebrow">The overlay</p>
      <h2>What it puts on your screen, and what it never will</h2>
    </div>
    <div class="tweeluik">
      <div class="tl-kolom tl-ja">
        <h3>On the panel</h3>
        <ul>
          <li>Objective respawn timers, counted from a kill the whole lobby watched</li>
          <li>The gold difference in items on the field</li>
          <li>Your own skill order, as you level it</li>
          <li>A nudge when your trinket slot is sitting empty</li>
        </ul>
      </div>
      <div class="tl-kolom tl-nee">
        <h3>Never on it</h3>
        <ul>
          <li>Enemy ability cooldowns</li>
          <li>Ultimate timers on portraits</li>
          <li>Ward positions</li>
          <li>Anything the game did not already show both teams</li>
        </ul>
        <p class="tl-waarom">
          Not because we could not build it &mdash; because Riot&rsquo;s third-party rules forbid
          exactly this, and a tool that gets you banned is not a tool.
        </p>
      </div>
    </div>
  </div>
</section>

${existsSync(join(HERE, "img/scheiding.png")) ? `<div class="scheiding" aria-hidden="true" style="background-image:url(img/scheiding.png)"></div>` : ""}
<section class="band" id="get">
  <div class="wrap rise downloadblok">
    <h2>Get it</h2>
    <p>Windows 10 and 11. No account, no telemetry, no installer surprises.</p>
    <a class="btn btn-primary" href="https://github.com/allmidgg/desktop/releases/latest/download/AllMid-Setup.exe">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></svg>
      Download for Windows
    </a>
    <p class="cta-note">Or <a href="https://github.com/allmidgg/desktop">read the source</a> first.</p>
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
    <p class="legal">Questions, corrections or takedown requests: <a href="mailto:contact@allmid.gg">contact@allmid.gg</a>.</p>
    <nav>
      <a href="classic.html">Classic</a>
      <a href="champions.html">Champions</a>
      <a href="https://github.com/allmidgg/desktop">GitHub</a>
    </nav>
  </div>
</footer>

${zoekIndex()}
${ZOEK_SCRIPT}
<script>
(function () {
  if (!("IntersectionObserver" in window)) { document.documentElement.classList.remove("reveal"); return; }
  var risers = [].slice.call(document.querySelectorAll(".rise"));
  var waarnemer = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add("op"); waarnemer.unobserve(e.target); }
    });
  }, { rootMargin: "0px 0px -8% 0px" });
  risers.forEach(function (r) { waarnemer.observe(r); });
  // A reveal that never fires must never cost the text.
  setTimeout(function () { risers.forEach(function (r) { r.classList.add("op"); }); }, 3000);
})();
</script>
</body>
</html>`;
}

/**
 * What the app actually does, one claim per block.
 *
 * Every entry here describes a feature that exists in the shipped app. That is
 * the rule: a showcase is a set of promises, and a promise about software is
 * only worth making about software that runs. `beeld` names a screenshot of
 * the real thing -- never an illustration of it, because a drawing of a feature
 * is a claim you cannot check.
 */
const KENMERKEN = [
  {
    id: "select",
    label: "Champion select",
    titel: "Your masteries, set before the timer runs out",
    tekst:
      "Tick one box and the app keeps your mastery page matched to whatever you picked, " +
      "including when you change your mind halfway. Underneath it: what wins on your champion " +
      "in your lane, who you are up against, and which counters actually beat them.",
    beeld: "img/app/champion-select.png",
  },
  {
    id: "overlay",
    label: "In-game overlay",
    titel: "Objective timers, on top of the game",
    tekst:
      "A dragon falling puts a banner on all ten screens, so counting forward from it is " +
      "arithmetic, not information you were not given. The panel carries that, the gold " +
      "difference in items on the field, your skill order so far, and a nudge when your " +
      "trinket slot is sitting empty.",
    beeld: "img/app/overlay.png",
  },
  {
    id: "builds",
    label: "Builds",
    titel: "What people build, not what somebody thinks they should",
    tekst:
      "Items, boots and summoner spells ranked by what actually won, per lane, with the " +
      "number of games behind every row. No editor's picks and no theory -- if a build is " +
      "listed it is because people played it and it worked.",
    beeld: "img/app/builds.png",
  },
  {
    id: "matchups",
    label: "Matchups",
    titel: "Counters that hold up per lane",
    tekst:
      "A matchup pooled across every lane tells you a bot-lane marksman beats a mid-lane mage, " +
      "which is true and useless. Ours are computed per lane and filtered by how often that " +
      "pairing actually happens, so a counter is a counter where you will meet it.",
    beeld: "img/app/matchups.png",
  },
  {
    id: "sample",
    label: "Every number",
    titel: "Sample size attached, always",
    tekst:
      "A 62% win rate over nine games is noise wearing a percentage. Every figure on the site " +
      "and in the app carries the count it came from, and anything too thin to mean something " +
      "says so instead of showing a number.",
    beeld: "img/app/sample.png",
  },
  {
    id: "lokaal",
    label: "Local first",
    titel: "No account, no telemetry, open source",
    tekst:
      "It reads your own client on your own machine and keeps its database in a file you can " +
      "open. Sharing your games is a switch you turn on, not a condition of using it. The whole " +
      "thing is MIT-licensed and the source is public.",
    beeld: "img/app/privacy.png",
  },
];

/** One showcase block, image left or right depending on its position. */
function kenmerkBlok(k, i) {
  const heeftBeeld = existsSync(join(HERE, k.beeld));
  return `<article class="kenmerk${i % 2 ? " gedraaid" : ""} rise" id="${k.id}">
    <div class="kenmerk-beeld">
      ${heeftBeeld ? `<img src="${k.beeld}" alt="${esc(k.titel)}" loading="lazy" />` : `<span class="kenmerk-wacht">${esc(k.label)}</span>`}
    </div>
    <div class="kenmerk-tekst">
      <p class="kenmerk-label">${esc(k.label)}</p>
      <h3>${esc(k.titel)}</h3>
      <p>${k.tekst}</p>
    </div>
  </article>`;
}

/**
 * The games AllMid covers.
 *
 * An array rather than markup because the second entry is the whole point: the
 * plan is more games, and adding one should be a line here rather than a
 * rewrite of every header on the site. Nothing is listed before it is real --
 * a row of greyed-out logos for games we have not started is a promise, and
 * this site does not make those.
 */
const SPELLEN = [{ slug: "lol", naam: "League of Legends", live: true }];

/**
 * The header: which game, then where in it.
 *
 * Two rows on purpose. The top one answers "which game am I looking at", which
 * only matters once there is more than one; the bottom one is the actual
 * navigation. Keeping them apart means adding a game later does not push the
 * sections around.
 *
 * `hier` marks the current section so the nav can say where you are. `op`
 * prefixes every link, so a page one directory down passes "../".
 */
function toolbalk(hier = "home", op = "") {
  const spellen = SPELLEN.map(
    (g) =>
      `<span class="spel${g.live ? " aan" : ""}">${esc(g.naam)}</span>`,
  ).join("");

  const secties = [
    { id: "home", naam: "Home", href: `${op}index.html` },
    { id: "champions", naam: "Champions", href: `${op}champions.html` },
    { id: "tiers", naam: "Tier list", href: `${op}tiers.html` },
    { id: "classic", naam: "Classic", href: `${op}classic.html`, merk: "data" },
    { id: "app", naam: "The app", href: `${op}app.html` },
    { id: "overlay", naam: "Overlay", href: `${op}overlay.html` },
  ]
    .map(
      (x) =>
        `<a href="${x.href}"${x.id === hier ? ' aria-current="page"' : ""}>${esc(x.naam)}` +
        `${x.merk ? `<span class="nav-merk">${esc(x.merk)}</span>` : ""}</a>`,
    )
    .join("");

  return `<header id="top-bar">
  <div class="balk-spellen">
    <div class="wrap">
      <a class="brand" href="${op}index.html">
        <svg class="mark" viewBox="0 0 120 118" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="mk-arm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a683a"/><stop offset="1" stop-color="#b89a4d"/></linearGradient><linearGradient id="mk-spike" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8a94f"/><stop offset="1" stop-color="#f4e6ba"/></linearGradient><filter id="mk-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7"/></filter></defs><circle cx="60" cy="60" r="22" fill="#e7c76e" opacity="0.18" filter="url(#mk-glow)"/><path d="M14 102 L33 20 L60 60 L87 20 L106 102" stroke="url(#mk-arm)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><path d="M60 60 L60 106" stroke="url(#mk-spike)" stroke-width="10" stroke-linecap="round"/><circle cx="60" cy="106" r="6.5" fill="#f7edc9"/></svg><span class="brand-name">All<em>Mid</em></span>
      </a>
      <div class="spellen">${spellen}</div>
      <a class="balk-bron" href="https://github.com/allmidgg/desktop">Open source</a>
    </div>
  </div>
  <div class="balk-nav">
    <div class="wrap">
      <nav class="secties">${secties}</nav>
      <form class="kopzoek" role="search" data-op="${op}">
        <input type="search" id="kopzoek-veld" placeholder="Search champions" autocomplete="off" aria-label="Search champions" />
        <div class="kopzoek-uit" id="kopzoek-uit" hidden></div>
      </form>
      <a class="btn btn-primary btn-sm" href="https://github.com/allmidgg/desktop/releases/latest/download/AllMid-Setup.exe">Download</a>
    </div>
  </div>
</header>`;
}

/**
 * The index the header search reads.
 *
 * Emitted once per page as JSON rather than fetched, because the whole site is
 * static files -- a fetch would need a server the site does not have.
 */
function zoekIndex() {
  const rijen = catalogus.champions.map((c) => [c.name, slugVan(c.name)]);
  return `<script id="zoek-data" type="application/json">${JSON.stringify(rijen)}</script>`;
}

/** Wires the header search up. Shared by every page that has a header. */
const ZOEK_SCRIPT = `<script>
(function () {
  var veld = document.getElementById("kopzoek-veld");
  var uit = document.getElementById("kopzoek-uit");
  var data = document.getElementById("zoek-data");
  if (!veld || !uit || !data) return;
  var rijen = JSON.parse(data.textContent);
  var op = veld.closest("[data-op]").dataset.op || "";

  function toon() {
    var q = veld.value.trim().toLowerCase();
    if (!q) { uit.hidden = true; uit.innerHTML = ""; return; }
    // Names that start with the query first: typing "ka" should offer Kayle
    // before Blitzcrank, even though both contain it.
    var treffers = rijen
      .filter(function (r) { return r[0].toLowerCase().indexOf(q) !== -1; })
      .sort(function (a, b) {
        var av = a[0].toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var bv = b[0].toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return av - bv || a[0].localeCompare(b[0]);
      })
      .slice(0, 8);
    if (!treffers.length) { uit.hidden = true; uit.innerHTML = ""; return; }
    uit.innerHTML = treffers
      .map(function (r) { return '<a href="' + op + 'champion/' + r[1] + '.html">' + r[0] + "</a>"; })
      .join("");
    uit.hidden = false;
  }

  veld.addEventListener("input", toon);
  veld.addEventListener("focus", toon);
  // A click inside the results must not close them before it lands.
  document.addEventListener("mousedown", function (e) {
    if (!uit.contains(e.target) && e.target !== veld) { uit.hidden = true; }
  });
  veld.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { uit.hidden = true; veld.blur(); }
    if (e.key === "Enter") {
      var eerste = uit.querySelector("a");
      if (eerste && !uit.hidden) { e.preventDefault(); window.location.href = eerste.href; }
    }
  });
})();
</script>`;

function championsPagina() {
  // Riot's tag vocabulary, in the order players think about roles rather than
  // the order Data Dragon happens to emit them.
  const ROLLEN = ["Fighter", "Tank", "Mage", "Assassin", "Marksman", "Support"];

  const metData = new Map(
    Object.values(champions.champions ?? {}).map((c) => [c.baseId, c]),
  );

  const kaarten = catalogus.champions
    .map((c) => {
      const stat = metData.get(c.id);
      const slug = slugVan(c.name);
      const cijfer = stat
        ? `<span class="ck-wr ${stat.winrate >= 50 ? "goed" : "slecht"}">${stat.winrate.toFixed(1)}%</span>
           <span class="ck-games">${n(stat.totalGames)} games</span>`
        : `<span class="ck-leeg">not in Classic</span>`;
      // Classic champions have a portrait from the client; the rest come from
      // Data Dragon. Same size, different source.
      const portret = stat ? iconOf(c.id) : `img/lol-champions/${c.alias.toLowerCase()}.png`;
      return `<a class="champkaart${stat ? " heeft-data" : ""}" href="champion/${slug}.html"
         data-naam="${esc(c.name.toLowerCase())}" data-rollen="${esc(c.tags.join(" "))}" data-data="${stat ? "1" : "0"}">
        <img src="${portret}" alt="" width="64" height="64" loading="lazy" />
        <span class="ck-naam">${esc(c.name)}</span>
        <span class="ck-cijfer">${cijfer}</span>
      </a>`;
    })
    .join("");

  const filters = ROLLEN.map(
    (r) => `<button type="button" data-rol="${r}">${r}</button>`,
  ).join("");

  const titel = "All League of Legends champions";
  const omschrijving =
    `All ${catalogus.champions.length} League of Legends champions, searchable. ` +
    `${Object.keys(roster).length} of them have Classic win rates from ${n(T.games)} recorded games.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Champions &middot; AllMid</title>
<meta name="description" content="${esc(omschrijving)}" />
<link rel="canonical" href="https://allmid.gg/champions.html" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(titel)} &middot; AllMid" />
<meta property="og:description" content="${esc(omschrijving)}" />
<meta name="theme-color" content="#06080c" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" />
<link rel="stylesheet" href="${CSS_PAD}" />
</head>
<body>

${toolbalk("champions")}

<main class="wrap champpagina">
  <div class="cp-kop">
    <h1>Champions</h1>
    <p>
      All ${catalogus.champions.length} champions in League of Legends.
      <strong>${Object.keys(roster).length}</strong> of them carry Classic win rates from
      ${n(T.games)} recorded games; the rest were not in the game in Season&nbsp;3, so there is
      nothing honest to put next to their name yet.
    </p>
  </div>

  <div class="cp-balk">
    <input type="search" id="cp-zoek" placeholder="Search champions" autocomplete="off" aria-label="Search champions" />
    <div class="cp-filters" id="cp-filters">
      <button type="button" data-rol="" class="aan">All</button>
      ${filters}
      <button type="button" data-only="1">Classic only</button>
    </div>
  </div>

  <p class="cp-telling" id="cp-telling" aria-live="polite"></p>
  <div class="champgrid" id="champgrid">${kaarten}</div>
  <p class="cp-niks" id="cp-niks" hidden>No champion by that name.</p>
</main>

<footer>
  <div class="wrap">
    <p class="legal">
      AllMid is an independent, open-source project released under the MIT licence. It is not endorsed by
      Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in
      producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered
      trademarks of Riot Games, Inc.
    </p>
    <nav>
      <a href="index.html">Home</a>
      <a href="https://github.com/allmidgg/desktop">GitHub</a>
    </nav>
  </div>
</footer>

<script>
(function () {
  var zoek = document.getElementById("cp-zoek");
  var grid = document.getElementById("champgrid");
  var filters = document.getElementById("cp-filters");
  var telling = document.getElementById("cp-telling");
  var niks = document.getElementById("cp-niks");
  if (!grid) return;
  var kaarten = [].slice.call(grid.children);
  var rol = "";
  var alleenData = false;

  function pas() {
    var q = (zoek.value || "").trim().toLowerCase();
    var zichtbaar = 0;
    kaarten.forEach(function (k) {
      var naamOk = !q || k.dataset.naam.indexOf(q) !== -1;
      var rolOk = !rol || k.dataset.rollen.split(" ").indexOf(rol) !== -1;
      var dataOk = !alleenData || k.dataset.data === "1";
      var toon = naamOk && rolOk && dataOk;
      k.hidden = !toon;
      if (toon) zichtbaar++;
    });
    telling.textContent = zichtbaar + " of " + kaarten.length + " champions";
    niks.hidden = zichtbaar !== 0;
  }

  zoek.addEventListener("input", pas);
  filters.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.only) {
      alleenData = !alleenData;
      b.classList.toggle("aan", alleenData);
    } else {
      rol = b.dataset.rol;
      [].forEach.call(filters.querySelectorAll("button[data-rol]"), function (x) {
        x.classList.toggle("aan", x === b);
      });
    }
    pas();
  });
  pas();
})();
</script>
${zoekIndex()}
${ZOEK_SCRIPT}
</body>
</html>`;
}

function catalogusPagina(c) {
  const slug = slugVan(c.name);
  const G = (pad) => `../${pad}`;
  const st = c.stats ?? {};
  const groei = (basis, per) =>
    basis === null || basis === undefined
      ? "&mdash;"
      : `${Math.round(basis)}${per ? ` <span class="cat-groei">+${per}/lvl</span>` : ""}`;

  const titel = `${c.name} &mdash; League of Legends champion`;
  const omschrijving =
    `${c.name}, ${c.title}. ${c.tags.join(" / ")}${c.resource ? `, ${c.resource}` : ""}. ` +
    `Base stats and where AllMid's data stands on this champion.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(c.name)} &middot; AllMid</title>
<meta name="description" content="${esc(omschrijving)}" />
<link rel="canonical" href="https://allmid.gg/champion/${slug}.html" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${titel}" />
<meta property="og:description" content="${esc(omschrijving)}" />
<meta name="theme-color" content="#06080c" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" />
<link rel="stylesheet" href="${G(CSS_PAD)}" />
</head>
<body>

${toolbalk("champions", "../")}

<main class="wrap guide">
  <div class="cat-kop">
    <img src="${G(`img/lol-champions/${c.alias.toLowerCase()}.png`)}" alt="" width="120" height="120" />
    <div>
      <h1>${esc(c.name)}</h1>
      <p class="cat-titel">${esc(c.title)}</p>
      <p class="cat-tags">
        ${c.tags.map((t) => `<span>${esc(t)}</span>`).join("")}
        ${c.resource ? `<span>${esc(c.resource)}</span>` : ""}
        ${c.difficulty !== null ? `<span>Riot difficulty ${c.difficulty}/10</span>` : ""}
      </p>
    </div>
  </div>

  ${existsSync(join(HERE, "img/leeg.png")) ? `<img class="leeg-beeld" src="${G("img/leeg.png")}" alt="" width="900" height="600" loading="lazy" />` : ""}
  <section class="guide-blok">
    <h2>No win rate here yet, and that is the honest answer</h2>
    <p>
      Every number on AllMid comes from games we recorded ourselves. Our data covers
      <strong>League Classic</strong>, the Season&nbsp;3 remake &mdash; and ${esc(c.name)} was not in
      the game in Season&nbsp;3, so there is no Classic match that could carry a statistic about
      this champion. That is a fact about the mode, not a gap we are hiding.
    </p>
    <p>
      Standard League queues are next. When there is a real sample behind ${esc(c.name)}, the
      builds, counters and lane numbers land on this page &mdash; with the sample size attached,
      the same as everywhere else here. Until then this page carries only what Riot publishes.
    </p>
  </section>

  <section class="guide-blok">
    <h2>Base stats</h2>
    <p>Riot&rsquo;s own published values, patch ${esc(catalogus.version ?? "&mdash;")}. Level 1, before items.</p>
    <div class="cat-stats">
      <div><span>Health</span><b>${groei(st.hp, st.hpPerLevel)}</b></div>
      <div><span>Attack damage</span><b>${groei(st.ad, st.adPerLevel)}</b></div>
      <div><span>Armor</span><b>${groei(st.armor, st.armorPerLevel)}</b></div>
      <div><span>Magic resist</span><b>${groei(st.mr, st.mrPerLevel)}</b></div>
      <div><span>Move speed</span><b>${st.moveSpeed ?? "&mdash;"}</b></div>
      <div><span>Attack range</span><b>${st.range ?? "&mdash;"}</b></div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <p class="legal">
      AllMid is an independent, open-source project released under the MIT licence. It is not endorsed by
      Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in
      producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered
      trademarks of Riot Games, Inc.
    </p>
    <p class="legal">Questions, corrections or takedown requests: <a href="mailto:contact@allmid.gg">contact@allmid.gg</a>.</p>
    <nav>
      <a href="${G("index.html")}">Home</a>
      <a href="https://github.com/allmidgg/desktop">GitHub</a>
    </nav>
  </div>
</footer>
${zoekIndex()}
${ZOEK_SCRIPT}
</body>
</html>`;
}

function guidePagina(c) {
  const build = builds.champions?.[String(c.baseId)];
  const buildPerLane = new Map((build?.lanes ?? []).map((l) => [l.lane, l]));
  const rijen = laneLijst(c).filter((l) => l.games > 0);
  const open = openLane(c) ?? rijen[0]?.lane;
  const vaakst = vaakstGespeeld(c);

  const knoppen = rijen
    .map(
      (l) => `
          <button type="button" data-lane="${l.lane}" aria-selected="${l.lane === open}"${l.qualified ? "" : " disabled"}>
            ${esc(LANES.find((x) => x.key === l.lane)?.label ?? l.lane)}
            <span>${n(l.games)}</span>
          </button>`,
    )
    .join("");

  const secties = rijen
    .map((l) => guideLane(l, buildPerLane.get(l.lane), builds.laneGemiddelden?.[l.lane], l.lane === open))
    .join("");

  const titel = `${c.name} Classic build, counters and lane stats`;
  const omschrijving =
    `${c.name} in League of Legends Classic: ${n(c.totalGames)} games, ` +
    `${pct(c.winrate)}% win rate, most played ${(LANES.find((x) => x.key === vaakst)?.label ?? "").toLowerCase()}. ` +
    `Items, boots, summoner spells and lane matchups from real Classic games.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(titel)} &middot; AllMid</title>
<meta name="description" content="${esc(omschrijving)}" />
<link rel="canonical" href="https://allmid.gg/champion/${slugVan(c.name)}.html" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(titel)}" />
<meta property="og:description" content="${esc(omschrijving)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" />
<link rel="stylesheet" href="${G(CSS_PAD)}" />
</head>
<body>

${toolbalk("champions", G(""))}

<main class="wrap guide">
  <div class="guide-held">
    <img class="guide-splash" src="${G(splashOf(c.baseId))}" alt="" width="640" height="360" />
    <div class="guide-held-tekst">
      <img src="${G(iconOf(c.baseId))}" alt="" width="128" height="128" />
      <div>
        <h1>${esc(c.name)}</h1>
        <p class="mono">${n(c.totalGames)} games &middot; ${pct(c.winrate)}% overall &middot;
          most played ${esc(LANES.find((x) => x.key === vaakst)?.label ?? "&mdash;")}</p>
      </div>
    </div>
  </div>

  <div class="build-lanes guide-lanes" id="guide-lanes" role="tablist" aria-label="Lane">${knoppen}</div>

  ${secties}

  <section class="guide-blok">
    <h2>Masteries and runes</h2>
    <p>
      Not here yet, and it would be dishonest to pretend otherwise. Classic uses the old
      systems &mdash; three mastery trees with 30 points, and rune pages with marks, seals,
      glyphs and quintessences &mdash; but a finished match carries no record of them. The match
      history AllMid reads gives champions, items, summoner spells, kills, deaths, assists, CS
      and gold, and nothing about how anyone was set up before the game started.
    </p>
    <p>
      There is one route left: reading the other nine players during a live game. That is a
      different piece of software than the one that produced this page, and it would only ever
      see games you play yourself. If it gets built, this section is where it lands.
    </p>
  </section>

  <section class="guide-blok">
    <h2>How to read this</h2>
    <p>
      Win rates are smoothed towards 50% with a 20-game prior, so a champion with 40 games in a
      lane cannot outrank one with 8,000 on a lucky streak. The raw figure and the sample size
      are both shown so you can judge for yourself.
    </p>
    <p>
      Items are what was <strong>still in the inventory when the game ended</strong>, not a build
      order. Classic match history has no timeline, so there is no honest way to say what anyone
      bought first, and a starting item that got sold does not appear at all. &ldquo;Most held
      together&rdquo; is the three-item combination that ended up in the inventory most often, not
      a sequence.
    </p>
    <p>
      Matchups are the champion standing opposite you in the same lane, and only opponents who
      hold at least 1% of that lane &mdash; picks you actually run into. Every number on this page
      comes from ${n(T.games)} Classic games collected from players who chose to share them.
    </p>
  </section>
</main>

<footer>
  <div class="wrap">
    <p class="legal">
      AllMid is an independent, open-source project released under the MIT licence. It is not endorsed by
      Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in
      producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered
      trademarks of Riot Games, Inc.
    </p>
    <p class="legal">Questions, corrections or takedown requests: <a href="mailto:contact@allmid.gg">contact@allmid.gg</a>.</p>
    <nav>
      <a href="${G("index.html")}">Home</a>
      <a href="https://github.com/allmidgg/desktop">GitHub</a>
    </nav>
  </div>
</footer>

<script>
// Zonder script staan alle lanes onder elkaar: dat is minder prettig maar wel
// compleet. Het script verbergt de rest pas als het echt kan wisselen.
(function () {
  var strip = document.getElementById("guide-lanes");
  var secties = [].slice.call(document.querySelectorAll(".guide-lane"));
  if (!strip || secties.length < 2) return;
  function toon(lane) {
    secties.forEach(function (s) { s.hidden = s.dataset.lane !== lane; });
    [].forEach.call(strip.querySelectorAll("button"), function (b) {
      b.setAttribute("aria-selected", String(b.dataset.lane === lane));
    });
  }
  strip.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-lane]");
    if (b && !b.disabled) toon(b.dataset.lane);
  });
  var open = strip.querySelector('button[aria-selected="true"]');
  toon(open ? open.dataset.lane : secties[0].dataset.lane);
})();
</script>
${zoekIndex()}
${ZOEK_SCRIPT}
</body>
</html>
`;
}

/**
 * De opmaak staat apart, niet in de pagina.
 *
 * Zolang er een pagina was maakte dat niet uit. Nu er per champion een
 * guidepagina bij komt zou elk van die 63 bestanden dezelfde 30 KB opnieuw
 * meedragen, en zou een kleurwijziging op 64 plekken opnieuw uitgeschreven
 * worden. Een los bestand wordt na de eerste pagina uit de cache gehaald.
 */
const css = `/* ───────────────────────────────────────────────────────────────────────────
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
/* Het merk is de naam. De M waarvan de middenstok naar beneden duikt naar een
   oplichtend punt: alles komt samen in mid. Eén schone vorm, scherp van
   favicon tot billboard, want het is vector en geen bestand. */
.brand .mark { width: 24px; height: 24px; flex: none; display: block; }
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
  position: relative;
  border: 1px solid var(--line-lit);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  background: var(--surface);
}

/* De bovenrand verdween steeds na een seconde.
   Gemeten: het paneel staat op .375 van een schermpixel. Een rand van 1px wordt
   dan over twee pixelrijen verdeeld, elk voor een deel, en var(--line-lit) op 37%
   over bijna-zwart is niets. Dat hij er eerst even wel is komt door de reveal:
   zolang die animeert heeft het paneel een eigen composietlaag en wordt de rand
   op hele pixels gerasterd. Zodra de animatie klaar is vervalt die laag.

   Twee eerdere pogingen werkten daarom niet. Een tweede lijn van 1px eronder valt
   op precies dezelfde gebroken positie en verdwijnt mee; feller maken schuift het
   probleem alleen op. De laag vasthouden met translateZ(0) zou het wel oplossen,
   maar dan wordt het hele paneel geresampled en gaat de tekst eronder wazig
   staan -- een erger probleem dan het probleem.

   Twee pixels hoog kan niet wegvallen: waar de breuk ook ligt, er is altijd één
   volledig gedekte pixelrij. Als verloop leest het als een oplichtende bovenrand
   in plaats van een dikke streep. */
.champpaneel::before {
  content: "";
  position: absolute; inset: 0 0 auto 0; height: 2px; z-index: 2;
  background: linear-gradient(180deg, rgba(241, 228, 198, 0.17), rgba(241, 228, 198, 0));
  pointer-events: none;
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
.mu-kop { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem 0.8rem; }
.mu-kop .block-label { margin: 0; }
.mu-schakel { margin-left: 0; }
.mu-schakel button { padding: 0.26rem 0.5rem; font-size: 0.62rem; }
.mu-note { margin: 0; font-size: 0.7rem; line-height: 1.45; color: var(--dim); }

/* border-collapse zodat de rand om de meest gespeelde lane een rechthoek is en
   geen losse stukjes per cel. De binnenmarge staat op alle regels, ook zonder
   rand, anders zou de gemarkeerde regel een halve letter verspringen. */
.lane-table { border-collapse: collapse; width: calc(100% + 0.9rem); margin-inline: -0.45rem; }
.lane-table th, .lane-table td { padding: 0.32rem 0; font-size: 0.83rem; }
.lane-table th:first-child, .lane-table td:first-child { padding-left: 0.45rem; }
.lane-table th:last-child, .lane-table td:last-child { padding-right: 0.45rem; }

/* De lane-namen zijn knoppen: hij kiest waar de matchups en de build over gaan. */
.lane-knop {
  font: inherit; color: inherit; background: none; border: 0; padding: 0;
  font-weight: 600; cursor: pointer;
}
.lane-knop:hover { color: var(--gold-lit); }
.lane-knop:focus-visible { outline: 2px solid var(--gold-dim); outline-offset: 2px; border-radius: 3px; }
.lane-knop.is-stil { cursor: default; color: var(--dim); font-weight: 500; }

.lane-tag {
  font-family: var(--mono); font-size: 0.52rem; letter-spacing: 0.09em;
  text-transform: uppercase; color: var(--gold-dim); white-space: nowrap;
}

/* De lane waar deze champion het vaakst staat. Bij Soraka is dat support met
   9.880 van haar 15.747 games; de andere vier lanes samen halen dat niet. */
.lane-table tr.is-vaakst > * { border-block: 1px solid rgba(231, 199, 110, 0.32); }
.lane-table tr.is-vaakst > :first-child { border-left: 1px solid rgba(231, 199, 110, 0.32); }
.lane-table tr.is-vaakst > :last-child { border-right: 1px solid rgba(231, 199, 110, 0.32); }

/* De lane die nu gekozen is. Bij het openen is dat dezelfde regel. */
.lane-table tbody tr[aria-selected="true"] > * { background: rgba(231, 199, 110, 0.07); }
.lane-table tbody tr:not([aria-selected="true"]) .lane-knop:not(.is-stil) { color: var(--muted); }
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
/* ── Guidepagina per champion ─────────────────────────────────────────── */

.guide { padding-block: clamp(1.5rem, 3vw, 2.5rem) clamp(3rem, 6vw, 5rem); display: grid; gap: 1.6rem; }

.guide-held {
  position: relative; overflow: hidden;
  border: 1px solid var(--line-lit); border-radius: var(--radius);
  box-shadow: var(--shadow); background: var(--raised);
  min-height: 200px; display: flex; align-items: flex-end;
}
.guide-splash {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  object-position: 50% 28%; filter: saturate(1.06) brightness(1.05);
}
.guide-held-tekst {
  position: relative; z-index: 1; width: 100%;
  display: flex; align-items: center; gap: 0.9rem; padding: 1.2rem;
  background: linear-gradient(180deg, transparent, rgba(6, 8, 12, 0.94) 58%);
}
.guide-held-tekst > img { width: 62px; height: 62px; border-radius: 7px; border: 1px solid var(--line-lit); flex: none; }
.guide-held-tekst h1 { font-size: clamp(1.7rem, 3.4vw, 2.5rem); margin: 0 0 0.15rem; }
.guide-held-tekst p { margin: 0; font-size: 0.78rem; color: var(--muted); }

.guide-link { margin-left: auto; flex: none; align-self: center; }
@media (max-width: 520px) { .guide-link { display: none; } }

.guide-lanes { margin-left: 0; gap: 0.4rem; }
.guide-lanes button[disabled] { opacity: 0.42; cursor: default; }

.guide-lane {
  border: 1px solid var(--line-lit); border-radius: var(--radius);
  background: var(--surface); box-shadow: var(--shadow);
  padding: clamp(1.1rem, 2.4vw, 1.6rem);
  display: grid; gap: 1.3rem;
}
.guide-lane[hidden] { display: none; }
.guide-lane-kop { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem 1rem; }
.guide-lane-kop h2 { margin: 0; font-size: 1.3rem; }
.guide-lane-kop p { margin: 0; font-size: 0.76rem; color: var(--muted); }

/* De cijferstrook. Elk getal krijgt het lane-gemiddelde eronder, want los zegt
   "206 CS" niets -- pas naast de 179 van de gemiddelde toplaner wordt het iets. */
.cijfers {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 1px; background: var(--line);
  border: 1px solid var(--line); border-radius: var(--radius-s); overflow: hidden;
}
.cijfer { background: var(--raised); padding: 0.7rem 0.8rem; display: grid; gap: 0.12rem; }
.cijfer-label {
  font-family: var(--mono); font-size: 0.58rem; letter-spacing: 0.11em;
  text-transform: uppercase; color: var(--dim);
}
.cijfer-waarde { font-family: var(--mono); font-size: 1.12rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.cijfer-ijk { font-family: var(--mono); font-size: 0.62rem; color: var(--dim); font-variant-numeric: tabular-nums; }
.tov-hoog { color: var(--wr-hi); }
.tov-laag { color: var(--wr-lo); }
.tov-gelijk { color: var(--dim); }

.guide-kolommen {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(1.2rem, 2.6vw, 2rem);
}
@media (max-width: 1040px) { .guide-kolommen { grid-template-columns: 1fr 1fr; } }
@media (max-width: 720px) { .guide-kolommen { grid-template-columns: 1fr; } }
.guide-kolommen .block-label:not(:first-child) { margin-top: 1.4rem; }

/* Drie items die samen in de tas zaten. Geen volgorde -- zie de uitleg onderaan
   de pagina -- dus ze staan naast elkaar en niet met pijlen ertussen. */
.corelijst { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.corelijst li {
  display: grid; grid-template-columns: auto auto auto 1fr;
  align-items: center; gap: 0.6rem;
  background: var(--raised); border: 1px solid var(--line);
  border-radius: var(--radius-s); padding: 0.5rem 0.6rem;
}
.core-items { display: flex; gap: 0.25rem; }
.core-items img { width: 30px; height: 30px; border-radius: 4px; border: 1px solid var(--line-lit); }
.corelijst .m-games { text-align: right; }

.guide-blok {
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--surface); padding: clamp(1.1rem, 2.4vw, 1.6rem);
}
.guide-blok h2 { margin: 0 0 0.7rem; font-size: 1.1rem; }
.guide-blok p { margin: 0 0 0.8rem; font-size: 0.86rem; color: var(--muted); max-width: 74ch; }
.guide-blok p:last-child { margin-bottom: 0; }
.guide-blok strong { color: var(--ink); font-weight: 600; }

/* Modusbalk: welke wachtrijen we dekken, en welke nog niet. */
.modusbalk { border-block: 1px solid var(--line); background: rgba(255, 255, 255, 0.012); }
.modusbalk .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; padding-block: 0.7rem; }
.modusbalk .mb-label {
  flex: none; margin-right: 0.5rem;
  font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--dim);
}
.modus {
  display: inline-flex; align-items: baseline; gap: 0.45rem;
  padding: 0.34rem 0.72rem; border-radius: 5px;
  border: 1px solid var(--line); color: var(--dim);
  font-size: 0.84rem; font-weight: 600; text-decoration: none;
}
.modus .mb-n { font-family: var(--mono); font-size: 0.68rem; font-weight: 500; opacity: 0.75; }
.modus.live { color: var(--ink); border-color: var(--gold-dim); background: rgba(231, 199, 110, 0.08); }
.modus.live .mb-n { color: var(--gold); opacity: 1; }
.modus.soon { opacity: 0.62; }
.modusbalk .mb-note { flex-basis: 100%; margin: 0.25rem 0 0; font-size: 0.76rem; color: var(--dim); }

/* Championpagina zonder cijfers: alleen wat Riot zelf publiceert. */
.cat-kop { display: flex; align-items: center; gap: 1.15rem; margin: 0 0 1.6rem; }
.cat-kop img { border-radius: 10px; border: 1px solid var(--line); flex: none; }
.cat-kop h1 { margin: 0; font-size: clamp(1.8rem, 4vw, 2.6rem); }
.cat-titel { margin: 0.15rem 0 0.6rem; color: var(--muted); font-size: 0.95rem; }
.cat-tags { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0; }
.cat-tags span {
  font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.08em;
  padding: 0.24rem 0.5rem; border-radius: 4px;
  border: 1px solid var(--line); color: var(--dim);
}
.cat-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.6rem; }
.cat-stats div {
  display: flex; flex-direction: column; gap: 0.2rem;
  padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 6px;
}
.cat-stats span {
  font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--dim);
}
.cat-stats b { font-size: 1.05rem; font-weight: 600; }
.cat-groei { font-family: var(--mono); font-size: 0.66rem; color: var(--dim); letter-spacing: 0; text-transform: none; }

/* ── Championsoverzicht ────────────────────────────────────────────────── */
.champpagina { padding-block: clamp(2rem, 4vw, 3.2rem) 4rem; }
.cp-kop h1 { margin: 0 0 0.5rem; font-size: clamp(2rem, 4.5vw, 3rem); }
.cp-kop p { margin: 0 0 1.8rem; color: var(--muted); max-width: 62ch; font-size: 0.95rem; }
.cp-kop strong { color: var(--ink); font-weight: 600; }

.cp-balk { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin: 0 0 1rem; }
#cp-zoek {
  flex: 1 1 240px; min-width: 0;
  padding: 0.6rem 0.85rem; border-radius: 7px;
  border: 1px solid var(--line); background: rgba(255, 255, 255, 0.03);
  color: var(--ink); font: inherit; font-size: 0.92rem;
}
#cp-zoek::placeholder { color: var(--dim); }
#cp-zoek:focus-visible { outline: 2px solid var(--gold-dim); outline-offset: 1px; border-color: var(--gold-dim); }

.cp-filters { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.cp-filters button {
  font: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;
  padding: 0.42rem 0.72rem; border-radius: 6px;
  border: 1px solid var(--line); background: transparent; color: var(--dim);
  transition: color 0.15s, border-color 0.15s, background-color 0.15s;
}
.cp-filters button:hover { color: var(--ink); border-color: var(--line-lit, var(--gold-dim)); }
.cp-filters button.aan { color: var(--ink); border-color: var(--gold-dim); background: rgba(231, 199, 110, 0.1); }

.cp-telling { font-family: var(--mono); font-size: 0.72rem; color: var(--dim); margin: 0 0 1rem; }
.cp-niks { color: var(--muted); font-size: 0.9rem; }

.champgrid {
  display: grid; gap: 0.6rem;
  grid-template-columns: repeat(auto-fill, minmax(126px, 1fr));
}
.champkaart {
  display: flex; flex-direction: column; align-items: center; gap: 0.3rem;
  padding: 0.8rem 0.5rem 0.7rem; border-radius: 9px; text-decoration: none;
  border: 1px solid var(--line); background: rgba(255, 255, 255, 0.015);
  transition: border-color 0.15s, background-color 0.15s, transform 0.15s;
}
.champkaart:hover { border-color: var(--gold-dim); background: rgba(231, 199, 110, 0.06); transform: translateY(-2px); }
/* display:flex hierboven wint van de standaard die [hidden] meebrengt, dus
   moet het filteren dit expliciet zeggen -- anders telt de teller wel af maar
   blijft alles staan. */
.champkaart[hidden] { display: none; }
.champkaart img { border-radius: 8px; border: 1px solid var(--line); }
/* Champions without a recorded game read as secondary rather than broken. */
.champkaart:not(.heeft-data) img { filter: saturate(0.45); opacity: 0.72; }
.champkaart:not(.heeft-data):hover img { filter: none; opacity: 1; }
.ck-naam { font-size: 0.83rem; font-weight: 600; color: var(--ink); text-align: center; line-height: 1.2; }
.ck-cijfer { display: flex; flex-direction: column; align-items: center; gap: 0.05rem; }
.ck-wr { font-family: var(--mono); font-size: 0.86rem; font-weight: 700; }
.ck-wr.goed { color: var(--wr-good, #6fcf97); }
.ck-wr.slecht { color: var(--wr-bad); }
.ck-games { font-family: var(--mono); font-size: 0.62rem; color: var(--dim); }
.ck-leeg { font-family: var(--mono); font-size: 0.62rem; color: var(--dim); }

/* ── Toolbalk: welk spel, dan waar in dat spel ─────────────────────────── */
#top-bar { position: sticky; top: 0; z-index: 60; backdrop-filter: blur(14px); }
.balk-spellen {
  background: rgba(4, 6, 10, 0.92);
  border-bottom: 1px solid var(--line);
}
.balk-spellen .wrap { display: flex; align-items: center; gap: 1.5rem; padding-block: 0.5rem; }
.balk-spellen .brand { margin-right: 0.25rem; }
.spellen { display: flex; gap: 0.3rem; flex: 1; }
.spel {
  font-size: 0.82rem; font-weight: 600; color: var(--dim);
  padding: 0.34rem 0.7rem; border-radius: 6px; border: 1px solid transparent;
}
.spel.aan {
  color: var(--ink); border-color: var(--gold-dim);
  background: rgba(231, 199, 110, 0.08);
}
.balk-bron {
  font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--dim); text-decoration: none; flex: none;
}
.balk-bron:hover { color: var(--gold); }

.balk-nav { background: rgba(6, 8, 12, 0.9); border-bottom: 1px solid var(--line); }
.balk-nav .wrap { display: flex; align-items: center; gap: 1rem; padding-block: 0.45rem; }
.secties { display: flex; gap: 0.15rem; flex-wrap: wrap; }
.secties a {
  position: relative; text-decoration: none;
  font-size: 0.86rem; font-weight: 600; color: var(--dim);
  padding: 0.5rem 0.7rem; border-radius: 6px;
  display: inline-flex; align-items: center; gap: 0.35rem;
}
.secties a:hover { color: var(--ink); background: rgba(255, 255, 255, 0.04); }
.secties a[aria-current="page"] { color: var(--gold); }
.secties a[aria-current="page"]::after {
  content: ""; position: absolute; left: 0.7rem; right: 0.7rem; bottom: -0.45rem;
  height: 2px; background: var(--gold); border-radius: 2px;
}
.nav-merk {
  font-family: var(--mono); font-size: 0.54rem; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--gold);
  border: 1px solid var(--gold-dim); border-radius: 3px;
  padding: 0.1rem 0.26rem; line-height: 1;
}

.kopzoek { position: relative; margin-left: auto; flex: 0 1 260px; }
#kopzoek-veld {
  width: 100%; padding: 0.44rem 0.7rem; border-radius: 6px;
  border: 1px solid var(--line); background: rgba(255, 255, 255, 0.04);
  color: var(--ink); font: inherit; font-size: 0.84rem;
}
#kopzoek-veld::placeholder { color: var(--dim); }
#kopzoek-veld:focus-visible { outline: none; border-color: var(--gold-dim); background: rgba(255, 255, 255, 0.07); }
.kopzoek-uit {
  position: absolute; top: calc(100% + 0.35rem); left: 0; right: 0; z-index: 70;
  background: #0a0d14; border: 1px solid var(--line); border-radius: 8px;
  overflow: hidden; box-shadow: 0 18px 40px -18px rgba(0, 0, 0, 0.9);
}
.kopzoek-uit a {
  display: block; padding: 0.5rem 0.7rem; font-size: 0.86rem;
  color: var(--muted); text-decoration: none;
}
.kopzoek-uit a:hover { background: rgba(231, 199, 110, 0.1); color: var(--ink); }

@media (max-width: 900px) {
  .balk-nav .wrap { flex-wrap: wrap; }
  .kopzoek { flex-basis: 100%; margin-left: 0; order: 3; }
}

/* ── Voorpagina: League of Legends ─────────────────────────────────────── */
.lol-held { position: relative; overflow: hidden; padding-block: clamp(3rem, 7vw, 5.5rem); }
.lol-held-dek { position: absolute; inset: 0; opacity: 0.2; pointer-events: none; }
.lol-held-dek::after {
  content: ""; position: absolute; inset: 0;
  background: radial-gradient(120% 90% at 70% 0%, transparent 0%, var(--bg) 72%);
}
.lol-held .wrap {
  position: relative; display: grid; align-items: center;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
  gap: clamp(2rem, 5vw, 4rem);
}
@media (max-width: 1000px) { .lol-held .wrap { grid-template-columns: 1fr; } }
.lol-held h1 { font-size: clamp(2.3rem, 5vw, 3.9rem); margin: 0 0 1.3rem; }
.lol-held h1 em { font-style: normal; color: var(--gold); }
.lol-held .lede { font-size: clamp(1rem, 0.96rem + 0.35vw, 1.14rem); color: var(--muted); max-width: 50ch; margin: 0 0 1.9rem; }
.lol-held-beeld {
  border-radius: 12px; overflow: hidden; border: 1px solid var(--line);
  background: linear-gradient(150deg, rgba(231, 199, 110, 0.07), rgba(255, 255, 255, 0.02));
  box-shadow: 0 32px 70px -34px rgba(0, 0, 0, 0.95);
  min-height: 240px; display: grid; place-items: center;
}
.lol-held-beeld img { display: block; width: 100%; height: auto; }

/* Secties */
.band.alt { background: rgba(255, 255, 255, 0.014); }
.sectiekop { max-width: 62ch; margin: 0 0 2.2rem; }
.sectiekop h2 { margin: 0 0 0.75rem; font-size: clamp(1.6rem, 3vw, 2.3rem); }
.sectielede { margin: 0; color: var(--muted); font-size: 0.97rem; }

/* Kenmerkblokken: beeld en tekst, om en om */
.kenmerken { display: grid; gap: clamp(1.6rem, 3vw, 2.6rem); }
.kenmerk {
  display: grid; align-items: center; gap: clamp(1.2rem, 3vw, 3rem);
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
}
.kenmerk.gedraaid .kenmerk-beeld { order: 2; }
@media (max-width: 860px) {
  .kenmerk, .kenmerk.gedraaid { grid-template-columns: 1fr; }
  .kenmerk.gedraaid .kenmerk-beeld { order: 0; }
}
.kenmerk-beeld {
  border-radius: 11px; overflow: hidden; border: 1px solid var(--line);
  background: linear-gradient(155deg, rgba(231, 199, 110, 0.06), rgba(255, 255, 255, 0.015));
  min-height: 210px; display: grid; place-items: center;
  box-shadow: 0 24px 54px -30px rgba(0, 0, 0, 0.9);
}
.kenmerk-beeld img { display: block; width: 100%; height: auto; }
/* Nog geen screenshot: een net vlak in plaats van een kapot icoontje. */
.kenmerk-wacht {
  font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--dim);
}
.kenmerk-label {
  display: inline-block; margin: 0 0 0.6rem;
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--gold);
  border: 1px solid var(--gold-dim); border-radius: 4px; padding: 0.22rem 0.46rem;
}
.kenmerk-tekst h3 { margin: 0 0 0.7rem; font-size: clamp(1.15rem, 2vw, 1.5rem); }
.kenmerk-tekst p { margin: 0; color: var(--muted); font-size: 0.93rem; max-width: 52ch; }

/* Rosterstrip */
.rosterstrip { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0 0 1.5rem; }
.rosterstrip img { border-radius: 8px; border: 1px solid var(--line); display: block; }
.rosterstrip a { line-height: 0; transition: transform 0.15s; }
.rosterstrip a:hover { transform: translateY(-3px); }
.rosterstrip a:hover img { border-color: var(--gold-dim); }

/* Classic-uitgelicht */
.spot { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr); gap: clamp(1.5rem, 4vw, 3.5rem); align-items: center; }
@media (max-width: 900px) { .spot { grid-template-columns: 1fr; } }
.spot-tekst h2 { margin: 0 0 0.9rem; font-size: clamp(1.5rem, 3vw, 2.2rem); }
.spot-tekst p { color: var(--muted); font-size: 0.95rem; margin: 0 0 0.9rem; max-width: 56ch; }
.spot-tekst strong { color: var(--ink); font-weight: 600; }
.spotcijfers { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
.spotcijfers div {
  padding: 1rem 1.1rem; border: 1px solid var(--line); border-radius: 9px;
  background: rgba(255, 255, 255, 0.015);
}
.spotcijfers b { display: block; font-family: var(--mono); font-size: 1.5rem; font-weight: 700; color: var(--gold); }
.spotcijfers span { font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }

/* Wel/niet */
.tweeluik { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
@media (max-width: 800px) { .tweeluik { grid-template-columns: 1fr; } }
.tl-kolom { padding: 1.3rem 1.4rem; border: 1px solid var(--line); border-radius: 10px; }
.tl-kolom h3 { margin: 0 0 0.9rem; font-size: 1.05rem; }
.tl-kolom ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.55rem; }
.tl-kolom li { position: relative; padding-left: 1.5rem; font-size: 0.9rem; color: var(--muted); }
.tl-kolom li::before { position: absolute; left: 0; font-weight: 700; }
.tl-ja { border-color: var(--gold-dim); background: rgba(231, 199, 110, 0.05); }
.tl-ja li::before { content: "\\2713"; color: var(--gold); }
.tl-nee li::before { content: "\\00d7"; color: var(--wr-bad); }
.tl-waarom { margin: 1.1rem 0 0; font-size: 0.84rem; color: var(--dim); }

/* Download */
.downloadblok { text-align: center; display: grid; justify-items: center; gap: 0.9rem; }
.downloadblok h2 { margin: 0; font-size: clamp(1.6rem, 3vw, 2.3rem); }
.downloadblok p { margin: 0; color: var(--muted); }

/* Pagina die al bestaat voordat zijn data bestaat. */
.geraamte { padding-block: clamp(2rem, 4vw, 3.2rem) 4rem; }
.geraamte .sectiekop h1 { font-size: clamp(2rem, 4.5vw, 3rem); margin: 0 0 0.6rem; }
.geraamte-cta { display: flex; flex-wrap: wrap; gap: 0.8rem; margin-top: 2.4rem; }

/* Wachtrij-kiezer op de tier-pagina */
.tier-keuze { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1.6rem; }
.tier-optie {
  display: flex; flex-direction: column; gap: 0.15rem; text-decoration: none;
  padding: 0.6rem 0.95rem; border-radius: 8px; border: 1px solid var(--line);
}
.tier-optie.aan { border-color: var(--gold-dim); background: rgba(231, 199, 110, 0.08); }
.tier-optie.aan:hover { background: rgba(231, 199, 110, 0.13); }
.tier-optie.soon { opacity: 0.55; }
.to-naam { font-size: 0.92rem; font-weight: 600; color: var(--ink); }
.tier-optie.soon .to-naam { color: var(--muted); }
.to-merk { font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.08em; color: var(--dim); }
.tier-optie.aan .to-merk { color: var(--gold); }

/* Het wachtpaneel: echte koppen, skelet-rijen eronder */
.wacht { border: 1px solid var(--line); border-radius: 11px; overflow: hidden; }
.wacht-kop {
  display: grid; grid-template-columns: 3.2rem 1fr 6rem 6rem; gap: 1rem;
  padding: 0.7rem 1.1rem; border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.02);
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.13em;
  text-transform: uppercase; color: var(--dim);
}
.wacht-rijen { position: relative; }
.wacht-rij {
  display: grid; grid-template-columns: 3.2rem 1fr 6rem 6rem; gap: 1rem; align-items: center;
  padding: 0.85rem 1.1rem; border-bottom: 1px solid var(--line);
}
.wacht-rij:last-child { border-bottom: 0; }
.wacht-blok {
  height: 0.8rem; border-radius: 4px;
  background: linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.09), rgba(255,255,255,0.05));
  background-size: 200% 100%; animation: wachtGlans 1.8s ease-in-out infinite;
}
.wacht-blok.w-portret { width: 2rem; height: 2rem; border-radius: 6px; }
.wacht-blok.w-lang { width: 60%; }
.wacht-blok.w-kort { width: 3.2rem; }
@keyframes wachtGlans { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .wacht-blok { animation: none; } }
.wacht-uitleg {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 1.1rem 1.2rem; background: rgba(255, 255, 255, 0.02);
}
.wacht-uitleg p { margin: 0; color: var(--muted); font-size: 0.9rem; max-width: 60ch; }
.btn-sm { padding: 0.4rem 0.8rem; font-size: 0.82rem; }

/* ── Ingebouwde sfeerbeelden ───────────────────────────────────────────── */
/* Hero: het slagveld ligt achter het portret-mozaïek, allebei gedempt. */
.held-foto {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; opacity: 0.55;
}
.lol-held-dek .mosaic { position: absolute; inset: 0; opacity: 0.5; mix-blend-mode: screen; }
.lol-held-dek::after {
  content: ""; position: absolute; inset: 0;
  background: radial-gradient(115% 130% at 72% 8%, transparent 0%, rgba(6,8,12,0.35) 42%, var(--bg) 82%);
}

/* Lege-staat beeld op een championpagina zonder cijfers. */
.leeg-beeld {
  display: block; width: 100%; max-width: 560px; height: auto;
  border-radius: 11px; border: 1px solid var(--line);
  margin: 0 0 1.8rem; opacity: 0.9;
}

/* Klein lege-staat beeld naast het wachtpaneel op de tier-pagina. */
.wacht-uitleg { align-items: center; }
.wacht-beeld {
  flex: none; width: 130px; height: auto; border-radius: 8px;
  border: 1px solid var(--line); opacity: 0.85;
}
.wacht-uitleg-tekst { display: flex; flex-direction: column; gap: 0.7rem; flex: 1; min-width: 240px; }
.wacht-uitleg-tekst p { margin: 0; }

/* Sectie-scheiding: de ene brede band, vlak voor de download. */
.scheiding {
  height: clamp(120px, 18vw, 240px);
  background-size: cover; background-position: center 60%;
  border-block: 1px solid var(--line);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
}
`;
writeFileSync(join(HERE, "style.css"), css, "utf8");

const CSS_PAD = "style.css";

/**
 * The League of Legends catalogue, as Riot publishes it.
 *
 * Independent of anything anyone has played: it is what exists, not what has
 * been recorded. That is what lets the site carry all 173 champions while the
 * statistics still only cover Classic -- a page for a champion with no games
 * says so, rather than not existing.
 */
const catalogus = existsSync(join(HERE, "data", "lol-catalog.json"))
  ? JSON.parse(readFileSync(join(HERE, "data", "lol-catalog.json"), "utf8"))
  : { version: null, champions: [], items: [] };

/** Base ids of the champions Classic actually has. */
const IN_CLASSIC = new Set(Object.values(roster).map((c) => c.baseId));

/**
 * Which queues this site has numbers for, and which it does not yet.
 *
 * Listing the empty ones is not a roadmap, it is the honest answer to "does
 * this cover my games?". Somebody who plays ranked should learn that in one
 * glance, rather than after reading a tier list built from a different mode.
 * Nothing here gets a number until there are real games behind it.
 */
const MODI = [
  { naam: "Classic", detail: `${n(T.games)} games`, live: true },
  { naam: "Ranked Solo/Duo", detail: "no data yet", live: false },
  { naam: "Flex", detail: "no data yet", live: false },
  { naam: "Normal Draft", detail: "no data yet", live: false },
  { naam: "ARAM", detail: "no data yet", live: false },
];

function modusBalk() {
  const knoppen = MODI.map(
    (m) =>
      `<span class="modus ${m.live ? "live" : "soon"}">${esc(m.naam)}` +
      `<span class="mb-n">${esc(m.detail)}</span></span>`,
  ).join("");
  return `<section class="modusbalk">
  <div class="wrap">
    <span class="mb-label">Queues</span>
    ${knoppen}
    <p class="mb-note">
      Every number on this page comes from Classic games. The other queues are next &mdash;
      they will show up here the moment there is a real sample behind them, and not before.
    </p>
  </div>
</section>`;
}

const classicHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>League Classic stats &middot; AllMid</title>
<meta name="description" content="Tier lists, counters and builds for League of Legends Classic, from ${n(T.games)} real games. Every number carries its sample size. Free and open source." />

<meta property="og:type" content="website" />
<meta property="og:title" content="League Classic stats &middot; AllMid" />
<meta property="og:description" content="The queue nobody else covers: ${n(T.games)} Classic games, ${n(T.players)} players, all 63 champions." />
<meta property="og:url" content="https://allmid.gg/classic.html" />
<meta property="og:image" content="https://allmid.gg/img/meta.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="theme-color" content="#06080c" />

<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" />

<link rel="stylesheet" href="${CSS_PAD}" />

<script>
  // Vóór de eerste tekening: alleen verbergen als we ook kunnen onthullen.
  if ("IntersectionObserver" in window) document.documentElement.classList.add("reveal");
</script>
</head>
<body>
  <div class="paginadek" aria-hidden="true">
    <div class="mosaic mosaic-pagina">${paginaTiles()}</div>
  </div>

${toolbalk('classic')}

${modusBalk()}

<!-- ── Hero ───────────────────────────────────────────────────────────── -->
<section class="hero">
  <div class="hero-bg" aria-hidden="true">
    <div class="mosaic">${mosaicTiles()}</div>
  </div>
  <div class="wrap">
    <div class="rise">
      <p class="eyebrow">Free &middot; Open source &middot; MIT &middot; Windows</p>
      <h1>League of Legends stats that <em>show their working</em>.</h1>
      <p class="lede">
        Tier lists, counters and builds where every number carries the sample size it came from.
        We start with the queue nobody else covers: Riot&rsquo;s public API does not carry Classic,
        so AllMid reads the client&rsquo;s own local APIs and builds the dataset from the games
        people actually play &mdash; <strong>${n(T.games)} games</strong> across
        <strong>${n(T.players)} players</strong> and all <strong>63 champions</strong>. The other
        queues follow, on the same terms. Free and open source.
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
        <p class="cov-label">Live Classic data</p>
        <span class="yes">${n(T.games)} games</span><span class="yes">${n(T.players)} players</span><span class="yes">patch ${esc(T.patches[0])}</span><span class="yes">updates itself</span>
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
      <p>Each of these comes straight out of the match data below, with the sample size it rests on.</p>
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
    <p class="legal">Questions, corrections or takedown requests: <a href="mailto:contact@allmid.gg">contact@allmid.gg</a>.</p>
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

  // Welke champion en lane er nu getoond worden. De lane is er een voor het hele
  // paneel: hij bepaalt tegelijk welke regel oplicht in de lane-tabel, over welke
  // lane de matchups gaan, en welke build eronder staat. Eerder had het buildblok
  // zijn eigen lane en gingen de matchups over alles tegelijk.
  let huidigeChamp = el("detail")?.dataset.seed ?? null;
  let huidigeLane = el("detail")?.dataset.lane || null;
  let matchupBron = "lane";

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

  function kiesLane(lane) {
    if (!lane) return;
    huidigeLane = lane;
    matchupBron = "lane";
    toonLaneKeuze();
    toonMatchups();
    showBuild(huidigeChamp, lane);
  }

  function toonLaneKeuze() {
    for (const tr of document.querySelectorAll("#detail-lane-rows tr[data-lane]")) {
      tr.setAttribute("aria-selected", String(tr.dataset.lane === huidigeLane));
    }
    const knop = el("mu-lane");
    if (knop) {
      knop.textContent = LANE_LABEL[huidigeLane] || "Lane";
      knop.hidden = !huidigeLane;
    }
  }

  /**
   * De matchups. Standaard alleen de tegenstander die in DEZE lane tegenover je
   * stond; dat is wat je bij een pick wilt weten. Gepoold over alle lanes kwam
   * Kog'Maw eruit met Skarner, Malphite, Garen en Nidalee als beste matchups, en
   * die vier staan nooit tegenover een botlane-ADC. Dat blijft opvraagbaar onder
   * "Overall", want voor een off-meta champion is dat soms het enige dat er is.
   */
  function toonMatchups() {
    const c = data.c[huidigeChamp];
    if (!c) return;
    const perLane = c.m ? c.m[huidigeLane] : null;
    const overall = matchupBron === "overall" || !perLane;
    const bron = overall ? { b: c.b, d: c.d } : perLane;
    // Zie leegTekst() in detailPanel: aan een kant niets betekent dat die kant er
    // niet is, niet dat er te weinig data is. Alleen als het aan beide kanten
    // leeg blijft, is er echt te weinig.
    const wint = bron.b || [], verliest = bron.d || [];
    const leeg = (dezeKant, andereKant) =>
      '<li class="c-empty">' +
      (andereKant.length ? "No " + dezeKant + " matchup in this lane." : "Not enough games.") +
      "</li>";
    el("detail-beats").innerHTML = wint.map((m) => matchupRow(m, "up")).join("") || leeg("winning", verliest);
    el("detail-loses").innerHTML = verliest.map((m) => matchupRow(m, "down")).join("") || leeg("losing", wint);
    for (const btn of document.querySelectorAll("#mu-schakel button[data-mu]")) {
      btn.setAttribute("aria-selected", String(btn.dataset.mu === (overall ? "overall" : "lane")));
    }
    const uitleg = el("mu-uitleg");
    if (uitleg) uitleg.textContent = overall ? "all lanes" : "in lane";
  }

  // Eén luisteraar op de container: de knoppen worden opnieuw opgebouwd bij elke
  // championwissel, dus luisteraars per knop zouden telkens opnieuw moeten.
  el("build-lanes")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-lane]");
    if (btn && huidigeChamp !== null) kiesLane(btn.dataset.lane);
  });

  // De hele regel is aanklikbaar, niet alleen het woord. Regels van lanes die de
  // drempel niet halen doen niets: daar valt niets te tonen.
  el("detail-lane-rows")?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-lane]");
    if (tr && tr.querySelector(".lane-knop:not(.is-stil)")) kiesLane(tr.dataset.lane);
  });

  el("mu-schakel")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mu]");
    if (!btn) return;
    matchupBron = btn.dataset.mu;
    toonMatchups();
  });

  function show(id) {
    const c = data.c[id];
    const r = data.r[id];
    if (!c || !r) return;

    // Elke champion opent op zijn eigen drukste lane, met de matchups van die
    // lane. Anders zou de lanekeuze van de vorige champion blijven hangen.
    huidigeChamp = id;
    huidigeLane = c.o || null;
    matchupBron = "lane";

    el("detail-name").textContent = r[0];
    el("detail-icon").src = r[1];
    el("detail-splash").src = r[2];
    const guide = el("detail-guide");
    if (guide) guide.href = "champion/" + r[3] + ".html";
    el("detail-sub").innerHTML =
      c.g ? num(c.g) + " games &middot; " + pct(c.w) + "% overall" : "&nbsp;";

    el("detail-lane-rows").innerHTML = c.l.some((x) => x[1] > 0)
      ? c.l
          .map(([lane, games, wr, rank, qual]) => {
            const label = LANE_LABEL[lane] || lane;
            const naam = qual
              ? '<button type="button" class="lane-knop" data-lane="' + lane + '">' + label + "</button>"
              : '<span class="lane-knop is-stil">' + label + "</span>";
            return '<tr data-lane="' + lane + '"' + (lane === c.h ? ' class="is-vaakst"' : "") +
              ' aria-selected="' + (lane === huidigeLane) + '">' +
              '<th scope="row">' + naam + (lane === c.h ? ' <span class="lane-tag">most played</span>' : "") + "</th>" +
              '<td class="c-rank">' + (rank ? "#" + rank : "&mdash;") + "</td>" +
              '<td class="c-bar">' + (wr === null ? "" : '<span style="width:' + barW(wr).toFixed(1) + '%"></span>') + "</td>" +
              '<td class="c-wr ' + (wr === null ? "" : wrClass(wr)) + '">' +
              (wr === null ? "&mdash;" : pct(wr) + "<small>%</small>") + "</td>" +
              '<td class="c-games">' + (games ? num(games) : "&mdash;") + "</td></tr>";
          })
          .join("")
      : '<tr><td colspan="5" class="c-empty">No lane data yet.</td></tr>';

    toonLaneKeuze();
    toonMatchups();

    showBuild(id, huidigeLane);
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

${zoekIndex()}
${ZOEK_SCRIPT}
</body>
</html>
`;

const homeHtml = leaguePagina();
const championsHtml = championsPagina();
writeFileSync(join(HERE, "classic.html"), classicHtml, "utf8");
writeFileSync(join(HERE, "index.html"), homeHtml, "utf8");
writeFileSync(join(HERE, "champions.html"), championsHtml, "utf8");
writeFileSync(join(HERE, "tiers.html"), tiersPagina(), "utf8");
writeFileSync(join(HERE, "app.html"), appPagina(), "utf8");
writeFileSync(join(HERE, "overlay.html"), overlayPagina(), "utf8");

mkdirSync(join(HERE, "champion"), { recursive: true });
let guideBytes = 0;
let guides = 0;
for (const c of Object.values(roster)) {
  const full = champions.champions[String(c.baseId)];
  if (!full) continue;
  const pagina = guidePagina(full);
  guideBytes += pagina.length;
  guides++;
  writeFileSync(join(HERE, "champion", `${slugVan(c.name)}.html`), pagina, "utf8");
}

// The rest of League. A champion who never existed in Season 3 cannot have a
// Classic statistic, so their page says that instead of not existing.
let catPaginas = 0;
for (const c of catalogus.champions) {
  if (IN_CLASSIC.has(c.id)) continue;
  const pagina = catalogusPagina(c);
  guideBytes += pagina.length;
  catPaginas++;
  writeFileSync(join(HERE, "champion", `${slugVan(c.name)}.html`), pagina, "utf8");
}
console.log(
  `[build] index.html -- ${(homeHtml.length / 1024).toFixed(0)} KB  |  ` +
    `classic.html -- ${(classicHtml.length / 1024).toFixed(0)} KB, ${n(T.games)} games  |  ` +
    `champions.html -- ${(championsHtml.length / 1024).toFixed(0)} KB, ${catalogus.champions.length} champions`,
);
console.log(
  `[build] champion/ geschreven -- ${guides} guides met data + ${catPaginas} zonder, ` +
    `${(guideBytes / 1024).toFixed(0)} KB samen, style.css ${(css.length / 1024).toFixed(0)} KB gedeeld`,
);
