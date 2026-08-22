/**
 * Het logboek van de host.
 *
 * Een servermanager die dagen achter elkaar aan staat mag zijn eigen logregels
 * niet gaan opsparen: dan groeit het geheugen langzaam vol en wordt de UI steeds
 * trager omdat elke snapshot meer regels meeneemt. Daarom houdt elke service een
 * eigen ringbuffer van een vast aantal regels -- de oudste valt eruit zodra er
 * een nieuwe bij komt, en dat is precies wat je van een logvenster wilt.
 *
 * Per service in plaats van één grote buffer, want anders duwt de service die het
 * drukst is de regels van de rustige buurman eruit: juist die ene foutmelding van
 * tien minuten geleden wil je nog kunnen lezen. Het gecombineerde overzicht wordt
 * uit die buffers samengevoegd en kost dus geen extra geheugen.
 */
import type { LogLevel } from "./services/types";
import type { LogEntry } from "../../shared/types";

/** Regels die we per service bewaren; ruim genoeg voor een opstart plus de fouten erna. */
const LINES_PER_CHANNEL = 500;

/** Wat het gecombineerde overzicht standaard teruggeeft. */
const COMBINED_LINES = 200;

/** Eén regel mag het logboek niet vol schrijven; stack traces zijn zo tienduizend tekens. */
const MAX_MESSAGE = 2_000;

/** Precies de vorm van ServiceContext.log, zodat een service er niets bij hoeft te bedenken. */
export type LogFn = (level: LogLevel, message: string) => void;

/**
 * Een regel plus zijn volgnummer.
 *
 * Op de tijd sorteren is niet genoeg: tien regels in dezelfde milliseconde is bij
 * het opstarten eerder regel dan uitzondering, en dan raakt de volgorde van een
 * "Starting..." en zijn "Failed" zoek. Het volgnummer is per logboek uniek en
 * loopt altijd op, dus daarmee klopt de samenvoeging wel.
 */
interface Stamped {
  seq: number;
  entry: LogEntry;
}

/**
 * Vaste-grootte buffer die van voren af aan overschrijft zodra hij vol is.
 *
 * Bewust geen array met shift(): dat verschuift bij elke regel de hele inhoud, en
 * dit is de plek waar juist onder druk (een service die foutmeldingen spuwt) veel
 * verkeer langskomt.
 */
class Ring<T> {
  private readonly items: T[] = [];
  /** Waar de volgende regel komt zodra de buffer vol is; daarvoor groeit hij gewoon. */
  private next = 0;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    this.items[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
  }

  /** Index 0 is de oudste bewaarde regel. */
  at(index: number): T | undefined {
    if (index < 0 || index >= this.items.length) return undefined;
    const oldest = this.items.length < this.capacity ? 0 : this.next;
    return this.items[(oldest + index) % this.items.length];
  }

  /** Oudste eerst. */
  toArray(): T[] {
    if (this.items.length < this.capacity) return [...this.items];
    return [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
  }
}

export interface LogbookOptions {
  /** Aantal regels dat elke service bewaart. */
  linesPerService?: number;
}

export class Logbook {
  /** Sleutel null is de host zelf; het aantal kanalen is dus begrensd door het aantal services. */
  private readonly channels = new Map<string | null, Ring<Stamped>>();
  private readonly listeners = new Set<(entry: LogEntry) => void>();
  private readonly capacity: number;
  private seq = 0;
  private notifying = false;

  constructor(options: LogbookOptions = {}) {
    this.capacity = options.linesPerService ?? LINES_PER_CHANNEL;
  }

  /**
   * De functie die als `log` in de ServiceContext meegaat. Null levert het kanaal
   * van de host zelf op.
   */
  channel(serviceId: string | null): LogFn {
    return (level, message) => {
      this.append(serviceId, level, message);
    };
  }

  append(serviceId: string | null, level: LogLevel, message: string): LogEntry {
    const entry: LogEntry = {
      at: Date.now(),
      serviceId,
      level,
      message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}...` : message,
    };
    this.channelFor(serviceId).push({ seq: this.seq++, entry });

    // Fouten van voordat het venster er is zou je anders nergens zien; in dev is
    // de terminal het enige dat dan meekijkt.
    if (level === "error") console.error(`[${serviceId ?? "host"}] ${entry.message}`);

    this.notify(entry);
    return entry;
  }

  /** Meelezen met nieuwe regels, bijvoorbeeld om de UI meteen bij te werken. */
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Alles van één service, oudste eerst. Null geeft de regels van de host.
   */
  forService(serviceId: string | null, limit = this.capacity): LogEntry[] {
    const ring = this.channels.get(serviceId);
    if (!ring || limit <= 0) return [];
    const lines = ring.toArray().map((stamped) => stamped.entry);
    return lines.length > limit ? lines.slice(lines.length - limit) : lines;
  }

  /**
   * Het gecombineerde overzicht, oudste eerst -- de volgorde die de UI verwacht.
   *
   * Elke ring is al op volgnummer gesorteerd, dus we lopen ze van achteren af
   * tegelijk door en pakken telkens de jongste regel. Zo kost een overzicht van
   * tweehonderd regels ook tweehonderd stappen, en niet het sorteren van alle
   * duizenden regels die we toch niet laten zien.
   */
  recent(limit = COMBINED_LINES): LogEntry[] {
    if (limit <= 0) return [];
    const cursors = [...this.channels.values()].map((ring) => ({ ring, index: ring.size - 1 }));
    const newestFirst: LogEntry[] = [];

    while (newestFirst.length < limit) {
      let pick: { ring: Ring<Stamped>; index: number } | null = null;
      let newest: Stamped | null = null;
      for (const cursor of cursors) {
        if (cursor.index < 0) continue;
        const candidate = cursor.ring.at(cursor.index);
        if (!candidate) continue;
        if (!newest || candidate.seq > newest.seq) {
          newest = candidate;
          pick = cursor;
        }
      }
      if (!pick || !newest) break;
      newestFirst.push(newest.entry);
      pick.index -= 1;
    }

    return newestFirst.reverse();
  }

  private channelFor(serviceId: string | null): Ring<Stamped> {
    const existing = this.channels.get(serviceId);
    if (existing) return existing;
    const ring = new Ring<Stamped>(this.capacity);
    this.channels.set(serviceId, ring);
    return ring;
  }

  private notify(entry: LogEntry): void {
    // Een luisteraar die zelf logt zou zichzelf eindeloos oproepen. Die regel komt
    // wel gewoon in de buffer, maar zet geen nieuwe ronde in gang.
    if (this.notifying) return;
    this.notifying = true;
    try {
      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          // Het logboek mag nooit stukgaan aan wie meeleest.
        }
      }
    } finally {
      this.notifying = false;
    }
  }
}
