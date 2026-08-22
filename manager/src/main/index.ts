/**
 * Electron main-proces van de Server Manager: het venster, de IPC-brug en het
 * opstarten van de host.
 *
 * Dit bestand doet zelf geen HTTP, kent geen game en leest geen matchbestand. Het
 * zet de vier onderdelen naast elkaar -- logboek, registry, host, opslag -- en
 * maakt ze bereikbaar voor de UI. Alles wat inhoudelijk iets weet zit in de
 * modules eronder; wat hier staat is bediening en vertaling.
 *
 * De vertaling is er omdat de schermen andere woorden gebruiken dan de opslag:
 * de Data-weergave denkt in matches, de MatchBrowser in regels van een bestand.
 * Die vertaalslag hoort op één plek te staan, en dit is hem.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MANAGER_CHANNELS } from "../../shared/types";
import type { ManagerSnapshot, ServiceActionResult } from "../../shared/types";
import { Logbook } from "./logbook";
import { ServiceRegistry } from "./registry";
import { ServiceHost } from "./host";
import { MatchBrowser } from "./data/browser";
import { createLolClassicService, watchDatabase } from "./services/lolClassic";
import { authService } from "./services/auth";
import type { BrowseQuery, SortKey } from "./data/browser";
import type { HttpMethod, ServiceRequest } from "./services/types";
import { defaultStorePath } from "../../../src/core/services/matchStore";
import type { StoredMatch } from "../../../src/core/services/matchStore";
// Alleen types: deze import verdwijnt bij het bouwen en sleept de preload (die
// contextBridge aanroept) dus niet het main-proces in.
import type {
  ApiKeyInfo,
  ChampionRef,
  DataColumn,
  DataDeleteRequest,
  DataMutationResult,
  DataPage,
  DataQueryRequest,
  DataUpdateRequest,
  IntegrityIssue,
  IntegrityReport,
  IssuedApiKey,
  ManagerSettings,
  MatchEdit,
  MatchIntegrityReport,
  MatchPage,
  MatchQuery,
  MatchSortKey,
  MutationResult,
  RepairResult,
  SettingsMutationResult,
  StorageUsage,
} from "../preload/index";

/**
 * De kanalen die niet in MANAGER_CHANNELS staan; zie dezelfde lijst in de
 * preload. Beide moeten dezelfde tekst bevatten -- main en preload kunnen elkaar
 * niet importeren, dus dit is de prijs.
 */
const EXTRA_CHANNELS = {
  setAutoStart: "manager:setAutoStart",
  hostStart: "host:start",
  hostStop: "host:stop",
  hostSetPort: "host:setPort",

  dataQuery: "data:query",
  dataUpdate: "data:update",
  dataDelete: "data:delete",
  dataIntegrity: "data:integrity",
  dataRepair: "data:repair",

  authCreateKey: "auth:createKey",
  authListKeys: "auth:listKeys",
  authRevokeKey: "auth:revokeKey",

  listMatches: "data:listMatches",
  updateMatch: "data:updateMatch",
  deleteMatches: "data:deleteMatches",
  inspectData: "data:inspect",
  repairMatches: "data:repairMatches",
  listChampions: "data:champions",

  getSettings: "settings:get",
  setDataRoot: "settings:setDataRoot",
  chooseDataRoot: "settings:chooseDataRoot",
  storageUsage: "settings:storage",
  createApiKey: "auth:createApiKey",
  revokeApiKey: "auth:revokeApiKey",
} as const;

/** Wat er tussen sessies bewaard blijft. De autostart per service doet de registry zelf. */
interface StoredSettings {
  port: number;
  /** Gaat de host meteen luisteren als de app opengaat? */
  hostAutoStart: boolean;
  /** Null betekent: de standaardmap onder userData. */
  dataRoot: string | null;
}

const DEFAULTS: StoredSettings = { port: 8080, hostAutoStart: true, dataRoot: null };

let settings: StoredSettings = { ...DEFAULTS };
let logbook: Logbook | null = null;
let registry: ServiceRegistry | null = null;
let host: ServiceHost | null = null;
let mainWindow: BrowserWindow | null = null;
let ticker: NodeJS.Timeout | null = null;

