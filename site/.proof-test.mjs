// Scratch harness: exercises bewijs() against the real data, writes nothing to the site.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));

const meta = read("data/meta.json");
const champions = read("data/champions.json");
const CH = champions.totals;
const MT = meta.totals;

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

/* ══ PASTE BLOCK STARTS ═══════════════════════════════════════════════════ */

/**
 * Largest-remainder apportionment.
 *
 * The mark field draws one mark per thousand player slots, so every lane needs a
 * whole number of marks that still add up to exactly the number of marks drawn.
 * Rounding each share on its own does not do that -- it lands one or two over or
 * under and the field ends ragged. Hamilton's method gives each group the floor
 * of its share and hands the leftovers to the largest remainders, which is both
 * exact in total and never more than one mark off any single share.
 */
function verdeelRest(waarden, totaal) {
  const som = waarden.reduce((a, b) => a + b, 0);
  if (!som) return waarden.map(() => 0);
  const exact = waarden.map((v) => (v / som) * totaal);
  const uit = exact.map((v) => Math.floor(v));
  const rest = totaal - uit.reduce((a, b) => a + b, 0);
  const grootste = exact
    .map((v, i) => [v - Math.floor(v), i])
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i);
  for (let k = 0; k < rest; k++) uit[grootste[k % grootste.length]]++;
  return uit;
}

/** Geometry of the mark field. 125 x 10 = 1250 marks, one per thousand slots. */
const VELD = { kolommen: 125, rijen: 10, cel: 8, breed: 4, hoog: 6 };

/**
 * The field is filled column by column, not row by row, so each group ends up as
 * a solid vertical band with one ragged column at its edge. Filled in reading
 * order the bands would wrap across ten rows and the split would be unreadable.
 */
function merkenVeld(groepen) {
  const totaalMerken = VELD.kolommen * VELD.rijen;
  const merken = verdeelRest(
    groepen.map((g) => g.waarde),
    totaalMerken,
  );
  let i = 0;
  return groepen.map((g, gi) => {
    let d = "";
    for (let k = 0; k < merken[gi]; k++, i++) {
      const x = Math.floor(i / VELD.rijen) * VELD.cel + (VELD.cel - VELD.breed) / 2;
      const y = (i % VELD.rijen) * VELD.cel + (VELD.cel - VELD.hoog) / 2;
      d += "M" + x + "," + y + "h" + VELD.breed + "v" + VELD.hoog + "h-" + VELD.breed + "z";
    }
    return { ...g, d, merken: merken[gi] };
  });
}

