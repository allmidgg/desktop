/**
 * Downloads the community aggregate that allmid.gg publishes, and keeps a copy.
 *
 * Why this exists: the app builds its numbers from the matches it has crawled
 * itself, and a fresh install has none. Champion select then reads "not enough
 * games" everywhere, for days, while the same counting has already been done
 * centrally over every game people chose to share. This closes that gap on the
 * first launch instead of the fiftieth.
 *
 * The file is not merged with the local store. Everything the app crawls is
 * uploaded to the same server, so those games are already inside the aggregate;
 * adding them again would count them twice. Local matches stay what they always
 * were: your own history, shown as your own history.
 *
 * Failing to download is not an error worth bothering anyone with. There is a
 * cached copy, and if there is not, the app falls back to whatever it crawled --
 * which is exactly how it behaved before this file existed.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AggregateStats } from "./stats";

/** Where the site publishes it. Same host as the download button. */
export const COMMUNITY_STATS_URL = "https://allmid.gg/data/app-stats.json";

/**
 * How long a cached copy is considered fresh enough to skip the network.
 *
 * The server regenerates at most every 30 minutes and at least every 6 hours, so
 * checking more than a few times a day only costs bandwidth on both ends. On a
 * conditional request the server answers 304 and nothing is transferred anyway;
 * this just avoids waking the network for a machine that opens the app all day.
 */
const VERS_MS = 6 * 60 * 60 * 1000;

/** Guards against a redirect to something enormous. The real file is ~1.4 MB. */
const MAX_BYTES = 32 * 1024 * 1024;

export interface CommunityLoad {
  stats: AggregateStats;
  /** "network" when just downloaded, "cache" when read from disk. */
  bron: "network" | "cache";
  /** When the counting ran, not when it was downloaded. */
  generatedAt: string;
  /** Timestamp of the newest game in the aggregate. */
  newestGame: string;
  games: number;
  players: number;
}

interface CacheMeta {
  etag?: string;
  lastModified?: string;
  checkedAt: number;
}

export class CommunityStatsCache {
  private readonly dir: string;
  private readonly bestand: string;
  private readonly metaBestand: string;

  constructor(
    dataRoot: string,
    private readonly url: string = COMMUNITY_STATS_URL,
  ) {
    this.dir = join(dataRoot, "data", "community");
    this.bestand = join(this.dir, "app-stats.json");
    this.metaBestand = join(this.dir, "app-stats.meta.json");
  }

  /** The copy on disk, or null when there is none or it will not parse. */
  lees(): CommunityLoad | null {
    if (!existsSync(this.bestand)) return null;
    try {
      const stats = JSON.parse(readFileSync(this.bestand, "utf8")) as AggregateStats;
      if (!stats?.champions || !stats?.matchups) return null;
      return {
        stats,
        bron: "cache",
        generatedAt: stats.generatedAt,
        newestGame: stats.newestGame ?? stats.generatedAt,
        games: stats.games,
        players: stats.players,
      };
    } catch {
      // A truncated or half-written file is not worth reporting; it gets
      // replaced on the next successful download.
      return null;
    }
  }

  /**
   * Fetch if worthwhile, otherwise hand back the cached copy.
   *
   * Never throws. The caller has a working app either way, and a stats file that
   * did not arrive should not stop anyone from playing.
   */
  async laad(opties: { forceer?: boolean; timeoutMs?: number } = {}): Promise<CommunityLoad | null> {
    const uitCache = this.lees();
    if (!opties.forceer && uitCache && this.recentGecontroleerd()) return uitCache;

    const meta = this.leesMeta();
    const afbreken = AbortSignal.timeout(opties.timeoutMs ?? 20_000);

    try {
      const kop: Record<string, string> = { accept: "application/json" };
      // Only send validators when there is actually something to validate
      // against, otherwise a 304 would leave us with nothing to show.
      if (uitCache && meta?.etag) kop["if-none-match"] = meta.etag;
      if (uitCache && meta?.lastModified) kop["if-modified-since"] = meta.lastModified;

      const res = await fetch(this.url, { headers: kop, signal: afbreken, redirect: "follow" });

      if (res.status === 304 && uitCache) {
        this.schrijfMeta({ ...meta, checkedAt: Date.now() });
        return uitCache;
      }
      if (!res.ok) return uitCache;

      const lengte = Number(res.headers.get("content-length") ?? 0);
      if (lengte > MAX_BYTES) return uitCache;

      const tekst = await res.text();
      if (tekst.length > MAX_BYTES) return uitCache;

      const stats = JSON.parse(tekst) as AggregateStats;
      // Refuse anything that is not recognisably the aggregate. Better to keep a
      // known-good cached copy than to overwrite it with an error page.
      if (!stats?.champions || !stats?.matchups || !stats?.velden) return uitCache;

      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.bestand, tekst, "utf8");
      this.schrijfMeta({
        etag: res.headers.get("etag") ?? undefined,
        lastModified: res.headers.get("last-modified") ?? undefined,
        checkedAt: Date.now(),
      });

      return {
        stats,
        bron: "network",
        generatedAt: stats.generatedAt,
        newestGame: stats.newestGame ?? stats.generatedAt,
        games: stats.games,
        players: stats.players,
      };
    } catch {
      return uitCache;
    }
  }

  private recentGecontroleerd(): boolean {
    const meta = this.leesMeta();
    if (meta?.checkedAt) return Date.now() - meta.checkedAt < VERS_MS;
    // No meta file but a cached copy: fall back to the file's own mtime, so an
    // upgrade from an older version does not re-download on every launch.
    try {
      return Date.now() - statSync(this.bestand).mtimeMs < VERS_MS;
    } catch {
      return false;
    }
  }

  private leesMeta(): CacheMeta | null {
    try {
      return JSON.parse(readFileSync(this.metaBestand, "utf8")) as CacheMeta;
    } catch {
      return null;
    }
  }

  private schrijfMeta(meta: CacheMeta): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.metaBestand, JSON.stringify(meta), "utf8");
    } catch {
      // Losing the meta file only costs one redundant download.
    }
  }
}
