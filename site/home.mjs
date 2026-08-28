/**
 * The platform homepage. Facts and demo panels come from build.mjs; wishlist
 * games are editorial content, never claims of existing integrations.
 */
import { icon } from "./icons.mjs";

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (value) => Number(value).toLocaleString("en-US");
const download = "https://github.com/allmidgg/desktop/releases/latest/download/AllMid-Setup.exe";

const games = [
  { id: "league", short: "LOL", name: "League of Legends", category: "MOBA", status: "Available now", color: "#e7c76e", title: "Your first module. Already in play.", text: "Explore Classic builds, lane matchups and objective timers. League is where AllMid starts; the recorded statistics currently cover Classic.", tags: ["Build insights", "Lane matchups", "Objective timers"], href: "classic.html", action: "Explore League Classic" },
  { id: "valorant", short: "VAL", name: "VALORANT", category: "TACTICAL FPS", status: "Wishlist", color: "#ff7887", title: "A sharper picture of the next round.", text: "A possible future direction: agent guides, preparation and match review. This integration is not available. Data access and game rules still need to be evaluated.", tags: ["Agent guides", "Match review", "Proposed"], href: "mailto:contact@allmid.gg?subject=AllMid%20game%20request%3A%20VALORANT", action: "Suggest VALORANT by email" },
  { id: "cs2", short: "CS2", name: "Counter-Strike 2", category: "TACTICAL FPS", status: "Wishlist", color: "#e9aa61", title: "Make the time between rounds count.", text: "Map knowledge and post-match learning could make a useful next module. Counter-Strike support is a wishlist idea, with no release date or working integration yet.", tags: ["Map guides", "Post-match learning", "Proposed"], href: "mailto:contact@allmid.gg?subject=AllMid%20game%20request%3A%20Counter-Strike%202", action: "Suggest CS2 by email" },
  { id: "fortnite", short: "FN", name: "Fortnite", category: "BATTLE ROYALE", status: "Wishlist", color: "#a799ff", title: "A new drop. A new kind of helper.", text: "A changing island needs a different kind of companion. Loadout reference and update guides are possible directions; Fortnite support is not available today.", tags: ["Loadout reference", "Update guides", "Proposed"], href: "mailto:contact@allmid.gg?subject=AllMid%20game%20request%3A%20Fortnite", action: "Suggest Fortnite by email" },
  { id: "overwatch", short: "OW", name: "Overwatch 2", category: "TEAM FPS", status: "Wishlist", color: "#70c7d1", title: "Understand your role in the team.", text: "Hero knowledge and team composition guides are ideas for a future module. We have not built this integration and are not promising a launch date.", tags: ["Hero guides", "Team composition", "Proposed"], href: "mailto:contact@allmid.gg?subject=AllMid%20game%20request%3A%20Overwatch", action: "Suggest Overwatch by email" },
  { id: "next", short: "+", name: "Your next game", category: "YOU DECIDE", status: "Open suggestion", color: "#90b79b", title: "What are you playing next?", text: "The long-term ambition is one companion for many games. Tell us your game and the information you wish you had beside it. Suggestions help shape the direction.", tags: ["More genres", "Community ideas", "No fixed roadmap"], href: "mailto:contact@allmid.gg?subject=My%20next%20AllMid%20game", action: "Send your game suggestion" },
];

function gameRadar() {
  return `<div class="am-radar" aria-label="Choose a game to see its support status">
    <div class="am-radar-grid" aria-hidden="true"></div>
    <div class="am-orbit am-orbit-outer" aria-hidden="true"></div>
    <div class="am-orbit am-orbit-inner" aria-hidden="true"></div>
    <div class="am-radar-scan" aria-hidden="true"></div>
    <div class="am-core" aria-hidden="true"><span>ALL<br>MID</span></div>
    ${games.map((game, i) => `<button type="button" class="am-node" data-game="${game.id}" aria-controls="game-${game.id}" aria-pressed="${i === 0}" style="--game-color:${game.color}">
      <span class="am-node-icon" aria-hidden="true">${game.short}</span><span><b>${game.name}</b><small>${game.status}</small></span>
    </button>`).join("")}
    <span class="am-radar-caption">SELECT A GAME / EXPLORE THE DIRECTION</span>
  </div>`;
}

