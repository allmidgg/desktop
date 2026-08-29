/**
 * The entry points for the modern crawl: puuids waiting to be walked.
 *
 * For League Classic the app crawls and the server counts. For the modern game
 * that is inverted, and this file is one half of the hinge. The key that reaches
 * MATCH-V5 lives on the server and nowhere else, so the server does the walking;
 * a client's only move is to say "start from me". That request lands in
 * srSeed.ts, and what it leaves behind lands here.
 *
 * Two properties matter more than anything else this class does.
 *
 * It survives a restart. A seed costs a request against a budget of 95 per two
 * minutes shared with the crawl itself, so losing the queue on every restart
 * would mean paying for the same entry points again -- and the person who seeded
 * has no way to know they need to ask twice.
 *
 * It refuses a puuid from the wrong namespace. The League client hands out a
 * 36-character UUID, MATCH-V5 hands out a 78-character string, and they are not
 * the same identifier for the same person: the 369,306 puuids already stored
 * from the client are worthless to MATCH-V5 and would each cost a request to
 * find that out. Today nothing can put one here -- srSeed.ts only ever stores
 * what ACCOUNT-V1 just answered -- and this guard is why that stays true when
 * somebody later adds a convenience route that takes a puuid directly.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SeedEntry {
  /** As MATCH-V5 spells it. Never a client puuid; see `isClientPuuid` below. */
  readonly puuid: string;
  /**
   * The platform this account plays on, uppercase, e.g. "EUW1".
   *
   * Carried per entry rather than assumed, because match ids are only reachable
   * from the routing region their platform belongs to. Ask europe for an NA
   * player's ids and Riot answers nothing at all -- which looks exactly like a
   * player with no games, and would quietly turn every seed from the wrong
   * continent into a dead end nobody could explain.
   */
  readonly platform: string;
  readonly addedAt: number;
}

export type SeedOutcome = "added" | "duplicate" | "full";

/**
 * The shape of a puuid as the League client issues it: a plain UUID.
 *
 * Matched on shape rather than on length, because "not 36 characters" would also
 * accept a truncated or padded one. This is the one identifier we can name with
 * certainty as belonging to the other namespace.
 */
const isClientPuuid = (puuid: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(puuid);

/**
 * How many entry points we hold at once.
 *
 * A seed is a place to start, not the crawl frontier: the crawler grows its own
 * queue from the nine other players in every match it fetches, so entry points
 * past the first few thousand buy nothing but a longer file. When this is full
 * the endpoint says so and asks the caller to come back, which is the honest
 * answer -- silently dropping a seed would let someone believe their account is
 * queued when it is not.
 */
const DEFAULT_MAX_PENDING = 10_000;

export class SrSeedQueue {
  private pending: SeedEntry[] = [];
  private readonly known = new Set<string>();
  private loaded = false;

  constructor(
    private readonly path: string,
    private readonly maxPending = DEFAULT_MAX_PENDING,
  ) {}

  get size(): number {
    return this.pending.length;
  }

  get isFull(): boolean {
    return this.pending.length >= this.maxPending;
  }

  has(puuid: string): boolean {
    return this.known.has(puuid);
  }

  async load(): Promise<void> {
    this.loaded = true;
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as { pending?: unknown };
      const rows = Array.isArray(data.pending) ? data.pending : [];
      for (const row of rows) {
        const entry = row as Partial<SeedEntry>;
        if (typeof entry.puuid !== "string" || typeof entry.platform !== "string") continue;
        // Re-checked on the way in as well as on the way out. A file is easier to
        // edit by hand than an endpoint is to call, and this is the boundary the
        // namespace rule has to hold at.
        if (isClientPuuid(entry.puuid)) continue;
        if (this.known.has(entry.puuid)) continue;
        this.known.add(entry.puuid);
        this.pending.push({
          puuid: entry.puuid,
          platform: entry.platform.toUpperCase(),
          addedAt: typeof entry.addedAt === "number" ? entry.addedAt : Date.now(),
        });
      }
    } catch {
      // A broken queue file costs a handful of seeds, not the crawl: the crawler
      // keeps its own visited set, and anyone who seeded can seed again. Starting
      // empty is better than refusing to start.
    }
  }

  /**
   * Puts an account in line, and says which of the three things happened.
   *
   * Deliberately not a boolean. "Already queued" and "no room" both mean the
   * caller's puuid is not newly queued, but one is a success the client should
   * stop retrying and the other is a request to come back later, and the
   * endpoint answers with different status codes for exactly that reason.
   */
  async add(puuid: string, platform: string): Promise<SeedOutcome> {
    if (isClientPuuid(puuid)) {
      // Loud, because there is no legitimate path here. Reaching this means some
      // caller is feeding the modern crawl from the client's namespace, and every
      // request spent on those ids is a request the crawl did not get.
      throw new Error("a client puuid cannot seed the modern crawl; the namespaces are disjoint");
    }
    if (this.known.has(puuid)) return "duplicate";
    if (this.isFull) return "full";
    this.known.add(puuid);
    this.pending.push({ puuid, platform: platform.toUpperCase(), addedAt: Date.now() });
    await this.save();
    return "added";
  }

  /**
   * Hands the crawler its next entry points and forgets them.
   *
   * Forgetting is on purpose: a puuid that has been crawled may be seeded again
   * later, and it should be, because by then that player has played games we do
   * not have. What must not be refetched is a *match*, and the match store
   * already answers that question by id -- so re-walking a player is cheap and
   * re-walking is the point.
   */
  async take(count: number): Promise<SeedEntry[]> {
    if (count <= 0 || this.pending.length === 0) return [];
    const taken = this.pending.splice(0, count);
    for (const entry of taken) this.known.delete(entry.puuid);
    await this.save();
    return taken;
  }

  /** What /health reports. No puuids: a health page is not a place for accounts. */
  status(): { waiting: number; oldest: number | null; loaded: boolean } {
    return {
      waiting: this.pending.length,
      oldest: this.pending[0]?.addedAt ?? null,
      loaded: this.loaded,
    };
  }

  /**
   * Written whole through a temporary file, because the queue is small and a
   * half-written file here means seeds that were paid for and lost. rename() is
   * atomic on both platforms this ever runs on.
   */
  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify({ pending: this.pending }), "utf8");
    await rename(temp, this.path);
  }
}
