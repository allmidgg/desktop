/**
 * De verzamelserver.
 *
 * Clients sturen de Classic-games door die ze tegenkomen; hier worden ze
 * ontdubbeld en opgeteld. Dat ontdubbelen is de kern: komen tien mensen dezelfde
 * game tegen, dan slaan we hem één keer op. Overlap tussen gebruikers kost dus
 * niets, en daarom schaalt dit goed naarmate er meer mensen meedraaien.
 *
 * Bewust zonder framework en zonder database-engine: hetzelfde JSONL-formaat als
 * de client, zodat er maar één opslagvorm bestaat om te begrijpen en te
 * inspecteren. Draait op elke machine waar Node staat.
 *
 *   ALLMID_KEY=geheim npm run server
 *
 * Draaien via kale node met --experimental-strip-types lukt NIET: de imports
 * hier hebben geen bestandsextensie en de ESM-resolver van node eist die wel.
 * tsx lost dat op, en dat is wat npm run server gebruikt.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { isJadeItemId } from "../src/core/jade/ids";
import { modeOfStored } from "../src/core/modes/detect";
import { RiotApiClient } from "../src/core/riot/api";
import {
  MatchStore,
  MatchStores,
  defaultStorePath,
  type StoredMatch,
} from "../src/core/services/matchStore";
import { JadeStats } from "../src/core/services/stats";
import { createRiotCrawler, riotRateFromEnv, type RiotCrawler } from "./riotCrawler";
import { SiteRefresher } from "./siteRefresh";
import { SrSeedEndpoint } from "./srSeed";
import { SrSeedQueue } from "./srSeedQueue";

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.ALLMID_KEY ?? "";
const DATA_ROOT = process.env.ALLMID_DATA ?? process.cwd();

/**
 * The key for Riot's official API. From the environment, and from nowhere else.
 *
 * Three places it deliberately does not come from:
 *
 *   - a client. The whole point of collecting the modern game here instead of in
 *     the app is that one key stays on one machine. A key shipped inside ten
 *     thousand installations is a public string with a person's developer account
 *     behind it, and Riot suspends the account, not the installation.
 *   - settings.json. `StoredSettings.riotApiKey` exists for the app, which needs
 *     it on the machine of whoever is running a probe by hand. This process is not
 *     that machine, and a key in a file travels with a zipped data folder and
 *     shows up in screenshots of bug reports.
 *   - data/riot-key.txt. Same objection, and it sits inside the directory that
 *     gets copied to a backup host.
 *
 * An environment variable is held by the process and never touches this disk. A
 * development key expires within a day anyway, so anything written down is stale
 * tomorrow.
 *
 * It is read into a const here and passed to exactly one object. It is never sent
 * in a response, never written to a log line, and never included in an error a
 * client can see -- see `scrub()` for the part that is not a matter of care.
 */
const RIOT_API_KEY = process.env.RIOT_API_KEY ?? "";

/**
 * The platforms this server gathers modern games for.
 *
 * A seed for anything else is refused rather than filed, because match ids can
 * only be fetched from the routing region a platform belongs to: a Brazilian
 * account queued as European is a puuid whose matches are never found, and that
 * failure looks exactly like a player with no games.
 */
const SR_PLATFORMS = (process.env.ALLMID_RIOT_PLATFORMS ?? "EUW1")
  .split(",")
  .map((platform) => platform.trim().toUpperCase())
  .filter((platform) => platform.length > 0);

/**
 * One client for one key, deliberately shared.
 *
 * Every RiotApiClient paces itself against its own window, so two of them on the
 * same key each believe they have the full allowance and together ask for twice
 * it. The account lookups behind the seed endpoint and whatever crawls with this
 * key must therefore be the same object -- that is what makes the seed budget in
 * srSeed.ts a share of the crawl's window rather than an addition to it.
 *
 * That is also why `createRiotCrawler()` takes this client instead of the key:
 * with the key it would have built its own, and the resulting 190 requests per
 * two minutes against a limit of 100 is not a slow crawl but a 429 followed by a
 * key nobody can use. The hazard is invisible at each call site on its own, so
 * the object is the thing that gets shared rather than the credential.
 *
 * The rate comes from the environment for the reason `riotRateFromEnv()` sets
 * out: a development key is 95 per two minutes and a production key is whatever
 * Riot negotiated, and the difference between them should not require a rebuild.
 * Reading it here rather than inside the crawler means the seed lookups obey the
 * same figure -- there is one budget on this key, so there is one place it is
 * configured.
 */
