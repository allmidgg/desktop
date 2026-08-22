/**
 * De enige brug tussen de UI en het main-proces.
 *
 * De renderer heeft geen Node-toegang; alles loopt via deze afgebakende lijst
 * functies. Dat houdt de aanvalsoppervlakte klein en maakt precies zichtbaar wat
 * de interface mag doen -- bij beheersoftware die sleutels uitdeelt en records
 * weggooit is dat geen luxe.
 *
 * De brug is groter dan de ManagerApi uit shared/types.ts. Dat bestand beschrijft
 * de kern (momentopname, services, poort, venster); alles daarnaast -- data
 * doorbladeren, integriteit, sleutels, instellingen -- staat hieronder en wordt
 * met een module-uitbreiding aan ManagerApi toegevoegd. Zo blijft er één type
 * waar `window.manager` op wijst en hoeft niemand te casten.
 */
import { contextBridge, ipcRenderer } from "electron";
import { MANAGER_CHANNELS } from "../../shared/types";
import type { ManagerSnapshot, ServiceActionResult } from "../../shared/types";

/**
 * De kanalen die niet in MANAGER_CHANNELS staan.
 *
 * Ze staan hier en in het main-proces letterlijk, want main en preload kunnen
 * elkaar niet importeren: dit bestand roept bij het laden contextBridge aan, en
 * dat bestaat in het main-proces niet. Wijzig je hier een naam, wijzig hem dan
 * ook in manager/src/main/index.ts.
 */
