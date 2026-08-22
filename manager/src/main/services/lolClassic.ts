/**
 * League of Legends Classic -- de verzamelservice.
 *
 * Clients sturen de Classic-games door die ze tegenkomen; hier worden ze
 * ontdubbeld en opgeteld. Dat ontdubbelen is de kern: komen tien mensen dezelfde
 * game tegen, dan slaan we hem één keer op. Overlap tussen gebruikers kost dus
 * niets, en daarom schaalt dit goed naarmate er meer mensen meedraaien.
 *
 * Dit is de oude server/index.ts, uit elkaar getrokken langs de scheidslijn van
 * het contract: alles wat met de buitenwereld te maken heeft (luisteren, uitpakken,
 * rate limiting) is nu van de host, en wat overblijft is wat deze game eigen is --
 * validatie, opslag en statistiek. Er wordt hier dus nergens een poort geopend.
 *
 * Opslag en statistiek komen ongewijzigd uit de client (MatchStore, JadeStats), zodat
 * er maar één formaat en één rekenwijze bestaat om te begrijpen: wat de server
 * uitrekent is precies wat de client lokaal uitrekent.
 */
import { timingSafeEqual } from "node:crypto";
import {
  MatchStore,
  defaultStorePath,
  type Position,
  type StoredMatch,
  type StoredPlayer,
} from "../../../../src/core/services/matchStore";
import { JadeStats } from "../../../../src/core/services/stats";
import { JADE_QUEUE_IDS, isJadeChampionId } from "../../../../src/core/jade/ids";
import { isWriting, pendingWrites, whenWritesFinish, withWriteLock } from "../data/writeQueue";
import type { DatabaseChange, DatabaseListener } from "../data/browser";
import type {
  GameService,
  ServiceContext,
  ServiceRequest,
  ServiceResponse,
  ServiceRoute,
  ServiceSummary,
} from "./types";

/**
 * Grenzen per verzoek. De host bewaakt hoeveel bytes er binnenkomen; wij bewaken
 * hoeveel wérk één verzoek mag veroorzaken -- een lichaam van een paar honderd kB
 * kan zonder deze grenzen alsnog tienduizenden validaties aanzetten.
 */
const MAX_MATCHES_PER_REQUEST = 500;
const MAX_IDS_PER_REQUEST = 2_000;

/**
 * Vanaf hoeveel games een champion in de tierlijst mag staan. Onder dit aantal is
 * een winrate ruis: 3 van de 4 gewonnen is geen 75%.
 */
const STATS_MIN_GAMES = 25;

/** De posities waarvoor we een tierlijst publiceren; UNKNOWN hoort er niet bij. */
const TIER_LIST_POSITIONS: readonly Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];
const KNOWN_POSITIONS: readonly string[] = [...TIER_LIST_POSITIONS, "UNKNOWN"];

/** Riot-puuids zijn base64url; iets anders is verzonnen. */
const PUUID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** slimGame() knipt de gameVersion af op "major.minor" -- meer mag er niet in staan. */
const PATCH_PATTERN = /^\d{1,3}\.\d{1,3}$/;

/** Ruim vóór Classic bestond; alles daarvóór is een kapotte of gesleutelde klok. */
const EARLIEST_PLAUSIBLE_MATCH = 1_420_070_400_000;
const ONE_DAY_MS = 86_400_000;

/**
 * Bovengrenzen per speler. Ze zijn er niet om vals spel te vangen maar om te
 * voorkomen dat één verzonnen regel de gemiddelden van een hele champion sloopt:
 * een enkele game met 100.000 kills verpest avgKills voor altijd.
 */
const MAX_KDA = 200;
const MAX_CS = 3_000;
const MAX_GOLD = 300_000;
const MAX_ITEM_ID = 1_000_000;
const MAX_SPELL_ID = 10_000;

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const json = (status: number, body: unknown): ServiceResponse => ({ status, body });