let crawler: RiotCrawler | null = null;
const riot = RIOT_API_KEY
  ? new RiotApiClient(RIOT_API_KEY, SR_PLATFORMS[0] ?? "EUW1", {
      ...riotRateFromEnv(),
      // Late-bound on purpose: the client has to exist before the crawler can be
      // built on it, so the counter it reports into cannot be passed in here.
      // A 429 that reaches this callback means our own bookkeeping was wrong,
      // and without it that shows up as a mysteriously slow crawl rather than as
      // a rate that needs lowering.
      onRateLimited: (retryAfter) => {
        crawler?.noteRateLimited();
        console.warn(`[allmid] Riot antwoordde 429; ${retryAfter}s wachten (verlaag ALLMID_RIOT_RPW)`);
      },
    })
  : null;

/**
 * The inbox between the endpoint and whatever crawls.
 *
 * Kept separate from the crawler's own queue on purpose. The crawler's queue is
 * its working set and it saves it when it feels like it; a seed has to survive
 * from the moment a client was told "queued" until a crawl run picks it up, even
 * if that is across a restart. Draining it is one line wherever the crawler is
 * started -- `crawler.seed((await srSeeds.take(n)).map((s) => s.puuid))` -- and
 * `take()` only forgets what it hands over.
 */
const srSeeds = new SrSeedQueue(join(DATA_ROOT, "data", "sr-seed-queue.json"));

const srSeedEndpoint = new SrSeedEndpoint({
  queue: srSeeds,
  enabled: riot !== null,
  platforms: SR_PLATFORMS,
  // The platform is not passed on, and that is not an oversight. ACCOUNT-V1
  // answers the same puuid whichever routing region is asked -- an account is
  // global, only its matches are not -- so one client can resolve a Riot ID for
  // any platform this server serves. Which region the *matches* have to be
  // fetched from is what the queue entry carries.
  lookup: (gameName, tagLine) => {
    if (!riot) throw new Error("no riot client");
    return riot.accountByRiotId(gameName, tagLine);
  },
  warn: (message) => console.warn(`[allmid] ${scrub(message)}`),
});

/**
 * The two stores, for the crawler only.
 *
 * The Classic half of this router is never loaded and never written, and that is
 * a guarantee rather than a hope. `srMatchOnly()` refuses every record whose mode
 * is not `lol:sr`; `MatchStores.add()` routes on `modeOfStored()`, which prefers
 * the mode already written into the record; and `MatchStores.write()` only opens
 * a store it actually has games for. So no path from this crawler reaches
 * matches.jsonl, and the idle `MatchStore` inside this router costs a few empty
 * Maps -- its constructor touches no file.
 *
 * It has to be the router and not just the modern store because that is where the
 * routing guarantee lives. Handing the crawler a bare `lol:sr` store would make
 * "modern games end up in the modern file" an agreement between two filters that
 * can drift, instead of a property of the object doing the filing.
 *
 * `store` above stays the one and only reader and writer of the Classic pool. The
 * uploader, /api/v1/matches, /matches/known, /stats and the site refresher all
 * go through it exactly as they did, and none of them can see this object.
 */
const srStores = new MatchStores(DATA_ROOT);

/**
 * How many players one crawl pass walks, and how often a pass starts.
 *
 * Both are budget dials rather than tuning knobs. Measured over 18 requests
 * against the live API, a pass costs about 1.3 requests per game stored on a cold
 * store, and one player is roughly one id request plus the matches of his that we
 * do not already hold -- so 25 players is well under a development key's 95 per
 * two minutes even when every match is new, and the client's own throttle absorbs
 * the rest by waiting rather than by failing.
 */
const CRAWL_PLAYERS_PER_PASS = Number(process.env.ALLMID_RIOT_PLAYERS ?? 25);
const CRAWL_EVERY_MS = Number(process.env.ALLMID_RIOT_EVERY ?? 300) * 1000;

