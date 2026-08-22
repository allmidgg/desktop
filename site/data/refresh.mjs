/**
 * Genereert site/data/meta.json, champions.json en builds.json uit een telling.
 *
 *   node site/data/refresh.mjs && node site/build.mjs
 *
 * ── Waarom dit bestand bestaat ───────────────────────────────────────────────
 *
 * De drie databestanden kwamen uit drie losse wegwerpscripts, elk gedraaid op een
 * ander moment terwijl de crawler doorliep. Daardoor stond champions.json op
 * 120.032 games en builds.json op 128.628, en spraken twee blokken op dezelfde
 * pagina elkaar tegen. De scripts zelf zaten niet in de repo, dus verversen
 * betekende dat circus opnieuw opvoeren.
 *
 * Hier gebeurt alles vanuit een en dezelfde telling. De crawler blijft tijdens de
 * doorloop achteraan matches.jsonl schrijven; daarom leggen we bij het openen de
 * bestandsgrootte vast en lezen we nooit verder dan die grens -- alle drie de
 * bestanden zien exact dezelfde games. Dat is de hele reden van bestaan van dit
 * script, dus die grens wordt op precies een plek bepaald en daarna doorgegeven.
 * Het bestand gaat er twee keer doorheen -- waarom staat bij combinatiesTellen --
 * maar allebei de keren binnen datzelfde bevroren venster.
 *
 * ── Rekenmethode ─────────────────────────────────────────────────────────────
 *
 * Overgenomen uit src/core/services/stats.ts, want site en app horen dezelfde
 * cijfers te tonen: prior 20, gladgestreken winrate (wins + 10) / (games + 20),
 * minimaal 8 games voor een matchup, minimaal 100 lane-games om mee te tellen in
 * een ranglijst. Sloten met positie UNKNOWN tellen niet mee, en de tegenstander
 * is de speler op dezelfde positie in het andere team.
 *
 * Bij een exact gelijke winrate wordt de volgorde vastgelegd: eerst de grootste
 * steekproef, daarna het laagste id. De vorige scripts lieten dat aan de volgorde
 * van binnenkomst over, waardoor twee doorlopen over dezelfde games een andere
 * top 5 konden geven. Percentages worden half naar boven afgerond (toFixed),
 * hetzelfde als build.mjs doet bij het uitschrijven.
 *
 * ── Wat de bron wel en niet bevat ────────────────────────────────────────────
 *
 * items[] is de eindinventaris, zeven lang, waarvan slot 6 het trinket is. Er zit
 * geen aankoopvolgorde en geen tijdlijn in. Nergens in de uitvoer staat dus een
 * volgorde alsof die gemeten is; "core" is een combinatie die vaak samen in de
 * eindinventaris zit, geen buildpad.
 *
 * ── Privacy ──────────────────────────────────────────────────────────────────
 *
 * De bron bevat puuids. Die worden alleen geteld (hoeveel unieke spelers) en
 * verlaten dit script nooit; in de uitvoer staan uitsluitend geaggregeerde
 * cijfers per champion, lane, item en spell.
 */
