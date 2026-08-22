/* Generates site/_var-c.html from site/data/meta.json + site/img/champions/manifest.json */
const fs = require("fs");
const path = require("path");

const ROOT = "C:\\Users\\Jeffrey\\Downloads\\LeagueClassic";
const GEN = "C:\\Users\\Jeffrey\\AppData\\Local\\Temp\\claude\\C--Users-Jeffrey-Downloads-LeagueClassic\\28eabf63-5cbd-41f0-b33f-9e40aa0e12dd\\scratchpad\\gen";

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "site/data/meta.json"), "utf8"));
const man = JSON.parse(fs.readFileSync(path.join(ROOT, "site/img/champions/manifest.json"), "utf8"));
const CSS = fs.readFileSync(path.join(GEN, "style.css"), "utf8");
const JS = fs.readFileSync(path.join(GEN, "app.js"), "utf8");

const OUT = process.argv[2] || path.join(ROOT, "site/_var-c.html");
const SCROLL = process.argv[3] ? parseInt(process.argv[3], 10) : 0;

/* ---------- helpers ---------- */
const nf = (n) => Number(n).toLocaleString("en-US");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const LANES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];
const LANE_LABEL = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", SUPPORT: "Support" };
const LANE_FULL = { TOP: "Top lane", JUNGLE: "Jungle", MIDDLE: "Mid lane", BOTTOM: "Bot lane", SUPPORT: "Support" };