/**
 * How many of a player's matches to ask for, and which queues to ask about.
 *
 * From the environment for the same reason the rate is: the right answer differs
 * by key, not by build. Under a development key the queue filter is most of the
 * throughput -- MATCH-V5 filters on its side, so asking with a queue means every
 * id that comes back is one we want, while asking without one means paying a
 * whole request to discover a game was ARAM. Under a production key the filter is
 * the thing holding the crawl back, and `ALLMID_RIOT_QUEUES=` (empty) turns it off
 * and lets `resolveMode()` sort out whatever arrives.
 *
 *     ALLMID_RIOT_MATCHES=20     matches per player   (MATCH-V5 caps this at 100)
 *     ALLMID_RIOT_QUEUES=420,440 ranked solo and flex; empty means no filter
 */
const CRAWL_MATCHES_PER_PLAYER = Number(process.env.ALLMID_RIOT_MATCHES ?? 20);
const CRAWL_QUEUES =
  process.env.ALLMID_RIOT_QUEUES === undefined
    ? undefined
    : process.env.ALLMID_RIOT_QUEUES.split(",")
        .map((queue) => Number(queue.trim()))
        .filter((queue) => Number.isFinite(queue) && queue > 0);

/**
 * How many seeds a pass takes off the queue before it starts.
 *
 * The crawler grows its own frontier from the nine other players in every match
 * it fetches, so seeds are entry points and not fuel: taking them all at once
 * would spend a day's worth of new installations on a single pass and lose the
 * spread that makes the crawl reach different parts of the network.
 */
const SEEDS_PER_PASS = 5;

/**
 * Whether this server crawls at all. Off unless someone says otherwise.
 *
 * A default of off is the honest one while the key is a development key. Starting
 * this process would otherwise begin spending a 95-per-two-minutes budget that is
 * shared with the seed endpoint and with whoever is testing, and it would do it
 * silently, on a key that expires within the day. Serving the API and gathering
 * the database are two decisions, so they are two switches:
 *
 *     ALLMID_RIOT_CRAWL=1   turn the crawl on
 *
 * With a production key this is the line to set and leave set.
 */
const CRAWL_ENABLED = process.env.ALLMID_RIOT_CRAWL === "1";

/**
 * Op welk adres we luisteren.
 *
 * Standaard alleen op localhost. Op de server staat hier een webserver voor
 * die het verkeer doorstuurt, en dan hoort deze poort niet vanaf het internet
 * bereikbaar te zijn: anders kan iemand de webserver omzeilen en rechtstreeks
 * uploaden, buiten de snelheidsbegrenzing en de sleutelcontrole van de proxy om.
 *
 * Zet ALLMID_HOST=0.0.0.0 als je hem bewust open wilt zetten.
 */
const HOST = process.env.ALLMID_HOST ?? "127.0.0.1";

/** Grenzen die voorkomen dat één verzoek de server plat legt. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MATCHES_PER_REQUEST = 500;
const MAX_IDS_PER_REQUEST = 2_000;

/**
 * Per IP: hoeveel verzoeken per minuut.
 *
 * Stond op 120 en dat was te krap. Een eerste sync vraagt eerst in blokken van
 * duizend welke gameIds ontbreken -- bij 128.000 games zijn dat al 129 verzoeken
 * voordat er een enkele game verstuurd is -- en daarna komt het uploaden zelf in
 * batches van 500. Samen bijna vierhonderd verzoeken, dus drie tot vier keer een
 * minuut stilstaan. Gemeten op de echte server: ruim vijf minuten voor de eerste
 * sync, en dat overkomt elke nieuwe gebruiker een keer.
 *
 * 600 haalt dat terug naar ongeveer een minuut en blijft begrensd. Het beschermt
 * ook niet minder dan eerst: wat een verzoek kan aanrichten wordt bepaald door
 * MAX_BODY_BYTES en MAX_MATCHES_PER_REQUEST, niet door hoe vaak je mag kloppen,
 * en alles wat binnenkomt gaat door isValidMatch en de ontdubbeling op gameId.
 */
const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;

/** Which mode this server counts. The shared pool has held nothing else, ever. */
const POOL_MODE = "lol:jade" as const;

// The mode is spelled out rather than left to the default, because this one file
// is the shared pool: a server pointed at a different mode's file would keep
// answering /stats in the same shape while the numbers behind it changed
// families, and no client could tell.
const DATABASE = defaultStorePath(DATA_ROOT, POOL_MODE);

