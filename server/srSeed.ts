/**
 * POST /api/v1/sr/seed -- "start from me".
 *
 * ── Why this endpoint exists at all ─────────────────────────────────────────
 *
 * For League Classic there is no documented way in, so the app walks the
 * client's own match history and every installation contributes what it finds.
 * For the modern game there is a documented way in, MATCH-V5, and Riot's
 * developer policy is clear that the documented route is the one to take. Taking
 * it moves the whole operation to the server, because a key handed to ten
 * thousand installations is not a key: it is a public string with somebody's
 * developer account behind it.
 *
 * So the server crawls and the client only reads -- with one thing left for the
 * client to say, which is where its own history starts. It cannot say it with a
 * puuid: the client's puuids and MATCH-V5's puuids are different identifiers for
 * the same people (36 characters against 78), and the 369,306 we already have
 * are useless here. It says it with the Riot ID the player can read off their own
 * profile, and the server spends one ACCOUNT-V1 request turning that into a
 * puuid MATCH-V5 will accept.
 *
 * ── What that one request has to be protected from ──────────────────────────
 *
 * The request comes out of a budget of 95 per two minutes that the crawl needs
 * all of, and it is a lookup service anyone can call. Left open, a single script
 * turns this endpoint into "resolve any Riot ID to a puuid, using someone else's
 * key", and eats the crawl at the same time. Four things stop that, and each one
 * stops a different half of it:
 *
 *   - the shape check, which costs nothing and answers most junk without asking
 *     Riot anything;
 *   - a per-address allowance, because one installation seeds itself once;
 *   - a global ceiling on lookups, so seeding can never crowd out crawling no
 *     matter how many addresses ask;
 *   - the reply, which says whether the account was queued and nothing else. No
 *     puuid, no game name, no region, nothing an account lookup would have
 *     returned. Answering "queued" is what the client needs; answering with the
 *     account is what would make this worth abusing.
 *
 * The remaining oracle is that an existing Riot ID gets a different status code
 * than one that does not exist. That is unavoidable -- the seeder has to be told
 * their name was wrong -- and at a handful of tries per hour per address it is a
 * worse way to check whether a name exists than Riot's own public client.
 */
import { RiotApiError } from "../src/core/riot/api";
import type { SrSeedQueue } from "./srSeedQueue";

/**
 * Length ceilings for the two halves of a Riot ID.
 *
 * These are not Riot's rules and do not pretend to be: we do not know Riot's
 * exact limits and encoding a guess would turn a valid Riot ID into a 400 that
 * blames the player. They exist to keep a request small and to answer obvious
 * junk without spending a lookup on it. Riot decides what a Riot ID is, and says
 * so with a 404 for everything these bounds let through.
 *
 * Counted in code points rather than in UTF-16 units, because names contain
 * characters outside the basic plane and `"..".length` counts those twice.
 */
const MAX_NAME_CHARS = 64;
const MAX_TAG_CHARS = 16;

/**
 * How many seeds one address may send per hour.
 *
 * An installation seeds itself once. The rest of this allowance is for the ways
 * that honestly happens more than once: a retry after a failure, a household or
 * a campus behind one address, someone who reinstalls. Past that it is not
 * seeding.
 *
 * Charged before the Riot request and also for the answers we serve from memory,
 * so that repeating a name that is already queued is not a free way to probe.
 */
const SEEDS_PER_ADDRESS = 5;
const ADDRESS_WINDOW_MS = 60 * 60 * 1000;

/**
 * The share of the key's budget seeding may take, over the same two-minute
 * window the client in src/core/riot/api.ts paces itself against.
 *
 * Ten of the 95 requests in that window, so the crawl keeps 85. The crawl is
 * continuous work and seeding is a one-off per installation, which is why the
 * split is this lopsided -- and ten per two minutes still admits 7,200 new
 * installations a day, far past anything this project will see. If that ever
 * stops being true the answer is a production key, not a bigger slice of a
 * development one.
 */
const LOOKUPS_PER_WINDOW = 10;
const LOOKUP_WINDOW_MS = 120_000;

/**
 * How long a client waits for the account lookup before we let it go.
 *
 * This is not about a slow network. The Riot client throttles itself against the
 * two-minute window and the crawler is using that same window, so a lookup can
 * legitimately sit in `throttle()` for the better part of two minutes waiting for
 * room, and its own 429 handling waits and retries on top of that. None of that
 * may hold a browser request open. Letting go here does not cancel the lookup --
 * if it lands, it lands and the puuid is queued -- it only stops us from holding
 * the socket while it does.
 */
const LOOKUP_TIMEOUT_MS = 10_000;

export interface SeedReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** Set on the answers that ask the caller to come back. */
  readonly retryAfter?: number;
}

