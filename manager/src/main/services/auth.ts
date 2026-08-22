/**
 * Sleuteldienst: wie mag er praten met de servers die hier draaien.
 *
 * Bewust geen accounts en geen wachtwoorden. Wat we nodig hebben is dat een
 * client zich herkenbaar maakt, niet dat iemand hier inlogt -- dus geven we
 * losse API-sleutels uit. Geen e-mailadressen, geen wachtwoordherstel, geen
 * persoonsgegevens die we later moeten beschermen of weggooien.
 *
 * Een sleutel ziet er zo uit:
 *
 *     gsk_<id>.<geheim>
 *
 * De id staat er niet voor de sier: die is openbaar en wijst meteen het juiste
 * record aan. Zonder id zouden we bij elke controle tegen élk record moeten
 * hashen, en dat is precies wat scrypt duur maakt. Nu is het één opzoeking plus
 * één hash.
 *
 * Op schijf staat alleen de scrypt-hash van het geheim. Wie het bestand in
 * handen krijgt heeft daarmee nog geen werkende sleutel, en wij kunnen een
 * sleutel dus ook niet "even opzoeken" voor iemand die hem kwijt is -- dat is
 * geen tekortkoming maar het hele punt. Kwijt is opnieuw uitgeven.
 *
 * Intrekken laat het record staan met een datum erbij. Dat kost een paar bytes
 * en levert twee dingen op: een ingetrokken sleutel is te onderscheiden van een
 * verzonnen sleutel (de client weet dan dat stoppen met proberen het juiste
 * antwoord is), en de id kan nooit per ongeluk opnieuw uitgedeeld worden.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type {
  GameService,
  ServiceContext,
  ServiceRequest,
  ServiceResponse,
  ServiceRoute,
  ServiceSummary,
} from "./types";

const KEY_PREFIX = "gsk_";
const KEYS_PATH = "/api/v1/keys";
const KEY_FILE = "keys.json";

/** Staat in het bestand zodat een toekomstige indeling herkenbaar is, en niet als "kapot" leest. */
const FILE_VERSION = 1;

const ID_BYTES = 8;
const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/**
 * Scrypt met bescheiden kosten, en dat is met opzet.
 *
 * De zwaarste instellingen bestaan om te voorkomen dat iemand een gelekt
 * wachtwoord raadt. Hier valt niets te raden: het geheim is 32 bytes uit
 * randomBytes, dus een woordenboek of een brute force helpt niet, hoe goedkoop
 * de hash ook is. De hash moet alleen zorgen dat het bestand zelf geen bruikbare
 * sleutels bevat. Zwaarder maken kost elke controle tijd zonder dat het iets
 * tegenhoudt.
 */
const SCRYPT: ScryptOptions = { N: 16_384, r: 8, p: 1 };

/**
 * Hoe lang een geslaagde controle onthouden wordt.
 *
 * Elke controle een scrypt draaien is tientallen milliseconden, en deze functie
 * hangt straks voor élk verzoek aan élke service. Daarom onthouden we per
 * sleutel de sha256 van het geheim dat zojuist klopte; dat is een vergelijking
 * van niks. De sha256 staat alleen in het geheugen, verdwijnt bij stop(), en
 * wordt bij intrekken meteen weggegooid zodat een ingetrokken sleutel niet nog
 * even doorwerkt.
 */
const CACHE_MS = 5 * 60_000;

/** Bijgewerkte gebruiksmomenten wegschrijven; niet per verzoek, dat zou een schrijfactie per request zijn. */
const FLUSH_MS = 30_000;

/** Ingetrokken sleutels blijven zo lang staan; daarna is het alleen nog ballast. */
const TOMBSTONE_MS = 90 * 24 * 60 * 60_000;

const LABEL_MAX = 60;
const SCOPES_MAX = 16;
const SCOPE_MAX = 64;

const ID_PATTERN = /^[0-9a-f]{16}$/;
const SCOPE_PATTERN = /^[a-z0-9*][a-z0-9:._*-]*$/;

