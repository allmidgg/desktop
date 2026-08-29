/**
 * The modern crawler. Runs on the SERVER, walks MATCH-V5, fills the modern store.
 *
 * ── Why this is not the other crawler ────────────────────────────────────────
 *
 * src/core/services/crawler.ts walks strangers' match histories through the
 * local League client, and for League Classic that is the only route there is.
 * For the modern game there is a documented one -- MATCH-V5 -- and Riot's
 * developer policy forbids scraping data from undocumented endpoints. So the
 * modern half of the database has to come through the official API, and that
 * single sentence inverts the architecture:
 *
 *     Classic   clients crawl,  the server adds up,   POST /api/v1/matches
 *     modern    the SERVER crawls, clients only read, and there is no POST
 *
 * The absence of a POST for modern games is the design, not an omission. An API
 * key shipped inside ten thousand installations is not a key -- anyone can pull
 * it out of the .exe in a minute -- so the key lives here and nowhere else. And
 * if a client could upload modern games, the LCU-derived modern corpus this
 * whole arrangement exists to avoid would simply reappear through the front
 * door.
 *
 * ── Three things that go wrong if you do not know them ───────────────────────
 *
 * 1. The two PUUID namespaces are disjoint. The LCU hands out 36 characters,
 *    MATCH-V5 hands out 78 (measured on EUW1_7924801606: all ten participants,
 *    78 each). The 369,306 players already stored from the Classic crawl are
 *    therefore worthless as a seed here, and no screen may add "players known"
 *    across the two sources -- that counts the same people twice, in the
 *    flattering direction. `usablePuuid()` below is the guard.
 *
 * 2. `info.gameDuration` is seconds, EXCEPT on reports from before patch 11.20,
 *    where it is milliseconds. The marker is the absence of `gameEndTimestamp`.
 *    Get it wrong and every converted old match trips the duration bounds while
 *    every log line still looks healthy. This file does not implement that rule;
 *    src/core/riot/slim.ts does, and it is named here only so nobody adds a
 *    second copy of it while reading this loop.
 *
 * 3. Riot's `gameMode` for the MODERN Summoner's Rift is the string "CLASSIC",
 *    which in this codebase means the opposite. No identifier here contains the
 *    word; `resolveMode()` and `ModeId` do the talking.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RiotApiClient, RiotApiError } from "../src/core/riot/api";
import { asMatchV5, slimMatchV5 } from "../src/core/riot/slim";
import type { MatchStores, StoredMatch } from "../src/core/services/matchStore";

/** The only mode this crawler may write. See `srMatchOnly()` for why it is not "any collected mode". */
const TARGET_MODE = "lol:sr" as const;

/**
 * Ranked Summoner's Rift, solo and flex.
 *
 * The default queue filter, and it is a budget decision rather than a taste one.
 * MATCH-V5 filters by queue on its own side, so asking with a queue means every
 * match id that comes back is one we want and every follow-up request buys a
 * game we keep. Asking without one means paying a full request to discover that
 * a match was ARAM. Under a development key -- 95 requests per two minutes, all
 * of it -- that difference is most of the throughput.
 *
 * Both are `kind: "ranked"` in the mode registry, so both count toward a tally
 * rather than merely being stored. Widen this for a production key; `queues: []`
 * turns the filter off entirely and lets `resolveMode()` sort it out afterwards.
 */
const DEFAULT_QUEUES: readonly number[] = [420, 440];

/** MATCH-V5 caps `count` at 100 and rejects anything above it. */
const MAX_IDS_PER_REQUEST = 100;
const DEFAULT_MATCHES_PER_PLAYER = 20;

/** How many players we get through between saves of the queue. */
const DEFAULT_SAVE_EVERY = 10;

/**
 * Consecutive failures before we assume it is us and not one bad match.
 *
 * Same shape as the LCU crawler's backoff and for the same reason, but a much
 * longer sleep: there the other end is a local process on the same machine, here
 * it is Riot, and hammering a service that is already answering 5xx is how a key
 * gets a closer look than anyone wants.
 */