const store = new MatchStore(DATABASE);

let stats = new JadeStats(POOL_MODE);
let statsCache: string | null = null;
let uploadsSinceRebuild = 0;

/**
 * Statistiek herberekenen is duur, dus niet bij elke upload.
 *
 * Dit getal gaat over de telling in dít proces voor /api/v1/stats: geheugen, geen
 * schijf, en klaar voordat het volgende verzoek binnen is. De site verversen is een
 * heel andere prijs (307 MB twee keer van schijf, plus de HTML, plus de publicatie)
 * en heeft daarom een eigen, veel hogere drempel. Zie de onderbouwing bij
 * ALLMID_SITE_EVERY in siteRefresh.ts.
 */
const REBUILD_AFTER_UPLOADS = 500;

/**
 * Zorgt dat de website de nieuwe games ook echt gaat tonen.
 *
 * Staat standaard uit; zonder ALLMID_SITE_REFRESH=1 gebeurt hier niets. Zie
 * siteRefresh.ts voor alle grenzen en waarom ze zo staan.
 */
const site = new SiteRefresher(DATABASE, () => store.size);

const hits = new Map<string, { count: number; resetAt: number }>();

/**
 * Geeft terug hoeveel seconden er nog gewacht moet worden, of 0 als het mag.
 *
 * Eerder was dit een simpele ja/nee. Dat was te weinig: de client kreeg een 429
 * zonder te weten hoe lang het venster nog loopt, gokte vijf seconden, en gaf na
 * zes pogingen op -- dertig seconden, terwijl het venster er zestig is. Een
 * eerste sync van honderdduizend games kwam er dus per definitie niet doorheen.
 */
function rateLimited(ip: string): number {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return 0;
  }
  entry.count++;
  if (entry.count <= RATE_LIMIT) return 0;
  return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
}

/**
 * Controleert een binnengekomen game voordat we hem opslaan.
 *
 * Alles wat hier binnenkomt is door een vreemde opgestuurd, dus we geloven er
 * niets van tot het klopt: tien spelers, plausibele cijfers, bekende velden.
 */
function isValidMatch(value: unknown): value is StoredMatch {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<StoredMatch>;
  if (typeof m.gameId !== "number" || !Number.isFinite(m.gameId) || m.gameId <= 0) return false;
  if (typeof m.createdAt !== "number" || typeof m.duration !== "number") return false;
  if (m.duration < 300 || m.duration > 10_800) return false;
  if (typeof m.queueId !== "number" || typeof m.patch !== "string" || m.patch.length > 12) return false;
  if (!Array.isArray(m.players) || m.players.length !== 10) return false;

  return m.players.every((p) => {
    if (!p || typeof p !== "object") return false;
    if (typeof p.puuid !== "string" || p.puuid.length < 8 || p.puuid.length > 128) return false;
    // This bound is the only thing keeping the shared aggregate single-mode, and
    // it reads like a sanity check rather than the mode gate it actually is.
    // Named here so whoever widens it for the modern game sees what else has to
    // change first: app-stats.json carries a modus field that refresh.mjs writes
    // and JadeStats.fromAggregate checks, the id shift on both sides of that file
    // is conditional on the mode, and positionTotals is counted per mode. Widen
    // this line alone and every installation downloads a mixed aggregate at once,
    // with no way to split it apart again.
    if (typeof p.championId !== "number" || p.championId < 60_000 || p.championId > 70_000) return false;
    // A record whose champions and items come from different id spaces is not a
    // Classic game however it was labelled. Queue 2450 (gameMode KIWI_JADE, Jade
    // content on the ARAM map) produces exactly that shape: modern champion ids
    // beside items in the 770000 range. Game 7953675289 is one. The champion
    // bound above already turns that direction away; this closes the mirror
    // image, a Jade champion holding modern items. Measured over the whole
    // 130,197-game store the item ids run 771001 to 773504, so this refuses
    // nothing that exists.
    if (!Array.isArray(p.items)) return false;
    if (p.items.some((id) => typeof id === "number" && id > 0 && !isJadeItemId(id))) return false;
    if (typeof p.win !== "boolean") return false;
    for (const key of ["kills", "deaths", "assists", "cs", "gold"] as const) {
      const n = p[key];
      if (typeof n !== "number" || n < 0 || n > 100_000) return false;
    }
    return Array.isArray(p.spells);
  });
}