/** Zoals de sleutel op schijf staat. Het geheim zelf komt hier nooit in voor. */
interface StoredKey {
  id: string;
  label: string;
  scopes: string[];
  salt: string;
  hash: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** Wat een andere service over de beller te weten komt. */
export interface KeyIdentity {
  id: string;
  label: string;
  scopes: string[];
}

/**
 * Waarom een verzoek niet doorgelaten werd.
 *
 * 'unknown' dekt zowel een onbekende id als een verkeerd geheim: het verschil
 * daartussen prijsgeven zou een aanvaller vertellen welke ids bestaan.
 */
export type AuthFailure = "unavailable" | "missing" | "malformed" | "unknown" | "revoked" | "forbidden";

export type AuthResult =
  | { ok: true; key: KeyIdentity }
  | { ok: false; reason: AuthFailure; response: ServiceResponse };

const json = (status: number, body: unknown, headers?: Record<string, string>): ServiceResponse =>
  headers ? { status, body, headers } : { status, body };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function derive(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, HASH_BYTES, SCRYPT, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

/** timingSafeEqual gooit bij ongelijke lengtes; die lengte ligt vast in de code en is geen geheim. */
const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

function splitKey(value: string): { id: string; secret: string } | null {
  if (!value.startsWith(KEY_PREFIX)) return null;
  const rest = value.slice(KEY_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  const id = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!ID_PATTERN.test(id) || secret.length < 32 || secret.length > 128) return null;
  return { id, secret };
}

/**
 * Waar de sleutel in het verzoek mag zitten.
 *
 * Nadrukkelijk niet in de querystring: die belandt in access logs, in
 * proxy-logs en in de geschiedenis van de browser, en daar is een sleutel niet
 * meer uit te halen.
 */
function presentedKey(req: ServiceRequest): string {
  const direct = req.headers["x-api-key"];
  if (direct) return direct.trim();
  const authorization = req.headers["authorization"];
  if (authorization && authorization.slice(0, 7).toLowerCase() === "bearer ") return authorization.slice(7).trim();
  return "";
}

/**
 * Komt dit verzoek van deze machine zelf?
 *
 * De host vult req.ip met x-forwarded-for als die header er is, en die header
 * schrijft de client zelf. Staat hij er, dan is het adres een bewering en geen
 * waarneming -- anders zou "X-Forwarded-For: 127.0.0.1" genoeg zijn om vanaf
 * het internet sleutels aan te maken. Vandaar: alleen een loopback-adres dat
 * door geen enkele proxy is aangeraakt telt als lokaal.
 */
function isLocal(req: ServiceRequest): boolean {
  for (const header of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
    if (req.headers[header]) return false;
  }
  const ip = req.ip.startsWith("::ffff:") ? req.ip.slice(7) : req.ip;
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.");
}

/** '*' mag alles, 'lol-classic:*' mag alles binnen die service. */
function grants(scopes: string[], needed: string): boolean {
  for (const scope of scopes) {
    if (scope === "*" || scope === needed) return true;
    if (scope.endsWith(":*") && needed.startsWith(scope.slice(0, -1))) return true;
  }
  return false;
}

function readScopes(value: unknown): string[] | null {
  // Niets opgegeven betekent een sleutel zonder beperking; wie wil beperken zegt het erbij.
  if (value === undefined || value === null) return ["*"];
  if (!Array.isArray(value) || value.length > SCOPES_MAX) return null;
  const scopes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const scope = entry.trim().toLowerCase();
    if (!scope || scope.length > SCOPE_MAX || !SCOPE_PATTERN.test(scope)) return null;
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes.length > 0 ? scopes : ["*"];
}

function toStoredKey(value: unknown): StoredKey | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const { id, label, scopes, salt, hash, createdAt, lastUsedAt, revokedAt } = raw;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof label !== "string" || typeof salt !== "string" || typeof hash !== "string") return null;
  if (!Array.isArray(scopes) || !scopes.every((scope): scope is string => typeof scope === "string")) return null;
  if (typeof createdAt !== "number") return null;
  if (lastUsedAt !== null && typeof lastUsedAt !== "number") return null;
  if (revokedAt !== null && typeof revokedAt !== "number") return null;
  return { id, label, scopes, salt, hash, createdAt, lastUsedAt, revokedAt };
}

/** Korte tekst voor de UI; de kaart heeft geen ruimte voor een volledige datum. */
function ago(at: number | null): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

class AuthService implements GameService {
  readonly id = "auth";
  readonly name = "Access Keys";
  readonly description = "Issues and verifies the API keys that clients use to reach the other services.";
  readonly basePath = "/auth";

  private file = "";
  private readonly keys = new Map<string, StoredKey>();
  private readonly recent = new Map<string, { digest: Buffer; until: number }>();
  private loaded = false;
  private dirty = false;
  private checks = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Schrijfacties staan op één ketting, zodat twee wijzigingen elkaars bestand niet halverwege overschrijven. */
  private writing: Promise<void> = Promise.resolve();
  private log: ServiceContext["log"] = () => {};