const BACKOFF_AFTER_ERRORS = 3;
const BACKOFF_MS = 30_000;

/**
 * The shortest a MATCH-V5 puuid can be before we refuse to believe it is one.
 *
 * Sits between the two namespaces on purpose: measured, the LCU's are 36 and
 * MATCH-V5's are 78. A bar in between survives Riot changing the length while
 * still making it impossible for a puuid from the Classic crawl to enter this
 * queue -- which matters because `data/crawler-state.json` is a 3 MB file full
 * of exactly those, sitting one mistyped path away from this crawler's own state
 * file. Feeding it in would not crash anything: every request would simply
 * return an empty list, and the crawl would spend a whole key doing nothing.
 */
const MIN_RIOT_PUUID_LENGTH = 40;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const usablePuuid = (value: unknown): value is string =>
  typeof value === "string" && value.length >= MIN_RIOT_PUUID_LENGTH;

/**
 * The gate that keeps this crawler pointed at exactly one store.
 *
 * The conversion itself lives in src/core/riot/slim.ts and is deliberately not
 * repeated here. That module carries the two rules this file would otherwise
 * have had to restate -- gameDuration is milliseconds when gameEndTimestamp is
 * absent, and the position comes from teamPosition rather than the legacy
 * lane/role pair -- and a second copy of either would be a second thing to keep
 * true. They are exactly the kind of rule that goes wrong silently: a drifted
 * copy still parses, still logs cleanly, and just quietly files a quarter of the
 * games under the wrong lane.
 *
 * What does belong here is the narrowing. `slimMatchV5()` accepts any mode this
 * application collects, which is right for a converter -- it reports what Riot
 * said. This crawler may write one of them. The other collected mode is League
 * Classic, and its store IS the shared pool that clients upload their own games
 * to; that corpus is defined by having come off people's own clients. A report
 * that resolved to lol:jade here would be routed straight into it by
 * MatchStores.add(), and nothing downstream would ever say so.
 *
 * So the converter reports and this decides, which is the same division
 * slimGame() and MatchStores.add() already have on the Classic side.
 */
export function srMatchOnly(raw: unknown): StoredMatch | null {
  const record = slimMatchV5(raw);
  return record?.mode === TARGET_MODE ? record : null;
}

/** `EUW1_7924801606` split into the two halves `MatchStore.has()` wants. */
export function splitMatchId(matchId: string): { platformId: string; gameId: number } | null {
  const cut = matchId.indexOf("_");
  if (cut <= 0) return null;
  const gameId = Number(matchId.slice(cut + 1));
  if (!Number.isSafeInteger(gameId) || gameId <= 0) return null;
  return { platformId: matchId.slice(0, cut).toUpperCase(), gameId };
}

export interface RiotCrawlProgress {
  visitedPlayers: number;
  queuedPlayers: number;
  /** Games in the modern store. Never added to the Classic figure -- see the header. */
  storedMatches: number;
  newThisRun: number;
  requestsThisRun: number;
  /** 429s. Above zero means the configured rate is too high for this key. */
  rateLimitHits: number;
  errors: number;
  gamesPerHour: number;
  /**
   * Requests spent per game actually stored, this run.
   *
   * The only number that turns a rate limit into a schedule, which is why it is
   * reported rather than assumed. It starts near 1 and climbs as the store fills:
   * the per-player id request is fixed overhead, so a player whose last twenty
   * games we already hold costs requests and yields nothing.
   */
  requestsPerStoredGame: number;
}

export interface RiotCrawlerConfig {
  /** Where the queue survives a restart. Something like `<data>/data/riot-crawl-state.json`. */
  readonly statePath: string;
  /** Queues to ask for, or `[]` for no filter at all. Defaults to ranked solo and flex. */
  readonly queues?: readonly number[];
  readonly matchesPerPlayer?: number;
  readonly saveEvery?: number;
  readonly onProgress?: (progress: RiotCrawlProgress) => void;
}

interface CrawlState {
  /** Bumped when the shape changes, so an old file is ignored rather than misread. */
  version: number;
  /** The routing region the queue was gathered for. See `loadState()`. */
  region: string;
  visited: string[];
  queue: string[];
}