/**
 * Eén MatchBrowser per service, want hij houdt een index van het bestand bij.
 * Elke keer opnieuw openen zou betekenen dat elke pagina het hele bestand
 * doorleest.
 *
 * De belofte staat in de map en niet de browser zelf: de Data-weergave vraagt bij
 * het openen drie dingen tegelijk (rijen, integriteit, kampioenen). Wie pas na
 * load() opbergt, bouwt er dan drie -- drie keer het bestand indexeren, en erger:
 * drie instanties die elk denken de enige schrijver te zijn.
 *
 * Twee bladeraars op hetzelfde bestand zouden elkaars herschrijving niet meer
 * kwijtraken -- het slot in data/writeQueue.ts geldt per bestandspad en niet per
 * instantie -- maar drie keer indexeren blijft zonde, dus deze map blijft staan.
 */
const browsers = new Map<string, Promise<MatchBrowser>>();

/**
 * Electron leidt de map voor gebruikersdata af uit de naam in package.json, en
 * die is van AllMid. Zonder deze twee regels delen de twee apps hun
 * instellingen en hun opslag.
 */
app.setName("Server Manager");
app.setPath("userData", join(app.getPath("appData"), "server-manager"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function dataRoot(): string {
  return settings.dataRoot ?? join(app.getPath("userData"), "data");
}

/* ------------------------------------------------------------------ *
 * Instellingen                                                        *
 * ------------------------------------------------------------------ */

function settingsFile(): string {
  return join(app.getPath("userData"), "settings.json");
}

async function readSettings(): Promise<StoredSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsFile(), "utf8"));
    if (!isRecord(parsed)) return { ...DEFAULTS };
    const port = typeof parsed.port === "number" && isValidPort(parsed.port) ? parsed.port : DEFAULTS.port;
    return {
      port,
      hostAutoStart: typeof parsed.hostAutoStart === "boolean" ? parsed.hostAutoStart : true,
      dataRoot: typeof parsed.dataRoot === "string" && parsed.dataRoot ? parsed.dataRoot : null,
    };
  } catch {
    // Eerste start, of een bestand dat iemand kapot heeft bewerkt: begin opnieuw.
    return { ...DEFAULTS };
  }
}

