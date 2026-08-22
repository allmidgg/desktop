/**
 * De HTTP-host: één server, één poort, alle services.
 *
 * Wie binnenkomt op /lol-classic/... wordt doorgezet naar de service die zich op
 * dat voorvoegsel heeft gemeld. Een service luistert nergens zelf op; het waarom
 * van die keuze staat in manager/README.md.
 *
 * Alles wat met de buitenwereld te maken heeft gebeurt hier en nergens anders:
 * uitpakken, begrenzen, tellen, loggen en antwoorden. Een handler krijgt een plat
 * object binnen en geeft een status plus een body terug. Hij kan de socket dus
 * niet kapen, geen halve headers sturen, en de host niet meeslepen als hij gooit.
 *
 * De regel waar de rest aan opgehangen is: een kapot verzoek is nooit een reden
 * om te stoppen met luisteren. Elke fout wordt een antwoord.
 *
 * Geen CORS-headers: dit is machine-naar-machine verkeer tussen clients en deze
 * server, er zit nooit een browser met een origin tussen.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostInfo } from "../../shared/types";
import type {
  GameService,
  LogLevel,
  ServiceRequest,
  ServiceResponse,
  ServiceRoute,
  ServiceStatus,
} from "./services/types";

/**
 * Ruim genoeg voor een eerste volledige sync.
 *
 * De client vraagt per 1.000 game-id's welke de server nog mist en stuurt daarna
 * per 200 games een pakket op. Een verzameling van 60.000 games kost dus 60 + 300
 * = 360 verzoeken, achter elkaar, vanaf één IP. De oude server stond er 120 per
 * minuut toe, en daar liep élke eerste sync op vast -- precies op het moment dat
 * iemand voor het eerst meedeed. Hier zit bijna een factor tien speling op, zodat
 * ook een client met kleinere pakketten of een huishouden achter één NAT-adres er
 * doorheen komt. Deze grens is er tegen een op hol geslagen client, niet tegen
 * verkeer dat nu eenmaal veel is.
 */
export const DEFAULT_RATE_LIMIT: RateLimit = { windowMs: 60_000, max: 3_000 };

/**
 * Een pakket van 200 games is ongeveer 0,6 MB. Deze grens laat daar ruim tien keer
 * zoveel van door en houdt tegelijk tegen dat één verzoek het geheugen opeet.
 * Gelijk aan wat de losse verzamelserver aanhield, zodat bestaande clients die hun
 * pakketgrootte op de server hebben afgestemd niets merken.
 */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Een handler die na deze tijd nog niets teruggaf houdt een verbinding bezet. */
const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;

/** Hoe vaak we verlopen ratelimiet-tellers opruimen; vaker is verspilling. */
const SWEEP_INTERVAL_MS = 60_000;

/** Bovengrens aan wat we van een pad in het logvenster zetten. */
const MAX_LOGGED_URL = 200;

/**
 * Wat een gepauzeerde service als retry-after meegeeft.
 *
 * Een pauze is een handeling van een mens achter de manager, dus de duur is niet
 * te weten. Een halve minuut is lang genoeg om een client niet te laten rammen en
 * kort genoeg om een hervatting binnen een redelijke tijd op te pikken.
 */
const PAUSED_RETRY_AFTER_SECONDS = 30;

export interface RateLimit {
  /** Lengte van het tijdvenster in milliseconden. */
  windowMs: number;
  /** Hoeveel verzoeken één IP binnen dat venster mag doen. */
  max: number;
}