const STATE_VERSION = 1;

/**
 * Why the whole run stopped, when it stopped early.
 *
 * A development key expires after 24 hours and then answers 403 to everything.
 * Without this the crawler would march through the queue marking every player
 * visited on a failure that has nothing to do with them, and a key renewed an
 * hour later would find its queue burned. So an authentication failure ends the
 * run rather than counting as one bad player.
 */
export type CrawlStopReason = "done" | "queue-empty" | "stopped" | "auth" | "rate-limit";

export class RiotCrawler {
  private readonly queue: string[] = [];
  /**
   * The queue mirrored as a set.
   *
   * Without it every enqueue would walk the array, and the array grows by up to
   * ten players per match fetched -- so the crawler would get slower exactly in
   * proportion to how well it was working.
   */
  private readonly queued = new Set<string>();
  private readonly visited = new Set<string>();
  private running = false;
  private stopped = false;
  private loadedRegion: string | null = null;

  private newThisRun = 0;
  private requestsThisRun = 0;
  private rateLimitHits = 0;
  private errorsThisRun = 0;
  private consecutiveErrors = 0;
  private startedAt = 0;

  constructor(
    private readonly riot: RiotApiClient,
    /**
     * The router, not a single store.
     *
     * Same rule the LCU crawler follows: `slimMatchV5()` writes the mode down and
     * `MatchStores.add()` files on it, so a record that somehow carried another
     * mode would land in its own file instead of silently in this one. Here it is
     * belt and braces -- `srMatchOnly()` has already refused everything but
     * `lol:sr` -- and that is the point: the guarantee lives in the router rather
     * than in an agreement between two filters that can drift apart.
     */
    private readonly stores: MatchStores,
    private readonly config: RiotCrawlerConfig,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Counted here rather than taken from the client, so the arithmetic below is honest. */
  noteRequest(): void {
    this.requestsThisRun++;
  }

  /** Hand this to `RiotApiOptions.onRateLimited` so a 429 is visible in the progress. */
  readonly noteRateLimited = (): void => {
    this.rateLimitHits++;
  };

  /**
   * Puts a player's own Riot ID into the queue. Costs one request.
   *
   * Seeding goes through a Riot ID and not through a stored puuid, and that is
   * the disjoint-namespace problem showing up as an API decision: the 369,306
   * puuids in the Classic database are LCU puuids, and MATCH-V5 has never heard
   * of a single one of them. A name and a tag are the only identifier both sides
   * of this application can agree on.
   */
  async seedFromRiotId(gameName: string, tagLine: string): Promise<string> {
    this.noteRequest();
    const account = await this.riot.accountByRiotId(gameName, tagLine);
    this.enqueue(account.puuid);
    return account.puuid;
  }

  seed(puuids: readonly string[]): number {
    let added = 0;
    for (const puuid of puuids) if (this.enqueue(puuid)) added++;
    return added;
  }

  private enqueue(puuid: string): boolean {
    if (!usablePuuid(puuid) || this.visited.has(puuid) || this.queued.has(puuid)) return false;
    this.queued.add(puuid);
    this.queue.push(puuid);
    return true;
  }

  /**
   * Restores the queue from disk.
   *
   * The reason this exists at all: a crawl that starts from one player after
   * every restart never gets anywhere. The first few hundred players are the
   * cheap ones -- almost every match they name is new -- and throwing that away
   * means paying for them again out of a budget that is the whole point of the
   * exercise.
   *
   * State from another routing region is refused rather than merged. MATCH-V5 is
   * served per region and a puuid only has matches on the region it plays in, so
   * a queue gathered on `europe` replayed against `asia` costs one request per
   * player to be told nothing. That is not a crash; it is a key spent on empty
   * lists, which is worse, because it looks like work.
   */
  async loadState(): Promise<{ loaded: boolean; dropped: number; reason?: string }> {
    const path = this.config.statePath;
    this.loadedRegion = this.riot.region;
    if (!existsSync(path)) return { loaded: false, dropped: 0 };
    let state: Partial<CrawlState>;
    try {
      state = JSON.parse(await readFile(path, "utf8")) as Partial<CrawlState>;
    } catch {
      // A half-written file is not worth a stack trace: we start over, which
      // costs requests but cannot corrupt anything.
      return { loaded: false, dropped: 0, reason: "state file unreadable" };
    }
    if (state.version !== STATE_VERSION) {
      return { loaded: false, dropped: 0, reason: `state version ${String(state.version)} is not ${STATE_VERSION}` };
    }
    if (state.region && state.region !== this.riot.region) {
      return {
        loaded: false,
        dropped: 0,
        reason: `state was gathered for region ${state.region} but this client is on ${this.riot.region}`,
      };
    }

    // Anything that is not a MATCH-V5 puuid is thrown away and counted. A file of
    // LCU puuids parses perfectly and would crawl forever without storing a game.
    let dropped = 0;
    for (const puuid of state.visited ?? []) {
      if (usablePuuid(puuid)) this.visited.add(puuid);
      else dropped++;
    }
    for (const puuid of state.queue ?? []) {
      if (usablePuuid(puuid)) this.enqueue(puuid);
      else dropped++;
    }
    return { loaded: true, dropped };
  }

  /**
   * Writes the queue out, atomically.
   *
   * Temp file plus rename rather than a plain write, because this is a server:
   * it gets restarted, deployed over and occasionally killed, and a truncated
   * state file read back on the next boot would throw away a queue that took a
   * day of rate-limited requests to build. The rename is the only step that is
   * visible to a reader, and it either happened or it did not.
   *
   * The queue is capped for the same reason the Classic crawler caps it: it grows
   * by up to ten names per match and there is no point carrying a backlog larger
   * than any key could work through.
   */
  async saveState(): Promise<void> {
    const path = this.config.statePath;
    await mkdir(dirname(path), { recursive: true });
    const state: CrawlState = {
      version: STATE_VERSION,
      region: this.loadedRegion ?? this.riot.region,
      visited: [...this.visited],
      queue: this.queue.slice(0, 50_000),
    };
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(state), "utf8");
    await rename(temp, path);
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Works through the queue until it is empty, `maxPlayers` is reached, or
   * something happened that makes carrying on pointless.
   *
   * Safe to call more than once: only one run happens at a time.
   */
  async run(maxPlayers = 25): Promise<{ progress: RiotCrawlProgress; reason: CrawlStopReason }> {
    if (this.running) return { progress: this.progress(), reason: "stopped" };
    this.running = true;
    this.stopped = false;
    this.newThisRun = 0;
    this.requestsThisRun = 0;
    this.rateLimitHits = 0;
    this.errorsThisRun = 0;
    this.startedAt = Date.now();

    /**
     * Only the modern store, and never the Classic one.
     *
     * `MatchStores.load()` takes a list precisely so a caller can skip a mode,
     * and skipping Classic here is not an optimisation. It is 326 MB of JSONL
     * and about 483 MB of heap to answer a question that cannot come back true:
     * Riot mints game ids from one counter per platform, so a modern id and a
     * Classic id from the same shard are never the same number. Loading it would
     * additionally re-open the hole `MatchStores.has()` documents -- a Classic
     * record with no platform recorded matching a modern id from another shard,
     * and the game silently never stored.
     */
    await this.stores.load(TARGET_MODE);

    let reason: CrawlStopReason = "done";
    try {
      let handled = 0;
      while (handled < maxPlayers && !this.stopped) {
        const puuid = this.takeNext();
        if (!puuid) {
          reason = "queue-empty";
          break;
        }
        this.queued.delete(puuid);
        if (this.visited.has(puuid)) continue;

        const found = await this.crawlPlayer(puuid);
        if (found.fatal) {
          // The player goes back: whatever went wrong was not about him.
          this.enqueue(puuid);
          reason = found.fatal;
          break;
        }
        // Marked visited only after the id request came back. A player struck off
        // on a failure is a player we will never look at again, and there is no
        // record anywhere that we skipped him.
        this.visited.add(puuid);
        handled++;

        this.config.onProgress?.(this.progress());
        if (handled % (this.config.saveEvery ?? DEFAULT_SAVE_EVERY) === 0) await this.saveState();
      }
      if (this.stopped) reason = "stopped";
    } finally {
      this.running = false;
      await this.saveState();
    }
    return { progress: this.progress(), reason };
  }

  /**
   * Takes the next player at random rather than from the front.
   *
   * Working in order digs one friend group out completely: those people play
   * with each other, so after the first few players their matches are all games
   * we already hold and every request buys nothing. Jumping around lands in a
   * different part of the network each time. Inherited from the Classic crawler,
   * where it was worth taking, and worth more here -- there a wasted request cost
   * 40 milliseconds against a local client, here it costs 1/95th of two minutes.
   */
  private takeNext(): string | undefined {
    if (this.queue.length === 0) return undefined;
    const index = Math.floor(Math.random() * this.queue.length);
    const last = this.queue.length - 1;
    const puuid = this.queue[index];
    // Swapping the tail in beats shifting the whole array down.
    if (index !== last) this.queue[index] = this.queue[last]!;
    this.queue.pop();
    return puuid;
  }

  /** One player: ask for his match ids, fetch the ones we do not have, file them. */
  private async crawlPlayer(puuid: string): Promise<{ fatal?: CrawlStopReason }> {
    const queues = this.config.queues ?? DEFAULT_QUEUES;
    const count = Math.min(MAX_IDS_PER_REQUEST, Math.max(1, this.config.matchesPerPlayer ?? DEFAULT_MATCHES_PER_PLAYER));

    const ids = new Set<string>();
    // `[]` means no queue filter: one request that returns everything the player
    // played, which a production key can afford and a development key cannot.
    for (const queue of queues.length > 0 ? queues : [undefined]) {
      this.noteRequest();
      try {
        for (const id of await this.riot.matchIds(puuid, { count, ...(queue === undefined ? {} : { queue }) })) {
          ids.add(id);
        }
        this.consecutiveErrors = 0;
      } catch (error) {
        const fatal = await this.noteError(error);
        if (fatal) return { fatal };
        // The id request is the one that decides whether this player was looked at
        // at all, so a failure here abandons him for now instead of half-doing him.
        return {};
      }
    }

    const slimmed: StoredMatch[] = [];
    const store = this.stores.for(TARGET_MODE);
    for (const matchId of ids) {
      if (this.stopped) break;
      const split = splitMatchId(matchId);
      // An id we cannot parse is not a crawl failure and must not count as one:
      // it would push us into backoff over a string.
      if (!split) continue;
      // The whole reason repeated crawling stays cheap. Asked with the platform,
      // because a game id only names one game within one shard and this store is
      // the first in the app that can hold more than one.
      if (store.has(split.gameId, split.platformId)) continue;

      this.noteRequest();
      let raw: unknown;
      try {
        raw = await this.riot.match(matchId);
        this.consecutiveErrors = 0;
      } catch (error) {
        const fatal = await this.noteError(error);
        if (fatal) return { fatal };
        continue;
      }

      // Every participant is a seed, including those of a match we then refuse.
      // They are real players who play other games, and we have already paid a
      // request for their names -- so an ARAM game is not wasted, it is ten
      // people who also play the Rift.
      for (const other of asMatchV5(raw)?.metadata?.participants ?? []) this.enqueue(other);

      const record = srMatchOnly(raw);
      if (record) slimmed.push(record);
    }

    if (slimmed.length > 0) {
      // One call per player, not one per match: `add()` takes the file lock and
      // fsyncs once per call, so a per-match loop would pay both twenty times over
      // for every player instead of once.
      const written = await this.stores.add(slimmed);
      this.newThisRun += written.sr;
    }
    return {};
  }

  /**
   * Records a failed request and says whether the whole run should stop.
   *
   * 403 and 401 end it. A development key lives 24 hours and then refuses
   * everything, and grinding on through the queue in that state would mark
   * hundreds of players as visited for a reason that has nothing to do with them
   * -- so a key renewed an hour later would restart on a queue that had already
   * thrown its best players away.
   *
   * A 429 that reaches here has already been retried inside the client, so seeing
   * one means something is badly out of step; stopping is safer than pressing on.
   * Everything else is one bad match: counted, backed off after three in a row,
   * and carried on from.
   */
  private async noteError(error: unknown): Promise<CrawlStopReason | undefined> {
    this.errorsThisRun++;
    this.consecutiveErrors++;
    if (error instanceof RiotApiError) {
      if (error.status === 401 || error.status === 403) return "auth";
      if (error.status === 429) {
        this.rateLimitHits++;
        return "rate-limit";
      }
    }
    // The sleep is awaited, and that is the whole mechanism: a caller that fired
    // it and carried on would keep making requests through the pause it just
    // decided to take, which is not a backoff but a log line about one.
    if (this.consecutiveErrors >= BACKOFF_AFTER_ERRORS) await sleep(BACKOFF_MS);
    return undefined;
  }

  private progress(): RiotCrawlProgress {
    const hours = (Date.now() - this.startedAt) / 3_600_000;
    return {
      visitedPlayers: this.visited.size,
      queuedPlayers: this.queue.length,
      storedMatches: this.stores.for(TARGET_MODE).size,
      newThisRun: this.newThisRun,
      requestsThisRun: this.requestsThisRun,
      rateLimitHits: this.rateLimitHits,
      errors: this.errorsThisRun,
      gamesPerHour: hours > 0 ? this.newThisRun / hours : 0,
      requestsPerStoredGame: this.newThisRun > 0 ? this.requestsThisRun / this.newThisRun : 0,
    };
  }
}

/**
 * The rate limit, read from the environment instead of compiled in.
 *
 * Two keys, two completely different machines. A development key is 100 requests
 * per two minutes and expires daily; a production key is granted per application
 * after review and its ceiling is negotiated, so there is no figure to hard-code
 * even if we wanted one. These variables are how the same build serves both:
 *
 *     ALLMID_RIOT_RPW=95      requests per window   (default: 95, a dev key)
 *     ALLMID_RIOT_WINDOW=120  window in seconds     (default: 120)
 *
 * Deliberately below whatever the key actually allows. Our window is a sliding
 * count kept in this process, Riot's is measured on their side with their clock,
 * and the two will not agree to the request -- so the margin is what stops a
 * disagreement from becoming a 429.
 */
export function riotRateFromEnv(): { requestsPerWindow: number; windowMs: number } {
  const rpw = Number(process.env.ALLMID_RIOT_RPW);
  const window = Number(process.env.ALLMID_RIOT_WINDOW);
  return {
    requestsPerWindow: Number.isFinite(rpw) && rpw > 0 ? Math.floor(rpw) : 95,
    windowMs: Number.isFinite(window) && window > 0 ? Math.floor(window * 1000) : 120_000,
  };
}

/**
 * Builds a crawler on a client somebody else already made.
 *
 * It takes the client rather than the key, and that signature is the whole
 * point. A RiotApiClient paces itself against a window it counts inside its own
 * instance, so two clients on one key each believe they own the full allowance
 * and together ask for twice it: 190 requests per two minutes against a limit of
 * 100, which is not a slow crawl but a 429 and then a suspended key. The account
 * lookups behind POST /api/v1/sr/seed and this crawl are the two callers on this
 * server, and they must be the same object for the seed budget in srSeed.ts to
 * be a share of the crawl's window instead of an addition to it.
 *
 * Taking the key here would have made that impossible to get right, because the
 * hazard is invisible at both call sites: each one is correct on its own. So the
 * key is read once, in server/index.ts, and turned into exactly one client --
 * and this function cannot make a second one even by accident.
 *
 * That key is held in that process only. It is never written to settings, never
 * sent to a renderer and never handed to a client; see the note on
 * `StoredSettings.riotApiKey`, which keeps it out of `Settings` for the same
 * reason.
 */
export function createRiotCrawler(
  riot: RiotApiClient,
  stores: MatchStores,
  config: RiotCrawlerConfig,
): RiotCrawler {
  return new RiotCrawler(riot, stores, config);
}
