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
import { MatchStore, defaultStorePath, type StoredMatch } from "../src/core/services/matchStore";
import { JadeStats } from "../src/core/services/stats";
import { SiteRefresher } from "./siteRefresh";

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.ALLMID_KEY ?? "";
const DATA_ROOT = process.env.ALLMID_DATA ?? process.cwd();

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

/** Per IP: hoeveel verzoeken per minuut. */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

const DATABASE = defaultStorePath(DATA_ROOT);

const store = new MatchStore(DATABASE);
let stats = new JadeStats();
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

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
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
    if (typeof p.championId !== "number" || p.championId < 60_000 || p.championId > 70_000) return false;
    if (typeof p.win !== "boolean") return false;
    for (const key of ["kills", "deaths", "assists", "cs", "gold"] as const) {
      const n = p[key];
      if (typeof n !== "number" || n < 0 || n > 100_000) return false;
    }
    return Array.isArray(p.items) && Array.isArray(p.spells);
  });
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
  stats = JadeStats.from(store.all());
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
    console.error("[allmid] verzoek mislukt:", (err as Error).message);
    if (!res.headersSent) send(res, 400, { error: (err as Error).message });
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
    });
  }

  if (rateLimited(ip)) return send(res, 429, { error: "te veel verzoeken" });

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
    req.method === "POST" &&
    (url.pathname === "/api/v1/matches" || url.pathname === "/api/v1/matches/known");

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

  send(res, 404, { error: "onbekend pad" });
}

async function main(): Promise<void> {
  console.log(`[allmid] database laden uit ${join(DATA_ROOT, "data")}...`);
  await store.load();
  rebuildStats();
  console.log(`[allmid] ${store.size} games, ${store.knownPuuids.length} spelers`);
  if (!API_KEY) console.warn("[allmid] LET OP: geen ALLMID_KEY gezet, iedereen mag uploaden");

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