/**
 * Removes the secrets from a piece of text that is about to be shown to someone.
 *
 * Belt and braces, and worth having as braces. The Riot key travels in the
 * X-Riot-Token header, so RiotApiError's url does not contain it and neither does
 * its message -- verified against the live API: a 404 from ACCOUNT-V1 gives
 * "Riot API 404 on https://europe.api.riotgames.com/riot/account/v1/accounts/
 * by-riot-id/.../..." with no key anywhere in it. That is a fact about today's
 * api.ts, though, not a property of the type. One `?api_key=` appended by
 * somebody debugging, and every 404 this server hands back starts carrying the
 * key, in a message nobody would think to check.
 *
 * Applied to both the response and the log line, because a key in the log is a
 * key in whatever gets pasted into an issue.
 */
function scrub(text: string): string {
  let safe = text;
  for (const secret of [RIOT_API_KEY, API_KEY]) {
    if (secret.length >= 8) safe = safe.split(secret).join("***");
  }
  return safe;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body te groot");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function rebuildStats(): void {
  /**
   * Sorted before counting, and here that is not belt and braces.
   *
   * JadeStats.ingest() throws on a record from another mode, which is right in
   * the app: there every match came off this machine, so a mismatch is a bug and
   * should be loud. Here every match came from a stranger. A single upload whose
   * queue id we cannot place would otherwise throw on every rebuild from then on
   * -- 400 to the uploader who tripped it, a dead process on the next restart,
   * and an aggregate frozen at whatever it held before. One unrecognised queue
   * is not worth the shared pool.
   *
   * So the boundary decides what goes in and the guard stays a guard. This does
   * not widen anything: isValidMatch() is still the only door, and its champion
   * range still turns modern uploads away before they are stored at all.
   */
  const own = store.all().filter((match) => modeOfStored(match) === POOL_MODE);
  const foreign = store.size - own.length;
  if (foreign > 0) console.warn(`[allmid] ${foreign} games buiten ${POOL_MODE} niet meegeteld`);
  stats = JadeStats.from(own, POOL_MODE);
  statsCache = null;
  uploadsSinceRebuild = 0;
}