export const EXTRA_CHANNELS = {
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

  // Kanalen op maat van de schermen: dezelfde opslag, maar in de vorm waarin de
  // Data- en Settings-weergave hem toont.
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

/* ------------------------------------------------------------------ *
 * Algemeen databeheer                                                 *
 * ------------------------------------------------------------------ */

export type SortDirection = "asc" | "desc";

/** Eén bladzijde uit de opslag van een service opvragen. */
export interface DataQueryRequest {
  serviceId: string;
  /** Leeg laten voor de eerste collectie die de service kent. */
  collection?: string;
  search?: string;
  sort?: string;
  direction?: SortDirection;
  offset?: number;
  limit?: number;
}

export interface DataColumn {
  key: string;
  /** Komt letterlijk boven de kolom te staan: kort en Engels. */
  label: string;
  type: "text" | "number" | "boolean" | "time";
  /** Onbewerkbare kolommen (id's, afgeleide velden) toont de UI als vaste tekst. */
  editable: boolean;
}

export interface DataRow {
  /** Waarmee de rij aangewezen wordt bij bijwerken en verwijderen. */
  id: string;
  values: Record<string, string | number | boolean | null>;
}

export interface DataPage {
  serviceId: string;
  collection: string;
  /** Alle collecties van deze service, zodat de UI zijn keuzelijst kan vullen. */
  collections: string[];
  columns: DataColumn[];
  rows: DataRow[];
  /** Aantal rijen dat aan de zoekterm voldoet, niet het aantal op deze bladzijde. */
  total: number;
  offset: number;
  limit: number;
  /** Gevuld als de vraag niet beantwoord kon worden; de UI toont dit in plaats van een lege tabel. */
  error: string | null;
}

export interface DataUpdateRequest {
  serviceId: string;
  collection: string;
  id: string;
  /** Alleen de gewijzigde velden. */
  values: Record<string, string | number | boolean | null>;
}

export interface DataDeleteRequest {
  serviceId: string;
  collection: string;
  ids: string[];
}

/** Antwoord op schrijfacties. Nooit een uitzondering over IPC: de UI moet iets kunnen tonen. */
export interface DataMutationResult {
  ok: boolean;
  /** Engelse UI-tekst, ook als het goed ging. */
  message: string;
  affected: number;
}

export interface IntegrityIssue {
  id: string;
  collection: string;
  severity: "warning" | "error";
  message: string;
  /** Of `dataRepair` hier iets aan kan doen; zo niet, dan is het handwerk. */
  repairable: boolean;
  count: number;
}

export interface IntegrityReport {
  serviceId: string;
  checkedAt: number;
  records: number;
  issues: IntegrityIssue[];
  /** Aantal daadwerkelijk herstelde records; 0 bij een controle zonder reparatie. */
  repaired: number;
  ok: boolean;
  message: string;
}

/* ------------------------------------------------------------------ *
 * Matches, zoals de Data-weergave ze toont                            *
 * ------------------------------------------------------------------ */

export type MatchPosition = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "SUPPORT" | "UNKNOWN";

export interface StoredPlayerRecord {
  puuid: string;
  championId: number;
  teamId: number;
  position: MatchPosition;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  items: number[];
  spells: number[];
}

export interface StoredMatchRecord {
  gameId: number;
  createdAt: number;
  duration: number;
  queueId: number;
  patch: string;
  players: StoredPlayerRecord[];
}

export type MatchSortKey = "createdAt" | "duration" | "queueId" | "patch";

export interface MatchQuery {
  serviceId: string;
  championId: number | null;
  position: MatchPosition | null;
  patch: string | null;
  /** Epoch-ms, inclusief. */
  from: number | null;
  /** Epoch-ms, exclusief -- zo valt de gekozen einddag er compleet in. */
  to: number | null;
  sort: MatchSortKey;
  direction: SortDirection;
  offset: number;
  limit: number;
}

export interface MatchPage {
  rows: StoredMatchRecord[];
  total: number;
  offset: number;
  limit: number;
}

/** Alleen de velden die veranderen; wat ontbreekt blijft zoals het was. */
export interface MatchEdit {
  createdAt?: number;
  duration?: number;
  queueId?: number;
  patch?: string;
  /** puuid -> positie, alleen voor de spelers die je aanpast. */
  positions?: Record<string, MatchPosition>;
}

export interface MutationResult {
  ok: boolean;
  message: string;
}

export interface MatchIntegrityReport {
  records: number;
  /** Regels die geen geldige JSON zijn. */
  broken: number;
  /** Records met een gameId dat al eerder in het bestand stond. */
  duplicates: number;
  /** Records die niet de vorm van een match hebben; statistisch onbruikbaar. */
  incomplete: number;
  fileBytes: number;
  checkedAt: number;
}

export interface RepairPlan {
  removeBroken: number;
  removeDuplicates: number;
  removeIncomplete: number;
  keepRecords: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface RepairResult {
  plan: RepairPlan;
  /** False bij een proefronde: dan is er niets naar schijf geschreven. */
  applied: boolean;
  message: string;
}

export interface ChampionRef {
  id: number;
  name: string;
}

/* ------------------------------------------------------------------ *
 * Instellingen en sleutels                                            *
 * ------------------------------------------------------------------ */

export interface ManagerSettings {
  port: number;
  /** Bovenliggende map; elke service krijgt daaronder zijn eigen map. */
  dataRoot: string;
  /** Start de host meteen als de app opengaat, in plaats van na een klik. */
  autoStart: boolean;
}

export interface StorageUsage {
  serviceId: string;
  name: string;
  /** Volledig pad naar de map waarin deze service schrijft. */
  path: string;
  bytes: number;
  records: number;
}

export interface ApiKeyInfo {
  id: string;
  label: string;
  /** De eerste tekens van de sleutel, genoeg om hem te herkennen in een lijst. */
  prefix: string;
  scopes: string[];
  createdAt: number;
  /** Null zolang er nooit een verzoek mee gedaan is. */
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/**
 * Het geheim komt alleen hieruit.
 *
 * De host bewaart na het aanmaken alleen een hash, dus dit is het enige moment
 * waarop de volledige sleutel bestaat: de UI moet hem meteen laten kopiëren.
 */
export interface IssuedApiKey {
  key: ApiKeyInfo;
  secret: string;
}

export interface SettingsMutationResult {
  ok: boolean;
  message: string;
}

const api = {
  getSnapshot: (): Promise<ManagerSnapshot> => ipcRenderer.invoke(MANAGER_CHANNELS.snapshot),

  startService: (id: string): Promise<ServiceActionResult> =>
    ipcRenderer.invoke(MANAGER_CHANNELS.start, id),
  stopService: (id: string): Promise<ServiceActionResult> =>
    ipcRenderer.invoke(MANAGER_CHANNELS.stop, id),
  restartService: (id: string): Promise<ServiceActionResult> =>
    ipcRenderer.invoke(MANAGER_CHANNELS.restart, id),
  /**
   * Pauze en hervatten staan al in ManagerApi (shared/types.ts), dus de
   * module-uitbreiding onderaan hoeft ze niet nog eens te declareren -- ze horen
   * bij de kern, niet bij de aanbouw.
   *
   * Zonder deze twee regels blijven de knoppen in ServicesView uitgeschakeld: die
   * tast `typeof window.manager.pauseService === "function"` af, zodat een oudere
   * brug een dode knop oplevert in plaats van een uitzondering.
   */
  pauseService: (id: string): Promise<ServiceActionResult> =>
    ipcRenderer.invoke(MANAGER_CHANNELS.pause, id),
  resumeService: (id: string): Promise<ServiceActionResult> =>
    ipcRenderer.invoke(MANAGER_CHANNELS.resume, id),

  /**
   * Twee dingen onder één naam, omdat er twee schermen op zitten: een service-id
   * zet het meestarten van die service om, een enkele boolean dat van de host.
   */
  setAutoStart: (target: string | boolean, enabled?: boolean): Promise<ManagerSettings> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.setAutoStart, target, enabled ?? true),

  startHost: (): Promise<ManagerSnapshot> => ipcRenderer.invoke(EXTRA_CHANNELS.hostStart),
  stopHost: (): Promise<ManagerSnapshot> => ipcRenderer.invoke(EXTRA_CHANNELS.hostStop),
  /** Laat de host opnieuw luisteren op een andere poort; services blijven draaien. */
  setPort: (port: number): Promise<ManagerSnapshot> =>
    ipcRenderer.invoke(MANAGER_CHANNELS.setPort, port),

  dataQuery: (request: DataQueryRequest): Promise<DataPage> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.dataQuery, request),
  dataUpdate: (request: DataUpdateRequest): Promise<DataMutationResult> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.dataUpdate, request),
  dataDelete: (request: DataDeleteRequest): Promise<DataMutationResult> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.dataDelete, request),
  dataIntegrity: (serviceId: string): Promise<IntegrityReport> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.dataIntegrity, serviceId),
  /** Herstelt wat `repairable` is; zonder id's alles. */
  dataRepair: (serviceId: string, issueIds?: string[]): Promise<IntegrityReport> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.dataRepair, serviceId, issueIds ?? null),

  listMatches: (query: MatchQuery): Promise<MatchPage> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.listMatches, query),
  updateMatch: (serviceId: string, gameId: number, edit: MatchEdit): Promise<MutationResult> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.updateMatch, serviceId, gameId, edit),
  deleteMatches: (serviceId: string, gameIds: number[]): Promise<MutationResult> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.deleteMatches, serviceId, gameIds),
  inspectData: (serviceId: string): Promise<MatchIntegrityReport> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.inspectData, serviceId),
  /** apply=false is een proefronde: hij rekent uit wat er zou gebeuren en raakt niets aan. */
  repairData: (serviceId: string, apply: boolean): Promise<RepairResult> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.repairMatches, serviceId, apply),
  listChampions: (serviceId: string): Promise<ChampionRef[]> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.listChampions, serviceId),

  getSettings: (): Promise<ManagerSettings> => ipcRenderer.invoke(EXTRA_CHANNELS.getSettings),
  setDataRoot: (path: string): Promise<ManagerSettings> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.setDataRoot, path),
  /** Opent de mapkiezer in het main-proces; null als de gebruiker afbreekt. */
  chooseDataRoot: (): Promise<string | null> => ipcRenderer.invoke(EXTRA_CHANNELS.chooseDataRoot),
  storageUsage: (): Promise<StorageUsage[]> => ipcRenderer.invoke(EXTRA_CHANNELS.storageUsage),

  createKey: (label: string, scopes?: string[]): Promise<IssuedApiKey> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.authCreateKey, label, scopes ?? []),
  listKeys: (): Promise<ApiKeyInfo[]> => ipcRenderer.invoke(EXTRA_CHANNELS.authListKeys),
  revokeKey: (id: string): Promise<SettingsMutationResult> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.authRevokeKey, id),
  createApiKey: (label: string, scopes?: string[]): Promise<IssuedApiKey> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.createApiKey, label, scopes ?? []),
  listApiKeys: (): Promise<ApiKeyInfo[]> => ipcRenderer.invoke(EXTRA_CHANNELS.authListKeys),
  revokeApiKey: (id: string): Promise<SettingsMutationResult> =>
    ipcRenderer.invoke(EXTRA_CHANNELS.revokeApiKey, id),

  /** Opent de datamap van een service in de verkenner, of de hoofdmap bij null. */
  openDataFolder: (serviceId: string | null): Promise<void> =>
    ipcRenderer.invoke(MANAGER_CHANNELS.openDataFolder, serviceId),

  /** Abonneert op statuswijzigingen; geeft een opzegfunctie terug. */
  onSnapshot: (handler: (snapshot: ManagerSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: ManagerSnapshot): void => handler(snapshot);
    ipcRenderer.on(MANAGER_CHANNELS.snapshot, listener);
    return () => ipcRenderer.removeListener(MANAGER_CHANNELS.snapshot, listener);
  },

  minimize: (): void => ipcRenderer.send(MANAGER_CHANNELS.minimize),
  maximize: (): void => ipcRenderer.send(MANAGER_CHANNELS.maximize),
  close: (): void => ipcRenderer.send(MANAGER_CHANNELS.close),
};

