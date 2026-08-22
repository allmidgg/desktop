/**
 * De boekhouding van de services: wie er zijn, wat ze doen, en wat er misging.
 *
 * Dit is de enige plek die een status omzet. De host vraagt hier of hij een
 * verzoek mag doorlaten, de UI vraagt hier wat ze moet tonen, en de services zelf
 * weten van niets -- die krijgen alleen start() en stop() te horen.
 *
 * De belangrijkste eigenschap is dat elke service op zichzelf staat. Een service
 * die bij het starten gooit levert een status 'error' met de melding erbij op,
 * meer niet: de andere services blijven draaien, de host blijft luisteren en de
 * app blijft open. Dat is precies waarom start() hier binnen een try staat en
 * nergens anders.
 *
 * Welke services vanzelf mee omhoog gaan blijft in manager.json staan, zodat de
 * app na een herstart weer draait wat er draaide.
 *
 * Pauze is het enige wat hier bewust NIET bewaard wordt. Hij staat alleen in het
 * geheugen, dus na het opstarten is een service gewoon aan of uit en nooit half:
 * een pauze die een dag later nog geldt is geen pauze meer maar een storing die
 * niemand kan verklaren.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServiceActionResult, ServiceInfo } from "../../shared/types";
import type { GameService, ServiceContext, ServiceStatus, ServiceSummary } from "./services/types";
import type { LogFn } from "./logbook";

/** De registry woont in de datamap zelf, naast de mappen van de services. */
export const defaultStatePath = (dataRoot: string): string => join(dataRoot, "manager.json");

export interface RegistryOptions {
  /** Bovenliggende map; elke service krijgt hieronder een eigen map met zijn id als naam. */
  dataRoot: string;
  /** Levert de logfunctie per service; in de praktijk Logbook.channel. */
  channel(serviceId: string | null): LogFn;
  /** Waar de autostart-voorkeuren blijven staan. Standaard manager.json in dataRoot. */
  statePath?: string;
  /** Wordt na elke statuswijziging aangeroepen, zodat de host een verse snapshot kan sturen. */
  onChange?(): void;
  /**
   * Hoeveel verzoeken de host op het pad van deze service afleverde.
   *
   * Als callback en niet als import: de registry hoort de host niet te kennen, maar
   * het is wel de enige plek waar één ServiceInfo wordt samengesteld -- twee plekken
   * zou betekenen dat de UI twee half gevulde objecten kan krijgen.
   */
  requestsFor?(serviceId: string): number;
}

/** Wat er tussen sessies bewaard blijft. Klein en plat: je moet het kunnen openen en snappen. */
interface PersistedState {
  autoStart: Record<string, boolean>;
}

interface Entry {
  readonly service: GameService;
  readonly log: LogFn;
  status: ServiceStatus;
  error: string | null;
  summary: ServiceSummary | null;
  startedAt: number | null;
  autoStart: boolean;
  /** De lopende start of stop; zolang die er is neemt deze service geen nieuwe opdracht aan. */
  busy: Promise<unknown> | null;
  /** Voorkomt dat een kapotte summary() elke seconde dezelfde waarschuwing wegschrijft. */
  summaryBroken: boolean;
}

