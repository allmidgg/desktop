/**
 * AllMid timeline-endpoint-probe -- does the client hold a timeline for a
 * Classic game, and does it hold one for games we only crawled?
 *
 * Four places in this repo state that Classic match history has no timeline, and
 * all four trace back to one observation: `Participant.timeline` carries lane and
 * role and nothing else. Nobody had ever asked the client for a timeline as a
 * resource of its own -- there was no reference to such a path anywhere in the
 * repository -- so "there is no timeline" was an assumption wearing the clothes
 * of a fact, and a load-bearing one: a timeline that only the live watcher can
 * produce covers the games this machine was running for, while a timeline from
 * match history covers all 130,095 games already in data/matches.jsonl.
 *
 *   npm run timeline-endpoint-probe                -- your own most recent game
 *   npm run timeline-endpoint-probe -- 7957444528  -- one specific gameId
 *
 * It asks in four stages, most decisive first:
 *
 *   A. The client's own route index. The LCU publishes every operation it
 *      serves, so this answers the question without guessing at all.
 *   B. The game detail the crawler already fetches, scanned for anything
 *      carrying a moment in time.
 *   C. Candidate paths, each reported with status, size, and whether frames came
 *      back -- including the route that stage A names, so a hit is proven rather
 *      than inferred from a listing.
 *   D. Whether the same answer is reachable through replays, which would be a
 *      far more expensive way to get it.
 *
 * Everything it saw lands in data/timeline-probe-<gameId>.json, so the result
 * can be read back later with no client running.
 */
import { createReadStream } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { LcuClient, LcuHttpError, LcuNotRunningError } from "../core/lcu/connector";
import type { Game } from "../core/lcu/types";
import { fetchCurrentSummoner, fetchRecentGames } from "../core/services/player";

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

/**
 * Pause between requests, matching the crawler's own measured pace. This probe
 * fires about twenty requests in total, which is less than the crawler does in
 * two seconds, so the pause is manners rather than protection.
 */
const PACE_MS = 60;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MATCHES_PATH = "data/matches.jsonl";
const REPORT_DIR = "data";

interface ProbeResult {
  path: string;
  /** Why this path was worth trying, so a later reader can judge the guess. */
  reason: string;
  status: number | "unreachable";
  bytes: number;
  /** What a scan of the body found, or null when there was no body to scan. */
  frames: FrameScan | null;
  preview?: string;
}

interface FrameScan {
  /** Paths of arrays whose rows each carry a moment in time. */
  timeSeries: string[];
  /** Key names anywhere in the body that read like timeline machinery. */
  timelineKeys: string[];
  verdict: "frames" | "timestamps only" | "nothing time-shaped";
}

/** Keys meaning "this row happened at a moment", across every Riot shape seen so far. */
const TIME_KEY = /^(timestamp|frametime|gametime|gamelength|time|at|ts|eventtime)$/i;
/** Key names suggesting timeline machinery even when they hold nothing useful. */
const TIMELINE_KEY = /timeline|frame|participantframes|events/i;

/**
 * Walks a response looking for anything shaped like a timeline.
 *
 * The point is to recognise a timeline whatever Riot called it. A body is
 * interesting when it holds an array of rows that each carry a moment in time --
 * that is a series, regardless of field names -- so the walk reports where such
 * arrays live instead of testing for one expected schema.
 */
function scanForFrames(
  value: unknown,
  path = "$",
  acc?: { series: string[]; keys: Set<string> },
  depth = 0,
): FrameScan {
  const bucket = acc ?? { series: [], keys: new Set<string>() };
  if (depth <= 8 && value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      const first = value[0];
      if (first !== null && typeof first === "object" && !Array.isArray(first)) {
        const hasTime = Object.keys(first as Record<string, unknown>).some((k) => TIME_KEY.test(k));
        if (hasTime) bucket.series.push(`${path} (${value.length} rows)`);
      }
      // One element is enough to learn the shape; the rest repeat it.
      if (value.length > 0) scanForFrames(value[0], `${path}[0]`, bucket, depth + 1);
    } else {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (TIMELINE_KEY.test(key)) bucket.keys.add(`${path}.${key}`);
        scanForFrames(child, `${path}.${key}`, bucket, depth + 1);
      }
    }
  }
  return {
    timeSeries: bucket.series,
    timelineKeys: [...bucket.keys],
    verdict:
      bucket.series.length > 0 ? "frames" : bucket.keys.size > 0 ? "timestamps only" : "nothing time-shaped",
  };
}