export type ManagerBridge = typeof api;

/**
 * Alles wat hierboven bovenop de ManagerApi is gekomen, aan dat type geplakt.
 *
 * shared/types.ts ligt vast, maar `window.manager` is overal als ManagerApi
 * getypeerd. Zonder deze uitbreiding zou elk scherm zelf moeten casten om bij de
 * rest van de brug te komen -- en dan verdwijnt precies de controle die het type
 * moest opleveren.
 */
declare module "../../shared/types" {
  interface ManagerApi {
    setAutoStart(target: string | boolean, enabled?: boolean): Promise<ManagerSettings>;
    startHost(): Promise<ManagerSnapshot>;
    stopHost(): Promise<ManagerSnapshot>;

    dataQuery(request: DataQueryRequest): Promise<DataPage>;
    dataUpdate(request: DataUpdateRequest): Promise<DataMutationResult>;
    dataDelete(request: DataDeleteRequest): Promise<DataMutationResult>;
    dataIntegrity(serviceId: string): Promise<IntegrityReport>;
    dataRepair(serviceId: string, issueIds?: string[]): Promise<IntegrityReport>;

    listMatches(query: MatchQuery): Promise<MatchPage>;
    updateMatch(serviceId: string, gameId: number, edit: MatchEdit): Promise<MutationResult>;
    deleteMatches(serviceId: string, gameIds: number[]): Promise<MutationResult>;
    inspectData(serviceId: string): Promise<MatchIntegrityReport>;
    repairData(serviceId: string, apply: boolean): Promise<RepairResult>;
    listChampions(serviceId: string): Promise<ChampionRef[]>;

    getSettings(): Promise<ManagerSettings>;
    setDataRoot(path: string): Promise<ManagerSettings>;
    chooseDataRoot(): Promise<string | null>;
    storageUsage(): Promise<StorageUsage[]>;

    createKey(label: string, scopes?: string[]): Promise<IssuedApiKey>;
    listKeys(): Promise<ApiKeyInfo[]>;
    revokeKey(id: string): Promise<SettingsMutationResult>;
    createApiKey(label: string, scopes?: string[]): Promise<IssuedApiKey>;
    listApiKeys(): Promise<ApiKeyInfo[]>;
    revokeApiKey(id: string): Promise<SettingsMutationResult>;
  }
}

contextBridge.exposeInMainWorld("manager", api);