  async start(ctx: ServiceContext): Promise<void> {
    this.log = ctx.log;
    this.file = join(ctx.dataRoot, KEY_FILE);
    this.keys.clear();
    this.recent.clear();
    this.dirty = false;
    this.checks = 0;

    await this.load();
    this.loaded = true;

    this.flushTimer = setInterval(() => {
      if (this.dirty) void this.persist().catch(() => undefined);
    }, FLUSH_MS);

    const revoked = [...this.keys.values()].filter((key) => key.revokedAt !== null).length;
    ctx.log("info", `${this.keys.size - revoked} active keys, ${revoked} revoked`);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) await this.persist().catch(() => undefined);
    await this.writing;
    // Pas nu, want persist() weigert te schrijven zodra dit uit staat -- en die laatste flush moest er nog uit.
    this.loaded = false;
    this.recent.clear();
    // De sleutels zelf blijven staan, want summary() moet ook op een gestopte service iets kunnen tonen.
  }

  routes(): ServiceRoute[] {
    return [
      { method: "POST", path: KEYS_PATH, handler: (req) => this.createKey(req) },
      { method: "GET", path: KEYS_PATH, handler: (req) => this.listKeys(req) },
      // De router kent geen padparameters, dus de id knippen we er zelf af.
      { method: "DELETE", path: `${KEYS_PATH}/*`, handler: (req) => this.revokeKey(req) },
      { method: "POST", path: "/api/v1/verify", handler: (req) => this.verifyKey(req) },
    ];
  }

  async summary(): Promise<ServiceSummary> {
    let active = 0;
    let revoked = 0;
    let lastUsed: number | null = null;
    for (const key of this.keys.values()) {
      if (key.revokedAt === null) active++;
      else revoked++;
      if (key.lastUsedAt !== null && (lastUsed === null || key.lastUsedAt > lastUsed)) lastUsed = key.lastUsedAt;
    }
    return {
      records: active,
      detail: { Active: active, Revoked: revoked, "Last used": ago(lastUsed), Checks: this.checks },
    };
  }

  /**
   * Controleert een verzoek namens een andere service.
   *
   * Geeft bij een afwijzing het antwoord kant-en-klaar mee, zodat elke service
   * dezelfde statuscodes en meldingen teruggeeft en niemand per ongeluk een 200
   * met een foutmelding stuurt.
   */
  async check(req: ServiceRequest, scope?: string): Promise<AuthResult> {
    const presented = presentedKey(req);
    if (!presented) return this.deny("missing");

    const found = await this.resolve(presented);
    if (!found.ok) return this.deny(found.reason);
    if (scope !== undefined && !grants(found.key.scopes, scope)) return this.deny("forbidden", scope);

    return {
      ok: true,
      key: { id: found.key.id, label: found.key.label, scopes: [...found.key.scopes] },
    };
  }

  private deny(reasonCode: AuthFailure, scope?: string): AuthResult {
    // Draait de sleuteldienst niet, dan laten we niets door: dicht is de enige veilige stand.
    if (reasonCode === "unavailable") {
      return { ok: false, reason: reasonCode, response: json(503, { error: "Key service is not running" }) };
    }
    if (reasonCode === "revoked") {
      return { ok: false, reason: reasonCode, response: json(403, { error: "This API key has been revoked" }) };
    }
    if (reasonCode === "forbidden") {
      const error = scope === undefined ? "This API key is not allowed here" : `This API key has no "${scope}" access`;
      return { ok: false, reason: reasonCode, response: json(403, { error }) };
    }
    const error = reasonCode === "missing" ? "Missing API key" : "Invalid API key";
    return {
      ok: false,
      reason: reasonCode,
      // Zonder deze header weet een client alleen dát het misging, niet hoe hij zich hoort te melden.
      response: json(401, { error }, { "www-authenticate": 'Bearer realm="server-manager"' }),
    };
  }

  private async resolve(
    presented: string,
  ): Promise<{ ok: true; key: StoredKey } | { ok: false; reason: AuthFailure }> {
    if (!this.loaded) return { ok: false, reason: "unavailable" };

    const parts = splitKey(presented);
    if (!parts) return { ok: false, reason: "malformed" };

    const record = this.keys.get(parts.id);
    // De id is openbaar -- hij staat in de lijst en reist mee in de sleutel -- dus dat deze
    // opzoeking niet tijdconstant is verraadt niets. Alleen het geheim moet dat wel zijn.
    if (!record) return { ok: false, reason: "unknown" };

    this.checks++;
    if (!(await this.secretMatches(record, parts.secret))) return { ok: false, reason: "unknown" };
    // Pas ná het geheim: wie "revoked" te horen krijgt op een gokje, weet dat de id bestaat.
    if (record.revokedAt !== null) return { ok: false, reason: "revoked" };

    record.lastUsedAt = Date.now();
    this.dirty = true;
    return { ok: true, key: record };
  }

  private async secretMatches(record: StoredKey, secret: string): Promise<boolean> {
    const digest = createHash("sha256").update(secret).digest();
    const cached = this.recent.get(record.id);
    if (cached && cached.until > Date.now() && sameBytes(cached.digest, digest)) return true;

    const derived = await derive(secret, Buffer.from(record.salt, "hex"));
    if (!sameBytes(derived, Buffer.from(record.hash, "hex"))) return false;

    this.recent.set(record.id, { digest, until: Date.now() + CACHE_MS });
    return true;
  }

  private async createKey(req: ServiceRequest): Promise<ServiceResponse> {
    if (!isLocal(req)) return json(403, { error: "Keys can only be created from this machine" });
    if (!this.loaded) return json(503, { error: "Key service is not running" });

    const body = asRecord(req.body);
    if (!body) return json(400, { error: "Expected a JSON object" });

    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > LABEL_MAX) {
      return json(400, { error: `Field "label" is required and may be up to ${LABEL_MAX} characters` });
    }
    const scopes = readScopes(body.scopes);
    if (!scopes) return json(400, { error: 'Field "scopes" must be a list of short lowercase names' });

    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const salt = randomBytes(SALT_BYTES);
    const record: StoredKey = {
      id: this.freshId(),
      label,
      scopes,
      salt: salt.toString("hex"),
      hash: (await derive(secret, salt)).toString("hex"),
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    };

    this.keys.set(record.id, record);
    try {
      await this.persist();
    } catch (error) {
      // Een sleutel die de gebruiker heeft opgeschreven maar na een herstart weg is,
      // is erger dan een eerlijke fout: dan zoekt hij straks in de verkeerde hoek.
      this.keys.delete(record.id);
      return json(500, { error: `Could not save the key: ${reason(error)}` });
    }

    this.log("info", `Issued key "${label}" (${record.id})`);
    return json(201, {
      id: record.id,
      // Het enige moment waarop het geheim bestaat buiten de client om; hierna kan niemand het meer opvragen.
      key: `${KEY_PREFIX}${record.id}.${secret}`,
      label,
      scopes,
      createdAt: record.createdAt,
    });
  }

  private async listKeys(req: ServiceRequest): Promise<ServiceResponse> {
    if (!isLocal(req)) return json(403, { error: "Keys can only be listed from this machine" });
    const keys = [...this.keys.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((key) => ({
        id: key.id,
        label: key.label,
        scopes: key.scopes,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt,
      }));
    return json(200, { keys, count: keys.length });
  }

  private async revokeKey(req: ServiceRequest): Promise<ServiceResponse> {
    if (!isLocal(req)) return json(403, { error: "Keys can only be revoked from this machine" });
    if (!this.loaded) return json(503, { error: "Key service is not running" });

    const id = req.path.slice(`${KEYS_PATH}/`.length);
    if (!ID_PATTERN.test(id)) return json(404, { error: "No such key" });

    const record = this.keys.get(id);
    if (!record) return json(404, { error: "No such key" });
    // Twee keer intrekken is geen fout; de sleutel is precies zo dood als gevraagd.
    if (record.revokedAt !== null) return json(200, { id, label: record.label, revokedAt: record.revokedAt });

    const revokedAt = Date.now();
    record.revokedAt = revokedAt;
    // Eerst uit de cache, anders blijft een zojuist gebruikte sleutel nog minuten werken.
    this.recent.delete(id);
    try {
      await this.persist();
    } catch (error) {
      record.revokedAt = null;
      return json(500, { error: `Could not revoke the key: ${reason(error)}` });
    }

    this.log("warn", `Revoked key "${record.label}" (${id})`);
    return json(200, { id, label: record.label, revokedAt });
  }

  private async verifyKey(req: ServiceRequest): Promise<ServiceResponse> {
    const body = asRecord(req.body);
    const presented = typeof body?.key === "string" ? body.key.trim() : "";
    if (!presented) return json(400, { error: 'Field "key" is required' });

    const found = await this.resolve(presented);
    // Bewust 200 met valid:false: de vraag "klopt deze sleutel" is beantwoord, ook als het antwoord nee is.
    if (!found.ok) return json(200, { valid: false, reason: found.reason });
    return json(200, { valid: true, id: found.key.id, label: found.key.label, scopes: found.key.scopes });
  }

  private freshId(): string {
    for (;;) {
      const id = randomBytes(ID_BYTES).toString("hex");
      if (!this.keys.has(id)) return id;
    }
  }

  /**
   * Leest het sleutelbestand.
   *
   * Gooit als het bestand er wel is maar niet te lezen valt. Dat is met opzet:
   * doorstarten met een lege lijst zou elke client buitensluiten én bij de
   * eerstvolgende wijziging het bestand overschrijven, en dan is er niets meer
   * terug te halen. Nu blijft het bestand onaangeraakt, zet de host de service
   * op 'error' en kan iemand ernaar kijken.
   */
  private async load(): Promise<void> {
    if (!existsSync(this.file)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      throw new Error(`${KEY_FILE} is unreadable (${reason(error)}); move it aside to start with no keys`);
    }

    const file = asRecord(parsed);
    const entries = file ? file.keys : null;
    if (!Array.isArray(entries)) {
      throw new Error(`${KEY_FILE} is not a key file; move it aside to start with no keys`);
    }

    // Eén onbruikbaar record is geen reden om alle andere sleutels te laten vallen.
    let broken = 0;
    const cutoff = Date.now() - TOMBSTONE_MS;
    for (const entry of entries) {
      const key = toStoredKey(entry);
      if (!key) {
        broken++;
        continue;
      }
      if (key.revokedAt !== null && key.revokedAt < cutoff) continue;
      this.keys.set(key.id, key);
    }
    if (broken > 0) this.log("warn", `Skipped ${broken} unreadable key ${broken === 1 ? "entry" : "entries"}`);
  }

  /**
   * Schrijft de sleutels weg via een tijdelijk bestand.
   *
   * Rechtstreeks over het bestand heen schrijven betekent dat een stroomstoring
   * halverwege alle sleutels kost. Nu is het bestand op elk moment óf de oude óf
   * de nieuwe versie.
   */
  private persist(): Promise<void> {
    if (!this.loaded) return Promise.resolve();

    const payload = JSON.stringify({ version: FILE_VERSION, keys: [...this.keys.values()] }, null, 2);
    this.dirty = false;
    const done = this.writing.then(() => this.write(payload));
    // De ketting mag nooit in een afgewezen staat blijven staan, anders lukt geen enkele schrijfactie meer.
    this.writing = done.catch(() => {
      this.dirty = true;
    });
    return done;
  }

  private async write(payload: string): Promise<void> {
    const temporary = `${this.file}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      this.log("error", `Could not save ${KEY_FILE}: ${reason(error)}`);
      throw error;
    }
  }
}

/**
 * Er is één sleutelbestand, dus één dienst die het beheert.
 *
 * Een tweede instantie zou hetzelfde bestand beschrijven en elkaars wijzigingen
 * overschrijven, dus die mogelijkheid bestaat hier niet: de host registreert
 * deze en andere services controleren hiertegen.
 */
const service = new AuthService();

export const authService: GameService = service;

/**
 * Controleert of een verzoek een geldige sleutel meebrengt.
 *
 * Bedoeld voor de host, zodat hij per service kan afdwingen dat er een sleutel
 * is zonder dat elke service zijn eigen versie van deze controle schrijft:
 *
 *     const auth = await authenticate(req, "lol-classic:write")
 *     if (!auth.ok) return auth.response
 *
 * Draait de sleuteldienst niet, dan is het antwoord 503 en niet "toegestaan" --
 * anders zou een service uitzetten neerkomen op de deur openzetten.
 */
export function authenticate(req: ServiceRequest, scope?: string): Promise<AuthResult> {
  return service.check(req, scope);
}

/** Zet een route achter een sleutel; de handler krijgt de beller erbij zodat hij kan loggen wie het was. */
export function requireKey(
  handler: (req: ServiceRequest, key: KeyIdentity) => Promise<ServiceResponse>,
  scope?: string,
): (req: ServiceRequest) => Promise<ServiceResponse> {
  return async (req) => {
    const auth = await authenticate(req, scope);
    return auth.ok ? handler(req, auth.key) : auth.response;
  };
}