function step(wr) {
  if (wr < 47) return 1;
  if (wr < 49.5) return 2;
  if (wr < 52) return 3;
  if (wr < 55) return 4;
  if (wr < 58) return 5;
  return 6;
}
function barPct(wr) {
  return Math.max(3, Math.min(100, ((wr - 46) / 16) * 100)).toFixed(1);
}
function bar(wr) {
  return `<span class="bar"><i class="bar-s${step(wr)}" style="width:${barPct(wr)}%"></i><span class="tick" style="left:25%"></span></span>`;
}
const LANE_PATH = {
  TOP: '<path d="M4 20V4h16"/><path d="M8 16L18 6"/>',
  JUNGLE: '<path d="M12 21v-5"/><path d="M12 16c-4 0-7-3-7-7 4 0 7 3 7 7z"/><path d="M12 16c4 0 7-3 7-7-4 0-7 3-7 7z"/>',
  MIDDLE: '<path d="M4 20L20 4"/><path d="M14 4h6v6"/>',
  BOTTOM: '<path d="M20 4v16H4"/><path d="M16 8L6 18"/>',
  SUPPORT: '<path d="M12 20s-7-4.4-7-9a4 4 0 017-2.6A4 4 0 0119 11c0 4.6-7 9-7 9z"/>',
};
const laneIcon = (l, cls = "lane-ico") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${LANE_PATH[l]}</svg>`;

const icon = (id, name, lazy = true, cls = "") =>
  `<img${cls ? ` class="${cls}"` : ""} src="img/champions/icon/${id}.png" width="128" height="128" alt="${esc(name)}"${lazy ? ' loading="lazy" decoding="async"' : ""}>`;
const splash = (id, name, lazy = true, cls = "") =>
  `<img${cls ? ` class="${cls}"` : ""} src="img/champions/splash/${id}.jpg" width="640" height="360" alt="${esc(name)} Classic splash art"${lazy ? ' loading="lazy" decoding="async"' : ""}>`;

/* ---------- champion model ---------- */
const champs = {};
man.champions.forEach((c) => {
  champs[c.baseId] = {
    id: c.baseId,
    cid: c.classicId,
    name: c.name,
    roles: c.roles.map(cap),
    lanes: [],
    counters: null,
    beats: [],
    laneGames: 0,
    totalGames: 0,
    mainLane: null,
  };
});
LANES.forEach((ln) => {
  meta.lanes[ln].forEach((row, i) => {
    const c = champs[row.baseId];
    if (!c) throw new Error("missing champ " + row.baseId);
    c.lanes.push({ lane: ln, rank: i + 1, wr: row.winrate, raw: row.winrateRuw, games: row.games, pick: row.pickRate });
  });
});
Object.values(meta.counters).forEach((entry) => {
  const c = champs[entry.baseId];
  c.counters = entry.counters.map((x) => ({ id: x.baseId, name: x.naam, wr: x.winrateTegen, raw: x.winrateTegenRuw, games: x.games }));
  c.laneGames = entry.laneGames;
  c.totalGames = entry.totaleGames;
  c.mainLane = entry.lane;
  entry.counters.forEach((x) => {
    champs[x.baseId].beats.push({ id: entry.baseId, name: entry.naam, wr: x.winrateTegen, games: x.games });
  });
});
Object.values(champs).forEach((c) => {
  c.lanes.sort((a, b) => b.wr - a.wr);
  c.beats.sort((a, b) => b.wr - a.wr);
  c.beats = c.beats.slice(0, 4);
});
const ordered = man.champions.map((c) => champs[c.baseId]);

/* embedded data for the client */
const clientData = {
  totals: { games: meta.totals.games, players: meta.totals.players, champions: meta.totals.champions },
  champions: {},
};
ordered.forEach((c) => {
  clientData.champions[c.id] = {
    id: c.id, cid: c.cid, name: c.name, roles: c.roles,
    lanes: c.lanes.map((l) => ({ lane: l.lane, rank: l.rank, wr: l.wr, games: l.games })),
    counters: c.counters, beats: c.beats.length ? c.beats : null,
    laneGames: c.laneGames || 0, totalGames: c.totalGames || 0, mainLane: c.mainLane,
  };
});

/* ---------- pieces ---------- */
const DEFAULT_ID = 23; /* Tryndamere */

const ES_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12v4"/><path d="M12 8.5v.01"/></svg>';
function emptyBlock(title, text, cta) {
  return `<div class="es"><span class="es-ic">${ES_ICON}</span><span class="es-t">${title}</span><p class="es-p">${text}</p><a class="btn btn-ghost btn-sm" href="#download">${cta}</a></div>`;
}

function detailHTML(c) {
  let laneHTML;
  if (c.lanes.length) {
    laneHTML = `<div class="col-key"><span>Lane</span><span></span><span>Win rate</span><span>Games</span></div><div class="lane-rows">${c.lanes
      .map(
        (l) => `<div class="lane-row">
              <span class="lane-tag">${laneIcon(l.lane)}${LANE_LABEL[l.lane]} <span class="rank-pill">#${l.rank}</span></span>
              ${bar(l.wr)}
              <span class="wr wr-s${step(l.wr)}">${l.wr.toFixed(1)}%</span>
              <span class="sub">${nf(l.games)}</span>
            </div>`
      )
      .join("")}</div>` +
      `<p class="lane-foot">Top 10 in <b>${c.lanes.length}</b> of 5 lanes &middot; strongest in <b>${LANE_FULL[c.lanes[0].lane]}</b> at <b>${c.lanes[0].wr.toFixed(1)}%</b></p>`;
  } else {
    laneHTML = emptyBlock(
      "Not in this public cut",
      `This page publishes the top&nbsp;10 per lane. <b>${esc(c.name)}</b> is in the dataset &mdash; all ${meta.totals.champions} champions are &mdash; but does not appear in those ten.`,
      "See the full table"
    );
  }
  let muTitle = "Worst matchups", muRows = c.counters;
  if (!muRows) { muTitle = "Wins into"; muRows = c.beats; }
  const muHTML = muRows && muRows.length
    ? `<div class="mu-rows">${muRows
        .map(
          (m) => `<div class="mu-row">${icon(m.id, m.name, false)}
              <span class="mu-mid"><span class="mu-top"><span class="mu-name">${esc(m.name)}</span><span class="mu-games">${nf(m.games)}g</span></span>${bar(m.wr)}</span>
              <span class="mu-wr wr-s${step(m.wr)}">${m.wr.toFixed(1)}%</span>
            </div>`
        )
        .join("")}</div>`
    : emptyBlock(
        "Matchups live in the app",
        `This page shows the twelve most-played champions head to head. AllMid reads <b>${esc(c.name)}</b>'s lane opponent straight out of champion select and pulls the matchup there.`,
        "Download AllMid"
      );

  return `<div class="detail-grid">
        <div class="detail-art">
          ${splash(c.id, c.name, false)}
          <div class="detail-art-txt">
            <div class="detail-name">${esc(c.name)}</div>
            <div class="detail-roles">${c.roles.map((r) => `<span class="role">${esc(r)}</span>`).join("")}<span class="role id">ID ${c.cid}</span></div>
          </div>
        </div>
        <div class="detail-col"><h4>Lane performance <span class="n">smoothed win rate, prior ${meta.methode.priorStrength}</span></h4>${laneHTML}</div>
        <div class="detail-col mu"><h4>${muTitle} <span class="n">head to head</span></h4>${muHTML}</div>
      </div>`;
}

const hasData = (c) => c.lanes.length > 0 || (c.counters && c.counters.length) || c.beats.length > 0;
const coveredCount = ordered.filter(hasData).length;
const champGrid = ordered
  .map(
    (c) =>
      `<button class="champ-btn${hasData(c) ? " has-data" : ""}" type="button" data-id="${c.id}" data-name="${esc(c.name.toLowerCase())}" aria-pressed="${c.id === DEFAULT_ID}" title="${esc(c.name)}${hasData(c) ? "" : " — no published rows on this page"}">${icon(c.id, c.name, false)}</button>`
  )
  .join("\n            ");

/* hero mosaic: a spread across the roster */
const mosaicIds = [];
for (let i = 0; i < 54; i++) mosaicIds.push(ordered[Math.round((i * (ordered.length - 1)) / 53)].id);
const mosaic = mosaicIds.map((id) => `<img src="img/champions/splash/${id}.jpg" alt="" width="640" height="360">`).join("");