/** De opgetelde statistiek, zoals de clients hem tonen. */
function buildStatsPayload(): string {
  if (statsCache) return statsCache;
  const positions = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"] as const;
  const lanes: Record<string, unknown> = {};
  for (const position of positions) {
    lanes[position] = stats.tierList(position, 25).map((entry) => ({
      championId: entry.championId,
      games: entry.games,
      winrate: entry.winrate,
      pickRate: entry.pickRate,
    }));
  }
  statsCache = JSON.stringify({
    games: stats.totalMatches,
    coverage: stats.coverage(),
    lanes,
    generatedAt: new Date().toISOString(),
  });
  return statsCache;
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    const message = scrub((err as Error).message);
    console.error("[allmid] verzoek mislukt:", message);
    if (!res.headersSent) send(res, 400, { error: message });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/api/v1/health") {
    // `site` erbij omdat de verversing anders onzichtbaar is: hij draait vanzelf,
    // in een kindproces, en de enige andere weg naar die informatie is het
    // logbestand doorspitten. Nu zie je in één blik wanneer de site voor het laatst
    // bijgewerkt is, met hoeveel games, en of er nu iets loopt of vastzit.
    return send(res, 200, {
      ok: true,
      games: store.size,
      players: store.knownPuuids.length,
      site: site.status(),
      // Named `srSeeds` and never folded into `players`. That count is Classic
      // puuids from the League client; these are MATCH-V5 puuids. They are
      // different identifiers for overlapping people, so any screen that adds
      // them up counts the same players twice, in the flattering direction.
      srSeeds: srSeeds.status(),
      // The modern store, reported beside the Classic one and never summed with
      // it for the same reason: `games` above is the shared Classic pool, `sr` is
      // what the key fetched. They are two corpora with two provenances, and one
      // total would hide which is which.
      sr: crawler
        ? { crawling: crawler.isRunning, games: srStores.for("lol:sr").size }
        : { crawling: false, games: 0 },
    });
  }

  const wacht = rateLimited(ip);
  if (wacht > 0) {
    // Retry-After erbij, anders moet de client gokken hoe lang hij moet wachten.
    res.setHeader("retry-after", String(wacht));
    return send(res, 429, { error: "te veel verzoeken", retryAfter: wacht });
  }

  /**
   * Uploaden mag ZONDER sleutel.
   *
   * Eerder gold de sleutel voor alles behalve /health. Dat werkte niet: de app
   * van een gebruiker heeft die sleutel niet, dus die kreeg een 401 op elke
   * upload -- terwijl het hele idee is dat iedereen die AllMid draait meebouwt
   * aan de database. En een sleutel die je in tienduizend installaties zet is
   * geen sleutel meer; die peutert iemand binnen een minuut uit de .exe.
   *
   * Wat uploads afschermt is dus niet een geheim maar de controle zelf:
   * isValidMatch() weigert alles wat er niet uitziet als een echte Classic-game,
   * de ontdubbeling op gameId maakt herhaald opsturen zinloos, en RATE_LIMIT
   * begrenst hoeveel een IP per minuut mag.
   *
   * De sleutel blijft voor wat wel afgeschermd hoort: de opgetelde statistiek.
   * Die is duur om te berekenen en hoeft niet door vreemden opgevraagd te
   * kunnen worden.
   */
  const openbaar =
    (req.method === "POST" &&
      (url.pathname === "/api/v1/matches" ||
        url.pathname === "/api/v1/matches/known" ||
        // Seeding is open for the same reason uploading is: it is a thing an
        // ordinary installation does, and an installation has no key. What guards
        // it is not a secret but the endpoint itself -- one account lookup per
        // request, a handful per address per hour, and a hard ceiling on how much
        // of Riot's budget seeding may take. See srSeed.ts.
        url.pathname === "/api/v1/sr/seed")) ||
    // Whatever the method. This one is outside the POST clause on purpose, and
    // measured rather than reasoned: while it sat inside, a POST here got the
    // explanation and a GET got a bare 401 -- which is precisely the answer the
    // refusal exists to replace. Somebody checking whether this endpoint exists
    // opens it in a browser, and a browser sends GET.
    url.pathname === "/api/v1/sr/matches";

  if (!openbaar && API_KEY && req.headers["x-allmid-key"] !== API_KEY) {
    return send(res, 401, { error: "ongeldige sleutel" });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/stats") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return void res.end(buildStatsPayload());
  }

  /** Welke van deze games kennen we al? Scheelt de client een hoop uploadverkeer. */
  if (req.method === "POST" && url.pathname === "/api/v1/matches/known") {
    const body = (await readBody(req)) as { gameIds?: unknown };
    const ids = Array.isArray(body?.gameIds) ? body.gameIds.slice(0, MAX_IDS_PER_REQUEST) : [];
    const missing = ids.filter((id): id is number => typeof id === "number" && !store.has(id));
    return send(res, 200, { missing });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/matches") {
    const body = (await readBody(req)) as { matches?: unknown };
    const incoming = Array.isArray(body?.matches) ? body.matches.slice(0, MAX_MATCHES_PER_REQUEST) : [];
    const valid = incoming.filter(isValidMatch);
    const added = await store.add(valid);

    uploadsSinceRebuild += added;
    if (uploadsSinceRebuild >= REBUILD_AFTER_UPLOADS) rebuildStats();
    else if (added > 0) statsCache = null;

    // Alleen melden, nooit erop wachten: de verversing beslist zelf of ze aan de
    // beurt is en draait daarna in een kindproces. Deze aanroep kost dus niets en
    // het antwoord aan de client hangt er niet vanaf.
    site.noteUploads(added);

    console.log(
      `[allmid] ${ip}: ${incoming.length} aangeboden, ${valid.length} geldig, ${added} nieuw ` +
        `(totaal ${store.size})`,
    );
    return send(res, 200, {
      accepted: added,
      rejected: incoming.length - valid.length,
      duplicates: valid.length - added,
      total: store.size,
    });
  }

  /**
   * "Start from me": a client hands over its own Riot ID and we queue it.
   *
   * The only thing a client may say about the modern game. Everything about the
   * shape of the request, what it costs and what comes back is in srSeed.ts.
   */
  if (req.method === "POST" && url.pathname === "/api/v1/sr/seed") {
    const reply = await srSeedEndpoint.handle(ip, await readBody(req));
    if (reply.retryAfter !== undefined) res.setHeader("retry-after", String(reply.retryAfter));
    // Logged without the Riot ID. The status and the queue depth are everything
    // needed to see this working; the name is somebody's, and a log file is the
    // one place data ends up that nobody remembers deciding to keep.
    console.log(`[allmid] ${ip}: seed ${reply.status} (wachtrij ${srSeeds.size})`);
    return send(res, reply.status, reply.body);
  }

  /*
   * ── There is no POST /api/v1/sr/matches, and there must not be ──────────────
   *
   * This is the line where you were about to add one. Two paragraphs, and then
   * decide.
   *
   * A client cannot upload modern games because a client cannot be allowed to
   * gather them. The only source it has is the League client's own match history,
   * which is an undocumented endpoint, and Riot's developer policy names scraping
   * undocumented endpoints as the thing not to do. For League Classic there is no
   * alternative -- no public API knows that game exists -- and that is precisely
   * why this project accepts the risk there and nowhere else. For the modern game
   * MATCH-V5 is documented, supported and already spoken by
   * src/core/riot/api.ts. Building a second, scraped corpus of a game that has a
   * documented one is effort spent acquiring a risk.
   *
   * So the absence is the design, not an omission. Add this endpoint and the
   * corpus it enables appears within a week: clients would fill it faster than
   * one server key ever could, every installation would start walking strangers'
   * histories through the client again, and the modern store would then hold data
   * we cannot say where it came from -- mixed in with what the key fetched
   * legally, with no field that separates them afterwards. The inversion this
   * whole step exists for (server crawls, clients read) would be undone by the
   * one route that looks like it is merely symmetrical with the Classic one.
   *
   * If you need the modern store to grow faster, the levers are the key's rate
   * (RiotApiOptions.requestsPerWindow, once there is a production key) and more
   * seeds. Not this.
   *
   * The same reasoning, from the client's side, is in the comment above
   * MatchUploader.sync(): it filters to lol:jade so nothing modern ever leaves a
   * machine in the first place. Both ends have to stay as they are; either one
   * alone is a promise, not a guarantee.
   *
   * The refusal below exists so this is not only written here. A comment is read
   * by whoever opens this file; the person about to build the upload is as likely
   * to be writing a client against the API, and all they would otherwise get is a
   * 404 that looks like something nobody has gotten round to yet.
   */
  if (url.pathname === "/api/v1/sr/matches") {
    return send(res, 404, {
      error: "moderne games worden hier niet geüpload",
      reason:
        "De server haalt ze zelf op via Riots MATCH-V5. Clients uploaden alleen " +
        "League Classic, waarvoor geen gedocumenteerde API bestaat.",
    });
  }

  send(res, 404, { error: "onbekend pad" });
}