async function saveSettings(): Promise<void> {
  try {
    await writeFile(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (error) {
    logbook?.append(null, "error", `Could not save settings: ${reason(error)}`);
  }
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function currentSettings(): ManagerSettings {
  return { port: settings.port, dataRoot: dataRoot(), autoStart: settings.hostAutoStart };
}

/* ------------------------------------------------------------------ *
 * Momentopname                                                        *
 * ------------------------------------------------------------------ */

function snapshot(): ManagerSnapshot {
  const info = host?.info() ?? {
    port: settings.port,
    listening: false,
    uptimeSeconds: 0,
    totalRequests: 0,
    error: null,
  };
  return {
    // Een gestopte host meldt poort 0; de UI moet de ingestelde poort tonen,
    // anders lijkt de instelling verdwenen zodra je hem uitzet.
    host: { ...info, port: info.listening ? info.port : settings.port },
    services: registry?.snapshot() ?? [],
    logs: logbook?.recent() ?? [],
    dataRoot: dataRoot(),
  };
}

function pushSnapshot(): void {
  const target = mainWindow;
  if (!target || target.isDestroyed()) return;
  target.webContents.send(MANAGER_CHANNELS.snapshot, snapshot());
}

/* ------------------------------------------------------------------ *
 * Opslag: de brug tussen matches en regels in een bestand             *
 * ------------------------------------------------------------------ */

/**
 * De MatchBrowser van een service, aangemaakt bij het eerste gebruik.
 *
 * `refresh()` bij elke aanroep: de service schrijft er ondertussen doorheen, dus
 * zonder dat zou de UI de uploads van het laatste kwartier missen.
 */
async function browserFor(serviceId: string): Promise<MatchBrowser> {
  const existing = browsers.get(serviceId);
  if (existing) {
    const browser = await existing;
    await browser.refresh();
    return browser;
  }
  const root = registry?.dataRootFor(serviceId);
  if (!root) throw new Error(`Unknown service "${serviceId}".`);
  const opening = (async () => {
    const browser = new MatchBrowser(defaultStorePath(root), (level, message) =>
      logbook?.append(serviceId, level, message),
    );
    // Zodat de draaiende service hoort wat de Data-weergave in zijn bestand
    // verandert: zonder dit blijft een verwijderde game in het geheugen van de
    // service bestaan, telt hij mee in /api/v1/stats en wordt hij bij een nieuwe
    // upload als duplicaat geweigerd. Aanmelden vóór load(), zodat er tussen het
    // indexeren en het abonneren geen wijziging doorheen kan glippen.
    //
    // Eén keer aanmelden is genoeg: de service-instantie wordt bij bootstrap
    // geregistreerd en overleeft start/stop, en absorb() doet niets zolang hij
    // stilstaat. De opzegfunctie negeren we bewust -- bladeraar en service leven
    // allebei zolang de app draait.
    watchDatabase(registry?.get(serviceId) ?? null, browser);
    await browser.load();
    return browser;
  })();
  // Meteen opbergen, nog vóór het inlezen klaar is: een tweede vraag die
  // ondertussen binnenkomt wacht dan op dezelfde browser.
  browsers.set(serviceId, opening);
  try {
    return await opening;
  } catch (error) {
    // Een mislukte poging niet laten staan, anders blijft elke volgende vraag
    // dezelfde fout krijgen terwijl het bestand allang weer leesbaar is.
    browsers.delete(serviceId);
    throw error;
  }
}

/**
 * De index kent geen sortering op wachtrij. gameId is het dichtstbijzijnde
 * alternatief dat wél stabiel is: hij loopt gelijk op met de tijd.
 */
const MATCH_SORT: Record<MatchSortKey, SortKey> = {
  createdAt: "date",
  duration: "duration",
  patch: "patch",
  queueId: "gameId",
};

function toBrowseQuery(query: MatchQuery): BrowseQuery {
  return {
    filter: {
      champion: query.championId ?? undefined,
      position: query.position ?? undefined,
      patch: query.patch ?? undefined,
      from: query.from ?? undefined,
      // De UI levert een exclusieve bovengrens, de index werkt inclusief.
      to: query.to === null ? undefined : query.to - 1,
      status: "valid",
    },
    sort: MATCH_SORT[query.sort] ?? "date",
    order: query.direction,
    offset: query.offset,
    limit: query.limit,
  };
}

async function listMatches(query: MatchQuery): Promise<MatchPage> {
  const browser = await browserFor(query.serviceId);
  const page = await browser.browse(toBrowseQuery(query));
  const rows: StoredMatch[] = [];
  for (const record of page.records) {
    if (record.match) rows.push(record.match);
  }
  return { rows, total: page.total, offset: page.offset, limit: page.limit };
}

/** Past de bewerkte velden toe op het record dat er staat; de rest blijft zoals het was. */
function applyEdit(match: StoredMatch, edit: MatchEdit): StoredMatch {
  const positions = edit.positions;
  return {
    ...match,
    createdAt: edit.createdAt ?? match.createdAt,
    duration: edit.duration ?? match.duration,
    queueId: edit.queueId ?? match.queueId,
    patch: edit.patch ?? match.patch,
    players: positions
      ? match.players.map((player) => ({
          ...player,
          position: positions[player.puuid] ?? player.position,
        }))
      : match.players,
  };
}

async function updateMatch(
  serviceId: string,
  gameId: number,
  edit: MatchEdit,
): Promise<MutationResult> {
  const browser = await browserFor(serviceId);
  const record = await browser.get(gameId);
  if (!record?.match) return { ok: false, message: `No match with id ${gameId} in this database.` };
  const result = await browser.update(gameId, applyEdit(record.match, edit));
  if (result.replaced === 0) return { ok: false, message: `Match ${gameId} was not written.` };
  return { ok: true, message: `Updated match ${gameId}.` };
}

async function deleteMatches(serviceId: string, gameIds: number[]): Promise<MutationResult> {
  if (gameIds.length === 0) return { ok: false, message: "Nothing selected." };
  const browser = await browserFor(serviceId);
  const result = await browser.removeMany(gameIds);
  return {
    ok: result.removed > 0,
    message:
      result.removed === 0
        ? "None of those matches are in the database."
        : `Removed ${result.removed} of ${gameIds.length} matches.`,
  };
}

async function inspectData(serviceId: string): Promise<MatchIntegrityReport> {
  const browser = await browserFor(serviceId);
  const report = await browser.verify();
  return {
    records: report.valid + report.suspect,
    broken: report.invalid,
    duplicates: report.duplicates,
    // 'suspect' is precies dat: leesbaar JSON dat niet de vorm van een match heeft.
    incomplete: report.suspect,
    fileBytes: report.bytes,
    checkedAt: Date.now(),
  };
}

/** De reden komt als losse zin uit de opslag; hieruit valt af te leiden in welke hoop hij hoort. */
function classify(text: string): "duplicates" | "broken" | "incomplete" {
  if (/superseded|duplicate/i.test(text)) return "duplicates";
  if (/blank|json|parse|object|game id/i.test(text)) return "broken";
  return "incomplete";
}

async function repairData(serviceId: string, apply: boolean): Promise<RepairResult> {
  const browser = await browserFor(serviceId);
  const report = await browser.repair({ dryRun: !apply, dropSuspect: true });
  const counts = { duplicates: 0, broken: 0, incomplete: 0 };
  for (const line of report.details) counts[classify(line.reason)]++;
  return {
    plan: {
      removeBroken: counts.broken,
      removeDuplicates: counts.duplicates,
      removeIncomplete: counts.incomplete,
      keepRecords: report.kept,
      bytesBefore: report.bytesBefore,
      bytesAfter: report.bytesAfter,
    },
    applied: !report.dryRun,
    message: report.dryRun
      ? `${report.removed} records would be removed, ${report.kept} kept.`
      : `Removed ${report.removed} records; ${report.kept} kept.` +
        (report.quarantinePath ? ` The removed lines are in ${report.quarantinePath}.` : ""),
  };
}

/**
 * De kampioenen die in deze database voorkomen.
 *
 * Namen horen bij de client, niet bij de server: die kent alleen nummers. De UI
 * krijgt het nummer dus als naam terug en kan er zelf iets moois van maken zodra
 * er een catalogus is.
 */
async function listChampions(serviceId: string): Promise<ChampionRef[]> {
  const browser = await browserFor(serviceId);
  const facets = await browser.facets();
  return facets.champions.map((id) => ({ id, name: `Champion ${id}` }));
}

/* ------------------------------------------------------------------ *
 * Het algemene datakanaal                                             *
 * ------------------------------------------------------------------ */

const MATCH_COLUMNS: DataColumn[] = [
  { key: "gameId", label: "Game", type: "number", editable: false },
  { key: "createdAt", label: "Played", type: "time", editable: true },
  { key: "duration", label: "Duration", type: "number", editable: true },
  { key: "queueId", label: "Queue", type: "number", editable: true },
  { key: "patch", label: "Patch", type: "text", editable: true },
  { key: "players", label: "Players", type: "number", editable: false },
];

async function dataQuery(request: DataQueryRequest): Promise<DataPage> {
  const limit = request.limit ?? 100;
  const offset = request.offset ?? 0;
  try {
    const browser = await browserFor(request.serviceId);
    // Eén zoekveld voor twee soorten waarden: een getal is een game-id, de rest
    // is een patch. Meer dan dat kan de index niet doorzoeken.
    const search = request.search?.trim() ?? "";
    const gameId = /^\d+$/.test(search) ? Number(search) : undefined;
    const page = await browser.browse({
      filter: { status: "valid", gameId, patch: gameId ? undefined : search || undefined },
      sort: "date",
      order: request.direction ?? "desc",
      offset,
      limit,
    });
    return {
      serviceId: request.serviceId,
      collection: "matches",
      collections: ["matches"],
      columns: MATCH_COLUMNS,
      rows: page.records.flatMap((record) =>
        record.match
          ? [
              {
                id: String(record.match.gameId),
                values: {
                  gameId: record.match.gameId,
                  createdAt: record.match.createdAt,
                  duration: record.match.duration,
                  queueId: record.match.queueId,
                  patch: record.match.patch,
                  players: record.match.players.length,
                },
              },
            ]
          : [],
      ),
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      error: null,
    };
  } catch (error) {
    return {
      serviceId: request.serviceId,
      collection: request.collection ?? "matches",
      collections: [],
      columns: [],
      rows: [],
      total: 0,
      offset,
      limit,
      error: reason(error),
    };
  }
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function dataUpdate(request: DataUpdateRequest): Promise<DataMutationResult> {
  const gameId = Number(request.id);
  if (!Number.isFinite(gameId)) return { ok: false, message: "That row has no game id.", affected: 0 };
  const values = request.values;
  const result = await updateMatch(request.serviceId, gameId, {
    createdAt: number(values.createdAt),
    duration: number(values.duration),
    queueId: number(values.queueId),
    patch: typeof values.patch === "string" ? values.patch : undefined,
  });
  return { ok: result.ok, message: result.message, affected: result.ok ? 1 : 0 };
}

async function dataDelete(request: DataDeleteRequest): Promise<DataMutationResult> {
  const ids = request.ids.map(Number).filter((id) => Number.isFinite(id));
  const result = await deleteMatches(request.serviceId, ids);
  return { ok: result.ok, message: result.message, affected: result.ok ? ids.length : 0 };
}

/**
 * De controle in de algemene vorm: per soort probleem één regel met een aantal.
 *
 * De aantallen komen uit de samenvatting en niet uit de lijst met voorbeelden --
 * die is afgekapt, en een afgekapte lijst tellen levert een te rooskleurig beeld.
 */
function toIntegrityReport(
  serviceId: string,
  report: Awaited<ReturnType<MatchBrowser["verify"]>>,
  repaired: number,
): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  const add = (
    id: string,
    severity: IntegrityIssue["severity"],
    message: string,
    count: number,
  ): void => {
    if (count > 0) issues.push({ id, collection: "matches", severity, message, repairable: true, count });
  };
  add("unreadable", "error", "Lines that are not valid JSON", report.invalid);
  add("duplicate", "error", "Records repeating a game id that came earlier", report.duplicates);
  add("malformed", "warning", "Records that are not shaped like a match", report.suspect);
  add("unterminated", "warning", "The last line is missing its newline", report.unterminatedTail ? 1 : 0);
  return {
    serviceId,
    checkedAt: Date.now(),
    records: report.valid,
    issues,
    repaired,
    ok: issues.length === 0,
    message:
      issues.length === 0
        ? `${report.valid} records, nothing wrong.`
        : `${issues.length} kinds of problem across ${report.lines} lines.`,
  };
}

/* ------------------------------------------------------------------ *
 * Sleutels                                                            *
 * ------------------------------------------------------------------ */

/**
 * De sleuteldienst bedienen via zijn eigen routes.
 *
 * Hij biedt geen aparte functies aan het main-proces aan, en dat is maar goed
 * ook: nu loopt de UI langs precies dezelfde controles als een client, inclusief
 * de eis dat het verzoek van deze machine zelf komt.
 */
async function callAuth(method: HttpMethod, path: string, body: unknown): Promise<unknown> {
  const route = authService
    .routes()
    .find(
      (candidate) =>
        candidate.method === method &&
        (candidate.path.endsWith("/*")
          ? path.startsWith(candidate.path.slice(0, -1))
          : candidate.path === path),
    );
  if (!route) throw new Error(`The key service has no ${method} ${path}.`);

  const request: ServiceRequest = {
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    body,
    // Loopback zonder proxy-headers: dat is precies wat de sleuteldienst als
    // 'van deze machine' accepteert.
    ip: "127.0.0.1",
  };
  const response = await route.handler(request);
  if (response.status >= 400) {
    const message = isRecord(response.body) && typeof response.body.error === "string"
      ? response.body.error
      : `The key service answered ${response.status}.`;
    throw new Error(message);
  }
  return response.body;
}

/** De id staat vooraan in de sleutel, dus dat is het stukje waaraan je hem herkent. */
const keyPrefix = (id: string): string => `gsk_${id}`;

function toKeyInfo(value: unknown): ApiKeyInfo | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    label: typeof value.label === "string" ? value.label : "",
    prefix: keyPrefix(value.id),
    scopes: Array.isArray(value.scopes) ? value.scopes.filter((s): s is string => typeof s === "string") : [],
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    lastUsedAt: typeof value.lastUsedAt === "number" ? value.lastUsedAt : null,
    revokedAt: typeof value.revokedAt === "number" ? value.revokedAt : null,
  };
}

async function listKeys(): Promise<ApiKeyInfo[]> {
  const body = await callAuth("GET", "/api/v1/keys", null);
  const raw = isRecord(body) && Array.isArray(body.keys) ? body.keys : [];
  return raw.flatMap((entry) => {
    const key = toKeyInfo(entry);
    return key ? [key] : [];
  });
}

async function createKey(label: string, scopes: string[]): Promise<IssuedApiKey> {
  const body = await callAuth("POST", "/api/v1/keys", { label, scopes });
  const key = toKeyInfo(body);
  if (!key || !isRecord(body) || typeof body.key !== "string") {
    throw new Error("The key service returned something unreadable.");
  }
  return { key, secret: body.key };
}

async function revokeKey(id: string): Promise<SettingsMutationResult> {
  await callAuth("DELETE", `/api/v1/keys/${id}`, null);
  return { ok: true, message: "The key can no longer be used." };
}

/* ------------------------------------------------------------------ *
 * Schijfgebruik                                                       *
 * ------------------------------------------------------------------ */

/** Alles bij elkaar wat een service heeft weggeschreven, inclusief onderliggende mappen. */
async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    // Een service die nog nooit gedraaid heeft, heeft nog geen map.
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else {
      try {
        total += (await stat(child)).size;
      } catch {
        // Bestand verdween tussen readdir en stat: dan telt het ook niet mee.
      }
    }
  }
  return total;
}

