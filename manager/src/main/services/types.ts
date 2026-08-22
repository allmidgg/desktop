/**
 * Het contract tussen de host en de services die hij draait.
 *
 * Dit bestand is bewust het enige raakvlak: de host kent geen enkele service bij
 * naam, en een service kent de host niet. Daardoor kan er een game bij zonder dat
 * er iets aan de host verandert, en kan één kapotte service de rest niet meeslepen.
 *
 * De belangrijkste afspraak: een service luistert NOOIT zelf op een poort. Er is
 * één HTTP-server in de host, die op basePath uitsplitst naar de juiste service.
 * Zie manager/README.md voor het waarom daarvan.
 */

/** Methodes die de router kent. Bewust geen HEAD/OPTIONS: die doet de host zelf. */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type LogLevel = "info" | "warn" | "error";

/**
 * De levensloop van een service.
 *
 * 'starting' en 'stopping' bestaan omdat start() en stop() traag mogen zijn --
 * een database van een paar honderdduizend regels inlezen duurt even -- en de UI
 * in die tijd iets eerlijks moet kunnen tonen. Vanuit 'error' mag opnieuw gestart
 * worden; de service blijft geregistreerd zodat je hem niet kwijtraakt.
 *
 * 'paused' is géén tussenstap van start of stop maar een stand van de host: de
 * service is en blijft gestart, houdt alles wat start() inlas gewoon vast, en
 * merkt zelf niets van de pauze. Alleen de host weigert vanaf dat moment zijn
 * paden. Daarom is pauzeren iets anders dan stoppen-en-weer-starten: dat laatste
 * laat de opslag los en moet hem daarna opnieuw inlezen.
 */
export type ServiceStatus = "stopped" | "starting" | "running" | "stopping" | "paused" | "error";

/**
 * Wat een service van de host meekrijgt bij het starten.
 *
 * Meer dan dit hoort een service niet nodig te hebben: geen Electron, geen
 * app-paden, geen verwijzing naar de host. Wie alleen dit gebruikt is ook buiten
 * de app te testen.
 */
export interface ServiceContext {
  /** Eigen map, door de host aangemaakt voordat start() wordt aangeroepen. */
  dataRoot: string;
  /** Belandt in het logvenster van de UI, met de service-id erbij. */
  log(level: LogLevel, message: string): void;
}

/**
 * Eén binnengekomen verzoek, al door de host uitgepakt.
 *
 * Bewust niet het rauwe IncomingMessage: een service die alleen dit ziet kan geen
 * headers half versturen, de socket kapen of de verbinding open laten staan.
 */
export interface ServiceRequest {
  method: string;
  /** Zonder basePath, begint altijd met '/' en bevat nooit de querystring. */
  path: string;
  query: URLSearchParams;
  /** Sleutels in kleine letters; meervoudige headers zijn samengevoegd met ', '. */
  headers: Record<string, string>;
  /** Geparste JSON, of null bij een leeg lichaam. Onleesbare JSON wordt 400 vóór de handler. */
  body: unknown;
  /** Herkomst van het verzoek, x-forwarded-for indien aanwezig. Alleen voor logging en rate limiting. */
  ip: string;
}

/**
 * Het antwoord van een handler.
 *
 * De host serialiseert `body` als JSON. Zet een handler zelf een `content-type`
 * in headers, dan moet `body` een string zijn en gaat die ongewijzigd de lijn op.
 * `null` levert een leeg lichaam op.
 */
export interface ServiceResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ServiceRoute {
  method: HttpMethod;
  /**
   * Relatief aan basePath, begint met '/'. Exacte match op het hele pad; een pad
   * dat eindigt op '/*' matcht ook alles eronder. Meer routering dan dat heeft
   * geen enkele service nodig, en het scheelt een router die zelf stuk kan.
   */
  path: string;
  handler(req: ServiceRequest): Promise<ServiceResponse>;
}

/**
 * Wat de UI over een service laat zien.
 *
 * `detail` is vrij invulbaar omdat elke game iets anders telt. De sleutels komen
 * letterlijk in beeld, dus schrijf ze kort en in het Engels ("Players", "Last upload").
 */
export interface ServiceSummary {
  /** Het aantal dat de service in één woord samenvat; de UI toont dit als hoofdgetal. */
  records: number;
  detail: Record<string, string | number>;
}

/**
 * Wat een game-service moet leveren om meegedraaid te kunnen worden.
 *
 * De host beheert de status: start() wordt alleen aangeroepen vanuit 'stopped' of
 * 'error', stop() alleen vanuit 'running', 'paused' of 'error'. Gooit start() een
 * fout, dan onthoudt de host die melding en blijft de rest van de app draaien.
 *
 * Pauzeren komt hier bewust niet in voor: dat is een besluit van de host over
 * binnenkomend verkeer, geen opdracht aan de service. Een service hoeft dus geen
 * pause() te schrijven en merkt het verschil niet.
 */
export interface GameService {
  /** Uniek, in kebab-case; ook de naam van de datamap. Bijvoorbeeld 'lol-classic'. */
  id: string;
  /** Zoals de gebruiker hem kent, bijvoorbeeld 'League of Legends Classic'. */
  name: string;
  /** Eén zin over wat de service doet; staat onder de naam in de UI. */
  description: string;
  /** Uniek voorvoegsel met een '/' ervoor en géén slash erachter, bijvoorbeeld '/lol-classic'. */
  basePath: string;

  /** Laadt de eigen opslag en start het eigen werk (timers, opschoning). Nooit een poort openen. */
  start(ctx: ServiceContext): Promise<void>;
  /** Moet alles vrijgeven wat start() heeft aangezet; wordt ook aangeroepen als de app sluit. */
  stop(): Promise<void>;

  /**
   * De vaste lijst paden van deze service. Moet altijd dezelfde lijst geven, ook
   * op een gestopte service: de host mount de paden één keer en beantwoordt ze
   * met 503 zolang de service niet draait.
   */
  routes(): ServiceRoute[];

  /**
   * Cijfers voor de UI. Wordt periodiek opgevraagd en moet daarom goedkoop zijn --
   * bijhouden in het geheugen, niet uitrekenen. Werkt ook op een gestopte service.
   */
  summary(): Promise<ServiceSummary>;
}