/**
 * One crawl pass: take the seeds that came in, then walk.
 *
 * This is the join the seed endpoint was written against and the crawler was
 * written for, and until it existed the two halves each worked while the whole
 * did nothing: `SrSeedQueue` filled up and nobody emptied it, so a client that
 * was told "queued" was told the truth about a queue with no consumer.
 *
 * The order matters. Seeds go in before the walk so that an account that arrived
 * during the last pass is in the frontier for this one, and `take()` only forgets
 * what it hands over -- so a crash between the take and the walk costs those
 * entry points rather than duplicating them, which is the cheaper of the two
 * mistakes: the crawler re-derives players from every match it fetches anyway,
 * and a person who seeded can seed again.
 *
 * Passes never overlap. `run()` refuses to start a second time on its own, but
 * the interval is the thing that would queue them up behind each other, so it is
 * checked here too -- a pass that is waiting out the rate limiter can easily be
 * longer than the interval.
 */
async function crawlPass(): Promise<void> {
  if (!crawler || crawler.isRunning) return;
  const seeds = await srSeeds.take(SEEDS_PER_PASS);
  if (seeds.length > 0) {
    const added = crawler.seed(seeds.map((seed) => seed.puuid));
    console.log(`[allmid] ${seeds.length} seeds opgenomen (${added} nieuw in de wachtrij)`);
  }
  const { progress, reason } = await crawler.run(CRAWL_PLAYERS_PER_PASS);
  console.log(
    `[allmid] crawl ${reason}: +${progress.newThisRun} games ` +
      `(${progress.storedMatches} totaal), ${progress.requestsThisRun} verzoeken, ` +
      `${progress.rateLimitHits} keer 429, ${progress.errors} fouten`,
  );
  // An expired key is the one outcome worth stopping for rather than retrying
  // every five minutes. A development key dies after 24 hours and then answers
  // 403 to everything; carrying on would spend every pass marking players visited
  // for a reason that has nothing to do with them.
  if (reason === "auth") {
    console.warn("[allmid] Riot weigert de sleutel; crawl gestopt tot herstart met een geldige sleutel");
    crawler = null;
  }
}