import { openSync, fstatSync, readSync, closeSync, statSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const HERE = dirname(fileURLToPath(import.meta.url)); // site/data
const REPO = resolve(HERE, "..", "..");

/* ── Argumenten ──────────────────────────────────────────────────────────────
 *
 * --in bestaat omdat repo en database op de server bewust gescheiden staan: de
 * verzamelserver schrijft naar C:\allmid\server-data\data\matches.jsonl terwijl de
 * repo in C:\allmid\desktop staat. Die database is 307 MB en hoort niet in
 * versiebeheer, dus hij kan daar niet naast build.mjs liggen. Zonder --in zou dit
 * script daar de verkeerde of helemaal geen database lezen.
 */
function argumenten(argv) {
  const uit = { in: null, out: HERE, lines: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const vlag = argv[i];
    const waarde = argv[i + 1];
    if (vlag === "--help" || vlag === "-h") {
      console.log(
        [
          "Gebruik: node site/data/refresh.mjs [--in <pad>] [--out <map>] [--lines <n>]",
          "",
          "  --in <pad>    matches.jsonl zelf, of een map waarin data/matches.jsonl of",
          "                matches.jsonl staat. Standaard: <repo>/data/matches.jsonl",
          "  --out <map>   waar meta.json, champions.json en builds.json landen.",
          "                Standaard: site/data/",
          "  --lines <n>   verwerk hooguit n regels. Alleen om een oudere momentopname",
          "                na te rekenen of uitvoer te vergelijken; laat hem normaal weg.",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (vlag === "--in") {
      if (!waarde) fout("--in verwacht een pad");
      uit.in = waarde;
      i++;
    } else if (vlag === "--out") {
      if (!waarde) fout("--out verwacht een map");
      uit.out = waarde;
      i++;
    } else if (vlag === "--lines") {
      const n = Number(waarde);
      if (!Number.isFinite(n) || n <= 0) fout("--lines verwacht een positief getal");
      uit.lines = Math.floor(n);
      i++;
    } else {
      fout(`onbekende vlag: ${vlag}`);
    }
  }
  return uit;
}

function fout(bericht) {
  console.error(`[refresh] ${bericht}`);
  process.exit(1);
}

/**
 * Een pad kan het JSONL-bestand zelf zijn of de map eromheen. Een map wordt
 * afgezocht op data/matches.jsonl (de indeling van de server en van de repo) en
 * daarna op matches.jsonl, zodat zowel --in C:\allmid\server-data als
 * --in C:\allmid\server-data\data werkt.
 */
function zoekDatabase(opgegeven) {
  if (!opgegeven) {
    const standaard = join(REPO, "data", "matches.jsonl");
    if (!existsSync(standaard)) {
      fout(`geen database gevonden op ${standaard}. Geef er een aan met --in <pad>.`);
    }
    return standaard;
  }
  const pad = isAbsolute(opgegeven) ? opgegeven : resolve(process.cwd(), opgegeven);
  if (!existsSync(pad)) fout(`--in ${opgegeven}: dit pad bestaat niet (gezocht op ${pad}).`);
  if (statSync(pad).isDirectory()) {
    for (const kandidaat of [join(pad, "data", "matches.jsonl"), join(pad, "matches.jsonl")]) {
      if (existsSync(kandidaat)) return kandidaat;
    }
    fout(`--in ${opgegeven} is een map zonder data/matches.jsonl of matches.jsonl erin.`);
  }
  return pad;
}

/* ── Catalogus en roster ─────────────────────────────────────────────────────
 *
 * De matchdata kent alleen ids. Namen, prijzen en buildpaden komen uit
 * data/catalog.json; welke 63 champions de site kent staat in het beeldmanifest,
 * en dat is ook precies de lijst waarop build.mjs stukloopt als er een mist.
 */
const catalogus = JSON.parse(readFileSync(join(REPO, "data", "catalog.json"), "utf8"));
const roster = JSON.parse(readFileSync(join(REPO, "site", "img", "champions", "manifest.json"), "utf8")).champions;

const CHAMPION_OFFSET = 60000;
const ITEM_OFFSET = 770000;

const championNaam = new Map(catalogus.champions.map((c) => [c.baseId, c.name]));
for (const c of roster) if (!championNaam.has(c.baseId)) championNaam.set(c.baseId, c.name);
const ROSTER = [...roster].map((c) => c.baseId).sort((a, b) => a - b);

const itemPerBase = new Map(catalogus.items.map((i) => [i.baseId, i]));

/**
 * Vier spells (705, 709, 716, 720) staan in de catalogus onder baseId in plaats
 * van jadeId -- Fortify, Rally, Surge en Promote. De matchdata gebruikt het getal
 * dat bij die vier de baseId is, dus we zoeken op exacte jadeId en vallen daarna
 * terug op baseId. Andersom zoeken zou 74 (Flash) op baseId 74 laten stuklopen.
 *
 * Een lege naam telt als niet gevonden. Dat is geen kosmetiek: jadeId 75 is een
 * naamloze restregel, terwijl 75 als baseId Clairvoyance is -- precies de spell
 * die de matchdata bedoelt.
 */
const spellPerJade = new Map(catalogus.spells.map((s) => [s.jadeId, s.name]));
const spellPerBase = new Map(catalogus.spells.map((s) => [s.baseId, s.name]));
const spellNaam = (id) => spellPerJade.get(id) || spellPerBase.get(id) || String(id);

/**
 * Consumables en trinkets zeggen niets over een build: iedereen koopt potions, en
 * wat er aan het eind toevallig nog in de tas zat is geen keuze. Ze staan hier met
 * de hand omdat de catalogus ze nergens als categorie markeert -- Health Potion,
 * Mana Potion, biscuits, elixirs, de wards en Recall.
 */
const CONSUMABLES = new Set([2001, 2003, 2004, 2009, 2037, 2038, 2039, 2042, 2043, 2044, 2050, 3517, 3518, 3519, 3521]);
const TRINKETS = new Set([3340, 3348]);
/**
 * Drie regels met prijs 0 die geen koopbaar item zijn maar een spelmechaniek:
 * Penetrating Bullets en de twee Rune Replacers. Sightstone en Ruby Sightstone
 * zien er in dezelfde hoek uit maar zijn wel gewoon te koop, en blijven dus staan.
 */
const NIET_KOOPBAAR = new Set([1500, 2139, 2140]);

/** Laarzen = Boots of Speed plus alles wat daaruit doorbouwt, transitief. */
const LAARZEN = (() => {
  const uit = new Set([1001]);
  let gegroeid = true;
  while (gegroeid) {
    gegroeid = false;
    for (const item of catalogus.items) {
      if (uit.has(item.baseId)) continue;
      const bouwtUit = (item.buildsFrom ?? []).map((id) => id - ITEM_OFFSET);
      if (bouwtUit.some((id) => uit.has(id))) {
        uit.add(item.baseId);
        gegroeid = true;
      }
    }
  }
  return uit;
})();

/**
 * Startitems zijn niet als zodanig gemarkeerd, dus we leiden ze af: een
 * basiscomponent (bouwt nergens uit voort) van 1 tot 500 goud dat geen consumable
 * is. Boots of Speed valt onder allebei -- laars en startitem -- en dat klopt.
 */
const STARTITEMS = new Set(
  catalogus.items
    .filter((i) => (i.buildsFrom ?? []).length === 0 && i.price >= 1 && i.price <= 500 && !CONSUMABLES.has(i.baseId))
    .map((i) => i.baseId),
);

const teltMeeAlsItem = (baseId) =>
  itemPerBase.has(baseId) && !CONSUMABLES.has(baseId) && !TRINKETS.has(baseId) && !NIET_KOOPBAAR.has(baseId);

/** Kandidaten voor "core": geen laarzen, geen startitems, geen wegwerpspul. */
const teltMeeAlsCore = (baseId) => teltMeeAlsItem(baseId) && !LAARZEN.has(baseId) && !STARTITEMS.has(baseId);

/* ── Rekenen ─────────────────────────────────────────────────────────────────*/

const PRIOR_STRENGTH = 20;
const MIN_MATCHUP_GAMES = 8;
const MIN_LANE_GAMES = 100;

/**
 * Twee eisen aan een matchup, allebei gelijk aan src/core/services/stats.ts.
 *
 * MIN_LANE_SHARE: hoe vaak de tegenstander minstens in die lane moet staan, als
 * deel van alle spelersloten daar. Zonder deze eis kwam Kog'Maw er in de botlane
 * uit als winnend tegen Ryze, Nunu, Alistar, Veigar en Lulu. Echte games, 19 tot
 * 40 stuks, maar geen van die vijf haalt 1% van de botlane -- Ryze staat er 36e
 * met 0,37%. Je krijgt ze nooit tegenover je. De botlane is negen ADC's die samen
 * 72% van de lane vullen, en dat is wat er hoort te staan.
 *
 * MIN_MATCHUP_SHARE: hoe groot de matchup minstens moet zijn ten opzichte van je
 * eigen lane-games. Een vaste ondergrens van 8 werkt averechts bij een veelge-
 * speelde champion: met 6.627 botgames is een reeks van 26 pure ruis, en door de
 * sortering op winrate belandt juist die ruis bovenaan. Deze eis schaalt mee --
 * Ezreal moet 320 games hebben, en een champion met 300 lane-games houdt de
 * ondergrens van 8, zodat er niemand leeg raakt.
 *
 * Nagerekend over alle 296 champion+lane-combinaties: geen enkele verliest al
 * zijn matchups. De mediaan houdt er 18 over, ruim meer dan de vijf die getoond
 * worden.
 */
const MIN_LANE_SHARE = 0.01;
const MIN_MATCHUP_SHARE = 0.01;
const LANES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];

/** Naar 50% getrokken winrate, in procenten. Bij weinig games zegt de rauwe niets. */
const glad = (games, wins) => ((wins + PRIOR_STRENGTH / 2) / (games + PRIOR_STRENGTH)) * 100;
const ruw = (games, wins) => (games ? (wins / games) * 100 : 0);

/**
 * Percentages krijgen een vast aantal decimalen, ook als dat een nul aan het eind
 * is: in een tabel naast elkaar leest 58.0 beter dan 58. JSON kent dat verschil
 * niet, dus het getal reist als markering mee en wordt bij het serialiseren weer
 * een kaal getal. Zie serialiseer().
 */
const vast = (waarde, decimalen) => `@@${Number(waarde).toFixed(decimalen)}@@`;
const rond = (waarde, decimalen) => Number(Number(waarde).toFixed(decimalen));
const serialiseer = (waarde, inspringen) =>
  JSON.stringify(waarde, null, inspringen).replace(/"@@(-?\d+(?:\.\d+)?)@@"/g, "$1");

/** Duizendtallen zoals de rest van de site ze schrijft: 20.454. */
const nl = (getal) => Number(getal).toLocaleString("nl-NL");

/* ── Lezen ───────────────────────────────────────────────────────────────────*/

/**
 * Loopt regel voor regel door het JSONL-bestand tot aan `grens` bytes.
 *
 * Die grens is de bestandsgrootte op het moment dat we begonnen. De crawler
 * schrijft ondertussen door; zonder grens zou de tweede doorloop meer games zien
 * dan de eerste en zouden de drie bestanden alsnog uit elkaar lopen.
 *
 * De laatste regel binnen de grens kan een halve append zijn die op dat moment nog
 * onderweg was. Die is niet kapot maar onaf, dus hij telt niet mee als onleesbare
 * regel -- hij wordt gewoon overgeslagen, en de volgende doorloop leest hem heel.
 */
function leesDoor(pad, grens, maxRegels, opRegel) {
  const fd = openSync(pad, "r");
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    const decoder = new StringDecoder("utf8");
    let positie = 0;
    let rest = "";
    let regels = 0;

    while (positie < grens && regels < maxRegels) {
      const wens = Math.min(buffer.length, grens - positie);
      const gelezen = readSync(fd, buffer, 0, wens, positie);
      if (gelezen <= 0) break;
      positie += gelezen;

      const stuk = rest + decoder.write(buffer.subarray(0, gelezen));
      const delen = stuk.split("\n");
      rest = delen.pop() ?? "";
      for (const deel of delen) {
        if (regels >= maxRegels) break;
        const regel = deel.endsWith("\r") ? deel.slice(0, -1) : deel;
        if (!regel) continue;
        regels++;
        opRegel(regel, false);
      }
    }

    const staart = (rest + decoder.end()).replace(/\r$/, "");
    if (staart && regels < maxRegels) {
      regels++;
      opRegel(staart, true);
    }
    return regels;
  } finally {
    closeSync(fd);
  }
}

/* ── Doorloop 1: alles tellen ────────────────────────────────────────────────*/

const nieuweTally = () => ({ games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 });
const nieuwPaar = () => ({ games: 0, wins: 0 });

function pak(kaart, sleutel, maak) {
  let waarde = kaart.get(sleutel);
  if (waarde === undefined) {
    waarde = maak();
    kaart.set(sleutel, waarde);
  }
  return waarde;
}

function tellen(pad, grens, maxRegels) {
  const t = {
    regels: 0,
    onleesbaar: 0,
    dubbel: 0,
    games: 0,
    sloten: 0,
    slotenZonderPositie: 0,
    duurTotaal: 0,
    eerste: Infinity,
    laatste: -Infinity,
    winsBlauw: 0,
    winsRood: 0,
    patches: new Map(),
    slotenPerLane: new Map(LANES.map((l) => [l, 0])),
    // "lane|champion" -> tally, en dezelfde sleutelvorm voor de rest
    champions: new Map(),
    matchups: new Map(), // "lane|champion|tegenstander"
    items: new Map(), // "lane|champion|item"
    spells: new Map(), // "lane|champion|a-b"
    slotenInclUnknown: new Map(), // champion -> games, inclusief UNKNOWN
    gameIds: new Set(),
    spelers: new Set(),
  };

  let halveStaart = 0;
  const gelezen = leesDoor(pad, grens, maxRegels, (regel, isStaart) => {
    let match;
    try {
      match = JSON.parse(regel);
    } catch {
      // Een onaffe laatste regel is een append die nog liep, geen bederf.
      if (isStaart) halveStaart++;
      else t.onleesbaar++;
      return;
    }
    if (t.gameIds.has(match.gameId)) {
      t.dubbel++;
      return;
    }
    t.gameIds.add(match.gameId);
    t.games++;
    t.duurTotaal += match.duration ?? 0;
    if (match.createdAt < t.eerste) t.eerste = match.createdAt;
    if (match.createdAt > t.laatste) t.laatste = match.createdAt;
    if (match.patch) t.patches.set(match.patch, (t.patches.get(match.patch) ?? 0) + 1);

    const spelers = match.players ?? [];
    // Wie er won staat per speler; op matchniveau is het de kant van team 100.
    const blauw = spelers.find((p) => p.teamId === 100);
    if (blauw && blauw.win) t.winsBlauw++;
    else if (blauw) t.winsRood++;

    for (const speler of spelers) {
      t.sloten++;
      t.spelers.add(speler.puuid);
      const champion = speler.championId - CHAMPION_OFFSET;
      t.slotenInclUnknown.set(champion, (t.slotenInclUnknown.get(champion) ?? 0) + 1);

      if (speler.position === "UNKNOWN") {
        t.slotenZonderPositie++;
        continue;
      }
      const lane = speler.position;
      t.slotenPerLane.set(lane, (t.slotenPerLane.get(lane) ?? 0) + 1);

      const sleutel = `${lane}|${champion}`;
      const tally = pak(t.champions, sleutel, nieuweTally);
      tally.games++;
      if (speler.win) tally.wins++;
      tally.kills += speler.kills;
      tally.deaths += speler.deaths;
      tally.assists += speler.assists;

      // Slot 6 is het trinket-slot; een item dat dubbel in de tas zit telt een keer.
      const gebouwd = new Set();
      for (let i = 0; i < 6; i++) {
        const id = speler.items?.[i] ?? 0;
        if (id > 0) gebouwd.add(id - ITEM_OFFSET);
      }
      for (const item of gebouwd) {
        if (!teltMeeAlsItem(item)) continue;
        const paar = pak(t.items, `${sleutel}|${item}`, nieuwPaar);
        paar.games++;
        if (speler.win) paar.wins++;
      }

      // Flash+Ignite en Ignite+Flash zijn dezelfde keuze, dus het paar gaat gesorteerd.
      const [a, b] = [...(speler.spells ?? [])].sort((x, y) => x - y);
      if (a && b) {
        const paar = pak(t.spells, `${sleutel}|${a}-${b}`, nieuwPaar);
        paar.games++;
        if (speler.win) paar.wins++;
      }

      // De directe tegenstander is de speler op dezelfde positie in het andere team.
      const tegen = spelers.find((ander) => ander.teamId !== speler.teamId && ander.position === lane);
      if (!tegen) continue;
      const paar = pak(t.matchups, `${sleutel}|${tegen.championId - CHAMPION_OFFSET}`, nieuwPaar);
      paar.games++;
      if (speler.win) paar.wins++;
    }
  });
  t.regels = gelezen - halveStaart;

  return t;
}

/* ── Doorloop 2: welke items zitten er samen in een build ────────────────────
 *
 * Combinaties kunnen niet in doorloop 1 mee: welke items in aanmerking komen weet
 * je pas als je ze allemaal geteld hebt, en alles tellen wat samen voorkomt loopt
 * in de miljoenen sleutels. Daarom eerst de kandidaten bepalen (de 30 vaakst
 * gebouwde items per champion+lane) en daarna alleen die combinaties tellen.
 */
const CORE_KANDIDATEN = 30;
const CORE_MIN_GAMES = 20;

function combinatiesTellen(pad, grens, maxRegels, poelPerLaneChamp) {
  const uit = new Map(); // "lane|champion" -> Map("a-b-c" -> {games, wins})
  for (const sleutel of poelPerLaneChamp.keys()) uit.set(sleutel, new Map());
  const gezien = new Set();

  leesDoor(pad, grens, maxRegels, (regel) => {
    let match;
    try {
      match = JSON.parse(regel);
    } catch {
      return;
    }
    // Dezelfde ontdubbeling als in doorloop 1. Zonder dit telt een game die twee
    // keer in het bestand staat hier wel mee en in de rest niet, en dan klopt een
    // core-combinatie net niet meer met de lane-games waar hij tegen afgezet wordt.
    if (gezien.has(match.gameId)) return;
    gezien.add(match.gameId);

    for (const speler of match.players ?? []) {
      if (speler.position === "UNKNOWN") continue;
      const sleutel = `${speler.position}|${speler.championId - CHAMPION_OFFSET}`;
      const poel = poelPerLaneChamp.get(sleutel);
      if (!poel) continue;

      const inBuild = [];
      for (let i = 0; i < 6; i++) {
        const id = speler.items?.[i] ?? 0;
        if (id <= 0) continue;
        const base = id - ITEM_OFFSET;
        if (poel.has(base) && !inBuild.includes(base)) inBuild.push(base);
      }
      if (inBuild.length < 2) continue;
      inBuild.sort((x, y) => x - y);

      const tellingen = uit.get(sleutel);
      for (let i = 0; i < inBuild.length; i++) {
        for (let j = i + 1; j < inBuild.length; j++) {
          const paar = pak(tellingen, `${inBuild[i]}-${inBuild[j]}`, nieuwPaar);
          paar.games++;
          if (speler.win) paar.wins++;
          for (let k = j + 1; k < inBuild.length; k++) {
            const drie = pak(tellingen, `${inBuild[i]}-${inBuild[j]}-${inBuild[k]}`, nieuwPaar);
            drie.games++;
            if (speler.win) drie.wins++;
          }
        }
      }
    }
  });

  return uit;
}

/* ── Afgeleide vormen ────────────────────────────────────────────────────────*/

/** champion -> { lane -> tally }, alleen wat er echt gespeeld is. */
function perChampion(t) {
  const uit = new Map();
  for (const [sleutel, tally] of t.champions) {
    const streep = sleutel.indexOf("|");
    const lane = sleutel.slice(0, streep);
    const champion = Number(sleutel.slice(streep + 1));
    pak(uit, champion, () => new Map()).set(lane, tally);
  }
  return uit;
}

/** Per lane de rangorde over champions met genoeg games, op gladgestreken winrate. */
function rangenPerLane(t) {
  const uit = new Map();
  for (const lane of LANES) {
    const rij = [];
    for (const champion of ROSTER) {
      const tally = t.champions.get(`${lane}|${champion}`);
      if (!tally || tally.games < MIN_LANE_GAMES) continue;
      rij.push({ champion, adjusted: glad(tally.games, tally.wins), games: tally.games });
    }
    rij.sort((a, b) => b.adjusted - a.adjusted || b.games - a.games || a.champion - b.champion);
    uit.set(lane, new Map(rij.map((r, i) => [r.champion, i + 1])));
  }
  return uit;
}

/**
 * Matchups per lane: "champion+lane" -> Map(tegenstander -> {games, wins}).
 *
 * Dit is wat je bij een pick eigenlijk wilt weten. De gepoolde variant hieronder
 * telt alle lanes bij elkaar op, en dat levert antwoorden op die niemand kan
 * gebruiken: Kog'Maw kwam er als bot-lane ADC uit met Skarner, Malphite, Garen en
 * Nidalee als beste matchups. Geen van die vier staat ooit tegenover hem in de
 * botlane. Die cijfers komen uit de zeldzame games waarin Kog'Maw top of mid ging.
 */
function laneMatchups(t) {
  const uit = new Map(); // "lane|champion" -> Map(tegenstander -> paar)
  for (const [sleutel, paar] of t.matchups) {
    const delen = sleutel.split("|");
    const perTegen = pak(uit, `${delen[0]}|${delen[1]}`, () => new Map());
    const totaal = pak(perTegen, Number(delen[2]), nieuwPaar);
    totaal.games += paar.games;
    totaal.wins += paar.wins;
  }
  return uit;
}

/** Matchups opgeteld over alle lanes: ook een off-meta champion houdt zo bruikbare cijfers. */
function gepooldeMatchups(t) {
  const uit = new Map(); // champion -> Map(tegenstander -> {games, wins})
  for (const [sleutel, paar] of t.matchups) {
    const delen = sleutel.split("|");
    const champion = Number(delen[1]);
    const tegen = Number(delen[2]);
    const perTegen = pak(uit, champion, () => new Map());
    const totaal = pak(perTegen, tegen, nieuwPaar);
    totaal.games += paar.games;
    totaal.wins += paar.wins;
  }
  return uit;
}

/** Items/spells van een champion+lane, gesorteerd op hoe vaak ze voorkomen. */
function verzamelMet(kaart, prefix) {
  const uit = [];
  for (const [sleutel, paar] of kaart) {
    if (!sleutel.startsWith(prefix)) continue;
    uit.push({ staart: sleutel.slice(prefix.length), games: paar.games, wins: paar.wins });
  }
  return uit;
}

/* ── meta.json ───────────────────────────────────────────────────────────────*/

function bouwMeta(t, nu) {
  const champTotalen = championTotalen(t);

  const lanes = {};
  const laneQualifiers = {};
  for (const lane of LANES) {
    const rij = [];
    for (const champion of ROSTER) {
      const tally = t.champions.get(`${lane}|${champion}`);
      if (!tally || tally.games < MIN_LANE_GAMES) continue;
      rij.push({
        baseId: champion,
        classicId: CHAMPION_OFFSET + champion,
        naam: championNaam.get(champion),
        games: tally.games,
        winrate: rond(glad(tally.games, tally.wins), 1),
        winrateRuw: rond(ruw(tally.games, tally.wins), 1),
        pickRate: rond((tally.games / (t.slotenPerLane.get(lane) || 1)) * 100, 2),
        _adjusted: glad(tally.games, tally.wins),
      });
    }
    rij.sort((a, b) => b._adjusted - a._adjusted || b.games - a.games || a.baseId - b.baseId);
    laneQualifiers[lane] = rij.length;
    lanes[lane] = rij.slice(0, 10).map(({ _adjusted, ...rest }) => rest);
  }

  // De twaalf meest gespeelde champions, elk met de vier tegenstanders die het
  // beste tegen ze scoren in hun eigen drukste lane.
  const drukste = [...champTotalen.entries()]
    .sort((a, b) => b[1].games - a[1].games || a[0] - b[0])
    .slice(0, 12);

  const counters = drukste.map(([champion, totaal]) => {
    const lane = totaal.drukste;
    const laneTally = t.champions.get(`${lane}|${champion}`);
    const tegenstanders = [];
    for (const ander of ROSTER) {
      const paar = t.matchups.get(`${lane}|${ander}|${champion}`);
      if (!paar || paar.games < MIN_MATCHUP_GAMES) continue;
      tegenstanders.push({
        baseId: ander,
        classicId: CHAMPION_OFFSET + ander,
        naam: championNaam.get(ander),
        winrateTegen: rond(glad(paar.games, paar.wins), 1),
        winrateTegenRuw: rond(ruw(paar.games, paar.wins), 1),
        games: paar.games,
        _adjusted: glad(paar.games, paar.wins),
      });
    }
    tegenstanders.sort((a, b) => b._adjusted - a._adjusted || b.games - a.games || a.baseId - b.baseId);
    return {
      baseId: champion,
      classicId: CHAMPION_OFFSET + champion,
      naam: championNaam.get(champion),
      lane,
      laneGames: laneTally?.games ?? 0,
      totaleGames: totaal.games,
      counters: tegenstanders.slice(0, 4).map(({ _adjusted, ...rest }) => rest),
    };
  });

  return {
    generatedAt: nu,
    bron: "data/matches.jsonl",
    methode: {
      beschrijving: "Zelfde berekening als src/core/services/stats.ts, zodat site en app dezelfde cijfers tonen.",
      priorStrength: PRIOR_STRENGTH,
      gladgestrekenWinrate: "(wins + 10) / (games + 20)",
      minMatchupGames: MIN_MATCHUP_GAMES,
      minLaneGames: MIN_LANE_GAMES,
      tegenstander: "speler op dezelfde positie in het andere team",
      posities: "spelersloten met positie UNKNOWN tellen niet mee",
      eenheden: {
        winrate: "procent, gladgestreken, 1 decimaal",
        winrateRuw: "procent, ruwe wins/games, 1 decimaal",
        pickRate: "procent van alle spelersloten in die lane, 2 decimalen",
      },
    },
    totals: {
      games: t.games,
      players: t.spelers.size,
      champions: ROSTER.length,
      patches: patchVolgorde(t),
      generatedAt: nu,
      gamesPerPatch: gamesPerPatch(t),
      spelersloten: t.sloten,
      slotenZonderPositie: t.slotenZonderPositie,
      gemiddeldeDuurSeconden: rond(t.games ? t.duurTotaal / t.games : 0, 1),
      eersteGame: new Date(t.eerste).toISOString(),
      laatsteGame: new Date(t.laatste).toISOString(),
      overgeslagenDubbeleGameIds: t.dubbel,
      onleesbareRegels: t.onleesbaar,
    },
    lanes,
    laneQualifiers,
    counters,
    highlights: bouwHighlights(t, champTotalen),
  };
}

/** Totalen per champion over alle lanes met bekende positie. */
function championTotalen(t) {
  const uit = new Map();
  for (const champion of ROSTER) {
    let games = 0;
    let wins = 0;
    let kills = 0;
    let deaths = 0;
    let assists = 0;
    let drukste = null;
    let drukstGames = -1;
    for (const lane of LANES) {
      const tally = t.champions.get(`${lane}|${champion}`);
      if (!tally) continue;
      games += tally.games;
      wins += tally.wins;
      kills += tally.kills;
      deaths += tally.deaths;
      assists += tally.assists;
      if (tally.games > drukstGames) {
        drukstGames = tally.games;
        drukste = lane;
      }
    }
    uit.set(champion, { games, wins, kills, deaths, assists, drukste });
  }
  return uit;
}

const patchVolgorde = (t) => [...t.patches.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)).map(([p]) => p);
const gamesPerPatch = (t) => Object.fromEntries(patchVolgorde(t).map((p) => [p, t.patches.get(p)]));

/**
 * Drie bevindingen die meeschuiven met de data. Ze worden berekend en niet
 * opgeschreven: een bevinding die na de volgende crawl niet meer klopt is erger
 * dan geen bevinding.
 */
function bouwHighlights(t, champTotalen) {
  const gerangschikt = [...champTotalen.entries()]
    .filter(([, v]) => v.games > 0)
    .map(([champion, v]) => ({
      champion,
      naam: championNaam.get(champion),
      games: v.games,
      wins: v.wins,
      adjusted: glad(v.games, v.wins),
      ruw: ruw(v.games, v.wins),
    }))
    .sort((a, b) => b.adjusted - a.adjusted || b.games - a.games || a.champion - b.champion);

  const beste = gerangschikt[0];
  const slechtste = gerangschikt[gerangschikt.length - 1];
  const minimaalGames = Math.min(...gerangschikt.map((c) => c.games));

  // De scheefste rechtstreekse lane-matchup met een fatsoenlijke steekproef.
  const DREMPEL = 100;
  let scheef = null;
  let vergeleken = 0;
  for (const [sleutel, paar] of t.matchups) {
    if (paar.games < DREMPEL) continue;
    vergeleken++;
    const kans = ruw(paar.games, paar.wins);
    if (!scheef || kans > scheef.ruw) {
      const delen = sleutel.split("|");
      scheef = {
        lane: delen[0],
        champion: Number(delen[1]),
        tegen: Number(delen[2]),
        games: paar.games,
        wins: paar.wins,
        ruw: kans,
        adjusted: glad(paar.games, paar.wins),
      };
    }
  }

  const winrateBlauw = ruw(t.games, t.winsBlauw);
  const highlights = [
    {
      titel: `${beste.naam} is over alle lanes heen de sterkste champion`,
      tekst:
        `${beste.naam} wint ${beste.ruw.toFixed(1)}% van ${nl(beste.games)} gespeelde games ` +
        `(${nl(beste.wins)} overwinningen), gladgestreken ${beste.adjusted.toFixed(1)}%. Dat is de hoogste ` +
        `winrate van alle ${ROSTER.length} champions; onderaan staat ${slechtste.naam} met ` +
        `${slechtste.adjusted.toFixed(1)}% over ${nl(slechtste.games)} games. Een verschil van ` +
        `${(beste.adjusted - slechtste.adjusted).toFixed(1)} procentpunt.`,
      cijfers: {
        champion: beste.naam,
        baseId: beste.champion,
        classicId: CHAMPION_OFFSET + beste.champion,
        games: beste.games,
        wins: beste.wins,
        winrate: rond(beste.adjusted, 1),
        winrateRuw: rond(beste.ruw, 1),
        zwakste: {
          champion: slechtste.naam,
          baseId: slechtste.champion,
          classicId: CHAMPION_OFFSET + slechtste.champion,
          games: slechtste.games,
          wins: slechtste.wins,
          winrate: rond(slechtste.adjusted, 1),
          winrateRuw: rond(slechtste.ruw, 1),
        },
        verschilProcentpunt: rond(beste.adjusted - slechtste.adjusted, 1),
        alleChampionsMinimaalGames: minimaalGames,
      },
    },
    {
      titel: "Blauwe kant wint vaker dan rode kant",
      tekst:
        `Team 100 (blauw) wint ${winrateBlauw.toFixed(1)}% van alle ${nl(t.games)} games: ` +
        `${nl(t.winsBlauw)} overwinningen tegen ${nl(t.winsRood)} voor rood ` +
        `(${ruw(t.games, t.winsRood).toFixed(1)}%), een verschil van ${nl(Math.abs(t.winsBlauw - t.winsRood))} games.`,
      cijfers: {
        games: t.games,
        winsBlauw: t.winsBlauw,
        winsRood: t.winsRood,
        winrateBlauw: rond(winrateBlauw, 1),
        winrateRood: rond(ruw(t.games, t.winsRood), 1),
      },
    },
  ];

  if (scheef) {
    const naam = championNaam.get(scheef.champion);
    const tegenNaam = championNaam.get(scheef.tegen);
    highlights.push({
      titel: `${naam} tegen ${tegenNaam} is de meest eenzijdige lane-matchup`,
      tekst:
        `In de ${scheef.lane}-lane wint ${naam} ${scheef.ruw.toFixed(1)}% van de ${nl(scheef.games)} directe ` +
        `duels met ${tegenNaam} (${nl(scheef.wins)} van ${nl(scheef.games)}), gladgestreken ` +
        `${scheef.adjusted.toFixed(1)}%. Dat is de scheefste matchup van alle ${nl(vergeleken)} matchups met ` +
        `minimaal ${DREMPEL} onderlinge games.`,
      cijfers: {
        lane: scheef.lane,
        champion: naam,
        championBaseId: scheef.champion,
        tegenstander: tegenNaam,
        tegenstanderBaseId: scheef.tegen,
        games: scheef.games,
        wins: scheef.wins,
        winrate: rond(scheef.adjusted, 1),
        winrateRuw: rond(scheef.ruw, 1),
        vergelekenMatchups: vergeleken,
        drempelGames: DREMPEL,
      },
    });
  }

  return highlights;
}

/* ── champions.json ──────────────────────────────────────────────────────────*/

/**
 * Uit een tabel tegenstander -> {games, wins} de vijf beste en vijf slechtste.
 *
 * Precies dezelfde drempel en volgorde als strongAgainst/strugglesAgainst in
 * src/core/services/stats.ts, want de app en de site horen nooit een ander
 * antwoord te geven op dezelfde vraag.
 */
function tegenstanders(perTegen, eis = null) {
  const matchups = [];
  const drempel = eis?.drempel ?? MIN_MATCHUP_GAMES;
  for (const [tegen, paar] of perTegen ?? []) {
    if (paar.games < drempel) continue;
    // Alleen tegenstanders die in deze lane ook echt voorkomen. Zie MIN_LANE_SHARE.
    if (eis && eis.laneAandeel(tegen) < MIN_LANE_SHARE) continue;
    matchups.push({
      baseId: tegen,
      name: championNaam.get(tegen),
      winrate: glad(paar.games, paar.wins),
      winrateRaw: ruw(paar.games, paar.wins),
      games: paar.games,
    });
  }
  const naarUit = (m) => ({
    baseId: m.baseId,
    name: m.name,
    winrate: vast(m.winrate, 1),
    winrateRaw: vast(m.winrateRaw, 1),
    games: m.games,
  });
  return {
    beats: matchups
      .filter((m) => m.winrateRaw > 50)
      .sort((a, b) => b.winrate - a.winrate || b.games - a.games || a.baseId - b.baseId)
      .slice(0, 5)
      .map(naarUit),
    losesTo: matchups
      .filter((m) => m.winrateRaw < 50)
      .sort((a, b) => a.winrate - b.winrate || b.games - a.games || a.baseId - b.baseId)
      .slice(0, 5)
      .map(naarUit),
  };
}

function bouwChampions(t, nu) {
  const perLaneRang = rangenPerLane(t);
  const pool = gepooldeMatchups(t);
  const perLaneTegen = laneMatchups(t);
  const champTotalen = championTotalen(t);
  const laneQualifiers = Object.fromEntries(LANES.map((lane) => [lane, perLaneRang.get(lane).size]));

  const champions = {};
  for (const champion of ROSTER) {
    const totaal = champTotalen.get(champion);
    const lanes = [];
    for (const lane of LANES) {
      const tally = t.champions.get(`${lane}|${champion}`);
      if (!tally) continue;
      const gekwalificeerd = tally.games >= MIN_LANE_GAMES;
      const regel = {
        lane,
        games: tally.games,
        wins: tally.wins,
        winrate: vast(glad(tally.games, tally.wins), 1),
        winrateRaw: vast(ruw(tally.games, tally.wins), 1),
        pickRate: rond((tally.games / (t.slotenPerLane.get(lane) || 1)) * 100, 2),
        qualified: gekwalificeerd,
      };
      // Een rang zonder drempel zou een lane met 40 games naast een met 8.000 zetten.
      if (gekwalificeerd) {
        regel.rank = perLaneRang.get(lane).get(champion);
        regel.rankOf = perLaneRang.get(lane).size;
      }
      // De tegenstander die in DEZE lane tegenover je stond. Vaak zijn dit er
      // minder dan bij de gepoolde variant, want MIN_MATCHUP_GAMES geldt nu per
      // lane. Dat is de bedoeling: liever vier eerlijke dan tien verzonnen.
      // Twee eisen, allebei nodig. De eerste zorgt dat er namen staan die je
      // echt tegenover je krijgt, de tweede dat het getal ernaast iets waard is.
      const slots = t.slotenPerLane.get(lane) || 1;
      const eigen = tegenstanders(perLaneTegen.get(`${lane}|${champion}`), {
        drempel: Math.max(MIN_MATCHUP_GAMES, Math.round(tally.games * MIN_MATCHUP_SHARE)),
        laneAandeel: (tegen) => (t.champions.get(`${lane}|${tegen}`)?.games ?? 0) / slots,
      });
      regel.beats = eigen.beats;
      regel.losesTo = eigen.losesTo;
      lanes.push(regel);
    }
    lanes.sort((a, b) => b.games - a.games || LANES.indexOf(a.lane) - LANES.indexOf(b.lane));

    // De sterkste lane is de gekwalificeerde met de hoogste gladgestreken winrate;
    // haalt geen enkele lane de drempel, dan de meest gespeelde.
    let sterkste = null;
    let besteWaarde = -Infinity;
    for (const regel of lanes) {
      if (!regel.qualified) continue;
      const waarde = glad(regel.games, regel.wins);
      if (waarde > besteWaarde) {
        besteWaarde = waarde;
        sterkste = regel.lane;
      }
    }
    if (!sterkste) sterkste = lanes[0]?.lane ?? null;

    const { beats, losesTo } = tegenstanders(pool.get(champion));

    champions[champion] = {
      baseId: champion,
      classicId: CHAMPION_OFFSET + champion,
      name: championNaam.get(champion),
      totalGames: totaal.games,
      totalWins: totaal.wins,
      winrate: vast(glad(totaal.games, totaal.wins), 1),
      winrateRaw: vast(ruw(totaal.games, totaal.wins), 1),
      lanes,
      strongestLane: sterkste,
      beats,
      losesTo,
      kda: {
        kills: vast(totaal.games ? totaal.kills / totaal.games : 0, 1),
        deaths: vast(totaal.games ? totaal.deaths / totaal.games : 0, 1),
        assists: vast(totaal.games ? totaal.assists / totaal.games : 0, 1),
        ratio: rond(totaal.deaths ? (totaal.kills + totaal.assists) / totaal.deaths : totaal.kills + totaal.assists, 2),
      },
      gamesInclUnknownLane: t.slotenInclUnknown.get(champion) ?? 0,
    };
  }

  return {
    generatedAt: nu,
    bron: "data/matches.jsonl",
    method: {
      beschrijving: "Zelfde berekening als src/core/services/stats.ts, zodat site en app dezelfde cijfers tonen.",
      priorStrength: PRIOR_STRENGTH,
      gladgestrekenWinrate: "(wins + 10) / (games + 20)",
      minMatchupGames: MIN_MATCHUP_GAMES,
      minLaneGames: MIN_LANE_GAMES,
      tegenstander: "speler op dezelfde positie in het andere team",
      posities: "spelersloten met positie UNKNOWN tellen niet mee",
      eenheden: {
        winrate: "procent, gladgestreken, 1 decimaal",
        winrateRaw: "procent, ruwe wins/games, 1 decimaal",
        pickRate: "procent van alle spelersloten in die lane, 2 decimalen",
      },
      afwijkingenTenOpzichteVanMetaJson: [
        `Alle ${ROSTER.length} champions uit site/img/champions/manifest.json staan erin, niet alleen de top 10 per lane.`,
        "lanes bevat elke lane waarin de champion voorkomt. qualified=true vanaf 100 lane-games; alleen dan is er een rank (plus rankOf: het aantal gekwalificeerde champions in die lane).",
        "totalGames/totalWins/kda tellen alleen spelersloten met een bekende positie, dus totalGames is exact de som van de lane-games. gamesInclUnknownLane laat zien hoeveel games er inclusief UNKNOWN-sloten waren.",
        "beats/losesTo op championniveau zijn gepoold over alle lanes: per lane geldt nog steeds 'tegenstander op dezelfde positie in het andere team', maar de tellingen van de lanes worden bij elkaar opgeteld voordat MIN_MATCHUP_GAMES=8 wordt toegepast. Zo hebben ook off-meta champions bruikbare matchups.",
        "lanes[].beats/losesTo zijn NIET gepoold: dat zijn alleen de tegenstanders uit die ene lane, met MIN_MATCHUP_GAMES=8 per lane. Dat is wat je bij een pick wilt weten -- gepoold kwam Kog'Maw eruit met Skarner en Malphite als beste matchups, die nooit tegenover hem in de botlane staan.",
        "beats bevat alleen matchups met een ruwe winrate boven 50%, losesTo alleen onder 50% (zelfde filter als strongAgainst/strugglesAgainst in stats.ts); gesorteerd op gladgestreken winrate. Daardoor kunnen het er minder dan 5 zijn.",
        "strongestLane = de gekwalificeerde lane met de hoogste gladgestreken winrate; heeft geen enkele lane 100 games, dan de meest gespeelde lane.",
        "Bevat uitsluitend geaggregeerde champion-cijfers; geen spelersidentificatie van welke aard dan ook.",
      ],
    },
    totals: {
      champions: ROSTER.length,
      games: t.games,
      spelersloten: t.sloten,
      slotenZonderPositie: t.slotenZonderPositie,
      overgeslagenDubbeleGameIds: t.dubbel,
      onleesbareRegels: t.onleesbaar,
      patches: patchVolgorde(t),
      gamesPerPatch: gamesPerPatch(t),
      spelerslotenPerLane: Object.fromEntries(LANES.map((lane) => [lane, t.slotenPerLane.get(lane) ?? 0])),
      laneQualifiers,
    },
    champions,
  };
}

/* ── builds.json ─────────────────────────────────────────────────────────────*/

const TOON_ITEMS = 12;
const TOON_LAARZEN = 3;
const TOON_STARTITEMS = 3;
const TOON_SPELLS = 5;
const TOON_CORE = 3;

/** Welke champion+lane-combinaties genoeg games hebben om builds van te tonen. */
function buildLanes(t) {
  const uit = [];
  for (const champion of ROSTER) {
    for (const lane of LANES) {
      const tally = t.champions.get(`${lane}|${champion}`);
      if (tally && tally.games >= MIN_LANE_GAMES) uit.push({ champion, lane, tally, sleutel: `${lane}|${champion}` });
    }
  }
  return uit;
}

/** De kandidaten voor core: de 30 vaakst gebouwde echte items per champion+lane. */
function corePoelen(t, lanes) {
  const uit = new Map();
  for (const { sleutel } of lanes) {
    const rij = verzamelMet(t.items, `${sleutel}|`)
      .map((r) => ({ item: Number(r.staart), games: r.games }))
      .filter((r) => teltMeeAlsCore(r.item))
      .sort((a, b) => b.games - a.games || a.item - b.item)
      .slice(0, CORE_KANDIDATEN);
    uit.set(sleutel, new Set(rij.map((r) => r.item)));
  }
  return uit;
}

function bouwBuilds(t, combinaties, lanes, nu) {
  const gebruikteItems = new Set();
  const gebruikteSpells = new Set();
  const weggelaten = { laarzen: 0, startitems: 0 };

  const itemRegel = (item, games, wins, laneGames) => {
    gebruikteItems.add(item);
    return {
      baseId: item,
      itemId: ITEM_OFFSET + item,
      naam: itemPerBase.get(item)?.name ?? String(item),
      games,
      pickRate: vast((games / laneGames) * 100, 1),
      winrate: vast(glad(games, wins), 1),
      winrateRaw: vast(ruw(games, wins), 1),
    };
  };

  const perChampion = new Map();
  for (const { champion, lane, tally, sleutel } of lanes) {
    const laneGames = tally.games;

    const alleItems = verzamelMet(t.items, `${sleutel}|`)
      .map((r) => ({ item: Number(r.staart), games: r.games, wins: r.wins }))
      .sort((a, b) => b.games - a.games || a.item - b.item);

    const laarzen = alleItems.filter((r) => LAARZEN.has(r.item));
    const startitems = alleItems.filter((r) => STARTITEMS.has(r.item));
    // De drie kolommen op de site moeten elk iets ANDERS zeggen. Deden ze niet:
    // bij Tryndamere top stond "Berserker's Greaves 78,8%" bovenaan bij items,
    // en er pal naast nog een keer bij laarzen. Bij Soraka gold hetzelfde voor
    // Ionian Boots, en Doran's Ring stond zowel bij items als bij startitems.
    // De bovenste regel van de itemlijst ging zo altijd verloren aan iets wat
    // er al stond. Laarzen en startitems hebben hun eigen kolom; items zijn nu
    // wat daar niet in zit.
    const echteItems = alleItems.filter((r) => !LAARZEN.has(r.item) && !STARTITEMS.has(r.item));
    // Zeldzame laarzen en startitems gaan eraf om het bestand onder de 900 KB te
    // houden; hoeveel dat er waren staat in totals.weggelatenRegels.
    weggelaten.laarzen += Math.max(0, laarzen.length - TOON_LAARZEN);
    weggelaten.startitems += Math.max(0, startitems.length - TOON_STARTITEMS);

    const spells = verzamelMet(t.spells, `${sleutel}|`)
      .map((r) => {
        const [a, b] = r.staart.split("-").map(Number);
        return { spells: [a, b], games: r.games, wins: r.wins };
      })
      .sort((a, b) => b.games - a.games || a.spells[0] - b.spells[0] || a.spells[1] - b.spells[1])
      .slice(0, TOON_SPELLS)
      .map((r) => {
        gebruikteSpells.add(r.spells[0]);
        gebruikteSpells.add(r.spells[1]);
        return {
          spells: r.spells,
          games: r.games,
          pickRate: vast((r.games / laneGames) * 100, 1),
          winrate: vast(glad(r.games, r.wins), 1),
          winrateRaw: vast(ruw(r.games, r.wins), 1),
        };
      });

    // Drietallen die vaak samen in de eindinventaris zitten. Zijn er te weinig met
    // genoeg games, dan vullen paren aan -- te herkennen aan 2 ids in "items".
    const tellingen = combinaties.get(sleutel) ?? new Map();
    const drietallen = [];
    const paren = [];
    for (const [combi, paar] of tellingen) {
      const ids = combi.split("-").map(Number);
      const regel = { items: ids, games: paar.games, wins: paar.wins };
      if (ids.length === 3) drietallen.push(regel);
      else paren.push(regel);
    }
    const opGames = (a, b) => b.games - a.games || a.items[0] - b.items[0] || a.items[1] - b.items[1];
    drietallen.sort(opGames);
    paren.sort(opGames);
    const core = drietallen.filter((r) => r.games >= CORE_MIN_GAMES).slice(0, TOON_CORE);
    for (const paar of paren) {
      if (core.length >= TOON_CORE) break;
      core.push(paar);
    }
    for (const regel of core) for (const id of regel.items) gebruikteItems.add(id);

    const laneUit = {
      lane,
      games: laneGames,
      wins: tally.wins,
      winrate: vast(glad(laneGames, tally.wins), 1),
      winrateRaw: vast(ruw(laneGames, tally.wins), 1),
      kda: {
        kills: rond(tally.kills / laneGames, 2),
        deaths: rond(tally.deaths / laneGames, 2),
        assists: rond(tally.assists / laneGames, 2),
        ratio: rond(tally.deaths ? (tally.kills + tally.assists) / tally.deaths : tally.kills + tally.assists, 2),
      },
      items: echteItems.slice(0, TOON_ITEMS).map((r) => itemRegel(r.item, r.games, r.wins, laneGames)),
      boots: laarzen.slice(0, TOON_LAARZEN).map((r) => itemRegel(r.item, r.games, r.wins, laneGames)),
      starters: startitems.slice(0, TOON_STARTITEMS).map((r) => itemRegel(r.item, r.games, r.wins, laneGames)),
      core: core.map((r) => ({
        items: r.items,
        games: r.games,
        pickRate: vast((r.games / laneGames) * 100, 1),
        winrate: vast(glad(r.games, r.wins), 1),
        winrateRaw: vast(ruw(r.games, r.wins), 1),
      })),
      spells,
    };
    pak(perChampion, champion, () => []).push(laneUit);
  }

  const champTotalen = championTotalen(t);
  const champions = {};
  for (const champion of ROSTER) {
    const lijst = perChampion.get(champion);
    if (!lijst || lijst.length === 0) continue;
    const totaal = champTotalen.get(champion);
    champions[champion] = {
      baseId: champion,
      classicId: CHAMPION_OFFSET + champion,
      name: championNaam.get(champion),
      totalGames: totaal.games,
      totalWins: totaal.wins,
      lanes: lijst.sort((a, b) => LANES.indexOf(a.lane) - LANES.indexOf(b.lane)),
    };
  }

  const itemtabel = {};
  for (const item of [...gebruikteItems].sort((a, b) => a - b)) {
    const catalogusRegel = itemPerBase.get(item);
    itemtabel[item] = {
      itemId: ITEM_OFFSET + item,
      naam: catalogusRegel?.name ?? String(item),
      prijs: catalogusRegel?.price ?? 0,
      laars: LAARZEN.has(item),
      startitem: STARTITEMS.has(item),
    };
  }
  const spelltabel = {};
  for (const spell of [...gebruikteSpells].sort((a, b) => a - b)) spelltabel[spell] = spellNaam(spell);

  return {
    // Zonder milliseconden, want dit bestand wordt met de hand vergeleken tussen
    // twee versies en de precisie zou daar alleen ruis zijn.
    generatedAt: nu.replace(/\.\d{3}Z$/, "Z"),
    bron: "data/matches.jsonl",
    startersToelichting:
      "Deze startitems zijn AFGELEID uit wat aan het eind van de game nog in de inventaris zat, niet gemeten als eerste aankoop. De matchdata bevat alleen de eindinventaris: geen aankoopvolgorde, geen tijdlijn, geen timestamps. Een startitem dat verkocht is, zie je hier dus niet terug, en de volgorde waarin er gekocht is valt uit deze data niet af te leiden.",
    method: {
      beschrijving: "Zelfde berekening als src/core/services/stats.ts, zodat site en app dezelfde cijfers tonen.",
      priorStrength: PRIOR_STRENGTH,
      gladgestrekenWinrate: "(wins + 10) / (games + 20)",
      minLaneGames: MIN_LANE_GAMES,
      posities: "spelersloten met positie UNKNOWN tellen niet mee",
      itemsPerSpeler: "items[0..5] uit de eindinventaris; slot 7 (trinket) telt niet mee; dubbele items tellen een keer",
      pickRate: "percentage van de games van die champion in die lane waarin het item in de eindinventaris stond",
      eenheden: {
        winrate: "procent, gladgestreken, 1 decimaal",
        winrateRaw: "procent, ruwe wins/games, 1 decimaal",
        pickRate: "procent, 1 decimaal",
      },
      geenVolgorde:
        "De bron bevat geen aankoopvolgorde en geen tijdlijn. Nergens in dit bestand staat een volgorde; 'core' is een combinatie die vaak samen in de eindinventaris zit, geen buildpad.",
      core: `De ${TOON_CORE} drietallen die het vaakst samen in de eindinventaris zitten, geteld over de ${CORE_KANDIDATEN} vaakst gebouwde items van die champion in die lane. Laarzen, startitems, consumables en trinkets doen niet mee, anders bestaat elke combinatie uit laarzen. Heeft een champion+lane minder dan ${TOON_CORE} drietallen met ${CORE_MIN_GAMES}+ games, dan is aangevuld met de vaakst voorkomende paren (te herkennen aan 2 ids in 'items').`,
      spells: "spellpaar oplopend gesorteerd, zodat Flash+Ignite en Ignite+Flash hetzelfde paar zijn",
    },
    filters: {
      trinkets: [...TRINKETS].sort((a, b) => a - b),
      consumables: [...CONSUMABLES].sort((a, b) => a - b),
      nietKoopbaar: [...NIET_KOOPBAAR].sort((a, b) => a - b),
      laarzenHerkendAls: "Boots of Speed (1001) plus elk item dat daaruit doorbouwt",
      startitemHerkendAls: "basiscomponent zonder buildsFrom, prijs 1-500 gold, geen consumable",
      toelichting:
        "Trinkets en consumables zijn uit alle tellingen gehouden. Boots of Speed staat zowel bij laarzen als bij startitems, want het is allebei.",
      kolommenZijnDisjunct:
        "items bevat GEEN laarzen en GEEN startitems; die hebben hun eigen lijst. Anders stond hetzelfde item in twee kolommen naast elkaar.",
      afkapping: `Om onder de 900 KB te blijven staan per champion+lane de ${TOON_ITEMS} vaakst gebouwde items, de ${TOON_LAARZEN} vaakste laarzen en de ${TOON_STARTITEMS} vaakste startitems in dit bestand. Zeldzamere laarzen en startitems zijn weggelaten; zie totals.weggelatenRegels voor hoeveel.`,
    },
    totals: {
      champions: Object.keys(champions).length,
      laneVermeldingen: lanes.length,
      regelsGelezen: t.regels,
      games: t.games,
      overgeslagenDubbeleGameIds: t.dubbel,
      onleesbareRegels: t.onleesbaar,
      spelerslotenZonderPositie: t.slotenZonderPositie,
      spelerslotenPerLane: Object.fromEntries(LANES.map((lane) => [lane, t.slotenPerLane.get(lane) ?? 0])),
      patches: gamesPerPatch(t),
      weggelatenRegels: weggelaten,
    },
    itemtabel,
    spelltabel,
    champions,
  };
}

/* ── Uitvoeren ───────────────────────────────────────────────────────────────*/

const opties = argumenten(process.argv.slice(2));
const database = zoekDatabase(opties.in);
const uitmap = isAbsolute(opties.out) ? opties.out : resolve(process.cwd(), opties.out);
mkdirSync(uitmap, { recursive: true });

// Hier wordt het venster vastgelegd. Alles hierna leest tot precies deze byte,
// ook de tweede doorloop, zodat de drie bestanden dezelfde jaargang krijgen.
const fd = openSync(database, "r");
const GRENS = fstatSync(fd).size;
closeSync(fd);

const start = Date.now();
console.log(`[refresh] lezen: ${database} (${(GRENS / 1024 / 1024).toFixed(1)} MB bevroren)`);
if (opties.lines !== Infinity) console.log(`[refresh] beperkt tot ${nl(opties.lines)} regels (--lines)`);

const t = tellen(database, GRENS, opties.lines);
console.log(
  `[refresh] doorloop 1: ${nl(t.games)} games, ${nl(t.sloten)} spelersloten, ${nl(t.spelers.size)} unieke spelers ` +
    `(${((Date.now() - start) / 1000).toFixed(1)}s)`,
);

const lanes = buildLanes(t);
const poelen = corePoelen(t, lanes);
const combinaties = combinatiesTellen(database, GRENS, opties.lines, poelen);
console.log(
  `[refresh] doorloop 2: itemcombinaties voor ${nl(lanes.length)} champion+lane-vermeldingen ` +
    `(${((Date.now() - start) / 1000).toFixed(1)}s)`,
);

const nu = new Date().toISOString();
const meta = bouwMeta(t, nu);
const champions = bouwChampions(t, nu);
const builds = bouwBuilds(t, combinaties, lanes, nu);

// meta.json wordt met de hand gelezen, dus die krijgt inspringing; de andere twee
// zijn machinevoer en gaan compact de deur uit.
const bestanden = [
  ["meta.json", serialiseer(meta, 2) + "\n"],
  ["champions.json", serialiseer(champions, 0)],
  ["builds.json", serialiseer(builds, 0)],
];
for (const [naam, inhoud] of bestanden) {
  writeFileSync(join(uitmap, naam), inhoud, "utf8");
  console.log(`[refresh] geschreven: ${join(uitmap, naam)} (${(Buffer.byteLength(inhoud) / 1024).toFixed(0)} KB)`);
}

console.log(
  [
    `[refresh] klaar in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    `          regels gelezen        ${nl(t.regels)}`,
    `          games                 ${nl(t.games)} (${nl(t.dubbel)} dubbele gameIds overgeslagen, ${nl(t.onleesbaar)} onleesbare regels)`,
    `          spelersloten          ${nl(t.sloten)}, waarvan ${nl(t.slotenZonderPositie)} zonder positie`,
    `          unieke spelers        ${nl(t.spelers.size)}`,
    `          champions             ${Object.keys(champions.champions).length} in champions.json, ${Object.keys(builds.champions).length} in builds.json`,
    `          champion+lane builds  ${nl(lanes.length)}`,
    `          patches               ${meta.totals.patches.map((p) => `${p}: ${nl(meta.totals.gamesPerPatch[p])}`).join(", ")}`,
    "          Alle drie de bestanden komen uit hetzelfde bevroren venster.",
  ].join("\n"),
);