/** mm:ss from seconds, for a mean game length that is stored as 1799.6. */
const mmss = (sec) => {
  const s = Math.round(sec);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

/**
 * The proof layer.
 *
 * "125,096 games" is a claim, and a claim is worth exactly what a visitor is
 * willing to take on faith -- which, for a stats site, is nothing. So this
 * section stops asserting and starts showing its books: every counter the
 * crawler kept, including the ones that make the sample look worse. The nine
 * duplicate game ids and the 164,160 slots with no position are the whole point.
 * A fabricated dataset does not have a nine in it.
 *
 * Everything here is read straight off champions.json's totals and meta.json's
 * totals. The four derived figures (games per day, hours of game time, games per
 * player, share of slots) carry their own arithmetic in the note beside them, so
 * a reader can check the multiplication themselves.
 */
function bewijs() {
  /* ── The mark field: every player slot, split by lane ─────────────────── */

  const slotenPerLane = CH.spelerslotenPerLane;
  const groepen = merkenVeld([
    ...LANES.map(({ key, label }, i) => ({
      key,
      label,
      waarde: slotenPerLane[key],
      dek: [1, 0.84, 0.68, 0.54, 0.4][i],
      qual: CH.laneQualifiers[key],
    })),
    {
      key: "UNKNOWN",
      label: "No position",
      waarde: CH.slotenZonderPositie,
      dek: 0.42,
      qual: null,
      uit: true,
    },
  ]);

  const aandeel = (v) => (v / CH.spelersloten) * 100;

  const paden = groepen
    .map(
      (g) =>
        `<path d="${g.d}" data-groep="${g.key}" fill="${g.uit ? "var(--dim)" : "var(--gold)"}" opacity="${g.dek}" />`,
    )
    .join("\n        ");

  const legenda = groepen
    .map(
      (g) => `
          <tr data-groep="${g.key}"${g.uit ? ` class="uit"` : ""}>
            <th scope="row"><span class="vk" style="--dek:${g.dek}"></span>${esc(g.label)}</th>
            <td class="num">${n(g.waarde)}</td>
            <td class="num zwak">${aandeel(g.waarde).toFixed(2)}%</td>
            <td class="num zwak">${g.qual === null ? `&mdash;` : `${g.qual}<span class="van">/63</span>`}</td>
          </tr>`,
    )
    .join("");

  /* ── The same games, split by the two patches they came from ──────────── */

  const patchBalk = CH.patches
    .map((p) => {
      const g = CH.gamesPerPatch[p];
      return `
          <div class="patch-deel" style="--breed:${((g / CH.games) * 100).toFixed(3)}%">
            <span class="patch-naam">Patch ${esc(p)}</span>
            <span class="patch-getal mono">${n(g)}</span>
          </div>`;
    })
    .join("");

  /* ── The ledger ───────────────────────────────────────────────────────── */

  const dagen = (new Date(MT.laatsteGame) - new Date(MT.eersteGame)) / 86400000;
  const perDag = CH.games / dagen;
  const speeluren = (CH.games * MT.gemiddeldeDuurSeconden) / 3600;
  const perSpeler = CH.spelersloten / MT.players;

  const regels = [
    ["Source", `data/matches.jsonl`, `one line per finished game, written by the app itself`],
    ["Games recorded", n(CH.games), `every one a finished Classic game, de-duplicated by id`],
    ["Player slots", n(CH.spelersloten), `${n(CH.games)} &times; 10 &mdash; not one game read half`],
    [
      "Distinct players",
      n(MT.players),
      `unique account ids; ${perSpeler.toFixed(1)} recorded games each on average`,
    ],
    ["Duplicate game ids dropped", n(CH.overgeslagenDubbeleGameIds), `the same match handed in twice`],
    ["Lines that would not parse", n(CH.onleesbareRegels), `nothing was skipped to make the totals tidier`],
    ["Patches covered", CH.patches.map((p) => esc(p)).join(" &middot; "), `both pooled in every figure on this site`],
    [
      "Collection window",
      `${DATE(MT.eersteGame)} &ndash; ${DATE(MT.laatsteGame)}`,
      `${dagen.toFixed(1)} days, about ${n(Math.round(perDag / 10) * 10)} games a day`,
    ],
    ["Mean game length", mmss(MT.gemiddeldeDuurSeconden), `${n(MT.gemiddeldeDuurSeconden)} seconds, measured`],
    [
      "Game time behind the numbers",
      `${n(Math.round(speeluren))} hours`,
      `games &times; mean length &mdash; ${(speeluren / 8766).toFixed(1)} years of League`,
    ],
    ["Minimum for a lane rank", `100 games`, `below it a champion is listed, never ranked`],
    ["Minimum for a matchup", `8 games`, `and the sample size is printed next to every one`],
    [
      "Smoothing prior",
      `20 games`,
      `(wins + 10) / (games + 20), so a 3&ndash;0 does not read as 100%`,
    ],
    ["Table generated", DATE(champions.generatedAt), `rebuilt from the raw file every time it runs`],
  ];

  return `
<section class="band bewijs" id="proof">
  <div class="wrap">

    <div class="sectiekop rise">
      <p class="eyebrow">The receipts</p>
      <h2>${n(CH.games)} games is a claim. This is what it is made of.</h2>
      <p class="sectielede">
        There is no panel of experts here and no model. There is one file &mdash;
        <code>matches.jsonl</code>, a line per finished game, written by the app as people play
        &mdash; and everything on this site is counted out of it. So here are its books, including
        the counters that make the sample look smaller than it is.
      </p>
    </div>

    <figure class="bewijs-veld rise" data-bewijs>
      <figcaption class="veld-kop">
        <p class="veld-groot">
          <b class="mono" data-tel="${CH.spelersloten}">${n(CH.spelersloten)}</b>
          <span>player slots read &mdash; every player, in every game, on both teams</span>
        </p>
        <p class="block-label">One mark = 1,000 slots &middot; grouped by the lane it was played in</p>
      </figcaption>

      <svg class="veld-svg" viewBox="0 0 ${VELD.kolommen * VELD.cel} ${VELD.rijen * VELD.cel}" role="img" aria-labelledby="veld-t veld-d" preserveAspectRatio="none">
        <title id="veld-t">${n(CH.spelersloten)} player slots, split by lane</title>
        <desc id="veld-d">A field of 1,250 marks, one per thousand player slots. The table below carries the same figures.</desc>
        ${paden}
      </svg>

      <div class="veld-rol">
      <table class="veld-legenda">
        <caption class="vh">Player slots per lane</caption>
        <thead>
          <tr>
            <th scope="col">Lane</th>
            <th scope="col" class="num">Player slots</th>
            <th scope="col" class="num">Share</th>
            <th scope="col" class="num">Ranked champions</th>
          </tr>
        </thead>
        <tbody>${legenda}</tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td class="num">${n(CH.spelersloten)}</td>
            <td class="num zwak">100%</td>
            <td class="num zwak">&mdash;</td>
          </tr>
        </tfoot>
      </table>
      </div>

      <p class="veld-noot">
        The grey band is the honest part: <strong>${n(CH.slotenZonderPositie)} slots</strong> came in
        without a position the client could name, so they are counted here and counted nowhere else.
        No lane number, no tier list and no matchup on this site uses them. The last column is the
        other half of that &mdash; how many of the 63 champions actually cleared 100 games in that
        lane, which is why Support ranks ${CH.laneQualifiers.SUPPORT} and Top ranks ${CH.laneQualifiers.TOP}.
      </p>
    </figure>

    <figure class="bewijs-patch rise">
      <figcaption class="block-label">The same ${n(CH.games)} games, by the patch they were played on</figcaption>
      <div class="patch-balk">${patchBalk}</div>
    </figure>

    <div class="grootboek rise">
      <div class="gb-rol">
      <table>
        <caption class="vh">Collection ledger</caption>
        <tbody>
          ${regels
            .map(
              ([k, v, note]) => `<tr>
            <th scope="row">${k}</th>
            <td class="gb-waarde mono">${v}</td>
            <td class="gb-noot">${note}</td>
          </tr>`,
            )
            .join("\n          ")}
        </tbody>
      </table>
      </div>
      <p class="gb-voet">
        Every figure above is a counter kept while the file was read, or arithmetic on two of them.
        The same totals drive the tier lists, the builds and the app itself.
        <a href="classic.html#tiers">See what they add up to</a>.
      </p>
    </div>

  </div>
</section>

<script>
(function () {
  var veld = document.querySelector("[data-bewijs]");
  if (!veld) return;

  /* Hovering a lane in the table lifts its band out of the field, and the other
     way round. Without JS the field and the table simply both stand there. */
  var paden = veld.querySelectorAll(".veld-svg [data-groep]");
  var rijen = veld.querySelectorAll(".veld-legenda tbody [data-groep]");
  function markeer(sleutel) {
    veld.classList.toggle("gericht", !!sleutel);
    [].forEach.call(paden, function (p) { p.classList.toggle("stil", !!sleutel && p.getAttribute("data-groep") !== sleutel); });
    [].forEach.call(rijen, function (r) { r.classList.toggle("aan", r.getAttribute("data-groep") === sleutel); });
  }
  [].forEach.call(rijen, function (r) {
    r.addEventListener("mouseenter", function () { markeer(r.getAttribute("data-groep")); });
    r.addEventListener("mouseleave", function () { markeer(null); });
  });
  [].forEach.call(paden, function (p) {
    p.addEventListener("mouseenter", function () { markeer(p.getAttribute("data-groep")); });
    p.addEventListener("mouseleave", function () { markeer(null); });
  });

  /* The slot count counts up once, on arrival. The final value is already in the
     HTML, so a visitor without JS -- or with reduced motion on -- reads it whole. */
  var tel = veld.querySelector("[data-tel]");
  var traag = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!tel || traag || !("IntersectionObserver" in window)) return;
  var doel = Number(tel.getAttribute("data-tel"));
  var eind = tel.textContent;
  var waarnemer = new IntersectionObserver(function (ingangen, zelf) {
    if (!ingangen[0].isIntersecting) return;
    zelf.disconnect();
    var start = 0;
    function stap(nu) {
      if (!start) start = nu;
      var t = Math.min(1, (nu - start) / 1400);
      var e = 1 - Math.pow(1 - t, 3);
      if (t < 1) {
        tel.textContent = Math.round(doel * e).toLocaleString("en-US");
        requestAnimationFrame(stap);
      } else {
        tel.textContent = eind;
      }
    }
    requestAnimationFrame(stap);
  }, { rootMargin: "0px 0px -15% 0px" });
  waarnemer.observe(tel);
})();
</script>`;
}

/* ══ PASTE BLOCK ENDS ═════════════════════════════════════════════════════ */

const html = bewijs();
writeFileSync(join(HERE, ".proof-test.html"), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><body>${html}</body>`, "utf8");
console.log("[proof] " + (html.length / 1024).toFixed(1) + " KB");