async function main(): Promise<void> {
  console.log(`[allmid] database laden uit ${join(DATA_ROOT, "data")}...`);
  await store.load();
  rebuildStats();
  console.log(`[allmid] ${store.size} games, ${store.knownPuuids.length} spelers`);
  if (!API_KEY) console.warn("[allmid] LET OP: geen ALLMID_KEY gezet, iedereen mag uploaden");

  await srSeeds.load();
  if (riot) {
    // Whether there is a key, never which key, and not even a prefix of one.
    console.log(
      `[allmid] moderne seeds aan voor ${SR_PLATFORMS.join(", ")}; ` +
        `${srSeeds.size} in de wachtrij`,
    );
  } else {
    console.warn("[allmid] geen RIOT_API_KEY gezet; /api/v1/sr/seed weigert alles");
  }

  if (riot && CRAWL_ENABLED) {
    crawler = createRiotCrawler(riot, srStores, {
      statePath: join(DATA_ROOT, "data", "riot-crawl-state.json"),
      matchesPerPlayer: CRAWL_MATCHES_PER_PLAYER,
      // Left undefined rather than defaulted here, so the crawler's own default
      // stays the single place ranked solo and flex are named.
      ...(CRAWL_QUEUES === undefined ? {} : { queues: CRAWL_QUEUES }),
    });
    // Says out loud what was thrown away, because the likeliest reason for a drop
    // is somebody having pointed this at data/crawler-state.json -- 3 MB of LCU
    // puuids, which parse perfectly and would crawl forever without storing a
    // single game. A silent zero here and a silent zero there look identical.
    // Only the modern mode, and never the Classic one. `load()` takes a list
    // precisely so a caller can skip a mode, and skipping matches.jsonl here is
    // not an optimisation: it is 326 MB of JSONL and about 483 MB of heap that
    // `store` above has already paid for once, and a second copy in this process
    // would answer questions nobody asks it. Done at startup rather than left to
    // the first pass so /health reports the real figure straight away.
    await srStores.load("lol:sr");
    const restored = await crawler.loadState();
    console.log(
      `[allmid] moderne crawl aan: ${restored.loaded ? "wachtrij hersteld" : "verse wachtrij"}` +
        `${restored.reason ? ` (${restored.reason})` : ""}` +
        `${restored.dropped > 0 ? `, ${restored.dropped} onbruikbare puuids weggelaten` : ""}`,
    );
    // The first pass is deliberately not run here. main() has to reach listen(),
    // and a pass can sit in the rate limiter for the better part of two minutes --
    // so starting one now would keep the port closed while it did.
    setInterval(() => {
      void crawlPass().catch((err) => console.error("[allmid] crawl mislukt:", scrub((err as Error).message)));
    }, CRAWL_EVERY_MS).unref();
  } else if (riot) {
    console.log("[allmid] moderne crawl staat uit; zet ALLMID_RIOT_CRAWL=1 om hem aan te zetten");
  }

  // Ná load(), want hij vergelijkt wat er gepubliceerd staat met wat de store kent.
  site.start();

  server.listen(PORT, HOST, () => {
    console.log(`[allmid] luistert op ${HOST}:${PORT}`);
    if (HOST === "127.0.0.1") {
      console.log("[allmid] alleen lokaal bereikbaar; zet er een webserver voor om hem publiek te maken");
    }
  });
}

void main();
