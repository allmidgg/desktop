/**
 * Dunne client voor de publieke Riot API.
 *
 * We gebruiken die alleen waar de lokale client tekortschiet. Het belangrijkste
 * voorbeeld: de matchhistorie van de client laat de runes van een Classic-game
 * leeg (`perk0` t/m `perk5` zijn 0), dus daar kunnen we nooit rune-statistiek
 * op bouwen. Of de publieke API die wel meestuurt, moet blijken.
 *
 * Een ontwikkelaarssleutel mag 20 verzoeken per seconde en 100 per twee minuten.
 * De tweede limiet is de bindende; daar houden we ons aan.
 */
const DEV_KEY_REQUESTS_PER_WINDOW = 95; // marge onder de 100
const WINDOW_MS = 120_000;

/** Van platform (waar een account staat) naar regio (waar match-v5 draait). */
const REGION_BY_PLATFORM: Record<string, string> = {
  EUW1: "europe", EUN1: "europe", TR1: "europe", RU: "europe", ME1: "europe",
  NA1: "americas", BR1: "americas", LA1: "americas", LA2: "americas",
  KR: "asia", JP1: "asia",
  OC1: "sea", PH2: "sea", SG2: "sea", TH2: "sea", TW2: "sea", VN2: "sea",
};

export class RiotApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`Riot API ${status} on ${url}: ${body.slice(0, 160)}`);
    this.name = "RiotApiError";
  }
}

export class RiotApiClient {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly platform = "EUW1",
  ) {}

  get region(): string {
    return REGION_BY_PLATFORM[this.platform.toUpperCase()] ?? "europe";
  }

  /** Wacht tot er weer ruimte is binnen het venster van twee minuten. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    while (this.timestamps.length > 0 && now - (this.timestamps[0] ?? 0) > WINDOW_MS) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= DEV_KEY_REQUESTS_PER_WINDOW) {
      const oldest = this.timestamps[0] ?? now;
      const wait = WINDOW_MS - (now - oldest) + 250;
      await new Promise((resolve) => setTimeout(resolve, wait));
      return this.throttle();
    }
    this.timestamps.push(Date.now());
  }

  private async get<T>(host: string, path: string): Promise<T> {
    await this.throttle();
    const url = `https://${host}.api.riotgames.com${path}`;
    const res = await fetch(url, { headers: { "X-Riot-Token": this.apiKey } });

    // 429 betekent dat onze eigen boekhouding ernaast zat; Riot vertelt hoe lang.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "5");
      await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
      return this.get<T>(host, path);
    }
    if (!res.ok) throw new RiotApiError(res.status, url, await res.text());
    return (await res.json()) as T;
  }

  /** Match-ID's van een speler. `queue` filtert op bijvoorbeeld 4310 (Classic ranked). */
  async matchIds(
    puuid: string,
    options: { count?: number; start?: number; queue?: number } = {},
  ): Promise<string[]> {
    const query = new URLSearchParams({
      count: String(options.count ?? 20),
      start: String(options.start ?? 0),
      ...(options.queue !== undefined ? { queue: String(options.queue) } : {}),
    });
    return this.get<string[]>(this.region, `/lol/match/v5/matches/by-puuid/${puuid}/ids?${query}`);
  }

  /** Het volledige rapport van een game. Type bewust los: we onderzoeken juist de vorm. */
  async match(matchId: string): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(this.region, `/lol/match/v5/matches/${matchId}`);
  }

  /** Zoekt een account op Riot-ID, zodat we de client niet nodig hebben. */
  async accountByRiotId(gameName: string, tagLine: string): Promise<{ puuid: string; gameName: string; tagLine: string }> {
    return this.get(
      this.region,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    );
  }

  /** Match-ID zoals de publieke API die kent, opgebouwd uit een lokaal gameId. */
  matchIdFromGameId(gameId: number): string {
    return `${this.platform.toUpperCase()}_${gameId}`;
  }
}