const dlIds = [];
for (let i = 0; i < 30; i++) dlIds.push(ordered[(ordered.length - 1) - Math.round((i * (ordered.length - 1)) / 29)].id);
const dlMosaic = dlIds.map((id) => `<img src="img/champions/splash/${id}.jpg" alt="" width="640" height="360" loading="lazy" decoding="async">`).join("");

/* tier list panels */
function lanePanel(ln, active) {
  const rows = meta.lanes[ln];
  const podium = rows
    .slice(0, 3)
    .map(
      (r, i) => `<div class="pod pod-${i + 1}">
            ${splash(r.baseId, r.naam, false, "art")}
            <span class="pod-rank">#${i + 1}</span>
            <div class="pod-in">
              <div class="pod-face">${icon(r.baseId, r.naam, false)}
                <div><div class="pod-nm">${esc(r.naam)}</div><div class="pod-wr wr-s${step(r.winrate)}">${r.winrate.toFixed(1)}%</div></div>
              </div>
              <div class="pod-stats"><span><b>${nf(r.games)}</b> games</span><span><b>${r.pickRate.toFixed(2)}%</b> pick</span><span>raw <b>${r.winrateRuw.toFixed(1)}%</b></span></div>
            </div>
          </div>`
    )
    .join("");
  const trs = rows
    .map(
      (r, i) => `<tr>
              <td class="t-rank">${i + 1}</td>
              <td><span class="t-champ">${icon(r.baseId, r.naam, false)}<span><span class="nm">${esc(r.naam)}</span><br><span class="id">${r.classicId}</span></span></span></td>
              <td class="t-bar">${bar(r.winrate)}</td>
              <td class="t-wr wr-s${step(r.winrate)}">${r.winrate.toFixed(1)}%</td>
              <td class="t-num r">${r.winrateRuw.toFixed(1)}%</td>
              <td class="t-num r">${nf(r.games)}</td>
              <td class="t-num r">${r.pickRate.toFixed(2)}%</td>
            </tr>`
    )
    .join("");
  return `<div class="lane-panel" data-lane="${ln}">
          <h3 class="lane-panel-h">${LANE_FULL[ln]} <span class="meta">top 10 &middot; ${meta.laneQualifiers[ln]} champions cleared the 100-game minimum</span></h3>
          <div class="podium">${podium}</div>
          <div class="table-shell">
            <div class="table-scroll">
              <table class="tier">
                <thead><tr>
                  <th>#</th><th>Champion</th><th>Win rate</th><th></th>
                  <th class="r">Raw</th><th class="r">Games</th><th class="r">Pick rate</th>
                </tr></thead>
                <tbody>${trs}</tbody>
              </table>
            </div>
            <div class="t-note">
              <span><span class="mono">${LANE_FULL[ln]}</span> &middot; ${meta.laneQualifiers[ln]} of ${meta.totals.champions} champions cleared the ${meta.methode.minLaneGames}-game minimum</span>
              <span>Smoothed win rate = <span class="mono">(wins + 10) / (games + 20)</span> &middot; prior ${meta.methode.priorStrength}</span>
            </div>
          </div>
        </div>`;
}

const laneTabs = LANES.map(
  (ln) =>
    `<button class="tab" type="button" role="tab" data-lane="${ln}" aria-selected="${ln === "MIDDLE"}">${laneIcon(ln, "lane-ico")}${LANE_FULL[ln]}</button>`
).join("\n            ");
const lanePanels = LANES.map((ln) => lanePanel(ln)).join("\n        ");

/* counters cards */
const counterCards = Object.values(meta.counters)
  .map((e) => {
    const rows = e.counters
      .map(
        (m) => `<div class="ct-row">${icon(m.baseId, m.naam)}
              <span><span class="nm">${esc(m.naam)}</span><br><span class="g">${nf(m.games)} games</span></span>
              ${bar(m.winrateTegen)}
              <span class="w wr-s${step(m.winrateTegen)}">${m.winrateTegen.toFixed(1)}%</span>
            </div>`
      )
      .join("");
    return `<article class="ct">
          <div class="ct-head">${icon(e.baseId, e.naam)}
            <div><div class="nm">${esc(e.naam)}</div><div class="mt">${nf(e.laneGames)} lane games &middot; ${nf(e.totaleGames)} total</div></div>
            <span class="ct-lane">${LANE_LABEL[e.lane]}</span>
          </div>
          <div class="ct-body">
            <div class="ct-lbl">Beaten hardest by</div>
            ${rows}
          </div>
        </article>`;
  })
  .join("\n        ");

/* highlights */
const h0 = meta.highlights[0].cijfers;
const h1 = meta.highlights[1].cijfers;
const h2 = meta.highlights[2].cijfers;

