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
 *   JADE_KEY=geheim node --experimental-strip-types server/index.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { MatchStore, defaultStorePath, type StoredMatch } from "../src/core/services/matchStore";
import { JadeStats } from "../src/core/services/stats";

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.JADE_KEY ?? "";
const DATA_ROOT = process.env.JADE_DATA ?? process.cwd();

/** Grenzen die voorkomen dat één verzoek de server plat legt. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MATCHES_PER_REQUEST = 500;
const MAX_IDS_PER_REQUEST = 2_000;

/** Per IP: hoeveel verzoeken per minuut. */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

const store = new MatchStore(defaultStorePath(DATA_ROOT));
let stats = new JadeStats();
let statsCache: string | null = null;
let uploadsSinceRebuild = 0;

/** Statistiek herberekenen is duur, dus niet bij elke upload. */
const REBUILD_AFTER_UPLOADS = 500;

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
    console.error("[jade] verzoek mislukt:", (err as Error).message);
    if (!res.headersSent) send(res, 400, { error: (err as Error).message });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/api/v1/health") {
    return send(res, 200, { ok: true, games: store.size, players: store.knownPuuids.length });
  }

  if (rateLimited(ip)) return send(res, 429, { error: "te veel verzoeken" });

  // Alles behalve health vereist de sleutel.
  if (API_KEY && req.headers["x-jade-key"] !== API_KEY) {
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

    console.log(
      `[jade] ${ip}: ${incoming.length} aangeboden, ${valid.length} geldig, ${added} nieuw ` +
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
  console.log(`[jade] database laden uit ${join(DATA_ROOT, "data")}...`);
  await store.load();
  rebuildStats();
  console.log(`[jade] ${store.size} games, ${store.knownPuuids.length} spelers`);
  if (!API_KEY) console.warn("[jade] LET OP: geen JADE_KEY gezet, iedereen mag uploaden");

  server.listen(PORT, () => console.log(`[jade] luistert op poort ${PORT}`));
}

void main();