export class ServiceRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly statePath: string;
  private readonly hostLog: LogFn;

  constructor(private readonly options: RegistryOptions) {
    this.statePath = options.statePath ?? defaultStatePath(options.dataRoot);
    this.hostLog = options.channel(null);
  }

  /**
   * Neemt een service op in de lijst. Dubbele id's of basePaden zijn een fout in
   * de code en geen gebruikersfout, dus die gooien meteen: twee services op
   * hetzelfde pad zou pas bij het eerste verzoek opvallen, en dan willekeurig.
   */
  register(service: GameService): void {
    if (this.entries.has(service.id)) {
      throw new Error(`service-id '${service.id}' is al geregistreerd`);
    }
    for (const entry of this.entries.values()) {
      if (entry.service.basePath === service.basePath) {
        throw new Error(`basePath '${service.basePath}' is al van '${entry.service.id}'`);
      }
    }
    this.entries.set(service.id, {
      service,
      log: this.options.channel(service.id),
      status: "stopped",
      error: null,
      summary: null,
      startedAt: null,
      // Standaard aan: wie een servermanager opent verwacht dat zijn servers
      // draaien. load() zet er daarna overheen wat de gebruiker echt wilde.
      autoStart: true,
      busy: null,
      summaryBroken: false,
    });
  }

  /** Leest de bewaarde voorkeuren. Aanroepen nadat alles geregistreerd is. */
  async load(): Promise<void> {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<PersistedState>;
      for (const [id, enabled] of Object.entries(raw.autoStart ?? {})) {
        // Voorkeuren van een service die er niet meer is laten we vallen; ze
        // verdwijnen vanzelf bij de eerstvolgende keer opslaan.
        const entry = this.entries.get(id);
        if (entry) entry.autoStart = enabled === true;
      }
    } catch {
      // Een onleesbaar bestand is geen reden om niets te doen: de standaard
      // (alles aan) is nog altijd wat de gebruiker verwacht.
    }
  }

  /**
   * Start alles wat aan stond. Elke service gaat zijn eigen gang, dus eentje die
   * er twintig seconden over doet houdt de rest niet op.
   */
  async startAutoStart(): Promise<void> {
    const wanted = [...this.entries.values()].filter((entry) => entry.autoStart);
    await Promise.all(wanted.map((entry) => this.start(entry.service.id)));
  }

  async start(id: string): Promise<ServiceActionResult> {
    const entry = this.entries.get(id);
    if (!entry) return unknownService(id);
    if (entry.busy) return this.result(entry, false, this.busyMessage(entry));
    if (entry.status === "running") {
      return this.result(entry, true, `${entry.service.name} is already running.`);
    }
    if (entry.status === "paused") {
      // Vanuit pauze hoort resume() en niet start(): de service is nog gestart en
      // een tweede start() zou hem zijn hele opslag opnieuw laten inlezen -- precies
      // wat pauzeren moest voorkomen.
      return this.result(entry, false, `${entry.service.name} is paused. Resume it instead of starting it.`);
    }

    const ok = await this.hold(entry, () => this.performStart(entry));
    // Alleen onthouden wat echt gedraaid heeft: een service die niet wil starten
    // hoeft niet elke keer opnieuw dezelfde fout in beeld te zetten.
    if (ok) await this.remember(entry, true);

    return this.result(
      entry,
      ok,
      ok
        ? `${entry.service.name} started.`
        : `${entry.service.name} failed to start: ${entry.error ?? "unknown error"}`,
    );
  }

  async stop(id: string): Promise<ServiceActionResult> {
    const entry = this.entries.get(id);
    if (!entry) return unknownService(id);
    if (entry.busy) return this.result(entry, false, this.busyMessage(entry));
    if (entry.status === "stopped") {
      return this.result(entry, true, `${entry.service.name} is already stopped.`);
    }

    // Ook vanuit 'paused': die service is nog gestart en houdt zijn opslag vast, dus
    // hij krijgt hier gewoon zijn stop() en geeft alles pas nu echt vrij.
    const ok = await this.hold(entry, () => this.performStop(entry));
    // Zelf stoppen betekent: laat hem voortaan ook staan bij het opstarten.
    await this.remember(entry, false);

    return this.result(
      entry,
      ok,
      ok
        ? `${entry.service.name} stopped.`
        : `${entry.service.name} did not stop cleanly: ${entry.error ?? "unknown error"}`,
    );
  }

  /**
   * Zet de service op pauze: hij blijft gestart, maar de host weigert zijn paden.
   *
   * Dit raakt de service met opzet niet aan -- geen stop(), geen enkele aanroep.
   * Bij lol-classic laat stop() de hele database los en moet start() 124 MB opnieuw
   * indexeren; wie even geen verkeer wil is daar niet mee geholpen. Alleen de status
   * verspringt, en de host leest die bij elk verzoek opnieuw uit.
   *
   * Geen hold(): er valt niets te serialiseren omdat er niets asynchroons gebeurt.
   * De busy-controle blijft wel staan, zodat een pauze niet middenin een lopende
   * start of stop de status onder die opdracht vandaan schrijft.
   */
  async pause(id: string): Promise<ServiceActionResult> {
    const entry = this.entries.get(id);
    if (!entry) return unknownService(id);
    if (entry.busy) return this.result(entry, false, this.busyMessage(entry));
    if (entry.status === "paused") {
      return this.result(entry, true, `${entry.service.name} is already paused.`);
    }
    if (entry.status !== "running") {
      // Alleen wat draait valt te pauzeren. Een gestopte of kapotte service pauzeren
      // zou een derde soort 'uit' opleveren waar niemand nog uit komt.
      return this.result(entry, false, `${entry.service.name} can only be paused while it is running.`);
    }

    this.setStatus(entry, "paused");
    entry.log("info", `${entry.service.name} is paused; ${entry.service.basePath} answers 503 until it resumes.`);
    // De autostart-voorkeur blijft staan: pauzeren zegt "nu even niet", niet
    // "morgen ook niet meer".
    return this.result(entry, true, `${entry.service.name} paused.`);
  }

  /** De weg terug uit pauze. Kost niets: de service heeft al die tijd doorgedraaid. */
  async resume(id: string): Promise<ServiceActionResult> {
    const entry = this.entries.get(id);
    if (!entry) return unknownService(id);
    if (entry.busy) return this.result(entry, false, this.busyMessage(entry));
    if (entry.status === "running") {
      return this.result(entry, true, `${entry.service.name} is already running.`);
    }
    if (entry.status !== "paused") {
      return this.result(entry, false, `${entry.service.name} is not paused. Start it instead.`);
    }

    this.setStatus(entry, "running");
    entry.log("info", `${entry.service.name} resumed; ${entry.service.basePath} is serving again.`);
    return this.result(entry, true, `${entry.service.name} resumed.`);
  }

  async restart(id: string): Promise<ServiceActionResult> {
    const entry = this.entries.get(id);
    if (!entry) return unknownService(id);
    if (entry.busy) return this.result(entry, false, this.busyMessage(entry));

    // Stoppen en starten onder hetzelfde slot, anders kan een klik ertussen
    // glippen op het moment dat de service even niets is.
    // Ook vanuit 'paused' toegestaan, en dan is de service daarna gewoon aan: een
    // herstart is een verse start, en die kan niet half zijn.
    const ok = await this.hold(entry, async () => {
      if (entry.status !== "stopped") await this.performStop(entry);
      return this.performStart(entry);
    });
    if (ok) await this.remember(entry, true);

    return this.result(
      entry,
      ok,
      ok
        ? `${entry.service.name} restarted.`
        : `${entry.service.name} failed to restart: ${entry.error ?? "unknown error"}`,
    );
  }

  /**
   * Bij het sluiten van de app: iedereen krijgt zijn stop(), ook als de buurman
   * gooit. Dit raakt de autostart-voorkeur bewust niet -- de app afsluiten is
   * geen opdracht om die service morgen niet meer te draaien.
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.drain(entry)));
  }

  /**
   * Haalt bij elke service zijn cijfers op. De host doet dit vlak voor hij een
   * snapshot stuurt, dus summary() hoort goedkoop te zijn.
   */
  async refreshSummaries(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.refreshSummary(entry)));
  }

  /** Wat de UI ziet, in de volgorde waarin de services geregistreerd zijn. */
  snapshot(): ServiceInfo[] {
    return [...this.entries.values()].map((entry) => this.info(entry));
  }

  /** Alle services in registratievolgorde; hiermee mount de host hun routes. */
  all(): GameService[] {
    return [...this.entries.values()].map((entry) => entry.service);
  }

  get(id: string): GameService | null {
    return this.entries.get(id)?.service ?? null;
  }

  infoFor(id: string): ServiceInfo | null {
    const entry = this.entries.get(id);
    return entry ? this.info(entry) : null;
  }

  /**
   * De vraag die de host bij elk verzoek stelt: doorlaten, of 503? Alleen 'running'
   * gaat door; de host maakt zelf onderscheid tussen 'paused' en de rest, zodat een
   * client "even niet" van "uit" kan onderscheiden. Een onbekende id telt als
   * gestopt -- er valt dan sowieso niets te bedienen.
   */
  statusOf(id: string): ServiceStatus {
    return this.entries.get(id)?.status ?? "stopped";
  }

  /** De map die deze service als dataRoot krijgt; ook wat "open data folder" opent. */
  dataRootFor(id: string): string | null {
    return this.entries.has(id) ? join(this.options.dataRoot, id) : null;
  }

  autoStartFor(id: string): boolean {
    return this.entries.get(id)?.autoStart ?? false;
  }

  async setAutoStart(id: string, enabled: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await this.remember(entry, enabled);
  }

  /** Gooit nooit; geeft terug of de service er echt staat. */
  private async performStart(entry: Entry): Promise<boolean> {
    const { service, log } = entry;
    this.setStatus(entry, "starting");
    log("info", `Starting ${service.name}...`);

    const dataRoot = join(this.options.dataRoot, service.id);
    try {
      // Het contract belooft de service dat zijn map er al is als start() draait.
      await mkdir(dataRoot, { recursive: true });
      const context: ServiceContext = { dataRoot, log };
      await service.start(context);
      entry.error = null;
      entry.startedAt = Date.now();
      entry.summaryBroken = false;
      this.setStatus(entry, "running");
      log("info", `${service.name} is serving ${service.basePath}.`);
      return true;
    } catch (err) {
      // Eén service die zijn opslag niet kan lezen mag de rest niet meenemen. De
      // melding blijft staan tot een geslaagde start, zodat hij te lezen valt.
      entry.startedAt = null;
      entry.error = describe(err);
      this.setStatus(entry, "error");
      log("error", `${service.name} failed to start: ${entry.error}`);
      return false;
    }
  }

  /** Gooit nooit; geeft terug of de service netjes is opgeruimd. */
  private async performStop(entry: Entry): Promise<boolean> {
    const { service, log } = entry;
    this.setStatus(entry, "stopping");
    log("info", `Stopping ${service.name}...`);

    try {
      await service.stop();
      entry.error = null;
      entry.startedAt = null;
      this.setStatus(entry, "stopped");
      log("info", `${service.name} stopped.`);
      return true;
    } catch (err) {
      // Wie zijn eigen opruiming niet afkrijgt is niet meer te vertrouwen: op
      // 'error' antwoordt de host 503 en blijft opnieuw starten wel mogelijk.
      entry.startedAt = null;
      entry.error = describe(err);
      this.setStatus(entry, "error");
      log("error", `${service.name} failed to stop: ${entry.error}`);
      return false;
    }
  }

  private async drain(entry: Entry): Promise<void> {
    // Een service die net aan het starten is maakt dat eerst af, anders stoppen we
    // iets dat zijn bestanden nog aan het openen is.
    if (entry.busy) await entry.busy.catch(() => undefined);
    if (entry.status === "stopped") return;
    await this.hold(entry, () => this.performStop(entry));
  }

  private async refreshSummary(entry: Entry): Promise<void> {
    // Middenin een start of stop zijn de tellers van niemand; laat staan wat er stond.
    // Een gepauzeerde service telt hier wél mee: die heeft zijn data nog gewoon vast,
    // en zijn cijfers laten bevriezen zou pauze op stilstand doen lijken.
    if (entry.status === "starting" || entry.status === "stopping") return;
    try {
      entry.summary = await entry.service.summary();
      entry.summaryBroken = false;
    } catch (err) {
      entry.summary = null;
      // Eén regel per storing: de UI vraagt dit elke seconde op, en anders is het
      // logboek binnen een minuut gevuld met dezelfde zin.
      if (!entry.summaryBroken) {
        entry.summaryBroken = true;
        entry.log("warn", `${entry.service.name} could not report its numbers: ${describe(err)}`);
      }
    }
  }

  /** Eén opdracht tegelijk per service; de andere services merken hier niets van. */
  private async hold<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    // Via een microtaak, zodat de vlag gezet is voordat er ook maar iets gebeurt.
    const running = Promise.resolve().then(work);
    entry.busy = running;
    try {
      return await running;
    } finally {
      entry.busy = null;
    }
  }

  private async remember(entry: Entry, autoStart: boolean): Promise<void> {
    if (entry.autoStart === autoStart) return;
    entry.autoStart = autoStart;
    await this.save();
  }

  private async save(): Promise<void> {
    const autoStart: Record<string, boolean> = {};
    for (const [id, entry] of this.entries) autoStart[id] = entry.autoStart;
    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify({ autoStart } satisfies PersistedState, null, 2), "utf8");
    } catch (err) {
      // Niet kunnen onthouden is vervelend, maar mag een start of stop die verder
      // gelukt is nooit alsnog laten mislukken.
      this.hostLog("warn", `Could not save manager settings: ${describe(err)}`);
    }
  }

  private setStatus(entry: Entry, status: ServiceStatus): void {
    if (entry.status === status) return;
    entry.status = status;
    try {
      this.options.onChange?.();
    } catch {
      // De UI bijwerken mag de boekhouding niet in de war schoppen.
    }
  }

  /** Alleen bereikbaar terwijl er een opdracht loopt, dus de status zegt welke. */
  private busyMessage(entry: Entry): string {
    return entry.status === "stopping"
      ? `${entry.service.name} is still stopping.`
      : `${entry.service.name} is still starting.`;
  }

  private info(entry: Entry): ServiceInfo {
    const { service } = entry;
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      basePath: service.basePath,
      status: entry.status,
      error: entry.error,
      summary: entry.summary,
      startedAt: entry.startedAt,
      autoStart: entry.autoStart,
      requests: this.options.requestsFor?.(service.id) ?? 0,
    };
  }

  private result(entry: Entry, ok: boolean, message: string): ServiceActionResult {
    return { ok, message, service: this.info(entry) };
  }
}

const describe = (err: unknown): string => {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
};

const unknownService = (id: string): ServiceActionResult => ({
  ok: false,
  message: `Unknown service '${id}'.`,
  service: null,
});