const highlights = `
        <article class="hl">
          <div class="hl-art">${splash(h0.baseId, h0.champion, false)}
            <div class="hl-vs">${icon(h0.baseId, h0.champion, false)}<span class="v">15.4 pp</span>${icon(h0.zwakste.baseId, h0.zwakste.champion, false)}</div>
          </div>
          <div class="hl-body">
            <h3 class="hl-title">${esc(h0.champion)} is the strongest champion across every lane</h3>
            <p class="hl-txt">${esc(h0.champion)} wins ${h0.winrate.toFixed(1)}% of ${nf(h0.games)} games (${nf(h0.wins)} wins) &mdash; the highest win rate of all ${meta.totals.champions} champions. At the other end sits ${esc(h0.zwakste.champion)} on ${h0.zwakste.winrate.toFixed(1)}% over ${nf(h0.zwakste.games)} games. Every champion here has at least ${nf(h0.alleChampionsMinimaalGames)} games.</p>
            <div class="hl-figs">
              <div class="f"><div class="v wr-s${step(h0.winrate)}">${h0.winrate.toFixed(1)}%</div><div class="k">${esc(h0.champion)}</div></div>
              <div class="f"><div class="v wr-s${step(h0.zwakste.winrate)}">${h0.zwakste.winrate.toFixed(1)}%</div><div class="k">${esc(h0.zwakste.champion)}</div></div>
              <div class="f"><div class="v">${nf(h0.games)}</div><div class="k">games</div></div>
            </div>
          </div>
        </article>
        <article class="hl">
          <div class="hl-art" style="background:radial-gradient(90% 120% at 20% 10%,rgba(89,169,255,.22),transparent 60%),radial-gradient(90% 120% at 90% 90%,rgba(255,95,114,.18),transparent 60%),#0d1019;display:flex;align-items:center;justify-content:center">
            <div class="side-bars">
              <div class="side-bar side-blue"><span class="t">Blue</span><span class="b"><i style="width:${(h1.winrateBlauw / 60) * 100}%"></i></span><span class="p" style="color:var(--blue)">${h1.winrateBlauw.toFixed(1)}%</span></div>
              <div class="side-bar side-red"><span class="t">Red</span><span class="b"><i style="width:${(h1.winrateRood / 60) * 100}%"></i></span><span class="p" style="color:var(--red)">${h1.winrateRood.toFixed(1)}%</span></div>
            </div>
          </div>
          <div class="hl-body">
            <h3 class="hl-title">Blue side still wins more than red side</h3>
            <p class="hl-txt">Team 100 takes ${h1.winrateBlauw.toFixed(1)}% of all ${nf(h1.games)} games: ${nf(h1.winsBlauw)} wins against ${nf(h1.winsRood)} for red (${h1.winrateRood.toFixed(1)}%). A gap of ${nf(h1.winsBlauw - h1.winsRood)} games &mdash; large enough that side selection is worth knowing about before you queue.</p>
            <div class="hl-figs">
              <div class="f"><div class="v" style="color:var(--blue)">${nf(h1.winsBlauw)}</div><div class="k">blue wins</div></div>
              <div class="f"><div class="v" style="color:var(--red)">${nf(h1.winsRood)}</div><div class="k">red wins</div></div>
              <div class="f"><div class="v">${nf(h1.games)}</div><div class="k">games</div></div>
            </div>
          </div>
        </article>
        <article class="hl">
          <div class="hl-art">${splash(h2.championBaseId, h2.champion, false)}
            <div class="hl-vs">${icon(h2.championBaseId, h2.champion, false)}<span class="v">VS</span>${icon(h2.tegenstanderBaseId, h2.tegenstander, false)}</div>
          </div>
          <div class="hl-body">
            <h3 class="hl-title">${esc(h2.champion)} into ${esc(h2.tegenstander)} is the most lopsided lane in the game</h3>
            <p class="hl-txt">In ${LANE_FULL[h2.lane].toLowerCase()}, ${esc(h2.champion)} wins ${h2.winrateRuw.toFixed(1)}% of the ${nf(h2.games)} direct duels with ${esc(h2.tegenstander)} (${nf(h2.wins)} of ${nf(h2.games)}), or ${h2.winrate.toFixed(1)}% after smoothing. That is the most skewed of all ${nf(h2.vergelekenMatchups)} matchups with at least ${h2.drempelGames} head-to-head games.</p>
            <div class="hl-figs">
              <div class="f"><div class="v wr-s${step(h2.winrateRuw)}">${h2.winrateRuw.toFixed(1)}%</div><div class="k">raw</div></div>
              <div class="f"><div class="v wr-s${step(h2.winrate)}">${h2.winrate.toFixed(1)}%</div><div class="k">smoothed</div></div>
              <div class="f"><div class="v">${nf(h2.games)}</div><div class="k">duels</div></div>
            </div>
          </div>
        </article>`;

