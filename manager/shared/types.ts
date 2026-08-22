/**
 * Types die het main-proces en de UI delen.
 *
 * Alles wat over IPC gaat moet door structured clone heen, dus geen Map, geen
 * URLSearchParams, geen class-instanties -- alleen platte objecten en arrays.
 *
 * De UI krijgt één momentopname van de hele host (ManagerSnapshot) in plaats van
 * losse velden per service. Dat scheelt een berg IPC-verkeer, en belangrijker:
 * de UI kan nooit een halve waarheid tonen waarin service A al gestopt is en de
 * teller van B nog van tien seconden geleden komt.
 */
import type { ServiceStatus, ServiceSummary } from "../src/main/services/types";

export type { ServiceStatus, ServiceSummary };

export type LogLevel = "info" | "warn" | "error";

/** Eén service zoals de UI hem kent; de host leidt dit af uit de GameService plus zijn eigen boekhouding. */
export interface ServiceInfo {
  id: string;
  name: string;
  description: string;
  basePath: string;
  status: ServiceStatus;
  /** De laatste startfout, of null. Blijft staan tot een geslaagde start, zodat de gebruiker hem kan lezen. */
  error: string | null;
  /** Null zolang de service nog nooit gedraaid heeft of zijn cijfers niet kon geven. */
  summary: ServiceSummary | null;
  /**
   * Epoch-ms van de laatste geslaagde start, null als hij niet draait.
   *
   * Blijft staan tijdens een pauze: de service is dan nog gestart, dus zijn looptijd
   * loopt gewoon door. Op nul zetten zou pauzeren op een herstart laten lijken.
   */
  startedAt: number | null;
  /**
   * Gaat deze service vanzelf mee omhoog als de manager opent?
   *
   * Staat hier omdat de manager de voorkeur bewaart: zonder dit veld zou de UI een
   * tweede kopie moeten bijhouden, en dan toont de schakelaar iets anders dan wat
   * er bij de volgende start gebeurt.
   */
  autoStart: boolean;
  /** Verzoeken die de host op dit basePath afleverde sinds hij is gaan luisteren. */
  requests: number;
}

/** De gedeelde HTTP-server waar alle services onder hangen. */
export interface HostInfo {
  port: number;
  listening: boolean;
  /** Sinds de server is gaan luisteren, niet sinds de app openging. */
  uptimeSeconds: number;
  /** Alle verzoeken sinds die start, inclusief 404's en 503's. */
  totalRequests: number;
  /** Waarom er niet geluisterd wordt -- meestal een bezette poort. */
  error: string | null;
}

export interface LogEntry {
  /** Epoch-ms. */
  at: number;
  /** Null als de host zelf de afzender is. */
  serviceId: string | null;
  level: LogLevel;
  message: string;
}

/**
 * De volledige stand van zaken. De host stuurt deze na elke wijziging naar de UI,
 * die verder geen eigen staat bijhoudt.
 */
export interface ManagerSnapshot {
  host: HostInfo;
  services: ServiceInfo[];
  /** Nieuwste laatst. De host bewaart alleen de laatste regels, niet de hele historie. */
  logs: LogEntry[];
  /** Bovenliggende map waaronder elke service zijn eigen dataRoot krijgt. */
  dataRoot: string;
}

/**
 * Antwoord op start/pauze/hervat/stop/herstart.
 *
 * `message` is Engelse UI-tekst en wordt letterlijk getoond, ook als het goed ging.
 */
export interface ServiceActionResult {
  ok: boolean;
  message: string;
  /** De service na afloop, of null als de id onbekend was. */
  service: ServiceInfo | null;
}

/**
 * De IPC-kanalen, op één plek zodat main, preload en renderer niet elk hun eigen
 * spelling kunnen verzinnen -- een typefout in een kanaalnaam levert anders pas
 * bij het klikken een fout op.
 */
export const MANAGER_CHANNELS = {
  snapshot: "manager:snapshot",
  start: "manager:start",
  stop: "manager:stop",
  restart: "manager:restart",
  pause: "manager:pause",
  resume: "manager:resume",
  setPort: "manager:setPort",
  openDataFolder: "manager:openDataFolder",
  minimize: "window:minimize",
  maximize: "window:maximize",
  close: "window:close",
} as const;

/**
 * Wat de preload aan de UI aanbiedt onder window.manager.
 *
 * Dit is de hele aanvalsoppervlakte van de renderer: geen Node, geen fs, alleen
 * deze functies.
 */
export interface ManagerApi {
  getSnapshot(): Promise<ManagerSnapshot>;
  startService(id: string): Promise<ServiceActionResult>;
  stopService(id: string): Promise<ServiceActionResult>;
  restartService(id: string): Promise<ServiceActionResult>;
  /**
   * Houdt het verkeer tegen zonder de service te lossen: hij blijft gestart met al
   * zijn data in het geheugen, alleen de host antwoordt 503 op zijn paden. Alleen
   * toegestaan op een draaiende service.
   */
  pauseService(id: string): Promise<ServiceActionResult>;
  /** De weg terug uit pauze; alleen toegestaan op een gepauzeerde service. */
  resumeService(id: string): Promise<ServiceActionResult>;
  /** Herstart de host op een andere poort; services blijven draaien. */
  setPort(port: number): Promise<ManagerSnapshot>;
  /** Opent de datamap van een service in de verkenner, of de hoofdmap bij null. */
  openDataFolder(serviceId: string | null): Promise<void>;

  /** Abonneert op statuswijzigingen; geeft een opzegfunctie terug. */
  onSnapshot(handler: (snapshot: ManagerSnapshot) => void): () => void;

  minimize(): void;
  maximize(): void;
  close(): void;
}