export interface HostOptions {
  /** Belandt in het logvenster van de UI; serviceId is null als de host zelf de afzender is. */
  log?(level: LogLevel, message: string, serviceId: string | null): void;
  maxBodyBytes?: number;
  rateLimit?: RateLimit;
  handlerTimeoutMs?: number;
  /** Standaard alle interfaces: de clients zitten op het LAN of achter een poortdoorverwijzing. */
  bindAddress?: string;
  /**
   * Alleen aanzetten als er echt een reverse proxy voor staat.
   *
   * x-forwarded-for is door de afzender zelf te schrijven. Wie die header zonder
   * proxy gelooft, geeft iedereen een gratis pad om de ratelimiet te omzeilen:
   * één regel per verzoek en de teller begint steeds opnieuw. Staat dit uit, dan
   * is het adres van de socket leidend en is ServiceRequest.ip dus altijd echt.
   */
  trustProxy?: boolean;
}

/** Eén gemonteerde service plus de boekhouding die de host erbij houdt. */
interface Mount {
  service: GameService;
  /** Per verzoek opgevraagd: de levensloop ligt bij de manager, niet bij de host. */
  status: () => ServiceStatus;
  /** Eenmalig opgehaald; het contract belooft dat de lijst niet verandert. */
  routes: ServiceRoute[];
  requests: number;
}

interface Bucket {
  count: number;
  resetAt: number;
  /** Voorkomt dat één doordravende client het logvenster volschrijft. */
  logged: boolean;
}

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "payload_too_large" | "invalid_json" | "client_closed" };

/** Losse waarde in plaats van een exception: een trage handler is geen fout om te vangen. */
const HANDLER_TIMEOUT: unique symbol = Symbol("handler-timeout");

const EMPTY = Buffer.alloc(0);

/** Als JSON.stringify zelf al niet lukt, moet het antwoord uit een vaste string komen. */
const UNSERIALISABLE = '{"error":"internal_error","message":"The response could not be serialised."}';

/**
 * De centrale server. Services meld je met mount(); start() en stop() gaan alleen
 * over het luisteren zelf, zodat een service starten of stoppen nooit een socket
 * raakt.
 */
export class ServiceHost {
  private readonly mounts: Mount[] = [];
  private readonly buckets = new Map<string, Bucket>();

  private readonly logSink: HostOptions["log"];
  private readonly maxBodyBytes: number;
  private readonly rateLimit: RateLimit;
  private readonly handlerTimeoutMs: number;
  private readonly bindAddress: string | undefined;
  private readonly trustProxy: boolean;

  private server: Server | null = null;
  private listeningPort = 0;
  private listeningSince: number | null = null;
  private lastError: string | null = null;
  private requests = 0;
  private nextSweep = 0;

  constructor(options: HostOptions = {}) {
    this.logSink = options.log;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    this.bindAddress = options.bindAddress;
    this.trustProxy = options.trustProxy ?? false;
  }

  // ---------------------------------------------------------------- montage

  /**
   * Hangt een service onder zijn basePath.
   *
   * `status` is een functie en geen waarde omdat de host de levensloop niet
   * beheert: hij kijkt bij elk verzoek wat de manager er op dát moment van vindt,
   * zodat er geen tweede kopie van de status kan gaan afwijken.
   *
   * Gooit bij een dubbel of ongeldig basePath. Dat is een programmeerfout die bij
   * het opstarten hoort op te vallen, niet bij het eerste verzoek.
   */
  mount(service: GameService, status: () => ServiceStatus): void {
    const base = service.basePath;
    if (!base.startsWith("/") || base.length < 2 || base.endsWith("/")) {
      throw new Error(`Service '${service.id}' has an invalid base path '${base}'.`);
    }
    for (const mounted of this.mounts) {
      if (mounted.service.id === service.id) throw new Error(`Service '${service.id}' is already mounted.`);
      if (mounted.service.basePath === base) {
        throw new Error(`Base path '${base}' is already taken by service '${mounted.service.id}'.`);
      }
    }

    let routes: ServiceRoute[];
    try {
      routes = service.routes();
    } catch (err) {
      throw new Error(`Service '${service.id}' could not list its routes: ${messageOf(err)}`);
    }

    this.mounts.push({ service, status, routes: [...routes], requests: 0 });
    // Langste voorvoegsel eerst, anders slokt '/spel' een genest '/spel/arena' op.
    this.mounts.sort((a, b) => b.service.basePath.length - a.service.basePath.length);
  }