/**
 * Requests one path and reports what came back, status included.
 *
 * `LcuClient.tryGet` is the safe way to touch an unknown endpoint, but it turns
 * a 404 into null and so erases the distinction this probe exists to draw: a 404
 * means the route is not registered, while a 400 or a 500 means it exists and we
 * asked it wrong -- which would be the most valuable answer of the run. The
 * error is therefore caught here and the status kept.
 */
async function probe(client: LcuClient, path: string, reason: string): Promise<ProbeResult> {
  await sleep(PACE_MS);
  try {
    const body = await client.get<unknown>(path);
    const text = JSON.stringify(body) ?? "";
    return { path, reason, status: 200, bytes: text.length, frames: scanForFrames(body), preview: text.slice(0, 400) };
  } catch (err) {
    if (err instanceof LcuHttpError) {
      return { path, reason, status: err.status, bytes: err.body.length, frames: null, preview: err.body.slice(0, 300) };
    }
    return { path, reason, status: "unreachable", bytes: 0, frames: null, preview: String(err).slice(0, 200) };
  }
}

/**
 * Pulls every route name out of an endpoint index.
 *
 * This is where a first version of this probe went wrong and nearly reported a
 * false negative. The LCU's /help does not list paths: it answers with
 * `{events, functions, types}` whose keys are operation names such as
 * GetLolMatchHistoryV1GameTimelinesByGameId. A scan that only kept strings
 * starting with a slash found nothing and concluded there was no index, while
 * the answer was sitting in it. So both keys and string values are kept, and
 * anything that reads like a route counts.
 */
function collectRouteNames(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  const looksLikeRoute = (s: string): boolean =>
    (s.startsWith("/") && s.length > 3) || /^(Get|Post|Put|Delete|Patch)[A-Z][A-Za-z0-9]{6,}$/.test(s);
  if (depth > 10) return out;
  if (typeof value === "string") {
    if (looksLikeRoute(value)) out.add(value);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (looksLikeRoute(key)) out.add(key);
    collectRouteNames(child, out, depth + 1);
  }
  return out;
}

/** Reads one gameId out of the crawled database without loading 325MB of it. */
async function gameIdFromDatabase(): Promise<number | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(MATCHES_PATH, { encoding: "utf8" });
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => {
      lines.close();
      stream.destroy();
      try {
        resolve((JSON.parse(line) as { gameId?: number }).gameId ?? null);
      } catch {
        resolve(null);
      }
    });
    lines.on("close", () => resolve(null));
    stream.on("error", () => resolve(null));
  });
}

function line(result: ProbeResult): string {
  const status =
    result.status === 200 ? `${c.green}200${c.reset}` :
    result.status === 404 ? `${c.dim}404${c.reset}` :
    `${c.yellow}${result.status}${c.reset}`;
  const found =
    result.frames?.verdict === "frames" ? `${c.green}FRAMES${c.reset}` :
    result.frames?.verdict === "timestamps only" ? `${c.yellow}time-shaped keys${c.reset}` :
    result.status === 200 ? `${c.dim}no frames${c.reset}` : "";
  return `   ${status}  ${String(result.bytes).padStart(8)}b  ${result.path}  ${found}`;
}