/**
 * Controleert een speler uit een binnengekomen game.
 *
 * De positie wordt hier bewust wél gecontroleerd, in tegenstelling tot de oude
 * server: JadeStats gebruikt hem als sleutel in zijn tabellen, dus een verzonnen
 * positie levert een tierlijst op die niemand ooit opvraagt en die alle
 * pick rates scheeftrekt.
 */
function isValidPlayer(value: unknown): value is StoredPlayer {
  const p = asRecord(value);
  if (!p) return false;
  if (typeof p.puuid !== "string" || !PUUID_PATTERN.test(p.puuid)) return false;
  if (!isInt(p.championId, 0, 100_000) || !isJadeChampionId(p.championId)) return false;
  if (p.teamId !== 100 && p.teamId !== 200) return false;
  if (typeof p.position !== "string" || !KNOWN_POSITIONS.includes(p.position)) return false;
  if (typeof p.win !== "boolean") return false;
  if (!isInt(p.kills, 0, MAX_KDA) || !isInt(p.deaths, 0, MAX_KDA) || !isInt(p.assists, 0, MAX_KDA)) return false;
  if (!isInt(p.cs, 0, MAX_CS) || !isInt(p.gold, 0, MAX_GOLD)) return false;

  // Zeven itemslots, waarvan de laatste het trinket is; 0 betekent leeg. We
  // controleren de vorm en niet de id-ruimte: een onbekend item is geen reden om
  // een verder prima game weg te gooien.
  if (!Array.isArray(p.items) || p.items.length !== 7) return false;
  if (!p.items.every((id) => isInt(id, 0, MAX_ITEM_ID))) return false;

  return Array.isArray(p.spells) && p.spells.length === 2 && p.spells.every((id) => isInt(id, 0, MAX_SPELL_ID));
}

/**
 * Controleert een binnengekomen game voordat we hem opslaan.
 *
 * Alles wat hier binnenkomt is door een vreemde opgestuurd, dus we geloven er
 * niets van tot het klopt. Wat er eenmaal in staat, staat er in de praktijk voor
 * altijd -- de opslag is append-only, alleen een mens die de Data-weergave
 * openslaat haalt er nog iets uit, en iedere client rekent er statistiek mee --
 * dus liever een echte game te veel geweigerd dan één verzonnen game toegelaten.
 */