/* mastery graphic */
function mnodes(on, total) {
  let s = "";
  for (let i = 0; i < total; i++) s += `<span class="mnode${i < on ? " on" : ""}"></span>`;
  return s;
}
const masteryChampIds = [23, 81, 99, 103, 53, 74];
const masteryRow = masteryChampIds
  .map((id, i) => `<img class="${i === 0 ? "act" : ""}" src="img/champions/icon/${id}.png" width="128" height="128" alt="${esc(champs[id].name)}" loading="lazy" decoding="async">`)
  .join("");

/* stats */
const dur = meta.totals.gemiddeldeDuurSeconden;
const durStr = Math.floor(dur / 60) + ":" + String(Math.round(dur % 60)).padStart(2, "0");
const check = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const cross = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const dot = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const gh = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.36-2.53-.5-2.69-.95-.09-.23-.48-.95-.82-1.14-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.19c0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const dlIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>';

/* screenshot helper only: shifts the page up so a mid-page band lands in the
   initial viewport, which headless Chromium actually rasterises. Never emitted
   into the final file (SCROLL is 0 there). */
const scrollStyle = SCROLL ? `<style>body{margin-top:-${SCROLL}px}</style>` : "";
const PICK = process.argv[4] ? parseInt(process.argv[4], 10) : 0;
const pickScript = PICK ? `<script>document.querySelector('.champ-btn[data-id="${PICK}"]').click();</script>` : "";

/* ---------- page ---------- */
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AllMid — stats for League of Legends Classic</title>
<meta name="description" content="Free, open-source stat tracker for League of Legends Classic: tier lists, counters, champion select scouting and automatic masteries, built from ${nf(meta.totals.games)} games.">
<meta name="color-scheme" content="dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>
${CSS}
</style>
</head>
<body>

<nav class="nav">
  <div class="wrap nav-in">
    <a class="brand" href="#top">
      <span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#e7c76e" stroke-width="2.4" stroke-linecap="round"><path d="M4 20L20 4"/><path d="M14 4h6v6"/></svg></span>
      <span class="brand-name">All<em>Mid</em></span>
      <span class="brand-tag">Classic</span>
    </a>
    <div class="nav-links">
      <a href="#champions">Champions</a>
      <a href="#tierlist">Tier list</a>
      <a href="#counters">Counters</a>
      <a href="#features">Features</a>
      <a href="#data">The data</a>
      <a href="#safety">Safety</a>
    </div>
    <a class="btn btn-primary btn-sm nav-cta" href="https://github.com/allmidgg/desktop/releases/latest">${dlIcon} Download</a>
  </div>
</nav>