async function main(): Promise<void> {
  const client = await LcuClient.connect();
  console.log(`\n${c.bold}AllMid timeline-endpoint-probe${c.reset}`);

  // The crawler stands down while you are in a game and so does this. Twenty
  // requests would hurt nothing, but a tool that decides for itself when to talk
  // to a busy client is the one nobody trusts to run in the background.
  const phase = await client.tryGet<string>("/lol-gameflow/v1/gameflow-phase").catch(() => null);
  console.log(`${c.dim}client on port ${client.port} | gameflow phase ${phase ?? "unknown"}${c.reset}`);
  if (phase === "InProgress" || phase === "ChampSelect") {
    console.log(`${c.yellow}You are in a game. Run this afterwards.${c.reset}\n`);
    return;
  }

  const me = await fetchCurrentSummoner(client);
  const argGameId = Number(process.argv[2]);

  // One of your own games is worth more than any other: if a timeline route
  // exists but serves only games you played, a stranger's id answers 404 and we
  // would read that as "the route does not exist". Own game first, always.
  let gameId: number | null = Number.isFinite(argGameId) && argGameId > 0 ? argGameId : null;
  let ownGame = false;
  if (gameId === null) {
    const [recent] = await fetchRecentGames(client, me.puuid, 1);
    if (recent) {
      gameId = recent.gameId;
      ownGame = true;
    }
  }
  if (gameId === null) {
    gameId = await gameIdFromDatabase();
    console.log(`${c.yellow}No Classic game on this account; falling back to a crawled id, where a 404` +
      ` would mean "not yours" rather than "no such route".${c.reset}`);
  }
  if (gameId === null) {
    console.log(`${c.red}No gameId to probe with. Pass one: npm run timeline-endpoint-probe -- <gameId>${c.reset}\n`);
    return;
  }
  console.log(`${c.dim}account ${me.gameName}#${me.tagLine} | gameId ${gameId}${ownGame ? " (yours)" : ""}${c.reset}\n`);

  // The client is asked which region it is on, because the older stats service
  // the client used to proxy carried a platform in the path.
  const regionInfo = await client
    .tryGet<{ region?: string; webRegion?: string }>("/riotclient/region-locale")
    .catch(() => null);
  const platform = (regionInfo?.region ?? "EUW1").toUpperCase();

  const results: ProbeResult[] = [];

  // ── Stage A: ask the client what it actually serves ────────────────────────
  console.log(`${c.bold}A. The client's own route index${c.reset}`);
  const routes = new Set<string>();
  for (const indexPath of ["/help?format=Full", "/swagger/v3/openapi.json", "/swagger/v2/swagger.json"]) {
    const res = await probe(client, indexPath, "endpoint index");
    // The index runs to megabytes, so only its size and status are worth
    // recording; the routes themselves are reported separately below.
    results.push({ ...res, preview: undefined });
    console.log(line(res));
    if (res.status !== 200) continue;
    const full = await client.get<unknown>(indexPath).catch(() => null);
    if (full) for (const route of collectRouteNames(full)) routes.add(route);
  }
  const timelineRoutes = [...routes].filter((r) => /timeline|frame/i.test(r)).sort();
  const matchHistoryRoutes = [...routes].filter((r) => /match-?history/i.test(r)).sort();
  if (routes.size === 0) {
    console.log(`   ${c.yellow}No index available. Stages B to D are the only evidence this run produces.${c.reset}`);
  } else {
    console.log(`   ${routes.size} routes registered`);
    console.log(`   ${c.bold}naming a timeline or frames: ${timelineRoutes.length}${c.reset}`);
    for (const r of timelineRoutes) console.log(`      ${c.green}${r}${c.reset}`);
    console.log(`   ${c.dim}match-history routes: ${matchHistoryRoutes.length}${c.reset}`);
    for (const r of matchHistoryRoutes.slice(0, 30)) console.log(`      ${c.cyan}${r}${c.reset}`);
    if (timelineRoutes.length === 0) {
      console.log(`   ${c.yellow}The index answered and names no timeline. That is close to final:` +
        ` the LCU serves what its plugins register.${c.reset}`);
    }
  }

  // ── Stage B: what we already fetch, read properly this time ────────────────
  console.log(`\n${c.bold}B. The game detail the crawler already fetches${c.reset}`);
  const detailRes = await probe(client, `/lol-match-history/v1/games/${gameId}`, "the request the crawler already makes");
  results.push(detailRes);
  console.log(line(detailRes));
  if (detailRes.status === 200) {
    const detail = await client.tryGet<Game>(`/lol-match-history/v1/games/${gameId}`).catch(() => null);
    const scan = detailRes.frames;
    if (scan) {
      console.log(`   time-shaped series: ${scan.timeSeries.length ? scan.timeSeries.join(", ") : `${c.dim}none${c.reset}`}`);
    }
    // Printed in full because this single field is the entire basis for the
    // claim that Classic has no timeline, and it turns out to carry more field
    // names than the type in core/lcu/types.ts admits -- all of them empty.
    const participant = detail?.participants?.[0];
    if (participant) console.log(`   participant[0].timeline = ${JSON.stringify(participant.timeline)}`);
  }

  // ── Stage C: candidate routes ──────────────────────────────────────────────
  console.log(`\n${c.bold}C. Candidate routes${c.reset}`);
  const candidates: Array<[string, string]> = [
    [`/lol-match-history/v1/game-timelines/${gameId}`,
      "sibling collection, in the naming this API uses elsewhere (games, products)"],
    [`/lol-match-history/v1/games/${gameId}/timeline`,
      "sub-resource of the one game route that demonstrably works"],
    [`/lol-match-history/v1/products/lol/${me.puuid}/matches/${gameId}/timeline`,
      "product-scoped, mirroring the matches route the crawler pages through"],
    [`/lol-match-history/v1/products/lol/${me.puuid}/matches/${gameId}`,
      "not a timeline: establishes whether the product route addresses a single match at all"],
    [`/lol-match-history/v1/products/lol/current-summoner/matches/${gameId}/timeline`,
      "current-summoner alias, which the match list already accepts"],
    [`/lol-match-history/v1/timelines/${gameId}`,
      "plain collection name, in case the resource is not filed under games"],
    [`/lol-match-history/v2/games/${gameId}/timeline`,
      "version bump: lol-summoner serves v1 and v2 side by side, so v2 is plausible"],
    [`/lol-match-history/v1/games/${gameId}/frames`,
      "the payload named after its contents rather than the concept"],
    [`/lol-match-history/v1/stats/game/${platform}/${gameId}/timeline`,
      "the shape of the old match-stats service the client used to proxy"],
    [`/lol-match-history/v1/delta`,
      "not a timeline: a control, to show what a wrong guess looks like"],
  ];
  // Anything stage A turned up that is not already on the list gets tried too,
  // because the index is the only source here that is not guesswork.
  for (const route of timelineRoutes) {
    if (!route.startsWith("/")) continue;
    const filled = route.replace(/\{[^}]+\}/g, String(gameId));
    if (!candidates.some(([p]) => p === filled)) candidates.push([filled, "named by the client's own route index"]);
  }
  for (const [path, reason] of candidates) {
    const res = await probe(client, path, reason);
    results.push(res);
    console.log(line(res));
  }

  // ── Stage D: the other route to the same answer ────────────────────────────
  //
  // A replay file is a complete recording of a game, so if Classic games can be
  // downloaded as .rofl then "what happened at minute 14" has an answer even
  // without a timeline endpoint. It is a far more expensive answer -- a binary
  // container to parse, tens of megabytes per game -- so it is reported apart
  // from the cheap candidates rather than mixed in with them.
  console.log(`\n${c.bold}D. Replays, the expensive alternative${c.reset}`);
  for (const [path, reason] of [
    ["/lol-replays/v1/configuration", "does this build have replays at all"],
    [`/lol-replays/v1/metadata/${gameId}`, "is there a replay for this specific game"],
    [`/lol-replays/v1/rofls/${gameId}/download/graceful`, "would it download"],
  ] as Array<[string, string]>) {
    const res = await probe(client, path, reason);
    results.push(res);
    console.log(line(res));
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const hits = results.filter(
    (r) => r.status === 200 && r.frames?.verdict === "frames" && r.path.includes("match-history"),
  );
  const alive = results.filter((r) => typeof r.status === "number" && r.status !== 200 && r.status !== 404);
  console.log(`\n${c.bold}Verdict${c.reset}`);
  if (hits.length > 0) {
    console.log(`   ${c.green}A timeline exists.${c.reset}`);
    for (const hit of hits) {
      console.log(`      ${hit.path} -> ${hit.bytes} bytes, series: ${hit.frames?.timeSeries.join(", ")}`);
    }
    console.log(`   ${c.dim}Next question, and the one that decides the size of this: run the probe again` +
      ` with a gameId out of matches.jsonl that you never played.${c.reset}`);
  } else if (alive.length > 0) {
    console.log(`   ${c.yellow}No frames, but these routes did not answer 404 -- they exist and refused us:${c.reset}`);
    for (const r of alive) console.log(`      ${r.status} ${r.path}  ${c.dim}${(r.preview ?? "").slice(0, 120)}${c.reset}`);
  } else {
    console.log(`   ${c.red}Nothing. Every candidate 404s and the index names no timeline route.${c.reset}`);
    console.log(`   ${c.dim}Then the live watcher's recording is the only timeline there is, and the` +
      ` crawled games stay end-of-game totals forever.${c.reset}`);
  }

  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = `${REPORT_DIR}/timeline-probe-${gameId}.json`;
  await writeFile(
    reportPath,
    JSON.stringify({ ranAt: Date.now(), gameId, ownGame, platform, phase, timelineRoutes, results }, null, 2),
    "utf8",
  );
  console.log(`\n${c.dim}full report written to ${reportPath}${c.reset}\n`);
}

main().catch((err) => {
  if (err instanceof LcuNotRunningError) {
    console.error(`\n${c.red}${err.message}${c.reset}` +
      `\n${c.dim}This probe can only ask a running client; nothing it reports can be guessed offline.${c.reset}\n`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