function isValidMatch(value: unknown): value is StoredMatch {
  const m = asRecord(value);
  if (!m) return false;
  if (!isInt(m.gameId, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (!isInt(m.createdAt, EARLIEST_PLAUSIBLE_MATCH, Date.now() + ONE_DAY_MS)) return false;
  // Remakes en vroege surrenders vertekenen elke statistiek; boven de drie uur
  // klopt er iets niet met de klok van de client.
  if (!isInt(m.duration, 300, 10_800)) return false;
  // Deze database gaat alleen over Classic. Komt er ooit een queue bij, dan is
  // JADE_QUEUES in core/jade/ids.ts de enige plek die mee moet.
  if (typeof m.queueId !== "number" || !JADE_QUEUE_IDS.includes(m.queueId)) return false;
  if (typeof m.patch !== "string" || !PATCH_PATTERN.test(m.patch)) return false;
  if (!Array.isArray(m.players) || m.players.length !== 10 || !m.players.every(isValidPlayer)) return false;

  // Tien geldige spelers zijn nog geen geldige game: vijf per team, en tien
  // verschillende mensen. Zonder deze twee controles is één speler die tien keer
  // gekopieerd wordt een perfect geldige "game".
  const players = m.players as StoredPlayer[];
  if (players.filter((p) => p.teamId === 100).length !== 5) return false;
  return new Set(players.map((p) => p.puuid)).size === 10;
}

/** Constante-tijd vergelijking, zodat het antwoord niets verraadt over de sleutel. */
function secretMatches(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  // timingSafeEqual gooit bij ongelijke lengtes, en die lekt sowieso al.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hoe lang geleden, in leesbare vorm voor de UI. */
function sinceLabel(at: number | null): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Wat start() heeft klaargezet. Als één geheel bewaard zodat stop() de database
 * in één keer loslaat -- een paar honderdduizend games in het geheugen houden
 * terwijl de service uit staat is precies wat stoppen zou moeten voorkomen.
 *
 * De drie caches lopen samen leeg zodra er games bijkomen. Ze staan er niet voor
 * de snelheid van één verzoek maar omdat de UI elke paar seconden summary()
 * opvraagt: knownPuuids kopieert de hele set, coverage() loopt elke matchup na, en
 * de tierlijsten serialiseren kost het meeste van alles.
 */
interface RunningState {
  store: MatchStore;
  stats: JadeStats;
  statsJson: string | null;
  players: number | null;
  usableMatchups: number | null;
  /**
   * ── De correctielaag op MatchStore ─────────────────────────────────────────
   *
   * De Data-weergave van de manager schrijft in hetzelfde bestand. Verwijdert een
   * gebruiker daar een game, dan staat hij niet meer op schijf maar wél nog in de
   * Map van onze MatchStore -- en dan blijft `has()` true, krijgt een client die de
   * game opnieuw aanbiedt 'duplicate', en komt de game nooit meer terug.
   *
   * Waarom niet gewoon opnieuw inlezen? Omdat dat honderden megabytes leeswerk is
   * voor het verwijderen van één regel, en de UI daar elke keer op zou staan
   * wachten. Waarom dan niet de game uit MatchStore halen? Omdat MatchStore in
   * src/core woont, gedeeld wordt met de client, en geen manier heeft om een game
   * te vergeten -- die uitbreiden is een wijziging buiten deze reparatie om.
   *
   * Wat overblijft is deze dunne laag ernaast: twee kleine verzamelingen die
   * vertellen waarin MatchStore achterloopt op het bestand. Alles wat naar buiten
   * kijkt (`has`, de tellers, de statistiek) leest MatchStore dóór deze laag heen.
   * Ze zijn per draaibeurt: bij de volgende start leest MatchStore het bestand toch
   * opnieuw en klopt het beeld vanzelf weer.
   */
  /** gameIds die de manager uit het bestand haalde nadat wij het inlazen. */
  deleted: Set<number>;
  /** Records die de manager veranderde; MatchStore kent alleen nog de oude inhoud. */
  edited: Map<number, StoredMatch>;
}

const EMPTY_SUMMARY: ServiceSummary = {
  records: 0,
  detail: { Players: 0, "Usable matchups": 0, "Last upload": "never" },
};

export class LolClassicService implements GameService {
  readonly id = "lol-classic";
  readonly name = "League of Legends Classic";
  readonly description = "Collects match data from clients and serves the shared statistics";
  readonly basePath = "/lol-classic";

  private state: RunningState | null = null;
  private ctx: ServiceContext | null = null;
  private apiKey = "";
  private lastUploadAt: number | null = null;
  /** De cijfers van de laatste draaibeurt, zodat een gestopte service geen nullen toont. */
  private lastSummary: ServiceSummary = EMPTY_SUMMARY;
  /** Het bestand waar we in schrijven; ook de sleutel van de gedeelde schrijfketting. */
  private storePath = "";
  /**
   * Staat aan zolang stop() bezig is.
   *
   * Zonder deze vlag zou stop() wachten op een wachtrij die zichzelf blijft
   * aanvullen: elke upload die tijdens het leeglopen binnenkomt sluit gewoon
   * achteraan aan. Eerst de deur dicht, dan pas wachten.
   */
  private stopping = false;

  /**
   * Eén vaste lijst, ook als de service niet draait: de host mount hem één keer
   * en antwoordt zelf met 503 zolang er niet gedraaid wordt.
   */
  private readonly routeTable: ServiceRoute[] = [
    { method: "GET", path: "/api/v1/health", handler: (req) => this.health(req) },
    { method: "GET", path: "/api/v1/stats", handler: (req) => this.readStats(req) },
    { method: "POST", path: "/api/v1/matches/known", handler: (req) => this.known(req) },
    { method: "POST", path: "/api/v1/matches", handler: (req) => this.upload(req) },
  ];

  async start(ctx: ServiceContext): Promise<void> {
    this.ctx = ctx;
    this.stopping = false;
    // De sleutel komt uit de omgeving en niet uit een instellingenbestand: hij
    // hoort bij hoe de server gestart wordt, niet bij de verzamelde data.
    this.apiKey = process.env.JADE_KEY ?? "";

    const path = defaultStorePath(ctx.dataRoot);
    this.storePath = path;
    const store = new MatchStore(path);
    // Inlezen in dezelfde ketting als de schrijvers. Zonder dat kan de manager het
    // bestand middenin ons inlezen vervangen: op Windows stuit zijn rename dan op
    // onze open handle, en wij zouden een bestand inlezen dat half van vóór en half
    // van ná de bewerking is.
    await withWriteLock(path, () => store.load());

    // Eén keer helemaal doorrekenen bij het starten; daarna groeit de statistiek
    // per game mee via ingest(). Zie upload().
    const stats = JadeStats.from(store.all());
    this.state = {
      store,
      stats,
      statsJson: null,
      players: null,
      usableMatchups: null,
      deleted: new Set(),
      edited: new Map(),
    };

    ctx.log("info", `Loaded ${store.size} games from ${path}`);
    if (!this.apiKey) ctx.log("warn", "No JADE_KEY set: anyone can upload matches");
  }

  async stop(): Promise<void> {
    // De deur eerst dicht (nieuwe verzoeken krijgen 503), dan pas wachten tot de
    // lopende uploads klaar zijn. Halverwege loslaten zou betekenen dat een client
    // 'accepted' terugkrijgt voor een game waarvan de regel nooit op schijf kwam --
    // hij zet hem in uploaded.json en biedt hem nooit meer aan.
    this.stopping = true;
    try {
      if (this.storePath) {
        if (isWriting(this.storePath)) {
          this.ctx?.log("info", `Waiting for ${pendingWrites(this.storePath)} write(s) in progress...`);
        }
        await whenWritesFinish(this.storePath);
      }
      // Eerst de stand vastleggen, dan pas loslaten: de UI blijft zo de cijfers van
      // de vorige draaibeurt tonen.
      this.lastSummary = await this.summary();
      this.state = null;
      this.ctx?.log("info", "Database released");
      this.ctx = null;
    } finally {
      // Ook als het wachten of het samenstellen van de samenvatting mislukt: de
      // vlag hoort bij deze stop-poging, niet bij de service.
      this.stopping = false;
    }
  }

  /**
   * Verwerkt een wijziging die de manager buiten ons om in het bestand aanbracht.
   *
   * Wordt aangeroepen vanuit MatchBrowser, terwijl die het schrijfslot op ons
   * bestand nog vasthoudt. Twee regels volgen daaruit: dit mag zelf nooit
   * `withWriteLock` op datzelfde pad aanroepen (het zou op zichzelf wachten), en
   * het moet klaar zijn voordat de volgende upload begint -- wat precies de
   * bedoeling is, want die upload moet dit bijgewerkte beeld zien.
   *
   * Alles gebeurt in het geheugen. Alleen een reparatie (`wholesale`) leest het
   * bestand opnieuw in, want die is niet per record te beschrijven; dat is een
   * dure maar zeldzame en door de gebruiker zelf aangezette actie.
   */
  async absorb(change: DatabaseChange): Promise<void> {
    const state = this.state;
    // Een gestopte service heeft geen beeld om bij te werken; de volgende start
    // leest het bestand toch helemaal opnieuw.
    if (!state) return;

    if (change.wholesale) {
      const store = new MatchStore(this.storePath);
      await store.load();
      state.store = store;
      state.deleted = new Set();
      state.edited = new Map();
      this.ctx?.log("info", `Reloaded ${store.size} games after a repair`);
    } else {
      for (const gameId of change.removed) {
        // Alleen wat wij ook echt kenden: een gameId die nooit in ons geheugen zat
        // zou de telling `size - deleted.size` scheeftrekken.
        if (state.store.has(gameId)) state.deleted.add(gameId);
        state.edited.delete(gameId);
      }
      for (const match of change.replaced) {
        if (!state.store.has(match.gameId)) continue;
        state.edited.set(match.gameId, match);
        state.deleted.delete(match.gameId);
      }
    }

    // De statistiek kan niet 'af-ingesten': één game eruit halen kan alleen door
    // opnieuw op te tellen. Dat is puur rekenwerk op wat we al in het geheugen
    // hebben -- geen schijf -- en het gebeurt alleen als een mens iets wijzigt.
    state.stats = JadeStats.from(this.currentMatches(state));
    state.statsJson = null;
    state.players = null;
    state.usableMatchups = null;
  }

  routes(): ServiceRoute[] {
    return this.routeTable;
  }

  async summary(): Promise<ServiceSummary> {
    const state = this.state;
    if (!state) return this.lastSummary;

    state.players ??= state.store.knownPuuids.length;
    state.usableMatchups ??= state.stats.coverage().usable;
    this.lastSummary = {
      records: this.countOf(state),
      detail: {
        Players: state.players,
        "Usable matchups": state.usableMatchups,
        "Last upload": sinceLabel(this.lastUploadAt),
      },
    };
    return this.lastSummary;
  }

  /* ─────────────── het beeld van het bestand, door de correctielaag heen ─────────────── */

  /** Kennen we deze game nog? Wat de manager verwijderde telt niet meer mee. */
  private knows(state: RunningState, gameId: number): boolean {
    return state.store.has(gameId) && !state.deleted.has(gameId);
  }

  /** Hoeveel games er in het bestand staan. */
  private countOf(state: RunningState): number {
    return state.store.size - state.deleted.size;
  }

  /**
   * De games zoals ze nu op schijf staan.
   *
   * Alleen voor het opnieuw doorrekenen van de statistiek. Zonder correcties geven
   * we de lijst van MatchStore ongewijzigd door -- dat is verreweg het gewone geval
   * en het scheelt een kopie van honderdduizenden verwijzingen.
   */
  private currentMatches(state: RunningState): StoredMatch[] {
    const all = state.store.all();
    if (state.deleted.size === 0 && state.edited.size === 0) return all;
    const current: StoredMatch[] = [];
    for (const match of all) {
      if (state.deleted.has(match.gameId)) continue;
      current.push(state.edited.get(match.gameId) ?? match);
    }
    return current;
  }

  /**
   * Draait uploads één voor één af, in DEZELFDE ketting als de manager gebruikt om
   * het bestand te herschrijven.
   *
   * Drie redenen. MatchStore schrijft met losse appends, die door elkaar heen halve
   * regels kunnen opleveren. De controle "kennen we deze game al?" mag niet
   * onderbroken worden door een tweede upload met dezelfde game erin. En -- de
   * reden dat dit een gedeeld slot moet zijn en niet onze eigen wachtrij -- een
   * append mag niet landen terwijl de manager het bestand aan het herschrijven is:
   * die regel staat dan wel in het oude bestand maar niet in de kopie, en verdwijnt
   * met de rename terwijl de client al 'accepted' heeft gekregen.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    return withWriteLock(this.storePath, task);
  }

  /**
   * Wat de handlers als 'draaiend' mogen beschouwen.
   *
   * Tijdens stop() is `state` er nog -- we maken de lopende uploads immers af --
   * maar we nemen geen nieuw werk meer aan.
   */
  private live(): RunningState | null {
    return this.stopping ? null : this.state;
  }

  private unavailable(): ServiceResponse {
    return json(503, { error: this.stopping ? "Service is shutting down" : "Service is not running" });
  }

  /**
   * Alles behalve health vereist de sleutel, als die er is. Zonder sleutel staat
   * de server open -- dat is een keuze van wie hem draait, en start() waarschuwt.
   */
  private denied(req: ServiceRequest): ServiceResponse | null {
    if (!this.apiKey) return null;
    return secretMatches(this.apiKey, req.headers["x-jade-key"])
      ? null
      : json(401, { error: "Invalid or missing API key" });
  }

  private async health(_req: ServiceRequest): Promise<ServiceResponse> {
    const state = this.live();
    if (!state) return this.unavailable();
    state.players ??= state.store.knownPuuids.length;
    return json(200, { ok: true, games: this.countOf(state), players: state.players });
  }

  /**
   * De opgetelde statistiek, zoals de clients hem tonen.
   *
   * Het antwoord gaat als voorgebakken tekst de deur uit: dezelfde tierlijsten
   * opnieuw serialiseren voor elke client die ze ophaalt is het duurste dat deze
   * service doet, en tussen twee uploads verandert er niets aan.
   */
  private async readStats(req: ServiceRequest): Promise<ServiceResponse> {
    const state = this.live();
    if (!state) return this.unavailable();
    const denied = this.denied(req);
    if (denied) return denied;

    state.statsJson ??= this.buildStatsJson(state.stats);
    return {
      status: 200,
      body: state.statsJson,
      headers: { "content-type": "application/json; charset=utf-8" },
    };
  }

  private buildStatsJson(stats: JadeStats): string {
    const lanes: Record<string, unknown> = {};
    for (const position of TIER_LIST_POSITIONS) {
      lanes[position] = stats.tierList(position, STATS_MIN_GAMES).map((entry) => ({
        championId: entry.championId,
        games: entry.games,
        winrate: entry.winrate,
        pickRate: entry.pickRate,
      }));
    }
    return JSON.stringify({
      games: stats.totalMatches,
      coverage: stats.coverage(),
      lanes,
      generatedAt: new Date().toISOString(),
    });
  }

  /** Welke van deze games kennen we al? Scheelt de client een hoop uploadverkeer. */
  private async known(req: ServiceRequest): Promise<ServiceResponse> {
    const state = this.live();
    if (!state) return this.unavailable();
    const denied = this.denied(req);
    if (denied) return denied;

    const body = asRecord(req.body);
    if (!body || !Array.isArray(body.gameIds)) return json(400, { error: "Expected a JSON object with 'gameIds'" });
    if (body.gameIds.length > MAX_IDS_PER_REQUEST) {
      return json(413, { error: `Too many ids in one request (max ${MAX_IDS_PER_REQUEST})` });
    }

    // Ontdubbelen voordat we antwoorden: een client die drie keer hetzelfde
    // nummer stuurt hoeft die game niet drie keer aangeboden te krijgen.
    const missing: number[] = [];
    const seen = new Set<number>();
    for (const id of body.gameIds) {
      if (!isInt(id, 1, Number.MAX_SAFE_INTEGER) || seen.has(id)) continue;
      seen.add(id);
      if (!this.knows(state, id)) missing.push(id);
    }
    return json(200, { missing });
  }

  private async upload(req: ServiceRequest): Promise<ServiceResponse> {
    const state = this.live();
    if (!state) return this.unavailable();
    const denied = this.denied(req);
    if (denied) return denied;

    const body = asRecord(req.body);
    if (!body || !Array.isArray(body.matches)) return json(400, { error: "Expected a JSON object with 'matches'" });
    const offered = body.matches;
    if (offered.length > MAX_MATCHES_PER_REQUEST) {
      return json(413, { error: `Too many matches in one request (max ${MAX_MATCHES_PER_REQUEST})` });
    }

    return this.serialize(async () => {
      const valid = offered.filter(isValidMatch);

      // Ontdubbelen doen we zelf, en niet alleen tegen de database maar ook binnen
      // het pakket: MatchStore telt twee keer dezelfde game in één aanroep als twee
      // toevoegingen terwijl er maar één regel bijkomt. Tussen deze lus en add()
      // staat bewust geen await, zodat `fresh` precies is wat er opgeslagen wordt
      // en de statistiek geen game dubbel telt.
      const fresh: StoredMatch[] = [];
      const seen = new Set<number>();
      for (const match of valid) {
        if (seen.has(match.gameId) || this.knows(state, match.gameId)) continue;
        seen.add(match.gameId);
        fresh.push(match);
      }

      // Twee soorten 'nieuw'. Games die MatchStore nog nooit gezien heeft gaan
      // gewoon via add(). Games die de manager uit het bestand haalde terwijl wij
      // ze in het geheugen hielden zijn het lastige geval: add() zou er niets mee
      // doen (zijn eigen Map kent ze nog) en dan zou 'accepted' liegen -- de client
      // zet de game in uploaded.json en biedt hem nooit meer aan. Die regel zetten
      // we er dus zelf achteraan, langs een weg met dezelfde duurzaamheids-
      // garanties; zie appendMatches().
      const unseen = fresh.filter((match) => !state.store.has(match.gameId));
      const restored = fresh.filter((match) => state.store.has(match.gameId));
      let accepted = unseen.length === 0 ? 0 : await state.store.add(unseen);
      if (restored.length > 0) {
        // Het getal van de schrijver zelf, niet restored.length: 'accepted' hoort
        // alleen te tellen wat er echt op schijf staat.
        const written = await this.appendMatches(restored);
        for (const match of restored) {
          // Bestand en geheugen zijn het weer eens: MatchStore had de game nooit
          // losgelaten, en nu staat hij ook weer op schijf.
          state.deleted.delete(match.gameId);
          state.edited.delete(match.gameId);
        }
        accepted += written;
        this.ctx?.log("info", `${written} previously removed game(s) came back in`);
      }

      if (accepted > 0) {
        // De statistiek groeit per game mee. De oude server rekende alles om de
        // zoveel uploads opnieuw door -- duur, en tussendoor stond er statistiek
        // in de lucht waar de nieuwste games nog niet in zaten.
        for (const match of fresh) state.stats.ingest(match);
        state.statsJson = null;
        state.players = null;
        state.usableMatchups = null;
        this.lastUploadAt = Date.now();
      }

      const rejected = offered.length - valid.length;
      const duplicates = valid.length - fresh.length;
      if (accepted > 0 || rejected > 0) {
        const level = rejected > 0 ? "warn" : "info";
        this.ctx?.log(
          level,
          `${req.ip}: ${offered.length} offered, ${accepted} new, ${duplicates} known, ${rejected} rejected ` +
            `(${this.countOf(state)} total)`,
        );
      }

      return json(200, { accepted, rejected, duplicates, total: this.countOf(state) });
    });
  }

  /**
   * Schrijft games weg die MatchStore al 'kent' en geeft terug hoeveel er
   * daadwerkelijk bijgeschreven zijn.
   *
   * ── Waarom hier een tweede, lege MatchStore staat ──────────────────────────
   *
   * Hier stond een kale `appendFile()`, en dat was een tweede appendweg met
   * zwakkere garanties dan de eerste: geen fsync, dus de bytes stonden alleen in
   * de paginacache van het besturingssysteem, en geen van de zes
   * EPERM/EACCES/EBUSY-herkansingen die een virusscanner op Windows nodig maakt.
   * Precies het gat dat in `MatchStore.add()` al dichtgezet was: de client kreeg
   * 'accepted' voor bytes die een stroomuitval niet zou overleven, zette de game
   * in uploaded.json en bood hem nooit meer aan. Twee appendwegen met
   * verschillende garanties is hóé dat gat ontstond, dus liften we mee op de weg
   * die de garanties al heeft in plaats van ze te dupliceren.
   *
   * Meeliften kan niet via `state.store`: die slaat over wat hij al kent, en dit
   * zijn juist de games die hij nooit heeft losgelaten -- `add()` zou nul
   * teruggeven en niets schrijven. Wat wél kan zonder MatchStore (in src/core,
   * gedeeld met de client) te wijzigen: een tweede store op hetzelfde pad die
   * niets kent. Hij wordt bewust nooit ingelezen -- `load()` blijft uit, dus zijn
   * Map is leeg -- waardoor hij niets wegfiltert en alles wegschrijft wat wij hem
   * geven. Daarmee krijgt deze weg vanzelf hetzelfde formaat, dezelfde
   * herkansingen, dezelfde fsync en dezelfde JADE_FSYNC-knop als de gewone weg,
   * en blijft er maar één stuk code dat weet hóé er geschreven wordt.
   *
   * Wat hij kost is een leeg object per aanroep: de paar games die hij indexeert
   * verdwijnen met hem zodra deze aanroep klaar is. Alleen het geheugenbeeld van
   * de échte store telt, en dat wordt bijgewerkt door de aanroeper.
   *
   * Het enige dat hij níét meekrijgt is de krimpmelding van
   * `detectExternalChange()`. Die vergelijkt met `knownSize`, en een store die
   * nooit gelezen heeft staat op nul, dus hij ziet elk bestand als 'gegroeid' en
   * waarschuwt nergens over. Dat kost hier niets: de melding gaat over een
   * geheugenbeeld dat niet meer met de schijf klopt, en dit object hééft geen
   * geheugenbeeld -- het schrijft één keer en verdwijnt. Het beeld dat er wél toe
   * doet is dat van `state.store`, en dat controleert zichzelf bij de eerstvolgende
   * `add()` met een game die hij nog niet kende. De duurzaamheid van deze append --
   * de fsync, de herkansingen, het afsluiten van een halve regel -- staat er los
   * van en is wél volledig.
   *
   * Neemt zelf géén slot: dit draait al binnen `serialize()`, dat het slot op dit
   * pad vasthoudt. De eigen schrijfketting van deze wegwerpstore is daarmee altijd
   * de binnenste en kan met geen enkel slot daarbuiten in de knoop raken.
   */
  private async appendMatches(matches: readonly StoredMatch[]): Promise<number> {
    const appender = new MatchStore(this.storePath);
    return appender.add([...matches]);
  }
}

/**
 * Het stukje MatchBrowser dat we hier nodig hebben.
 *
 * Als losse vorm opgeschreven zodat dit bestand de bladeraar niet hoeft te
 * importeren: de service hoort niets te weten van hoe de manager zijn UI voedt.
 */
export interface DatabaseChangeSource {
  watch(listener: DatabaseListener): () => void;
}

/**
 * Verbindt een bladeraar met de service die hetzelfde bestand in het geheugen
 * heeft, als dat er een is.
 *
 * Woont hier en niet in index.ts omdat dit de plek is die weet welke services een
 * geheugenbeeld bijhouden. De bedrading blijft daar dan één regel, en een service
 * die niets in het geheugen houdt levert vanzelf `null` op.
 *
 * Geeft terug hoe je de verbinding weer verbreekt, of null als er niets te
 * verbinden viel.
 */
export function watchDatabase(service: GameService | null, source: DatabaseChangeSource): (() => void) | null {
  if (!(service instanceof LolClassicService)) return null;
  return source.watch((change) => service.absorb(change));
}

/**
 * Bewust een fabriek en geen gedeelde instantie: twee keer dezelfde service
 * draaien zou twee keer dezelfde bestanden openen, en dat hoort de host te
 * bepalen, niet dit bestand.
 */
export const createLolClassicService = (): GameService => new LolClassicService();