export interface SeedDeps {
  readonly queue: SrSeedQueue;
  /**
   * One ACCOUNT-V1 lookup. Injected rather than reached for, so this file can be
   * exercised against a fake as well as against the live API -- and so the only
   * thing here that can reach Riot is this one call.
   */
  readonly lookup: (
    gameName: string,
    tagLine: string,
    platform: string,
  ) => Promise<{ puuid: string }>;
  /**
   * The platforms this server crawls, uppercase. A seed for any other platform
   * is refused rather than quietly filed: the api client falls back to the
   * European routing region for a platform it does not know, and a seed filed
   * under the wrong region is a puuid whose matches can never be found.
   */
  readonly platforms: readonly string[];
  /** Whether the server holds a Riot key at all. Never the key itself. */
  readonly enabled: boolean;
  readonly now?: () => number;
  /** Server-side only. Never receives anything a client sent. */
  readonly warn?: (message: string) => void;
}

interface Allowance {
  count: number;
  resetAt: number;
}

export class SrSeedEndpoint {
  private readonly perAddress = new Map<string, Allowance>();
  private readonly lookupTimestamps: number[] = [];
  /**
   * Riot IDs resolved since this process started, so seeding the same account
   * twice costs one request rather than two.
   *
   * Memory only, and that is a decision rather than laziness. Writing it down
   * would put a file of players' names on the server for the sake of saving a
   * request after a restart, and the server has no other reason to know anyone's
   * name -- it stores puuids. Bounded, because it is fed by strangers.
   */
  private readonly resolved = new Map<string, string>();

  constructor(private readonly deps: SeedDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async handle(address: string, body: unknown): Promise<SeedReply> {
    if (!this.deps.enabled) {
      // Said without naming what is missing. "No API key configured" tells a
      // stranger about the server's credentials; "not collecting" tells them what
      // they need to know, which is not to keep asking.
      return { status: 503, body: { error: "deze server verzamelt geen moderne games" } };
    }

    const riotId = readRiotId(body);
    if ("error" in riotId) return { status: 400, body: { error: riotId.error } };

    const platform = (riotId.platform ?? this.deps.platforms[0] ?? "").toUpperCase();
    if (!this.deps.platforms.includes(platform)) {
      return {
        status: 400,
        body: { error: "dit platform wordt hier niet verzameld", platforms: this.deps.platforms },
      };
    }

    const wait = this.chargeAddress(address);
    if (wait > 0) return { status: 429, body: { error: "te veel seeds" }, retryAfter: wait };

    const cacheKey = `${platform}|${riotId.gameName.toLowerCase()}#${riotId.tagLine.toLowerCase()}`;
    const remembered = this.resolved.get(cacheKey);
    if (remembered) return this.enqueue(remembered, platform);

    const room = this.chargeLookup();
    if (room > 0) {
      // A 503 and not a 429: the caller did nothing wrong and their own allowance
      // is untouched. The key is busy, and the honest thing is to say come back.
      return { status: 503, body: { error: "even geen ruimte om op te zoeken" }, retryAfter: room };
    }

    let puuid: string;
    try {
      puuid = await this.resolve(riotId.gameName, riotId.tagLine, platform);
    } catch (err) {
      return this.explain(err);
    }
    this.remember(cacheKey, puuid);
    return this.enqueue(puuid, platform);
  }

  private async resolve(gameName: string, tagLine: string, platform: string): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const account = await Promise.race([
        this.deps.lookup(gameName, tagLine, platform),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new LookupTimeout()), LOOKUP_TIMEOUT_MS);
        }),
      ]);
      const puuid = account?.puuid;
      if (typeof puuid !== "string" || puuid.length === 0) {
        throw new Error("ACCOUNT-V1 answered without a puuid");
      }
      return puuid;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async enqueue(puuid: string, platform: string): Promise<SeedReply> {
    const outcome = await this.deps.queue.add(puuid, platform);
    if (outcome === "full") {
      return { status: 503, body: { error: "wachtrij vol" }, retryAfter: 3600 };
    }
    // `queued` distinguishes "you are new here" from "you were already in line",
    // and both are a success: the account will be walked either way, and a client
    // that got `false` knows not to ask again.
    return { status: 200, body: { ok: true, queued: outcome === "added", waiting: this.deps.queue.size } };
  }

  /**
   * Turns whatever went wrong into something safe to hand a stranger.
   *
   * Nothing from the error object reaches the reply. RiotApiError carries the url
   * it called and the first 160 characters of Riot's response body, neither of
   * which is a client's business -- and the general rule is worth more than the
   * particular case: an error on the way to Riot is the one place where our
   * credentials and their infrastructure are closest to a response we are about
   * to write.
   */
  private explain(err: unknown): SeedReply {
    if (err instanceof LookupTimeout) {
      return { status: 503, body: { error: "opzoeken duurde te lang" }, retryAfter: 60 };
    }
    if (err instanceof RiotApiError) {
      if (err.status === 404) return { status: 404, body: { error: "Riot-ID niet gevonden" } };
      if (err.status === 400) return { status: 400, body: { error: "ongeldig Riot-ID" } };
      if (err.status === 401 || err.status === 403) {
        // The one failure the operator has to see immediately: a development key
        // dies after 24 hours and this is what that looks like from here. The
        // status is reported, never the key and never the url that carried it.
        this.deps.warn?.(`Riot weigert de sleutel (${err.status}); moderne seeds staan stil`);
        return { status: 503, body: { error: "deze server verzamelt geen moderne games" } };
      }
      this.deps.warn?.(`Riot antwoordde ${err.status} op een account-lookup`);
      return { status: 502, body: { error: "Riot antwoordde niet zoals verwacht" }, retryAfter: 60 };
    }
    this.deps.warn?.("account-lookup mislukt zonder antwoord van Riot");
    return { status: 502, body: { error: "kon Riot niet bereiken" }, retryAfter: 60 };
  }

  /** Seconds to wait, or 0 when this address may seed. */
  private chargeAddress(address: string): number {
    const now = this.now;
    const seen = this.perAddress.get(address);
    if (!seen || now > seen.resetAt) {
      this.perAddress.set(address, { count: 1, resetAt: now + ADDRESS_WINDOW_MS });
      return 0;
    }
    seen.count++;
    if (seen.count <= SEEDS_PER_ADDRESS) return 0;
    return Math.max(1, Math.ceil((seen.resetAt - now) / 1000));
  }

  /** Seconds until the next lookup fits in the window, or 0 when there is room. */
  private chargeLookup(): number {
    const now = this.now;
    while (this.lookupTimestamps.length > 0 && now - (this.lookupTimestamps[0] ?? 0) > LOOKUP_WINDOW_MS) {
      this.lookupTimestamps.shift();
    }
    if (this.lookupTimestamps.length >= LOOKUPS_PER_WINDOW) {
      const oldest = this.lookupTimestamps[0] ?? now;
      return Math.max(1, Math.ceil((LOOKUP_WINDOW_MS - (now - oldest)) / 1000));
    }
    this.lookupTimestamps.push(now);
    return 0;
  }

  private remember(key: string, puuid: string): void {
    // Bounded by dropping the oldest, which a Map iterates first. The cache saves
    // a request; it is not allowed to become a way for strangers to fill memory.
    if (this.resolved.size >= 5_000) {
      const oldest = this.resolved.keys().next().value;
      if (oldest !== undefined) this.resolved.delete(oldest);
    }
    this.resolved.set(key, puuid);
  }
}