function featurePanel(id, label, title, description, demo, href, active) {
  return `<section class="am-feature-panel" id="feature-${id}" role="tabpanel" aria-labelledby="tab-${id}" tabindex="0"${active ? "" : " hidden"}>
    <div class="am-feature-copy"><span class="am-section-number">0${id === "builds" ? "1" : id === "select" ? "2" : "3"} / LEAGUE CLASSIC</span><h3>${title}</h3><p>${description}</p><a class="am-link" href="${href}">Explore ${label.toLowerCase()} <span aria-hidden="true">↗</span></a></div>
    <div class="am-demo"><div class="am-demo-title"><span class="am-status-dot"></span>${demo?.titel ?? label}<span class="am-example-label">WEBSITE EXAMPLE</span></div><div class="am-demo-body">${demo?.body ?? "<p>Explore the full module for details.</p>"}</div><p class="am-demo-note">Illustrative presentation using the current Classic dataset. Not connected to your game.</p></div>
  </section>`;
}

export function renderHome({ header, search, stats, demos, leaders }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AllMid — Your game. Your next move.</title>
  <meta name="description" content="Meet AllMid, your free, open-source gaming companion. Explore League Classic builds, matchups and an in-game overlay. More games are on the wishlist.">
  <link rel="canonical" href="https://allmid.gg/">
  <meta property="og:type" content="website">
  <meta property="og:title" content="AllMid — Your game. Your next move.">
  <meta property="og:description" content="Free game intelligence. League Classic available now. A bigger gaming universe ahead.">
  <meta property="og:url" content="https://allmid.gg/">
  <meta property="og:image" content="https://allmid.gg/img/meta.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#080b10">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap">
  <link rel="stylesheet" href="style.css">
  <link rel="stylesheet" href="home.css">
  <link rel="stylesheet" href="icon-polish.css">
  <link rel="stylesheet" href="section-surfaces.css">
  <script src="home.js" defer></script>
</head>
<body class="am-home">
<a class="am-skip" href="#main">Skip to content</a>
${header}
<main id="main">
  <section class="am-hero" aria-labelledby="hero-title">
    <div class="am-hero-atmosphere" aria-hidden="true"></div>
    <div class="wrap am-hero-grid">
      <div class="am-hero-copy">
        <p class="am-kicker"><span class="am-status-dot"></span> YOUR NEXT MOVE STARTS HERE</p>
        <h1 id="hero-title">Your game<br>changes.<br><em>AllMid keeps up.</em></h1>
        <p class="am-lede">The context behind a better play.<br>Builds, matchups and a little less guesswork, right beside your game.</p>
        <div class="am-actions"><a class="btn btn-primary" href="${download}">${icon("download")} Get AllMid for Windows</a><a class="am-watch" href="#experience"><span aria-hidden="true">${icon("play")}</span> See how it works</a></div>
        <p class="am-install-note">Free &amp; open source <span>·</span> Windows 10 &amp; 11</p>
        <div class="am-current-module"><span class="am-tiny-icon">L</span><span><b>League of Legends</b><small>First module available · Classic data</small></span><a href="#games" aria-label="Explore all game modules">${icon("arrowUpRight")}</a></div>
      </div>
      <div class="am-hero-visual">
        <div class="am-stage-orbit" aria-hidden="true"></div>
        <div class="am-stage-corners" aria-hidden="true"><span>01 / THE COMPANION</span><span>BUILT AROUND YOUR GAME</span></div>
        <div class="am-art-ribbon" aria-hidden="true"><img src="img/champions/splash/22.jpg" alt="" width="640" height="360"><img src="img/champions/splash/62.jpg" alt="" width="640" height="360"><img src="img/champions/splash/103.jpg" alt="" width="640" height="360"></div>
        <figure class="am-app-window"><div class="am-window-bar"><span class="am-window-lights" aria-hidden="true"><i></i><i></i><i></i></span><span>ALLMID / LEAGUE CLASSIC</span><span class="am-window-status">DESKTOP APP</span></div><img src="img/app/allmid-main.png" alt="AllMid desktop app showing a Classic match history with champion portraits, items and match statistics" width="1296" height="828" fetchpriority="high"><figcaption>Actual app screenshot · historical example</figcaption></figure>
        <div class="am-floating-insight"><span class="am-insight-symbol" aria-hidden="true">${icon("chart")}</span><div><small>CONTEXT, NOT CLUTTER</small><b>The numbers behind your play.</b><span>Every win rate carries its sample size.</span></div></div>
      </div>
    </div>
    <div class="wrap am-hero-bottom"><a href="#games" class="am-scroll-cue"><span aria-hidden="true">${icon("arrowDown")}</span> EXPLORE THE UNIVERSE</a><button class="am-motion" type="button" aria-pressed="false" hidden>${icon("pause")} <span data-motion-label>Pause motion</span></button></div>
  </section>

  <div class="am-proof-strip"><div class="wrap"><div class="am-metric"><span class="am-metric-icon">${icon("database")}</span><p><b>${num(stats.games)}</b><span>Classic games recorded</span></p></div><div class="am-metric"><span class="am-metric-icon">${icon("champions")}</span><p><b>${num(stats.champions)}</b><span>Classic champions with data</span></p></div><div class="am-metric"><span class="am-metric-icon">${icon("code")}</span><p><b>Open source</b><span>Explore the code. Make it yours.</span></p></div><a href="classic.html">See the dataset <span aria-hidden="true">${icon("arrowUpRight")}</span></a></div></div>

  <section class="am-section am-universe" id="games" aria-labelledby="games-title">
    <div class="wrap"><div class="am-section-head am-reveal"><div><span class="am-section-symbol">${icon("radar")}</span><p class="am-kicker">01 / A BIGGER PLAYGROUND</p><h2 id="games-title">One companion.<br><em>A whole lot of possibility.</em></h2></div><p>League is just the beginning of the ambition.<br>Select a game to see what is available today, and what could come next.</p></div>
      <div class="am-universe-layout">
        <div class="am-game-details" aria-live="polite" aria-atomic="true">
        ${games.map((game, i) => `<article class="am-game-detail" id="game-${game.id}" style="--game-color:${game.color}"${i ? " hidden" : ""}><div class="am-game-id"><span class="am-game-mark" aria-hidden="true">${game.short}</span><div><small>${game.category}</small><h3>${game.name}</h3></div><span class="am-game-status${i ? "" : " available"}">${game.status}</span></div><h4>${game.title}</h4><p>${game.text}</p><ul class="am-game-tags">${game.tags.map(tag => `<li>${tag}</li>`).join("")}</ul><a class="am-link" href="${game.href}">${game.action} <span aria-hidden="true">↗</span></a></article>`).join("")}
          <p class="am-roadmap-note">Wishlist entries are ideas, not supported games or promised release dates.</p>
        </div>
        ${gameRadar()}
      </div>
      <noscript><p class="am-roadmap-note">League Classic is available. VALORANT, Counter-Strike 2, Fortnite and Overwatch are wishlist ideas only. <a href="mailto:contact@allmid.gg">Email a game suggestion.</a></p></noscript>
    </div>
  </section>

  <section class="am-section am-experience" id="experience" aria-labelledby="experience-title">
    <div class="wrap"><div class="am-section-head am-reveal"><div><span class="am-section-symbol">${icon("layers")}</span><p class="am-kicker">02 / IN YOUR CORNER</p><h2 id="experience-title">Less searching.<br><em>More playing.</em></h2></div><p>Good information should be easy to find.<br>Here is what the League Classic module brings to your setup.</p></div>
      <div class="am-feature-tabs" role="tablist" aria-label="Explore League Classic features"><button id="tab-builds" role="tab" aria-selected="true" aria-controls="feature-builds" data-feature="builds" type="button">${icon("layers")}<span>01</span> Build insights</button><button id="tab-select" role="tab" aria-selected="false" aria-controls="feature-select" data-feature="select" tabindex="-1" type="button">${icon("matchup")}<span>02</span> Matchup context</button><button id="tab-overlay" role="tab" aria-selected="false" aria-controls="feature-overlay" data-feature="overlay" tabindex="-1" type="button">${icon("overlay")}<span>03</span> In-game overlay</button></div>
      ${featurePanel("builds", "Builds", "A build is better<br>with context.", "See the items people actually finished their games with, split by champion and lane. Pick rates and win rates sit together, so you can read the evidence. These are finished inventories, not a purchase order.", demos.builds, "champions.html", true)}
      ${featurePanel("select", "Matchups", "Know the matchup.<br>Make your own call.", "The same champion plays differently in different lanes. Explore opponents and counters in their lane context, with the number of recorded games beside the result.", demos.select, "champions.html", false)}
      ${featurePanel("overlay", "Overlay", "Keep the useful<br>details in view.", "Objective respawn windows, item-gold differences and your skill order, in a small panel above the game. The overlay does not display hidden enemy information.", demos.overlay, "overlay.html", false)}
      <noscript><p>Explore all features on <a href="app.html">the app page</a>, including <a href="overlay.html">the overlay</a>.</p></noscript>
      <div class="am-principles"><article><span aria-hidden="true">${icon("monitor")}</span><h3>Your client. Your machine.</h3><p>AllMid reads the local client and keeps its database on your device.</p></article><article><span aria-hidden="true">${icon("target")}</span><h3>Numbers with a source.</h3><p>Sample sizes stay visible. Small samples are called out, not dressed up.</p></article><article><span aria-hidden="true">${icon("code")}</span><h3>Open from the start.</h3><p>No account required. Optional data sharing. Code you can inspect.</p></article></div>
    </div>
  </section>

  <section class="am-section am-data" id="classic-data" aria-labelledby="data-title">
    <div class="wrap"><div class="am-section-head am-reveal"><div><span class="am-section-symbol">${icon("chart")}</span><p class="am-kicker">03 / THE PROOF IS IN THE GAMES</p><h2 id="data-title">Real games.<br><em>Readable insights.</em></h2></div><div><p>A snapshot from League Classic.<br>Top overall win rates in our recorded dataset, pooled across lanes.</p><p class="am-dataset-date">Dataset updated ${esc(stats.date)}</p></div></div>
      <div class="am-champion-cards">${leaders.map((champ, i) => `<a class="am-champion-card" href="champion/${esc(champ.slug)}.html"><div class="am-champion-art"><img src="${esc(champ.art)}" alt="" width="640" height="360" loading="lazy"><span class="am-rank">0${i + 1} / CLASSIC OVERALL</span><span class="am-card-arrow" aria-hidden="true">↗</span></div><div class="am-champion-info"><h3>${esc(champ.name)}</h3><div><b>${champ.winrate.toFixed(1)}<small>%</small></b><span>smoothed win rate</span></div></div><p class="am-champion-sample">${num(champ.games)} recorded games <span>All lanes combined</span></p></a>`).join("")}</div>
      <div class="am-data-footer"><p>Win rate uses a 20-game prior. Lane-level results can differ from the overall ranking.</p><a class="am-link" href="classic.html">Explore the full Classic dataset <span aria-hidden="true">↗</span></a></div>
    </div>
  </section>

  <section class="am-section am-faq" id="faq" aria-labelledby="faq-title"><div class="wrap am-faq-layout"><div><span class="am-section-symbol">${icon("help")}</span><p class="am-kicker">BEFORE YOU QUEUE</p><h2 id="faq-title">A few things<br><em>worth knowing.</em></h2><a class="am-link" href="mailto:contact@allmid.gg">Ask us something <span aria-hidden="true">↗</span></a></div><div class="am-faq-list">
    <details><summary>Which games can I use it with today?<span aria-hidden="true">+</span></summary><p>League of Legends is the first module. The published win rates, builds and matchups currently come from Classic games. The other games on this page are wishlist ideas, not working integrations.</p></details>
    <details><summary>Is AllMid really free?<span aria-hidden="true">+</span></summary><p>Yes. AllMid is free and open source under the MIT licence. You can inspect the code on <a href="https://github.com/allmidgg/desktop">GitHub</a>.</p></details>
    <details><summary>Do I need an account?<span aria-hidden="true">+</span></summary><p>No. AllMid reads your local client and stores its database on your machine. Sharing your games is optional and separate from using the app.</p></details>
    <details><summary>What does the overlay show?<span aria-hidden="true">+</span></summary><p>The current overlay includes objective respawn timers based on visible kill events, item-gold differences and your own skill order. It does not show hidden enemy cooldowns or ward positions. See <a href="overlay.html">the overlay page</a> for the full scope. This is not a guarantee about anti-cheat or publisher approval.</p></details>
    <details><summary>Can I suggest the next game?<span aria-hidden="true">+</span></summary><p>Absolutely. <a href="mailto:contact@allmid.gg?subject=My%20next%20AllMid%20game">Tell us the game</a> and the information that would help you most. Each game needs its own data access and rules review before an integration can be promised.</p></details>
  </div></div></section>

  <section class="am-download" id="get"><div class="wrap"><div class="am-download-orbits" aria-hidden="true"></div><span class="am-section-symbol">${icon("download")}</span><p class="am-kicker">READY WHEN YOU ARE</p><h2>Your next match.<br><em>A little more informed.</em></h2><p>Get the League Classic companion today.<br>Be here for what comes next.</p><a class="btn btn-primary" href="${download}">${icon("download")} Download AllMid for Windows</a><p class="am-install-note">Windows 10 &amp; 11 <span>·</span> Free <span>·</span> No account</p></div></section>
</main>
<footer class="am-footer"><div class="wrap"><div class="am-footer-top"><a class="am-footer-brand" href="index.html">All<span>Mid</span><small>GAME INTELLIGENCE, IN YOUR CORNER.</small></a><nav aria-label="Footer"><a href="app.html">The app</a><a href="classic.html">League Classic</a><a href="https://github.com/allmidgg/desktop">GitHub ↗</a><a href="mailto:contact@allmid.gg">Get in touch ↗</a></nav></div><div class="am-footer-bottom"><p>Independent. Open source. Made for the next game.</p><p>Game names and artwork belong to their respective owners. AllMid is not endorsed by Riot Games or the publishers of the games shown.</p></div></div></footer>
${search}
</body>
</html>`;
}