<header class="hero" id="top">
  <div class="mosaic" aria-hidden="true">${mosaic}</div>
  <div class="mosaic-veil" aria-hidden="true"></div>
  <div class="wrap hero-in">
    <div class="hero-top">
      <div class="hero-copy" id="champions">
        <span class="eyebrow"><span class="dot"></span>Free &middot; open source &middot; MIT &middot; patch ${meta.totals.patches.join(" &amp; ")}</span>
        <h1 class="hero-h">The stat page League of Legends <span class="accent">Classic</span> never had.</h1>
        <p class="hero-sub">Classic has no public API, so every tracker you know stops at modern League. AllMid reads the Classic client's own local APIs and has already indexed <strong>${nf(meta.totals.games)} games</strong> across <strong>${nf(meta.totals.players)} players</strong> and all <strong>${meta.totals.champions} champions</strong> &mdash; on the original season&nbsp;3 art, not the remakes.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="https://github.com/allmidgg/desktop/releases/latest">${dlIcon} Download for Windows</a>
          <a class="btn btn-ghost" href="https://github.com/allmidgg/desktop">${gh} View the source</a>
        </div>
        <p class="hero-fine">Windows 10 &amp; 11 <span class="sep">&middot;</span> no account <span class="sep">&middot;</span> MIT licence <span class="sep">&middot;</span> data from ${new Date(meta.totals.eersteGame).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} to ${new Date(meta.totals.laatsteGame).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>
        <div class="unsupported">
          <div class="unsupported-t">Classic coverage</div>
          <div class="unsupported-row">
            <span class="chip-x"><span class="x">&times;</span><b>Blitz</b></span>
            <span class="chip-x"><span class="x">&times;</span><b>Porofessor</b></span>
            <span class="chip-x"><span class="x">&times;</span><b>OP.GG</b></span>
            <span class="chip-x"><span class="x">&times;</span><b>METAsrc</b></span>
            <span class="chip-x chip-ok"><span class="x">&check;</span><b>AllMid</b></span>
          </div>
        </div>
      </div>

      <div class="picker">
        <div class="picker-head">
          <span class="picker-title">Champion explorer</span>
          <span class="live-dot"><i></i>live data</span>
        </div>
        <div class="search-wrap">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <label class="sr-only" for="champ-search" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Search champions</label>
          <input id="champ-search" type="search" autocomplete="off" placeholder="Pick a champion below" disabled>
        </div>
        <div class="champ-grid" id="champ-grid">
            ${champGrid}
        </div>
        <div class="no-hits" id="champ-nohits">No champion by that name in Classic.</div>
        <div class="picker-foot"><span class="count" id="champ-count">${meta.totals.champions}</span> champions &middot; <span class="dot-key"></span> ${coveredCount} with published rows &middot; click any portrait</div>
      </div>
    </div>

    <div class="detail" id="champ-detail">${detailHTML(champs[DEFAULT_ID])}</div>

    <div class="strip">
      <div><div class="v">${nf(meta.totals.games)}</div><div class="k">games indexed</div></div>
      <div><div class="v">${nf(meta.totals.players)}</div><div class="k">players seen</div></div>
      <div><div class="v">${meta.totals.champions}</div><div class="k">champions covered</div></div>
      <div><div class="v">${durStr}<span> min</span></div><div class="k">average game</div></div>
      <div><div class="v">${meta.totals.patches.length}</div><div class="k">patches &middot; ${meta.totals.patches.join(", ")}</div></div>
    </div>
  </div>
</header>

<section id="findings">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="sec-kicker">What the data says</div>
      <h2>Three things ${nf(meta.totals.games)} Classic games make obvious</h2>
      <p class="sec-sub">Computed with the same code the desktop app runs, straight from the match log. Nothing here is an estimate.</p>
    </div>
    <div class="hl-grid reveal">${highlights}
    </div>
  </div>
</section>

<section id="tierlist" style="background:var(--bg-2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="sec-kicker">Tier list</div>
      <h2>Every lane, ranked by smoothed win rate</h2>
      <p class="sec-sub">Top 10 per lane on patches ${meta.totals.patches.join(" and ")}. A champion needs ${meta.methode.minLaneGames} games in a lane to qualify; win rates are Bayesian-smoothed with a prior of ${meta.methode.priorStrength} games so a lucky 12-game sample cannot top the chart.</p>
    </div>
    <div class="tabs" id="lane-tabs" role="tablist" aria-label="Lane" hidden>
            ${laneTabs}
    </div>
    <div id="lane-panels" class="reveal">
        ${lanePanels}
    </div>
  </div>
</section>

<section id="counters">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="sec-kicker">Matchup intel</div>
      <h2>Who actually beats who</h2>
      <p class="sec-sub">The twelve most-played champions in the sample and the four opponents that beat them hardest, measured player-versus-player in the same position. Minimum ${meta.methode.minMatchupGames} head-to-head games.</p>
    </div>
    <div class="ct-grid reveal">
        ${counterCards}
    </div>
  </div>
</section>

<section id="features" style="background:var(--bg-2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="sec-kicker">The app</div>
      <h2>Four things AllMid does while you play</h2>
      <p class="sec-sub">A desktop app for Windows that sits beside the Classic client. Everything below is on this page because you should know what a program does before you run it.</p>
    </div>

    <div class="feat reveal">
      <div class="feat-txt">
        <div class="feat-num">01 &mdash; Champion select</div>
        <h3>Scout both teams before the game starts</h3>
        <p>The moment locks come in, AllMid reads champion select from the client and tells you what you are walking into: your own matchup, the enemy composition, and the win rates behind them.</p>
        <ul>
          <li>${dot}<span>Both teams, resolved to lanes automatically &mdash; nothing to type in.</span></li>
          <li>${dot}<span>Your lane opponent's numbers pulled from ${nf(meta.totals.games)} indexed games.</span></li>
          <li>${dot}<span>Counters ranked by head-to-head win rate, not by opinion.</span></li>
          <li>${dot}<span>Original Classic portraits, so what you see matches what is on screen.</span></li>
        </ul>
      </div>
      <div class="shot">
        <div class="shot-bar"><i></i><i></i><i></i><span class="t">AllMid &mdash; champion select</span></div>
        <img src="img/champion-select.png" width="1216" height="708" alt="AllMid champion select window showing both teams with champion portraits" loading="lazy" decoding="async">
      </div>
    </div>

    <div class="feat flip reveal">
      <div class="feat-txt">
        <div class="feat-num">02 &mdash; Masteries</div>
        <h3>A full mastery page, set for you, every time you switch</h3>
        <p>Thirty points placed automatically for the champion you locked. Change champion and the page is rewritten for the new pick. Your existing pages are backed up before anything is touched, and none of it happens unless you ask for it.</p>
        <ul>
          <li>${dot}<span>All 30 points, distributed for the champion in front of you.</span></li>
          <li>${dot}<span>Re-applied on every champion change during select.</span></li>
          <li>${dot}<span>Existing mastery pages are backed up first &mdash; nothing is overwritten blindly.</span></li>
          <li>${dot}<span>Off by default in the sense that it only ever runs on your request.</span></li>
        </ul>
      </div>
      <div class="mastery">
        <div class="mastery-top">
          <span class="t">Mastery page</span>
          <span class="pts">30 / 30 points</span>
        </div>
        <div class="mrow-champ">${masteryRow}</div>
        <div class="mastery-cols">
          <div class="mcol mcol-off"><div class="mcol-h"><span class="n">Offense</span><span class="c">21</span></div><div class="mnodes">${mnodes(21, 24)}</div></div>
          <div class="mcol mcol-def"><div class="mcol-h"><span class="n">Defense</span><span class="c">9</span></div><div class="mnodes">${mnodes(9, 24)}</div></div>
          <div class="mcol mcol-uti"><div class="mcol-h"><span class="n">Utility</span><span class="c">0</span></div><div class="mnodes">${mnodes(0, 24)}</div></div>
        </div>
        <div class="mastery-foot"><span class="badge">backup made</span> Your existing pages are saved before AllMid writes a new one.</div>
      </div>
    </div>

    <div class="feat reveal">
      <div class="feat-txt">
        <div class="feat-num">03 &mdash; Live &amp; history</div>
        <h3>Your recent games, read back from the client</h3>
        <p>Portraits, KDA, items and results for the games you just played, without opening a browser. The same match records feed the tier lists on this page.</p>
        <ul>
          <li>${dot}<span>Recent games with champion portraits, KDA and full item builds.</span></li>
          <li>${dot}<span>Win and loss marked per game, per champion.</span></li>
          <li>${dot}<span>Everything is read from the client's own local APIs.</span></li>
        </ul>
      </div>
      <div class="shot">
        <div class="shot-bar"><i></i><i></i><i></i><span class="t">AllMid &mdash; live</span></div>
        <img src="img/app/allmid-main.png" width="1296" height="828" alt="AllMid main window listing recent Classic games with champion portraits, KDA and items" loading="lazy" decoding="async">
      </div>
    </div>

    <div class="feat flip reveal">
      <div class="feat-txt">
        <div class="feat-num">04 &mdash; Meta</div>
        <h3>Tier lists, builds and counters, offline in the app</h3>
        <p>The full ranking &mdash; not the top 10 this page publishes. Every one of the ${meta.totals.champions} champions, in every lane, with summoner spells, item builds and the matchups that decide the lane.</p>
        <ul>
          <li>${dot}<span>All ${meta.totals.champions} champions ranked per lane, not a sample.</span></li>
          <li>${dot}<span>Summoner spells and item builds by pick rate.</span></li>
          <li>${dot}<span>Counter tables per champion, filtered on minimum sample size.</span></li>
          <li>${dot}<span>Refreshed as the pooled dataset grows.</span></li>
        </ul>
      </div>
      <div class="shot">
        <div class="shot-bar"><i></i><i></i><i></i><span class="t">AllMid &mdash; meta</span></div>
        <img src="img/meta.png" width="1296" height="828" alt="AllMid meta window showing the champion tier list with summoner spells and item builds" loading="lazy" decoding="async">
      </div>
    </div>
  </div>
</section>

<section id="data">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="sec-kicker">Where the numbers come from</div>
      <h2>There is no API for Classic. So we built the dataset.</h2>
      <p class="sec-sub">This is the whole reason AllMid exists, and it is worth understanding before you trust a number on this page.</p>
    </div>
    <div class="pipe reveal">
      <div class="pipe-step"><div class="n">1</div><h4>No public API</h4><p>Riot publishes no match endpoint for Classic. That is exactly why every other tracker stops at modern League &mdash; there is nothing for them to read.</p><span class="fig">0 public endpoints</span></div>
      <div class="pipe-step"><div class="n">2</div><h4>Two local APIs</h4><p>The Classic client exposes two APIs on your own machine, the same ones the client itself talks to. AllMid uses those, and nothing else.</p><span class="fig">on your machine only</span></div>
      <div class="pipe-step"><div class="n">3</div><h4>Walking the match graph</h4><p>From a game you played, AllMid follows the other players to their games, and outward from there. The graph grows on its own.</p><span class="fig">${nf(meta.totals.games)} games reached</span></div>
      <div class="pipe-step"><div class="n">4</div><h4>Deduplicated and pooled</h4><p>Every find is keyed on gameId, so two users meeting the same match cost nothing. The pooled numbers go back out to everyone.</p><span class="fig">${meta.totals.overgeslagenDubbeleGameIds} duplicate ids skipped</span></div>
    </div>
    <div class="dl-facts reveal">
      <div><div class="v">${nf(meta.totals.games)}</div><div class="k">unique games in the log</div></div>
      <div><div class="v">${nf(meta.totals.spelersloten)}</div><div class="k">player slots parsed</div></div>
      <div><div class="v">${nf(meta.totals.slotenZonderPositie)}</div><div class="k">slots without a resolved position, excluded from lane stats</div></div>
      <div><div class="v">${meta.totals.onleesbareRegels}</div><div class="k">unreadable rows</div></div>
    </div>
  </div>
</section>

<section id="safety" style="background:var(--bg-2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="sec-kicker">Safety</div>
      <h2>Exactly what the program does, and what it refuses to do</h2>
      <p class="sec-sub">Written out in full because you are about to run an executable someone on the internet built. Read this first; the source backs up every line of it.</p>
    </div>
    <div class="safety-grid reveal">
      <div class="safe-card safe-no">
        <div class="safe-head"><span class="ic">${cross}</span>AllMid does not</div>
        <ul>
          <li>${cross}<span><b>Read or write game memory.</b> <span class="g">No process scanning, no memory patching, at any point.</span></span></li>
          <li>${cross}<span><b>Inject anything into the game.</b> <span class="g">No injection, no DLLs, no hooks into the client.</span></span></li>
          <li>${cross}<span><b>Ask for your login.</b> <span class="g">No Riot credentials, no password, no token, ever.</span></span></li>
          <li>${cross}<span><b>Modify game files.</b> <span class="g">Nothing in the install directory is patched, replaced or removed.</span></span></li>
          <li>${cross}<span><b>Play for you.</b> <span class="g">No input automation, no scripting, no bot behaviour of any kind.</span></span></li>
        </ul>
      </div>
      <div class="safe-card safe-yes">
        <div class="safe-head"><span class="ic">${check}</span>AllMid does</div>
        <ul>
          <li>${check}<span><b>Use the client's own local APIs.</b> <span class="g">The two interfaces the Classic client already exposes on your machine.</span></span></li>
          <li>${check}<span><b>Write your mastery page when you ask.</b> <span class="g">And back up the pages you already had before it writes anything.</span></span></li>
          <li>${check}<span><b>Share the match data it collects.</b> <span class="g">That is what builds the pooled dataset &mdash; and you can switch it off in settings.</span></span></li>
          <li>${check}<span><b>Build in the open.</b> <span class="g">Public CI produces the release, so the binary matches the source you can read.</span></span></li>
          <li>${check}<span><b>Stay MIT-licensed and public.</b> <span class="g">Read it, fork it, or build it yourself from the repository.</span></span></li>
        </ul>
      </div>
    </div>
    <div class="safe-foot reveal">
      <span><b>Why this is on the download page.</b> A description of behaviour is worth more than a promise: it is the thing you can check the source against. Every claim above maps to code in <a href="https://github.com/allmidgg/desktop">github.com/allmidgg/desktop</a>, and the data sharing in the third line is the only network traffic that leaves your machine.</span>
    </div>
  </div>
</section>

<section class="dl" id="download">
  <div class="dl-mosaic" aria-hidden="true">${dlMosaic}</div>
  <div class="dl-veil" aria-hidden="true"></div>
  <div class="wrap dl-in reveal">
    <h2>Stop guessing in Classic.</h2>
    <p>Tier lists, counters, champion select scouting and automatic masteries for the mode nobody else covers. Free, open source, and built on ${nf(meta.totals.games)} real games.</p>
    <div class="dl-actions">
      <a class="btn btn-primary" href="https://github.com/allmidgg/desktop/releases/latest">${dlIcon} Download for Windows</a>
      <a class="btn btn-ghost" href="https://github.com/allmidgg/desktop">${gh} Read the source</a>
    </div>
    <div class="dl-meta">
      <span>Windows 10 &amp; 11</span><span>Free, no account</span><span>MIT licence</span><span>${nf(meta.totals.games)} games indexed</span><span>Patch ${meta.totals.patches.join(" &amp; ")}</span>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <div class="foot-top">
      <a class="brand" href="#top">
        <span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#e7c76e" stroke-width="2.4" stroke-linecap="round"><path d="M4 20L20 4"/><path d="M14 4h6v6"/></svg></span>
        <span class="brand-name">All<em>Mid</em></span>
      </a>
      <div class="foot-links">
        <a href="https://github.com/allmidgg/desktop">GitHub</a>
        <a href="https://github.com/allmidgg/desktop/releases/latest">Releases</a>
        <a href="https://github.com/allmidgg/desktop/issues">Issues</a>
        <a href="#safety">Safety</a>
        <a href="#data">Method</a>
      </div>
    </div>
    <p class="foot-note">
      <b>AllMid is an independent project and is not endorsed by Riot Games.</b>
      League of Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc. League of Legends &copy; Riot Games, Inc.
      Champion portraits and splash art are the property of Riot Games, Inc. and are shown here to identify the champions they depict.
      Statistics on this page were generated on ${new Date(meta.totals.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} from ${nf(meta.totals.games)} games on patches ${meta.totals.patches.join(" and ")}.
    </p>
  </div>
</footer>

<script type="application/json" id="allmid-data">${JSON.stringify(clientData).replace(/</g, "\\u003c")}</script>
<script>
${JS}
</script>
${scrollStyle}${pickScript}
</body>
</html>
`;

fs.writeFileSync(OUT, html, "utf8");
console.log("wrote", OUT, (html.length / 1024).toFixed(1) + " KB");