/**
 * The characters a Riot ID may not contain, by number where they are invisible.
 *
 * 0x00 to 0x1f and 0x7f are the control characters: they have no business in a
 * name and they are what a log-injection attempt is made of. The four visible
 * ones are the separators -- "#" splits a Riot ID in two, and the slashes and
 * the question mark are the parts of a url that decide which endpoint gets
 * called. encodeURIComponent() in the api client already neutralises those, and
 * a value carrying them is still not a Riot ID.
 */
const SEPARATORS = new Set(["#", "/", "?", "\\"]);
const hasForbidden = (text: string): boolean =>
  [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || SEPARATORS.has(ch);
  });

class LookupTimeout extends Error {
  constructor() {
    super("account lookup timed out");
    this.name = "LookupTimeout";
  }
}

/**
 * Reads a Riot ID out of a body a stranger sent, or says what was wrong with it.
 *
 * `name#TAG` in one field is accepted as well as the two separate fields,
 * because that is how a player reads their own id off their profile and a client
 * that passes it through unsplit is the likeliest client there will be.
 */
function readRiotId(
  body: unknown,
): { gameName: string; tagLine: string; platform?: string } | { error: string } {
  if (!body || typeof body !== "object") return { error: "verwacht een JSON-object" };
  const raw = body as Record<string, unknown>;

  let gameName = typeof raw.gameName === "string" ? raw.gameName.trim() : "";
  let tagLine = typeof raw.tagLine === "string" ? raw.tagLine.trim() : "";

  if (!gameName && typeof raw.riotId === "string" && raw.riotId.includes("#")) {
    const hash = raw.riotId.lastIndexOf("#");
    gameName = raw.riotId.slice(0, hash).trim();
    tagLine = raw.riotId.slice(hash + 1).trim();
  }

  if (!gameName || !tagLine) return { error: "gameName en tagLine zijn verplicht" };
  if ([...gameName].length > MAX_NAME_CHARS || [...tagLine].length > MAX_TAG_CHARS) {
    return { error: "Riot-ID is te lang" };
  }
  // Control characters, and the four that mean something in a Riot ID or in the
  // url it is about to become. Spaces stay allowed on purpose: game names do
  // contain them, and a filter stricter than Riot turns a real player into an
  // error that blames them. Everything else is Riot's judgement to make,
  // including alphabets we have never seen.
  //
  // Written by code point rather than as a character class, so that the control
  // characters this refuses are named by number instead of sitting invisibly in
  // the source of the check that refuses them.
  if (hasForbidden(gameName) || hasForbidden(tagLine)) {
    return { error: "Riot-ID bevat tekens die er niet in horen" };
  }

  const platform = typeof raw.platform === "string" ? raw.platform.trim() : undefined;
  if (platform !== undefined && !/^[A-Za-z]{2,4}[0-9]?$/.test(platform)) {
    return { error: "platform ziet er niet uit als een platform" };
  }
  return { gameName, tagLine, platform };
}
