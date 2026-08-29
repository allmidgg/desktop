/**
 * Stuurt gevonden games door naar de gedeelde server.
 *
 * De aanpak is bewust zuinig: eerst vragen we welke game-ID's de server nog
 * niet kent, en pas daarna sturen we die paar games op. Komen tien gebruikers
 * dezelfde game tegen, dan gaat er negen keer alleen een lijstje nummers over
 * de lijn in plaats van negen keer de volledige game.
 *
 * Wat we al opgestuurd hebben onthouden we lokaal, zodat een herstart niet
 * opnieuw over alles begint.
 *
 * De ijzeren regel van dat afvinken: een game gaat pas op de lijst als de
 * server hem aantoonbaar heeft. Óf omdat hij hem al had (dat vertelt /known),
 * óf omdat wij hem hebben opgestuurd en daar een antwoord op kregen. Vinken we
 * eerder af, dan verdwijnt een game bij de eerste de beste 500 stilletjes en
 * voorgoed: lokaal geldt hij als verstuurd, op de server bestaat hij niet.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modeOfStored } from "../modes/detect";
import type { MatchStore, StoredMatch, StoredPlayer } from "./matchStore";

/** Hoeveel games we per verzoek meesturen; de server weigert grotere pakketten. */
const UPLOAD_BATCH = 200;
const ID_BATCH = 1_000;

/**
 * Ratelimiet-instellingen. Een eerste sync van 60.000 games loopt gegarandeerd
 * tegen de limiet van de server aan; dat is geen fout maar een verzoek om
 * geduld, dus wachten we en bieden hetzelfde pakket opnieuw aan. De bovengrens
 * op de wachttijd voorkomt dat een server die "kom over een uur terug" zegt de
 * hele sync laat hangen -- dan stoppen we liever en proberen het later opnieuw.
 */
const RATE_LIMIT_ATTEMPTS = 8;

/**
 * Zonder Retry-After van de server wachten we oplopend: 5, 10, 20, 40, 75, 75...
 * Vast op vijf seconden bleven staan was fout -- zes pogingen kwamen samen op
 * dertig seconden, terwijl het venster van de server er zestig is. De sync gaf
 * dus altijd op vlak voordat de teller zou terugvallen.
 */
const RATE_LIMIT_FALLBACK_MS = 5_000;

/**
 * De bovengrens moet ruim boven een venster van 60 seconden liggen, anders kap
 * je precies de wachttijd af die nodig is. Hij bestaat om een server die "kom
 * over een uur terug" zegt niet de hele sync te laten hangen.
 */
const RATE_LIMIT_MAX_WAIT_MS = 75_000;

/**
 * Hoe vaak we de afvinklijst op zijn vroegst tussentijds wegschrijven. Na elke
 * batch zou netter zijn, maar bij tienduizenden games is die lijst honderden
 * kilobytes; eens per paar seconden houdt de schade van een crash klein zonder
 * de schijf bij elke batch opnieuw vol te schrijven.
 */
const STATE_FLUSH_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface UploadResult {
  checked: number;
  uploaded: number;
  rejected: number;
  serverTotal: number | null;
  error?: string;
}

/** Fout mét statuscode, zodat de aanroeper 429 (wachten) van 500 (stoppen) kan scheiden. */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`server gaf ${status}`);
    this.name = "HttpError";
  }
}

/**
 * Retry-After mag twee vormen hebben: een aantal seconden of een HTTP-datum.
 * Welke de server kiest ligt niet aan ons, dus begrijpen we ze allebei.
 * `null` betekent: geen bruikbare hint, val terug op onze eigen wachttijd.
 */