async function storageUsage(): Promise<StorageUsage[]> {
  const services = registry?.snapshot() ?? [];
  return Promise.all(
    services.map(async (service) => {
      const path = registry?.dataRootFor(service.id) ?? join(dataRoot(), service.id);
      return {
        serviceId: service.id,
        name: service.name,
        path,
        bytes: await directoryBytes(path),
        records: service.summary?.records ?? 0,
      };
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Venster                                                             *
 * ------------------------------------------------------------------ */

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: "#07080a",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Externe links openen in de browser, niet in de app zelf.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

/* ------------------------------------------------------------------ *
 * IPC                                                                 *
 * ------------------------------------------------------------------ */

const NO_HOST = "The host is still starting.";

function registerIpc(): void {
  ipcMain.handle(MANAGER_CHANNELS.snapshot, () => snapshot());

  ipcMain.handle(MANAGER_CHANNELS.start, async (_event, id: string) => run(id, "start"));
  ipcMain.handle(MANAGER_CHANNELS.stop, async (_event, id: string) => run(id, "stop"));
  ipcMain.handle(MANAGER_CHANNELS.restart, async (_event, id: string) => run(id, "restart"));
  // Pauze raakt de service zelf niet: hij blijft gestart met zijn opslag in het
  // geheugen, alleen de host antwoordt 503 op zijn paden.
  ipcMain.handle(MANAGER_CHANNELS.pause, async (_event, id: string) => run(id, "pause"));
  ipcMain.handle(MANAGER_CHANNELS.resume, async (_event, id: string) => run(id, "resume"));

  /**
   * Twee betekenissen, twee soorten eerste argument: een service-id zet het
   * meestarten van die service om (dat bewaart de registry), een boolean dat van
   * de host zelf (dat bewaren wij).
   */
  ipcMain.handle(
    EXTRA_CHANNELS.setAutoStart,
    async (_event, target: string | boolean, enabled: boolean) => {
      if (typeof target === "boolean") {
        settings.hostAutoStart = target;
        await saveSettings();
      } else {
        await registry?.setAutoStart(target, enabled);
      }
      pushSnapshot();
      return currentSettings();
    },
  );

  ipcMain.handle(EXTRA_CHANNELS.hostStart, async () => {
    await startHost(settings.port);
    return snapshot();
  });
  ipcMain.handle(EXTRA_CHANNELS.hostStop, async () => {
    await host?.stop();
    pushSnapshot();
    return snapshot();
  });

  // Twee namen voor dezelfde handeling: shared/types.ts kent hem als
  // manager:setPort, de schermen spreken van host:setPort.
  const setPort = async (_event: unknown, port: number): Promise<ManagerSnapshot> => {
    if (!isValidPort(port)) {
      logbook?.append(null, "warn", `Port ${port} is not a usable port number.`);
      return snapshot();
    }
    settings.port = port;
    await saveSettings();
    // Alleen opnieuw gaan luisteren als hij al luisterde; anders zou de knop
    // "poort opslaan" ook de host aanzetten, en dat vroeg niemand.
    if (host?.isListening) await startHost(port);
    pushSnapshot();
    return snapshot();
  };
  ipcMain.handle(MANAGER_CHANNELS.setPort, setPort);
  ipcMain.handle(EXTRA_CHANNELS.hostSetPort, setPort);

  ipcMain.handle(EXTRA_CHANNELS.dataQuery, (_event, request: DataQueryRequest) => dataQuery(request));
  ipcMain.handle(EXTRA_CHANNELS.dataUpdate, (_event, request: DataUpdateRequest) => dataUpdate(request));
  ipcMain.handle(EXTRA_CHANNELS.dataDelete, (_event, request: DataDeleteRequest) => dataDelete(request));
  ipcMain.handle(EXTRA_CHANNELS.dataIntegrity, async (_event, serviceId: string) => {
    const browser = await browserFor(serviceId);
    return toIntegrityReport(serviceId, await browser.verify(), 0);
  });
  ipcMain.handle(EXTRA_CHANNELS.dataRepair, async (_event, serviceId: string) => {
    const browser = await browserFor(serviceId);
    const repair = await browser.repair({ dropSuspect: true });
    const report = toIntegrityReport(serviceId, await browser.verify(), repair.removed);
    pushSnapshot();
    return report;
  });

  ipcMain.handle(EXTRA_CHANNELS.listMatches, (_event, query: MatchQuery) => listMatches(query));
  ipcMain.handle(
    EXTRA_CHANNELS.updateMatch,
    (_event, serviceId: string, gameId: number, edit: MatchEdit) =>
      updateMatch(serviceId, gameId, edit),
  );
  ipcMain.handle(EXTRA_CHANNELS.deleteMatches, async (_event, serviceId: string, gameIds: number[]) => {
    const result = await deleteMatches(serviceId, gameIds);
    pushSnapshot();
    return result;
  });
  ipcMain.handle(EXTRA_CHANNELS.inspectData, (_event, serviceId: string) => inspectData(serviceId));
  ipcMain.handle(EXTRA_CHANNELS.repairMatches, async (_event, serviceId: string, apply: boolean) => {
    const result = await repairData(serviceId, apply);
    if (apply) pushSnapshot();
    return result;
  });
  ipcMain.handle(EXTRA_CHANNELS.listChampions, (_event, serviceId: string) => listChampions(serviceId));

  ipcMain.handle(EXTRA_CHANNELS.authListKeys, () => listKeys());
  ipcMain.handle(EXTRA_CHANNELS.authCreateKey, (_event, label: string, scopes: string[]) =>
    createKey(label, scopes),
  );
  ipcMain.handle(EXTRA_CHANNELS.createApiKey, (_event, label: string, scopes: string[]) =>
    createKey(label, scopes),
  );
  ipcMain.handle(EXTRA_CHANNELS.authRevokeKey, (_event, id: string) => revokeKey(id));
  ipcMain.handle(EXTRA_CHANNELS.revokeApiKey, (_event, id: string) => revokeKey(id));

  ipcMain.handle(EXTRA_CHANNELS.getSettings, () => currentSettings());
  ipcMain.handle(EXTRA_CHANNELS.setDataRoot, async (_event, path: string) => {
    settings.dataRoot = path.trim() || null;
    await saveSettings();
    // De registry heeft zijn mappen al uitgedeeld en services hebben bestanden
    // open; verhuizen tijdens bedrijf zou data achterlaten waar niemand hem zoekt.
    logbook?.append(null, "warn", "The data folder changes when the manager restarts.");
    pushSnapshot();
    return currentSettings();
  });
  ipcMain.handle(EXTRA_CHANNELS.chooseDataRoot, async () => {
    const target = mainWindow;
    if (!target) return null;
    const result = await dialog.showOpenDialog(target, {
      title: "Choose the data folder",
      defaultPath: dataRoot(),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(EXTRA_CHANNELS.storageUsage, () => storageUsage());

  ipcMain.handle(MANAGER_CHANNELS.openDataFolder, async (_event, serviceId: string | null) => {
    // Een service die nog nooit gedraaid heeft, heeft nog geen map; dan zou de
    // verkenner niets doen en lijkt de knop stuk.
    const folder = serviceId ? (registry?.dataRootFor(serviceId) ?? join(dataRoot(), serviceId)) : dataRoot();
    await mkdir(folder, { recursive: true });
    await shell.openPath(folder);
  });

  ipcMain.on(MANAGER_CHANNELS.minimize, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.minimize(),
  );
  ipcMain.on(MANAGER_CHANNELS.maximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on(MANAGER_CHANNELS.close, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.close(),
  );
}

/**
 * Eén doorgeefluik voor alle vijf de opdrachten.
 *
 * De registry bewaakt zelf welke overgang mag en geeft een nette weigering terug;
 * hier staat alleen de vertaling van naam naar methode plus de momentopname
 * achteraf. Die laatste is strikt genomen dubbelop -- setStatus roept onChange al
 * aan -- maar pause/resume kunnen ook afwijzen zonder de status te raken, en dan
 * is dit de enige duw die de UI krijgt.
 */
async function run(
  id: string,
  action: "start" | "stop" | "restart" | "pause" | "resume",
): Promise<ServiceActionResult> {
  if (!registry) return { ok: false, message: NO_HOST, service: null };
  const services = registry;
  const result = await (action === "start"
    ? services.start(id)
    : action === "stop"
      ? services.stop(id)
      : action === "restart"
        ? services.restart(id)
        : action === "pause"
          ? services.pause(id)
          : services.resume(id));
  pushSnapshot();
  return result;
}

/** Gaat luisteren en houdt een mislukking bij de host zelf; de app blijft staan. */
async function startHost(port: number): Promise<void> {
  try {
    await host?.start(port);
  } catch (error) {
    logbook?.append(null, "error", `Could not listen on port ${port}: ${reason(error)}`);
  }
  pushSnapshot();
}

/* ------------------------------------------------------------------ *
 * Opstarten en afsluiten                                              *
 * ------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  settings = await readSettings();
  const root = dataRoot();
  await mkdir(root, { recursive: true });

  const book = new Logbook();
  logbook = book;
  registry = new ServiceRegistry({
    dataRoot: root,
    channel: (serviceId) => book.channel(serviceId),
    onChange: pushSnapshot,
    // De host telt per basePath mee; zo staat die teller in dezelfde ServiceInfo
    // als de rest en hoeft de UI niets bij elkaar te zoeken.
    requestsFor: (serviceId) => host?.requestsFor(serviceId) ?? 0,
  });
  host = new ServiceHost({
    log: (level, message, serviceId) => void book.append(serviceId, level, message),
  });

  // De sleuteldienst hoort bij de manager zelf, de rest zijn games. Beide zijn
  // gewone services: ze hangen onder hun eigen basePath en zijn los te stoppen.
  registry.register(createLolClassicService());
  registry.register(authService);

  // Mounten gebeurt één keer, ongeacht status: de host antwoordt zelf met 503
  // zolang een service niet draait, zodat een client 'even niet' van 'bestaat
  // niet' kan onderscheiden.
  const current = registry;
  for (const service of current.all()) {
    host.mount(service, () => current.statusOf(service.id));
  }

  await current.load();
  if (settings.hostAutoStart) await startHost(settings.port);
  await current.startAutoStart();
  pushSnapshot();

  /**
   * Looptijd, verzoekenteller en de cijfers van een service veranderen zonder
   * dat er iets gebeurt waar een gebeurtenis bij hoort. Eén keer per seconde de
   * stand opmaken is goedkoop -- alles staat in het geheugen -- en houdt de
   * statusbalk eerlijk.
   */
  ticker = setInterval(() => {
    // Een service die zijn cijfers niet kan geven mag de statusbalk niet laten
    // bevriezen; de registry meldt zoiets zelf in het logboek.
    void current.refreshSummaries().catch(() => undefined).finally(pushSnapshot);
  }, 1000);
}

void app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  // Na het venster: zo staat er meteen iets op het scherm terwijl de services
  // hun bestanden inlezen.
  await bootstrap();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** Wat een nette afsluiting hoogstens mag duren; daarna gaat de app alsnog dicht. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

let shuttingDown = false;

/**
 * Afsluiten met het opruimen erbij.
 *
 * Het opruimen alleen starten is niet genoeg: Electron sluit het proces dan
 * terwijl een service zijn laatste regels nog wegschrijft. Daarom houden we het
 * afsluiten één keer tegen, ruimen we op, en gaan we daarna zelf dicht -- met een
 * wachttijd eromheen, want een service die blijft hangen mag de app niet gijzelen.
 */
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void shutdown().finally(() => app.exit(0));
});

async function shutdown(): Promise<void> {
  if (ticker) clearInterval(ticker);
  ticker = null;

  // Services krijgen de kans hun bestanden af te ronden; de host laat lopende
  // verzoeken uitspreken. Een fout hier is geen reden om te blijven staan: we
  // zijn toch al aan het afsluiten.
  const closing = Promise.all([
    registry?.stopAll(),
    host?.stop(),
    ...[...browsers.values()].map((opening) =>
      opening.then((browser) => browser.close()).catch(() => undefined),
    ),
  ]).catch(() => undefined);

  await Promise.race([closing, delay(SHUTDOWN_TIMEOUT_MS)]);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * Een bezette poort of een client die halverwege wegloopt is dagelijkse kost
 * voor een server; daar hoort geen foutmelding over het scherm voor te komen.
 * Alles wat hier wél doorheen komt is een echte fout en verbergen we niet.
 */
const EXPECTED_ERRORS = /EADDRINUSE|ECONNRESET|EPIPE|ECONNABORTED|socket hang up/i;

function handleFatal(scope: string, error: unknown): void {
  const message = reason(error);
  if (EXPECTED_ERRORS.test(message)) {
    logbook?.append(null, "warn", `${scope}: ${message}`);
    return;
  }
  console.error(`[manager] ${scope}:`, error);
  dialog.showErrorBox("Server Manager", `Something went wrong (${scope}):\n\n${message}`);
}

process.on("uncaughtException", (error) => handleFatal("uncaughtException", error));
process.on("unhandledRejection", (cause) => handleFatal("unhandledRejection", cause));