  unmount(serviceId: string): boolean {
    const index = this.mounts.findIndex((mount) => mount.service.id === serviceId);
    if (index === -1) return false;
    this.mounts.splice(index, 1);
    return true;
  }

  // ---------------------------------------------------------------- luisteren

  get isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** De poort waarop echt geluisterd wordt; bij poort 0 dus de toegewezen poort. */
  get port(): number {
    return this.listeningPort;
  }

  /** Alle verzoeken sinds de laatste start, inclusief 404's, 429's en 503's. */
  get totalRequests(): number {
    return this.requests;
  }

  /** Waarom er niet geluisterd wordt, in Engelse UI-tekst. */
  get error(): string | null {
    return this.lastError;
  }

  requestsFor(serviceId: string): number {
    return this.mounts.find((mount) => mount.service.id === serviceId)?.requests ?? 0;
  }

  info(): HostInfo {
    return {
      port: this.listeningPort,
      listening: this.isListening,
      uptimeSeconds: this.listeningSince === null ? 0 : Math.floor((Date.now() - this.listeningSince) / 1000),
      totalRequests: this.requests,
      error: this.lastError,
    };
  }

  /**
   * Gaat luisteren. Draait er al een server, dan wordt die eerst netjes gesloten,
   * zodat een poortwissel vanuit de UI één aanroep is.
   *
   * Poort 0 laat het besturingssysteem kiezen; handig om tegen te testen.
   */
  async start(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`Port ${port} is not a valid port number.`);
    }
    if (this.server) await this.stop();

    const server = createServer((req, res) => this.accept(req, res));

    // Keep-alive is geen luxe maar de kern van een sync: honderden verzoeken achter
    // elkaar over dezelfde verbinding schelen evenzoveel TCP-handshakes.
    server.keepAliveTimeout = 30_000;
    // Node wil headersTimeout ruimer dan keepAliveTimeout, anders sneuvelt een
    // hergebruikte verbinding net voordat het volgende verzoek binnenkomt.
    server.headersTimeout = 40_000;
    // Begrenst hoe lang iemand een verbinding met een druppelend lichaam bezet houdt.
    server.requestTimeout = 120_000;

    // Een verzoek dat al stuk is voordat het een verzoek werd (rommel op de poort,
    // TLS tegen een HTTP-server) mag geen uncaught error worden.
    server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        this.lastError = describeListenError(err, port);
        this.log("error", this.lastError, null);
        reject(new Error(this.lastError));
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        // Vanaf nu is een serverfout geen reden meer om start() te laten falen;
        // hem opslokken is beter dan het proces eraan opknopen.
        server.on("error", (err) => this.log("error", `HTTP server error: ${err.message}`, null));

        const address = server.address();
        this.listeningPort = typeof address === "object" && address !== null ? (address as AddressInfo).port : port;
        this.server = server;
        this.listeningSince = Date.now();
        this.lastError = null;
        // Tellers horen bij deze luisterbeurt, net als uptimeSeconds.
        this.requests = 0;
        for (const mount of this.mounts) mount.requests = 0;
        this.log("info", `HTTP host is listening on port ${this.listeningPort}.`, null);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      if (this.bindAddress) server.listen(port, this.bindAddress);
      else server.listen(port);
    });
  }

  /**
   * Stopt met luisteren. Sluit ook openstaande keep-alive verbindingen, want die
   * houden close() anders tegen tot de client uit zichzelf opgeeft -- en dan hangt
   * het afsluiten van de app aan een vreemde.
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.listeningSince = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Wie halverwege een upload zit krijgt een paar seconden, daarna gaat de stekker eruit.
        server.closeAllConnections();
        finish();
      }, 3_000);
      timer.unref();

      server.close(() => finish());
      server.closeIdleConnections();
    });

    this.buckets.clear();
    this.log("info", "HTTP host stopped listening.", null);
  }

  // ---------------------------------------------------------------- verzoeken

  private accept(req: IncomingMessage, res: ServerResponse): void {
    // Een client die er halverwege uitklapt levert anders een uncaught error op.
    req.on("error", () => undefined);
    res.on("error", () => undefined);

    const startedAt = Date.now();
    void this.route(req, res, startedAt).catch((err: unknown) => {
      // Hier hoort niets meer te komen; komt er toch iets, dan is een 500 beter dan een dode host.
      this.log("error", `Request handling failed: ${messageOf(err)}`, null);
      this.finish(req, res, null, "unknown", startedAt, internalError(), false);
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse, startedAt: number): Promise<void> {
    this.requests++;

    const ip = this.clientIp(req);
    const method = (req.method ?? "GET").toUpperCase();
    let mount: Mount | null = null;
    /** Elke uitgang loopt hier langs, zodat er precies één plek is die antwoordt en logt. */
    const reply = (response: ServiceResponse, silent = false): void =>
      this.finish(req, res, mount, ip, startedAt, response, silent);

    const target = parseTarget(req.url);
    if (!target) return reply(problem(400, "bad_request", "The request path is malformed."));

    const limited = this.throttle(ip, startedAt);
    if (limited) {
      if (limited.announce) {
        this.log("warn", `Rate limit reached for ${ip}; further requests are refused for now.`, null);
      }
      const retry = { "retry-after": String(limited.retryAfter) };
      const message = `Too many requests. Try again in ${limited.retryAfter} seconds.`;
      return reply(problem(429, "rate_limited", message, retry), !limited.announce);
    }

    mount =
      this.mounts.find(
        (candidate) =>
          target.path === candidate.service.basePath || target.path.startsWith(`${candidate.service.basePath}/`),
      ) ?? null;
    if (!mount) return reply(problem(404, "not_found", `No service is mounted at '${target.path}'.`));
    mount.requests++;

    const label = `${method} ${target.path}`;
    const path = target.path.slice(mount.service.basePath.length) || "/";
    // Exacte paden gaan voor op wildcards, ongeacht de volgorde waarin de service ze opgaf.
    const candidates = [
      ...mount.routes.filter((route) => !isWildcard(route) && route.path === path),
      ...mount.routes.filter((route) => isWildcard(route) && matchesWildcard(route, path)),
    ];
    if (candidates.length === 0) {
      return reply(problem(404, "not_found", `Service '${mount.service.name}' has no route for '${path}'.`));
    }

    const allow = allowHeader(candidates);
    // OPTIONS gaat over de routetabel, en die staat los van of de service draait.
    if (method === "OPTIONS") return reply({ status: 204, body: null, headers: { allow } }, true);

    // Het pad bestaat, de service staat alleen uit: dat is 503 en geen 404, anders
    // gaat een client zijn eigen adres verdenken en stopt hij met proberen.
    //
    // Pauze krijgt zijn eigen code en melding. Een client die op `error` stuurt kan
    // dan het verschil maken tussen "deze service is uit" (opgeven, of een mens
    // erbij halen) en "deze service komt zo terug" (straks nog eens proberen), en
    // daar hoort een retry-after bij zodat hij niet hoeft te gokken hoe lang.
    const status = this.statusOf(mount);
    if (status !== "running") {
      const paused = status === "paused";
      const code = paused ? "service_paused" : "service_unavailable";
      const message = paused
        ? `Service '${mount.service.name}' is paused and will answer again once it is resumed.`
        : `Service '${mount.service.name}' is not running.`;
      const headers = paused ? { "retry-after": String(PAUSED_RETRY_AFTER_SECONDS) } : undefined;
      return reply(problem(503, code, message, headers, { service: mount.service.id, status }));
    }

    const wanted = method === "HEAD" ? "GET" : method;
    const route = candidates.find((candidate) => candidate.method === wanted);
    if (!route) {
      return reply(problem(405, "method_not_allowed", `${method} is not allowed on '${path}'.`, { allow }));
    }

    const body = await this.readBody(req, method);
    if (!body.ok) {
      // Niemand meer om tegen te praten; alleen de verbinding loslaten.
      if (body.code === "client_closed") return void res.destroy();
      if (body.code === "invalid_json") return reply(problem(400, "invalid_json", "Request body is not valid JSON."));
      // De rest van het lichaam komt nog aan; de verbinding sluiten is de enige
      // manier om die megabytes niet alsnog te moeten wegslikken.
      const message = `Request body exceeds ${this.maxBodyBytes} bytes.`;
      return reply(problem(413, "payload_too_large", message, { connection: "close" }));
    }

    const request: ServiceRequest = {
      method: wanted,
      path,
      query: target.query,
      headers: headersOf(req),
      body: body.value,
      ip,
    };

    try {
      const outcome = await this.invoke(route, request);
      if (outcome !== HANDLER_TIMEOUT) return reply(outcome);
      this.log("error", `Handler for ${label} timed out.`, mount.service.id);
      return reply(problem(504, "handler_timeout", "The service took too long to answer."));
    } catch (err) {
      // Een gooiende handler is een fout in die service, niet in de host: melden en doorgaan.
      this.log("error", `Handler for ${label} failed: ${messageOf(err)}`, mount.service.id);
      return reply(internalError());
    }
  }

  /** Roept de handler aan met een klok ernaast, zodat één trage service geen verbindingen opstapelt. */
  private async invoke(
    route: ServiceRoute,
    request: ServiceRequest,
  ): Promise<ServiceResponse | typeof HANDLER_TIMEOUT> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race<ServiceResponse | typeof HANDLER_TIMEOUT>([
        route.handler(request),
        new Promise<typeof HANDLER_TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(HANDLER_TIMEOUT), this.handlerTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private statusOf(mount: Mount): ServiceStatus {
    try {
      return mount.status();
    } catch {
      // Een status die niet op te vragen is behandelen we als 'kapot', niet als 'draait'.
      return "error";
    }
  }

  // ---------------------------------------------------------------- lichaam

  /**
   * Leest het lichaam met een harde bovengrens en parseert het als JSON.
   *
   * Bij GET/HEAD/OPTIONS wordt er niets gelezen maar wel afgevoerd: een niet
   * uitgelezen stroom houdt de verbinding bezet voor het volgende verzoek.
   */
  private readBody(req: IncomingMessage, method: string): Promise<BodyResult> {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      req.resume();
      return Promise.resolve({ ok: true, value: null });
    }

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      return Promise.resolve({ ok: false, code: "payload_too_large" });
    }

    return new Promise<BodyResult>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      const finish = (result: BodyResult): void => {
        if (settled) return;
        settled = true;
        chunks.length = 0;
        resolve(result);
      };

      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          // Pauzeren in plaats van doorlezen: de rest van dit lichaam hoeft niet
          // eerst door ons geheugen voordat we hem mogen weigeren.
          req.pause();
          finish({ ok: false, code: "payload_too_large" });
          return;
        }
        chunks.push(chunk);
      });

      req.once("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.trim() === "") {
          finish({ ok: true, value: null });
          return;
        }
        try {
          finish({ ok: true, value: JSON.parse(text) as unknown });
        } catch {
          finish({ ok: false, code: "invalid_json" });
        }
      });

      req.once("aborted", () => finish({ ok: false, code: "client_closed" }));
      req.once("error", () => finish({ ok: false, code: "client_closed" }));
      req.once("close", () => finish({ ok: false, code: "client_closed" }));
    });
  }

  // ---------------------------------------------------------------- ratelimiet

  /**
   * Vast tijdvenster per IP. Geeft null als het verzoek mag; anders hoeveel
   * seconden de client moet wachten.
   *
   * Bewust geen token bucket: een venster is in één zin uit te leggen aan wie een
   * 429 krijgt, en Retry-After valt er exact uit af te leiden.
   */
  private throttle(ip: string, now: number): { retryAfter: number; announce: boolean } | null {
    this.sweep(now);

    const bucket = this.buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.rateLimit.windowMs, logged: false });
      return null;
    }

    bucket.count++;
    if (bucket.count <= this.rateLimit.max) return null;

    const announce = !bucket.logged;
    bucket.logged = true;
    return { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)), announce };
  }

  /** Verlopen tellers opruimen, anders groeit de map mee met elk IP dat ooit langskwam. */
  private sweep(now: number): void {
    if (now < this.nextSweep) return;
    this.nextSweep = now + SWEEP_INTERVAL_MS;
    for (const [ip, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(ip);
    }
  }

  private clientIp(req: IncomingMessage): string {
    if (this.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
      if (first) return normalizeIp(first);
    }
    return normalizeIp(req.socket.remoteAddress ?? "");
  }

  // ---------------------------------------------------------------- antwoord

  /**
   * Schrijft het antwoord en logt het verzoek. Idempotent: een tweede aanroep op
   * dezelfde verbinding (trage handler die alsnog terugkomt) doet niets.
   */
  private finish(
    req: IncomingMessage,
    res: ServerResponse,
    mount: Mount | null,
    ip: string,
    startedAt: number,
    response: ServiceResponse,
    silent: boolean,
  ): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return;

    const headers: Record<string, string> = { "cache-control": "no-store" };
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      if (value === undefined || value === null) continue;
      headers[key.toLowerCase()] = String(value);
    }

    let status = response.status;
    let payload = EMPTY;
    if (response.body !== null && response.body !== undefined) {
      const custom = headers["content-type"];
      if (custom !== undefined && typeof response.body === "string") {
        payload = Buffer.from(response.body, "utf8");
      } else {
        if (custom !== undefined) {
          // Contractbreuk van de service; een verkeerd content-type de lijn op sturen
          // is erger dan het stilletjes rechtzetten.
          const warning = `Handler set content-type '${custom}' but did not return a string.`;
          this.log("warn", warning, mount?.service.id ?? null);
        }
        try {
          payload = Buffer.from(JSON.stringify(response.body) ?? "null", "utf8");
          headers["content-type"] = "application/json; charset=utf-8";
        } catch (err) {
          this.log("error", `Response body could not be serialised: ${messageOf(err)}`, mount?.service.id ?? null);
          status = 500;
          payload = Buffer.from(UNSERIALISABLE, "utf8");
          headers["content-type"] = "application/json; charset=utf-8";
        }
      }
    } else {
      delete headers["content-type"];
    }

    if (!Number.isInteger(status) || status < 100 || status > 599) {
      this.log("error", `Handler returned invalid status ${String(response.status)}.`, mount?.service.id ?? null);
      status = 500;
    }
    // 204 en 304 hóren geen lichaam te hebben; een content-length erbij zetten
    // maakt strenge clients aan het twijfelen over wat er nog komt.
    if (status !== 204 && status !== 304) headers["content-length"] = String(payload.length);

    try {
      res.writeHead(status, headers);
      // Bij HEAD hoort dezelfde content-length maar geen lichaam.
      if ((req.method ?? "GET").toUpperCase() === "HEAD" || payload.length === 0) res.end();
      else res.end(payload);
    } catch (err) {
      // Een onmogelijke header of statuscode van een service mag de host niet slopen.
      this.log("error", `Could not write response: ${messageOf(err)}`, mount?.service.id ?? null);
      res.destroy();
      return;
    }

    // Wat niet gelezen is alsnog afvoeren, anders blijft de verbinding hangen. Bij
    // een 413 juist niet: daar is de hele grap dat we die bytes niet willen.
    if (!req.readableEnded && headers["connection"] !== "close") req.resume();

    if (silent) return;
    // Geslaagde verzoeken gaan niet in het log: een sync van 60.000 games zou het
    // logvenster in één keer leegspoelen. Daarvoor zijn de tellers.
    if (status < 400) return;

    const target = truncate(req.url ?? "", MAX_LOGGED_URL);
    const line = `${(req.method ?? "?").toUpperCase()} ${target} -> ${status} (${ip}, ${Date.now() - startedAt} ms)`;
    // 503 is geen storing maar het afgesproken antwoord van een uitgezette of
    // gepauzeerde service; dat als fout wegschrijven maakt het logvenster rood om niets.
    this.log(status >= 500 && status !== 503 ? "error" : "warn", line, mount?.service.id ?? null);
  }

  private log(level: LogLevel, message: string, serviceId: string | null): void {
    try {
      this.logSink?.(level, message, serviceId);
    } catch {
      // Een logboek dat zelf gooit mag geen verzoek meenemen.
    }
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Splitst pad en querystring zonder new URL().
 *
 * URL() heeft een basis nodig en trapt dan in een pad als '//elders/x', dat als
 * protocolrelatief adres wordt gelezen en zomaar een ander pad oplevert. Hier
 * knippen we bij de eerste '?' en verder niets.
 *
 * Paden met '.' of '..' erin weigeren we: geen enkele echte client stuurt ze, en
 * een service die er een bestandsnaam van maakt heeft er zo een lek mee te pakken.
 * Het percentgecodeerde pad geven we ongewijzigd door, zodat %2F nooit stilletjes
 * een extra padscheiding wordt.
 */
function parseTarget(url: string | undefined): { path: string; query: URLSearchParams } | null {
  if (!url || !url.startsWith("/")) return null;

  const mark = url.indexOf("?");
  const raw = mark === -1 ? url : url.slice(0, mark);
  const query = new URLSearchParams(mark === -1 ? "" : url.slice(mark + 1));

  if (raw.includes("\0")) return null;
  for (const segment of raw.split("/")) {
    if (segment === "." || segment === "..") return null;
  }

  // Een afsluitende slash is een schrijfwijze, geen ander pad.
  const path = raw.length > 1 && raw.endsWith("/") ? raw.replace(/\/+$/, "") || "/" : raw;
  return { path, query };
}

const isWildcard = (route: ServiceRoute): boolean => route.path.endsWith("/*");

function matchesWildcard(route: ServiceRoute, path: string): boolean {
  const prefix = route.path.slice(0, -2);
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

function allowHeader(routes: ServiceRoute[]): string {
  const methods = new Set<string>(routes.map((route) => route.method));
  if (methods.has("GET")) methods.add("HEAD");
  methods.add("OPTIONS");
  return [...methods].join(", ");
}

/** Node maakt de sleutels al klein; meervoudige waarden voegen we samen zoals het contract belooft. */
function headersOf(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/** Foutlichamen hebben altijd dezelfde vorm, zodat een client op `error` kan sturen. */
function problem(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
  extra?: Record<string, unknown>,
): ServiceResponse {
  return { status, body: { error: code, message, ...extra }, headers };
}

const internalError = (): ServiceResponse =>
  problem(500, "internal_error", "The service failed to handle this request.");

/** IPv4 in IPv6-jas levert anders twee tellers op voor dezelfde client. */
function normalizeIp(address: string): string {
  if (!address) return "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function describeListenError(err: NodeJS.ErrnoException, port: number): string {
  if (err.code === "EADDRINUSE") return `Port ${port} is already in use by another program.`;
  if (err.code === "EACCES") return `Port ${port} cannot be opened without extra permissions.`;
  return `Could not listen on port ${port}: ${err.message}`;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const truncate = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}...` : value);