function parseRetryAfter(header: string | null): number | null {
  const value = header?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

/**
 * Copies out exactly the fields the shared server is meant to receive.
 *
 * Until now sync() handed the stored record straight to the POST, which means
 * anything ever added to StoredMatch would start being shared the moment it was
 * added -- no upload code touched, no number in UploadResult changed, and nobody
 * told. That became a real hazard the day timelines arrived: a per-minute series
 * for all ten seats is exactly the behavioural fingerprint shared/types.ts warns
 * about under Verloop, and hanging one on the stored match -- which is the
 * natural-looking convenience -- would have published nine strangers' games as a
 * side effect of a refactor nobody would have thought to review for it.
 *
 * So the shape is written out by name rather than spread. Adding a field to the
 * upload is now an edit to this function, which is a thing a reviewer can see.
 * Timelines have no line here and are not meant to get one: they live in their
 * own local cache, out of MatchStore entirely, and stay on the machine that
 * fetched them.
 */
function voorVerzending(match: StoredMatch): StoredMatch {
  return {
    gameId: match.gameId,
    surrendered: match.surrendered,
    createdAt: match.createdAt,
    duration: match.duration,
    queueId: match.queueId,
    patch: match.patch,
    players: match.players.map(
      (p): StoredPlayer => ({
        puuid: p.puuid,
        championId: p.championId,
        teamId: p.teamId,
        position: p.position,
        win: p.win,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        cs: p.cs,
        gold: p.gold,
        items: p.items,
        spells: p.spells,
        damage: p.damage,
        damageTaken: p.damageTaken,
        vision: p.vision,
        wards: p.wards,
        level: p.level,
      }),
    ),
  };
}

export class MatchUploader {
  private readonly uploaded = new Set<number>();
  private statePath: string | null = null;
  private lastSaveAt = 0;

  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
    private readonly store: MatchStore,
  ) {}

  /**
   * Hoeveel games er aantoonbaar op de server staan.
   *
   * Alleen om te tonen. Dit is dezelfde afvinklijst die `sync()` bijhoudt, en
   * die groeit uitsluitend als de server bevestigd heeft -- dus dit getal liegt
   * niet over wat er gedeeld is.
   */
  get confirmedCount(): number {
    return this.uploaded.size;
  }

  async loadState(path: string): Promise<void> {
    this.statePath = path;
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as { uploaded?: number[] };
      for (const id of data.uploaded ?? []) this.uploaded.add(id);
    } catch {
      // Onleesbare staat betekent hooguit dat we een keer te veel aanbieden.
    }
  }

  private async saveState(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    // Eerst compleet naast het echte bestand schrijven en dan pas omwisselen.
    // Een crash halverwege kost zo geen half bestand -- dat zou bij de volgende
    // start als onleesbaar gelden en een sync van tienduizenden games opnieuw
    // beginnen.
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, JSON.stringify({ uploaded: [...this.uploaded] }), "utf8");
    await rename(temp, this.statePath);
    this.lastSaveAt = Date.now();
  }

  /** Tussentijds opslaan, maar hooguit eens per STATE_FLUSH_MS. */
  private async maybeSaveState(): Promise<void> {
    if (Date.now() - this.lastSaveAt < STATE_FLUSH_MS) return;
    await this.saveState();
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.serverUrl.replace(/\/$/, "")}${path}`;
    const payload = JSON.stringify(body);

    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { "x-allmid-key": this.apiKey } : {}),
        },
        body: payload,
      });
      if (res.ok) return (await res.json()) as T;

      // Alles behalve 429 is een echte fout: doorgeven en de sync afbreken.
      if (res.status !== 429 || attempt >= RATE_LIMIT_ATTEMPTS) throw new HttpError(res.status);

      const wait = Math.min(
        parseRetryAfter(res.headers.get("retry-after")) ??
          RATE_LIMIT_FALLBACK_MS * Math.pow(2, attempt - 1),
        RATE_LIMIT_MAX_WAIT_MS,
      );
      console.warn(
        `[uploader] rate limited, retrying in ${Math.round(wait / 1_000)}s ` +
          `(attempt ${attempt}/${RATE_LIMIT_ATTEMPTS})`,
      );
      await sleep(wait);
    }
  }

  /**
   * Biedt alles aan wat we nog niet verstuurd hebben.
   * `onProgress` krijgt tussenstanden, zodat een lange sync zichtbaar blijft.
   *
   * Mislukt er iets halverwege, dan is dat geen ramp: alles wat de server tot
   * dat moment bevestigd heeft blijft afgevinkt, de rest staat gewoon weer in
   * de wachtrij bij de volgende ronde.
   */
  /**
   * Offer everything not yet sent -- League Classic only.
   *
   * Two reasons pointing the same way. The hard one: while nothing but Classic
   * leaves this machine, the shared aggregate cannot mix by construction, which
   * is a stronger guarantee than any check on the receiving end.
   *
   * The other is Riot's developer policy, and it is the reason not to "just
   * generalise this" later. This database exists because there is no dataset
   * about Classic anywhere; it is built from the LCU's undocumented match
   * history. For the modern game a dataset already exists and there is a
   * documented way to it -- MATCH-V5, which src/core/riot/api.ts already speaks,
   * throttle and 429 handling included. Building a second scraped corpus for a
   * game that has one is effort spent to acquire a risk.
   *
   * Note also what happens without this filter: server/index.ts rejects a whole
   * game on one modern champion id, and sync() checks rejected games off
   * permanently ("hij heeft ze gezien en beoordeeld"). Every modern game would
   * cross the wire once, be discarded, and be recorded as sent forever.
   */
  async sync(onProgress?: (uploaded: number, total: number) => void): Promise<UploadResult> {
    const pending = this.store
      .all()
      .filter((match) => modeOfStored(match) === "lol:jade" && !this.uploaded.has(match.gameId));
    const result: UploadResult = { checked: pending.length, uploaded: 0, rejected: 0, serverTotal: null };
    if (pending.length === 0) return result;

    try {
      const byId = new Map(pending.map((m) => [m.gameId, m]));
      const toSend: StoredMatch[] = [];

      // Stap 1: vragen wat de server mist.
      for (let i = 0; i < pending.length; i += ID_BATCH) {
        const slice = pending.slice(i, i + ID_BATCH).map((m) => m.gameId);
        const { missing } = await this.post<{ missing: number[] }>("/api/v1/matches/known", {
          gameIds: slice,
        });
        const missingIds = new Set(missing);
        for (const id of missingIds) {
          const match = byId.get(id);
          if (match) toSend.push(match);
        }
        // Alleen wat de server níét miste heeft hij dus al: die zijn hier klaar.
        // De ontbrekende games moeten eerst nog echt over de lijn (stap 2) en
        // worden pas daar afgevinkt.
        for (const id of slice) {
          if (!missingIds.has(id)) this.uploaded.add(id);
        }
        await this.maybeSaveState();
      }

      // Stap 2: alleen de ontbrekende games opsturen.
      let sent = 0;
      for (let i = 0; i < toSend.length; i += UPLOAD_BATCH) {
        const batch = toSend.slice(i, i + UPLOAD_BATCH);
        const response = await this.post<{ accepted: number; rejected: number; total: number }>(
          "/api/v1/matches",
          { matches: batch.map(voorVerzending) },
        );

        // Pas hier staat vast dat deze batch is aangekomen. Ook de games die de
        // server weigerde vinken we af: hij heeft ze gezien en beoordeeld, en
        // welke het waren zegt hij niet -- opnieuw sturen levert alleen elke
        // sync dezelfde ballast op. Hoeveel er geweigerd zijn meldt het
        // resultaat, dus stil is het niet.
        for (const match of batch) this.uploaded.add(match.gameId);

        result.uploaded += response.accepted;
        result.rejected += response.rejected;
        result.serverTotal = response.total;
        sent += batch.length;
        onProgress?.(sent, toSend.length);
        await this.maybeSaveState();
      }

      await this.saveState();
      return result;
    } catch (err) {
      // Een server die even weg is mag het verzamelen niet stoppen. We bewaren
      // wat wél bevestigd is; de rest staat nog in de wachtrij en gaat bij de
      // volgende ronde gewoon opnieuw mee.
      result.error = (err as Error).message;
      await this.saveState();
      return result;
    }
  }
}

export const defaultUploadStatePath = (root: string): string => join(root, "data", "uploaded.json");
