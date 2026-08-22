/**
 * Beheer van de matches die een service heeft opgeslagen.
 *
 * De dataset is de reden dat dit project bestaat, dus deze view moet twee dingen
 * kunnen die een gewone lijst niet hoeft te kunnen: hem doorzoeken zonder hem in
 * zijn geheel op te halen, en hem repareren zonder dat iemand per ongeluk zijn
 * eigen verzameling sloopt.
 *
 * Alles wat de lijst bepaalt -- filter, sortering, pagina -- gaat mee in één
 * vraag aan het main-proces. Bij zestigduizend regels is elke vorm van "haal op
 * en filter in de browser" een vastgelopen venster: het main-proces leest per
 * pagina en de renderer houdt nooit meer dan honderd records vast.
 *
 * Verwijderen en repareren zijn onomkeerbaar. Ze vragen daarom altijd eerst om
 * bevestiging, en repareren laat eerst zien wat het zou weggooien.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ManagerSnapshot } from "../../../../shared/types";

/**
 * De vorm van een record zoals hij over IPC komt.
 *
 * Bewust hier opnieuw beschreven en niet geleend uit de opslagcode: die praat
 * met de schijf en hoort niet in de renderer-bundel terecht te komen. Wat hier
 * staat is precies wat de brug doorgeeft, niet meer.
 */
export type Position = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "SUPPORT" | "UNKNOWN";

export interface StoredPlayerRecord {
  puuid: string;
  championId: number;
  teamId: number;
  position: Position;
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
export type SortDirection = "asc" | "desc";

export interface MatchFilter {
  championId: number | null;
  position: Position | null;
  /** Exacte patch, bijvoorbeeld "15.3". */
  patch: string | null;
  /** Epoch-ms, inclusief. */
  from: number | null;
  /** Epoch-ms, exclusief -- zo valt de gekozen einddag er compleet in. */
  to: number | null;
}

export interface MatchQuery extends MatchFilter {
  serviceId: string;
  sort: MatchSortKey;
  direction: SortDirection;
  offset: number;
  limit: number;
}

export interface MatchPage {
  rows: StoredMatchRecord[];
  /** Aantal ná filteren; zonder dit getal valt er geen pagina-indeling te maken. */
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
  positions?: Record<string, Position>;
}

export interface MutationResult {
  ok: boolean;
  /** Engelse UI-tekst, wordt letterlijk getoond. */
  message: string;
}

export interface IntegrityReport {
  records: number;
  /** Regels die geen geldige JSON zijn. */
  broken: number;
  /** Records met een gameId dat al eerder in het bestand stond. */
  duplicates: number;
  /** Records met minder dan tien spelers; statistisch onbruikbaar. */
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

/** De functies die deze view van window.manager gebruikt, bovenop ManagerApi. */
interface DataBridge {
  listMatches(query: MatchQuery): Promise<MatchPage>;
  updateMatch(serviceId: string, gameId: number, edit: MatchEdit): Promise<MutationResult>;
  deleteMatches(serviceId: string, gameIds: number[]): Promise<MutationResult>;
  inspectData(serviceId: string): Promise<IntegrityReport>;
  /** apply=false is een proefronde: hij rekent uit wat er zou gebeuren en raakt niets aan. */
  repairData(serviceId: string, apply: boolean): Promise<RepairResult>;
  listChampions(serviceId: string): Promise<ChampionRef[]>;
}

/**
 * De brug per aanroep opzoeken in plaats van één keer bij het laden.
 *
 * Zo valt de view niet om als de preload een functie (nog) niet aanbiedt: de
 * gebruiker krijgt dan een leesbare melding op de plek waar hij klikte, in
 * plaats van een lege pagina.
 */
function endpoint<K extends keyof DataBridge>(name: K): DataBridge[K] {
  const bridge = (window as unknown as { manager?: Partial<DataBridge> }).manager;
  const fn = bridge?.[name];
  if (typeof fn !== "function") throw new Error(`This build of the manager does not provide "${name}".`);
  return fn as DataBridge[K];
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

/**
 * Bovengrens op elke IPC-aanroep waar een knop of de tabel op staat te wachten.
 *
 * Een afgewezen belofte komt netjes in catch terecht, maar een belofte die
 * nooit antwoordt niet. Hangt het main-proces -- een bestand dat nog geschreven
 * wordt, een handler die nooit terugkeert -- dan blijft 'loading' of 'busy'
 * eeuwig aan: de tabel staat voorgoed op "Loading matches…" en het
 * bevestigingsvenster voorgoed op "Working…", zonder enige knop die nog werkt.
 * Met deze grens wordt zo'n aanroep alsnog een leesbare melding.
 */
const READ_TIMEOUT_MS = 30_000;

/** Ruimer: een reparatie herschrijft het hele bestand en dat mag even duren. */
const WRITE_TIMEOUT_MS = 60_000;

function withTimeout<T>(work: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(errorText(error)));
      },
    );
  });
}

/**
 * Bij schrijven mag een tijdslimiet nooit "mislukt" beweren: dat weet hij niet.
 * De aanroep kan hangen terwijl het bestand allang herschreven is. Dus melden
 * wat we wél weten -- er kwam geen antwoord -- en de gebruiker naar het opnieuw
 * ingelezen scherm sturen om te zien wat er echt staat.
 */
const writeTimeoutMessage = (action: string): string =>
  `${action} did not finish within ${Math.round(WRITE_TIMEOUT_MS / 1000)} seconds. It may or may not have been applied — the view has been reloaded, check it before trying again.`;

const POSITIONS: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT", "UNKNOWN"];

const POSITION_LABELS: Record<Position, string> = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "Bot",
  SUPPORT: "Support",
  UNKNOWN: "Unknown",
};

/** Een rauw queue-nummer zegt een mens niets; de bekende krijgen hun naam terug. */
const QUEUE_LABELS: Record<number, string> = {
  400: "Normal Draft",
  420: "Ranked Solo",
  430: "Normal Blind",
  440: "Ranked Flex",
  450: "ARAM",
  700: "Clash",
  830: "Co-op vs AI",
  840: "Co-op vs AI",
  850: "Co-op vs AI",
  1020: "One for All",
};

const PAGE_SIZES = [25, 50, 100];

const EMPTY_FILTER: MatchFilter = {
  championId: null,
  position: null,
  patch: null,
  from: null,
  to: null,
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** Vaste notatie in plaats van de landinstelling: in een tabel moet elke regel even breed zijn. */
function formatDateTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${pad(Math.max(0, Math.round(seconds % 60)))}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let step = 0;
  while (value >= 1024 && step < units.length - 1) {
    value /= 1024;
    step += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[step] ?? "B"}`;
}

const formatCount = (value: number): string => value.toLocaleString("en-US");

const queueLabel = (id: number): string => QUEUE_LABELS[id] ?? `Queue ${id}`;

const toDateInput = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** "2024-03-11" wordt middernacht in de tijdzone van de gebruiker, niet in UTC. */
const fromDateInput = (value: string): number | null => {
  if (!value) return null;
  const ms = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ms) ? null : ms;
};

const toLocalInput = (ms: number): string => {
  const date = new Date(ms);
  return `${toDateInput(ms)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** Een dag is niet altijd 24 uur (zomertijd), dus schuiven we over de kalender. */
const shiftDay = (ms: number, days: number): number => {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
};

type Tone = "ok" | "error";

interface Notice {
  tone: Tone;
  text: string;
}

/**
 * De service hoort in de bevestiging zelf, niet in de state van het scherm.
 *
 * Het venster ligt over de pagina heen, maar de servicekeuze erachter blijft met
 * Tab bereikbaar. Zou het uitvoeren de dan geldende service pakken, dan wist een
 * bevestigd "verwijder deze twintig" ze uit een bestand dat de gebruiker nooit
 * heeft gezien. Wat bevestigd is, is wat er gebeurt.
 */
type Confirmation =
  | { kind: "delete"; serviceId: string; gameIds: number[] }
  | { kind: "repair"; serviceId: string; plan: RepairPlan };

const inputClass =
  "rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-white/90 outline-none placeholder:text-white/25 focus:border-emerald-400/40";

const buttonClass =
  "rounded-lg border border-white/10 px-3 py-1.5 text-[12px] font-medium text-white/70 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

const dangerClass =
  "rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[12px] font-medium text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40";

export function DataView({
  snapshot,
  serviceId,
}: {
  snapshot?: ManagerSnapshot | null;
  serviceId?: string;
}): JSX.Element {
  const services = snapshot?.services ?? [];
  const [chosenService, setChosenService] = useState<string | null>(null);
  /** Keuze van de gebruiker gaat voor; daarna wat de ouder meegeeft, dan de eerste service die er is. */
  const activeService = chosenService ?? serviceId ?? services[0]?.id ?? "lol-classic";

  const [filter, setFilter] = useState<MatchFilter>(EMPTY_FILTER);
  const [championInput, setChampionInput] = useState("");
  const [sort, setSort] = useState<MatchSortKey>("createdAt");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  const [page, setPage] = useState<MatchPage | null>(null);
  const [loading, setLoading] = useState(true);
  /** Blijft staan tot een volgende poging lukt: een fout die je weg kunt klikken laat je met een lege tabel zonder uitleg achter. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [champions, setChampions] = useState<Map<number, string>>(new Map());
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  /**
   * Antwoorden komen niet per se in de volgorde waarin ze gevraagd zijn. Zonder
   * dit volgnummer kan een trage vraag van drie filters geleden de tabel weer
   * overschrijven zodra hij eindelijk binnenkomt.
   */
  const requestId = useRef(0);

  /**
   * Losstaand van 'busy': die vlag is pas na een render in de knop zichtbaar, en
   * twee klikken kort na elkaar vallen daar tussendoor. Een ref geldt meteen.
   */
  const mutating = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const seq = (requestId.current += 1);
    setLoading(true);
    try {
      const result = await withTimeout(
        endpoint("listMatches")({
          serviceId: activeService,
          ...filter,
          sort,
          direction,
          offset,
          limit,
        }),
        READ_TIMEOUT_MS,
        "Loading matches timed out: the manager did not answer.",
      );
      if (seq !== requestId.current) return;
      setLoadError(null);

      /**
       * Een lege pagina terwijl er wél records zijn betekent dat de offset voorbij
       * het einde staat. Dat gebeurt zodra verwijderen of repareren de lijst korter
       * maakt dan de pagina waar je op stond: de lijst herlaadt, maar de paginastand
       * schuift niet mee. Wat je dan overhoudt is een lege tabel met een teller die
       * "976–300 of 300" beweert en Next/Last uitgeschakeld -- een stand die nergens
       * op slaat. Terugvallen op de laatste pagina die nog bestaat is het enige
       * antwoord dat klopt.
       */
      const lastOffset = result.total === 0 ? 0 : (Math.ceil(result.total / limit) - 1) * limit;
      if (result.rows.length === 0 && offset > lastOffset) {
        // De offset gaat hier strikt omlaag, dus deze correctie kan zichzelf niet blijven herhalen.
        // De oude rijen blijven één render staan; setPage doen we pas met de pagina die klopt.
        setOffset(lastOffset);
        return;
      }
      setPage(result);
    } catch (error) {
      if (seq !== requestId.current) return;
      // Niet de vorige pagina laten staan: rijen die we niet meer kunnen verantwoorden
      // zijn erger dan geen rijen, want ze zijn nog bewerkbaar.
      setPage({ rows: [], total: 0, offset: 0, limit });
      setLoadError(errorText(error));
    } finally {
      if (seq === requestId.current) setLoading(false);
    }
  }, [activeService, filter, sort, direction, offset, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const inspect = useCallback(async (): Promise<void> => {
    try {
      setReport(
        await withTimeout(
          endpoint("inspectData")(activeService),
          READ_TIMEOUT_MS,
          "The integrity check timed out: the manager did not answer.",
        ),
      );
    } catch (error) {
      setReport(null);
      setNotice({ tone: "error", text: errorText(error) });
    }
  }, [activeService]);

  useEffect(() => {
    void inspect();
  }, [inspect]);

  /** Namen zijn een luxe: zonder die lijst blijft alles werken, alleen met nummers. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await endpoint("listChampions")(activeService);
        if (!cancelled) setChampions(new Map(list.map((champion) => [champion.id, champion.name])));
      } catch {
        if (!cancelled) setChampions(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeService]);

  const championName = useCallback(
    (id: number): string => champions.get(id) ?? `#${id}`,
    [champions],
  );

  const championOptions = useMemo(
    () => [...champions.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    [champions],
  );

  /** Elke wijziging aan het filter zet de lijst terug naar het begin; pagina 7 van het oude filter bestaat niet meer. */
  const changeFilter = useCallback((patch: Partial<MatchFilter>): void => {
    setFilter((current) => ({ ...current, ...patch }));
    setOffset(0);
    setSelected(new Set());
    setExpanded(null);
  }, []);

  /**
   * Typen in het championveld mag niet elke toetsaanslag een vraag opleveren.
   * Pas als het even stil is wordt de invoer een id -- via de namenlijst, en
   * anders als los nummer zodat het ook zonder die lijst werkt.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const text = championInput.trim();
      let next: number | null = null;
      if (text) {
        const match = championOptions.find((champion) => champion.name.toLowerCase() === text.toLowerCase());
        const numeric = Number(text.replace("#", ""));
        next = match ? match.id : Number.isFinite(numeric) && numeric > 0 ? numeric : null;
      }
      setFilter((current) => (current.championId === next ? current : { ...current, championId: next }));
      setOffset((current) => (current === 0 ? current : 0));
    }, 300);
    return () => clearTimeout(timer);
  }, [championInput, championOptions]);

  const toggleSort = useCallback(
    (column: MatchSortKey): void => {
      // Een nieuwe kolom begint bij de nuttigste kant: nieuwste datum eerst, de rest oplopend.
      setDirection((current) =>
        sort === column ? (current === "asc" ? "desc" : "asc") : column === "createdAt" ? "desc" : "asc",
      );
      setSort(column);
      setOffset(0);
    },
    [sort],
  );

  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const pageIndex = Math.min(Math.floor(offset / limit), pageCount - 1);
  const allOnPageSelected = rows.length > 0 && rows.every((row) => selected.has(row.gameId));

  const toggleSelected = (gameId: number): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(gameId)) next.delete(gameId);
      else next.add(gameId);
      return next;
    });
  };

  const toggleAllOnPage = (): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPageSelected) for (const row of rows) next.delete(row.gameId);
      else for (const row of rows) next.add(row.gameId);
      return next;
    });
  };

  const goTo = (index: number): void => {
    setOffset(Math.max(0, Math.min(index, pageCount - 1)) * limit);
    setExpanded(null);
  };

  const saveMatch = async (gameId: number, edit: MatchEdit): Promise<void> => {
    if (mutating.current) return;
    mutating.current = true;
    const service = activeService;
    setBusy(true);
    try {
      const result = await withTimeout(
        endpoint("updateMatch")(service, gameId, edit),
        WRITE_TIMEOUT_MS,
        writeTimeoutMessage("Saving this match"),
      );
      setNotice({ tone: result.ok ? "ok" : "error", text: result.message });
      if (result.ok) await load();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
      // Ook na een uitgelopen aanroep opnieuw lezen: alleen het bestand weet nog wat er staat.
      await load();
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };

  /** De proefronde is de hele reden dat repareren te vertrouwen is: eerst kijken, dan pas schrijven. */
  const previewRepair = async (): Promise<void> => {
    if (mutating.current) return;
    mutating.current = true;
    // De service van dít moment vasthouden: het plan hieronder hoort bij dit bestand en geen ander.
    const service = activeService;
    setBusy(true);
    try {
      const result = await withTimeout(
        endpoint("repairData")(service, false),
        READ_TIMEOUT_MS,
        "The repair preview timed out: the manager did not answer. Nothing has been written.",
      );
      setConfirmation({ kind: "repair", serviceId: service, plan: result.plan });
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };

  const runConfirmation = async (): Promise<void> => {
    // Twee keer bevestigen mag niet twee keer uitvoeren: repareren schrijft het
    // bestand dan tweemaal opnieuw en verwijderen loopt een tweede keer over ids
    // die er al niet meer zijn.
    if (!confirmation || mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      if (confirmation.kind === "delete") {
        const result = await withTimeout(
          endpoint("deleteMatches")(confirmation.serviceId, confirmation.gameIds),
          WRITE_TIMEOUT_MS,
          writeTimeoutMessage("The delete"),
        );
        setNotice({ tone: result.ok ? "ok" : "error", text: result.message });
        if (result.ok) {
          setSelected(new Set());
          setExpanded(null);
        }
      } else {
        const result = await withTimeout(
          endpoint("repairData")(confirmation.serviceId, true),
          WRITE_TIMEOUT_MS,
          writeTimeoutMessage("The repair"),
        );
        setNotice({ tone: result.applied ? "ok" : "error", text: result.message });
      }
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setConfirmation(null);
      // Herlezen hoort ook bij de mislukte en de uitgelopen afloop: anders staat er een
      // lijst op het scherm waarvan niemand meer weet of hij nog klopt. load() en
      // inspect() vangen hun eigen fouten af, dus deze finally kan zelf niet klappen.
      await Promise.all([load(), inspect()]);
      mutating.current = false;
      setBusy(false);
    }
  };

  const filtersActive =
    filter.championId !== null ||
    filter.position !== null ||
    filter.patch !== null ||
    filter.from !== null ||
    filter.to !== null;

  return (
    <div className="animate-rise space-y-4">
      <IntegrityPanel
        report={report}
        busy={busy}
        onRecheck={() => void inspect()}
        onRepair={() => void previewRepair()}
      />

      {notice ? (
        <div
          className={`flex items-start justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-[12px] ${
            notice.tone === "ok"
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 opacity-60 hover:opacity-100">
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="flex flex-wrap items-end gap-3 border-b border-white/8 px-4 py-3">
          {services.length > 1 ? (
            <Labelled label="Service">
              <select
                value={activeService}
                onChange={(event) => {
                  setChosenService(event.target.value);
                  setOffset(0);
                  setSelected(new Set());
                  setExpanded(null);
                }}
                className={inputClass}
              >
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </Labelled>
          ) : null}

          <Labelled label="Champion">
            <input
              list="data-view-champions"
              value={championInput}
              onChange={(event) => setChampionInput(event.target.value)}
              placeholder="Name or id"
              className={`${inputClass} w-40`}
            />
            <datalist id="data-view-champions">
              {championOptions.map((champion) => (
                <option key={champion.id} value={champion.name} />
              ))}
            </datalist>
          </Labelled>

          <Labelled label="Position">
            <select
              value={filter.position ?? ""}
              onChange={(event) =>
                changeFilter({ position: event.target.value ? (event.target.value as Position) : null })
              }
              className={inputClass}
            >
              <option value="">Any</option>
              {POSITIONS.map((position) => (
                <option key={position} value={position}>
                  {POSITION_LABELS[position]}
                </option>
              ))}
            </select>
          </Labelled>

          <Labelled label="Patch">
            <input
              value={filter.patch ?? ""}
              onChange={(event) => changeFilter({ patch: event.target.value.trim() || null })}
              placeholder="15.3"
              className={`${inputClass} w-20`}
            />
          </Labelled>

          <Labelled label="From">
            <input
              type="date"
              value={filter.from === null ? "" : toDateInput(filter.from)}
              onChange={(event) => changeFilter({ from: fromDateInput(event.target.value) })}
              className={inputClass}
            />
          </Labelled>

          <Labelled label="To">
            <input
              type="date"
              value={filter.to === null ? "" : toDateInput(shiftDay(filter.to, -1))}
              onChange={(event) => {
                // De gekozen dag hoort er zelf bij, dus de grens ligt op de volgende middernacht.
                const start = fromDateInput(event.target.value);
                changeFilter({ to: start === null ? null : shiftDay(start, 1) });
              }}
              className={inputClass}
            />
          </Labelled>

          {filtersActive ? (
            <button
              onClick={() => {
                setChampionInput("");
                changeFilter(EMPTY_FILTER);
              }}
              className={buttonClass}
            >
              Clear filters
            </button>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 ? (
              <button
                onClick={() =>
                  setConfirmation({ kind: "delete", serviceId: activeService, gameIds: [...selected] })
                }
                className={dangerClass}
                disabled={busy}
              >
                Delete {formatCount(selected.size)} selected
              </button>
            ) : null}
            <select
              value={limit}
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setOffset(0);
              }}
              className={inputClass}
              title="Rows per page"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="text-[10px] tracking-[0.14em] text-white/35 uppercase">
                <th className="w-8 py-2 pl-4">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={rows.length === 0}
                    aria-label="Select every match on this page"
                    className="accent-emerald-400"
                  />
                </th>
                <SortHeader label="Date" column="createdAt" sort={sort} direction={direction} onSort={toggleSort} />
                <SortHeader label="Queue" column="queueId" sort={sort} direction={direction} onSort={toggleSort} />
                <SortHeader label="Patch" column="patch" sort={sort} direction={direction} onSort={toggleSort} />
                <SortHeader label="Duration" column="duration" sort={sort} direction={direction} onSort={toggleSort} />
                <th className="py-2 font-medium">Champions</th>
                <th className="w-16 py-2 pr-4" />
              </tr>
            </thead>

            {rows.map((match) => (
              <tbody key={match.gameId} className="border-t border-white/6">
                <tr className="hover:bg-white/[0.03]">
                  <td className="py-2 pl-4 align-middle">
                    <input
                      type="checkbox"
                      checked={selected.has(match.gameId)}
                      onChange={() => toggleSelected(match.gameId)}
                      aria-label={`Select match ${match.gameId}`}
                      className="accent-emerald-400"
                    />
                  </td>
                  <td className="py-2 pr-4 tabular-nums whitespace-nowrap text-white/80">
                    {formatDateTime(match.createdAt)}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap text-white/60">{queueLabel(match.queueId)}</td>
                  <td className="py-2 pr-4 tabular-nums whitespace-nowrap text-white/60">{match.patch}</td>
                  <td className="py-2 pr-4 tabular-nums whitespace-nowrap text-white/60">
                    {formatDuration(match.duration)}
                  </td>
                  <td className="py-2 pr-4">
                    <TeamSummary players={match.players} championName={championName} />
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <button
                      onClick={() => setExpanded((current) => (current === match.gameId ? null : match.gameId))}
                      className="text-[11px] text-white/45 transition-colors hover:text-white"
                      aria-expanded={expanded === match.gameId}
                    >
                      {expanded === match.gameId ? "Close" : "Details"}
                    </button>
                  </td>
                </tr>
                {expanded === match.gameId ? (
                  <tr>
                    <td colSpan={7} className="bg-black/20 px-4 pb-4">
                      <MatchDetail
                        key={match.gameId}
                        match={match}
                        championName={championName}
                        busy={busy}
                        onSave={(edit) => void saveMatch(match.gameId, edit)}
                        onDelete={() =>
                          setConfirmation({
                            kind: "delete",
                            serviceId: activeService,
                            gameIds: [match.gameId],
                          })
                        }
                      />
                    </td>
                  </tr>
                ) : null}
              </tbody>
            ))}
          </table>

          {rows.length === 0 ? (
            <div className="py-14 text-center text-[12px] text-white/40">
              {/* Een mislukte lezing ziet er anders precies uit als een lege dataset, en die leugen is niet te herstellen zonder een filter aan te raken. */}
              {loadError ? (
                <div className="flex flex-col items-center gap-2.5">
                  <span className="text-rose-200">{loadError}</span>
                  <button onClick={() => void load()} disabled={loading} className={buttonClass}>
                    {loading ? "Retrying…" : "Retry"}
                  </button>
                </div>
              ) : loading ? (
                "Loading matches…"
              ) : filtersActive ? (
                "No matches for these filters."
              ) : (
                "No matches stored yet."
              )}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 px-4 py-3 text-[11px] text-white/45">
          <span className="tabular-nums">
            {total === 0
              ? "0 matches"
              : `${formatCount(offset + 1)}–${formatCount(Math.min(offset + rows.length, total))} of ${formatCount(total)} matches`}
            {loading ? " · loading…" : ""}
          </span>
          <div className="flex items-center gap-1.5">
            <button onClick={() => goTo(0)} disabled={pageIndex === 0} className={buttonClass}>
              First
            </button>
            <button onClick={() => goTo(pageIndex - 1)} disabled={pageIndex === 0} className={buttonClass}>
              Previous
            </button>
            <span className="px-2 tabular-nums">
              Page {formatCount(pageIndex + 1)} of {formatCount(pageCount)}
            </span>
            <button
              onClick={() => goTo(pageIndex + 1)}
              disabled={pageIndex >= pageCount - 1}
              className={buttonClass}
            >
              Next
            </button>
            <button onClick={() => goTo(pageCount - 1)} disabled={pageIndex >= pageCount - 1} className={buttonClass}>
              Last
            </button>
          </div>
        </div>
      </div>

      {confirmation ? (
        <ConfirmDialog
          title={confirmation.kind === "delete" ? "Delete matches" : "Repair the data file"}
          confirmLabel={
            confirmation.kind === "delete"
              ? `Delete ${formatCount(confirmation.gameIds.length)} match${confirmation.gameIds.length === 1 ? "" : "es"}`
              : "Repair now"
          }
          busy={busy}
          onCancel={() => {
            // Zodra de opdracht onderweg is valt er niets meer af te breken. Het venster
            // dan laten sluiten wekt de indruk dat het niet doorgaat, terwijl het bestand
            // al herschreven wordt.
            if (!busy) setConfirmation(null);
          }}
          onConfirm={() => void runConfirmation()}
        >
          {confirmation.kind === "delete" ? (
            <>
              <p>
                {confirmation.gameIds.length === 1
                  ? "This match is removed from the data file."
                  : `These ${formatCount(confirmation.gameIds.length)} matches are removed from the data file.`}{" "}
                There is no undo, and the games cannot be collected again.
              </p>
              <ul className="max-h-32 space-y-0.5 overflow-y-auto tabular-nums text-white/50">
                {confirmation.gameIds.slice(0, 20).map((gameId) => (
                  <li key={gameId}>Game {gameId}</li>
                ))}
                {confirmation.gameIds.length > 20 ? (
                  <li>and {formatCount(confirmation.gameIds.length - 20)} more…</li>
                ) : null}
              </ul>
            </>
          ) : (
            <RepairSummary plan={confirmation.plan} />
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

export default DataView;

function Labelled({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] tracking-[0.12em] text-white/35 uppercase">{label}</span>
      <span className="flex items-center gap-1.5">{children}</span>
    </label>
  );
}

function SortHeader({
  label,
  column,
  sort,
  direction,
  onSort,
}: {
  label: string;
  column: MatchSortKey;
  sort: MatchSortKey;
  direction: SortDirection;
  onSort: (column: MatchSortKey) => void;
}): JSX.Element {
  const active = sort === column;
  return (
    <th className="py-2 pr-4 font-medium">
      <button
        onClick={() => onSort(column)}
        className={`flex items-center gap-1 tracking-[0.14em] uppercase transition-colors ${
          active ? "text-white/70" : "hover:text-white/60"
        }`}
      >
        {label}
        <span className="text-[9px] opacity-70">{active ? (direction === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

/** De tien champions in twee ploegen, gekleurd naar wie won -- dat leest sneller dan een kolom "winner". */
function TeamSummary({
  players,
  championName,
}: {
  players: StoredPlayerRecord[];
  championName: (id: number) => string;
}): JSX.Element {
  const teams = [100, 200];
  return (
    <div className="flex items-center gap-2">
      {teams.map((teamId, index) => {
        const side = players.filter((player) => player.teamId === teamId);
        const won = side.some((player) => player.win);
        return (
          <span key={teamId} className="flex items-center gap-1">
            {index === 1 ? <span className="pr-1 text-[10px] text-white/25">vs</span> : null}
            {side.map((player) => (
              <span
                key={player.puuid}
                title={`${championName(player.championId)} · ${POSITION_LABELS[player.position]}`}
                className={`max-w-[72px] truncate rounded border px-1.5 py-0.5 text-[10px] ${
                  won
                    ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200/90"
                    : "border-rose-500/20 bg-rose-500/[0.07] text-rose-200/70"
                }`}
              >
                {championName(player.championId)}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}

interface Draft {
  createdAt: string;
  duration: string;
  queueId: string;
  patch: string;
  positions: Record<string, Position>;
}

const toDraft = (match: StoredMatchRecord): Draft => ({
  createdAt: toLocalInput(match.createdAt),
  duration: String(match.duration),
  queueId: String(match.queueId),
  patch: match.patch,
  positions: Object.fromEntries(match.players.map((player) => [player.puuid, player.position])),
});

/**
 * Het volledige record, met alleen die velden bewerkbaar waar een correctie
 * ergens op slaat: de tijdstempel, de duur, de queue, de patch en de positie.
 *
 * gameId en de spelersstatistieken blijven vast. Die komen rechtstreeks van de
 * client; ze met de hand bijstellen maakt de dataset niet beter maar onbetrouwbaar.
 * Positie wél, want die wordt uit lane plus role geraden en levert regelmatig
 * "Unknown" op.
 */
function MatchDetail({
  match,
  championName,
  busy,
  onSave,
  onDelete,
}: {
  match: StoredMatchRecord;
  championName: (id: number) => string;
  busy: boolean;
  onSave: (edit: MatchEdit) => void;
  onDelete: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => toDraft(match));

  useEffect(() => {
    setDraft(toDraft(match));
  }, [match]);

  const parsedCreatedAt = new Date(draft.createdAt).getTime();
  const parsedDuration = Number(draft.duration);
  const parsedQueue = Number(draft.queueId);
  const valid =
    !Number.isNaN(parsedCreatedAt) &&
    Number.isFinite(parsedDuration) &&
    parsedDuration > 0 &&
    Number.isFinite(parsedQueue) &&
    parsedQueue >= 0 &&
    draft.patch.trim().length > 0;

  /** Alleen sturen wat echt veranderd is: dan schrijft het main-proces ook alleen dat. */
  const edit = useMemo<MatchEdit>(() => {
    const next: MatchEdit = {};
    if (valid) {
      if (parsedCreatedAt !== match.createdAt) next.createdAt = parsedCreatedAt;
      if (parsedDuration !== match.duration) next.duration = parsedDuration;
      if (parsedQueue !== match.queueId) next.queueId = parsedQueue;
      if (draft.patch.trim() !== match.patch) next.patch = draft.patch.trim();
    }
    const positions: Record<string, Position> = {};
    for (const player of match.players) {
      const chosen = draft.positions[player.puuid];
      if (chosen && chosen !== player.position) positions[player.puuid] = chosen;
    }
    if (Object.keys(positions).length > 0) next.positions = positions;
    return next;
  }, [draft, match, valid, parsedCreatedAt, parsedDuration, parsedQueue]);

  const dirty = Object.keys(edit).length > 0;

  return (
    <div className="space-y-4 pt-1">
      <div className="flex flex-wrap items-end gap-3">
        <Labelled label="Played at">
          <input
            type="datetime-local"
            value={draft.createdAt}
            onChange={(event) => setDraft({ ...draft, createdAt: event.target.value })}
            className={inputClass}
          />
        </Labelled>
        <Labelled label="Duration (s)">
          <input
            value={draft.duration}
            onChange={(event) => setDraft({ ...draft, duration: event.target.value })}
            className={`${inputClass} w-24 tabular-nums`}
          />
          <span className="text-[11px] text-white/35 tabular-nums">
            {Number.isFinite(parsedDuration) ? formatDuration(parsedDuration) : "--"}
          </span>
        </Labelled>
        <Labelled label="Queue">
          <input
            value={draft.queueId}
            onChange={(event) => setDraft({ ...draft, queueId: event.target.value })}
            className={`${inputClass} w-20 tabular-nums`}
          />
          <span className="text-[11px] text-white/35">
            {Number.isFinite(parsedQueue) ? queueLabel(parsedQueue) : ""}
          </span>
        </Labelled>
        <Labelled label="Patch">
          <input
            value={draft.patch}
            onChange={(event) => setDraft({ ...draft, patch: event.target.value })}
            className={`${inputClass} w-20`}
          />
        </Labelled>
        <Labelled label="Game id">
          <span className="px-1 py-1.5 text-[12px] text-white/40 tabular-nums">{match.gameId}</span>
        </Labelled>

        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setDraft(toDraft(match))} disabled={!dirty || busy} className={buttonClass}>
            Discard
          </button>
          <button
            onClick={() => onSave(edit)}
            disabled={!dirty || !valid || busy}
            className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-[12px] font-medium text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save changes
          </button>
          <button onClick={onDelete} disabled={busy} className={dangerClass}>
            Delete match
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {[100, 200].map((teamId) => {
          const side = match.players.filter((player) => player.teamId === teamId);
          const won = side.some((player) => player.win);
          return (
            <div key={teamId} className="rounded-xl border border-white/8">
              <div className="flex items-center justify-between border-b border-white/6 px-3 py-1.5 text-[10px] tracking-[0.12em] uppercase">
                <span className="text-white/40">{teamId === 100 ? "Blue side" : "Red side"}</span>
                <span className={won ? "text-emerald-300" : "text-rose-300/80"}>{won ? "Win" : "Loss"}</span>
              </div>
              <table className="w-full text-[11px]">
                <tbody>
                  {side.map((player) => (
                    <tr key={player.puuid} className="border-t border-white/5">
                      <td className="py-1.5 pl-3 text-white/80">{championName(player.championId)}</td>
                      <td className="py-1.5">
                        <select
                          value={draft.positions[player.puuid] ?? player.position}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              positions: { ...draft.positions, [player.puuid]: event.target.value as Position },
                            })
                          }
                          className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-[11px] text-white/70 outline-none focus:border-emerald-400/40"
                        >
                          {POSITIONS.map((position) => (
                            <option key={position} value={position}>
                              {POSITION_LABELS[position]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1.5 tabular-nums text-white/60">
                        {player.kills}/{player.deaths}/{player.assists}
                      </td>
                      <td className="py-1.5 tabular-nums text-white/40">{player.cs} cs</td>
                      <td className="py-1.5 tabular-nums text-white/40">{formatCount(player.gold)}g</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-[10px] text-white/25" title={player.puuid}>
                        {player.puuid.slice(0, 8)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IntegrityPanel({
  report,
  busy,
  onRecheck,
  onRepair,
}: {
  report: IntegrityReport | null;
  busy: boolean;
  onRecheck: () => void;
  onRepair: () => void;
}): JSX.Element {
  const damaged = report ? report.broken + report.duplicates + report.incomplete : 0;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-6">
        <Stat label="Records" value={report ? formatCount(report.records) : "—"} />
        <Stat label="Broken lines" value={report ? formatCount(report.broken) : "—"} alert={(report?.broken ?? 0) > 0} />
        <Stat
          label="Duplicates"
          value={report ? formatCount(report.duplicates) : "—"}
          alert={(report?.duplicates ?? 0) > 0}
        />
        <Stat
          label="Incomplete"
          value={report ? formatCount(report.incomplete) : "—"}
          alert={(report?.incomplete ?? 0) > 0}
        />
        <Stat label="File size" value={report ? formatBytes(report.fileBytes) : "—"} />

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-white/30">
            {report ? `Checked ${formatDateTime(report.checkedAt)}` : "Not checked yet"}
          </span>
          <button onClick={onRecheck} disabled={busy} className={buttonClass}>
            Re-check
          </button>
          <button
            onClick={onRepair}
            disabled={busy || damaged === 0}
            title={damaged === 0 ? "Nothing to repair" : "Preview what a repair would change"}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-[12px] font-medium text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Repair…
          </button>
        </div>
      </div>
      {damaged > 0 ? (
        <p className="mt-2.5 text-[11px] text-amber-200/70">
          {formatCount(damaged)} line{damaged === 1 ? "" : "s"} would be dropped by a repair. Nothing is written until
          you review the plan and confirm.
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value, alert = false }: { label: string; value: string; alert?: boolean }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] tracking-[0.12em] text-white/35 uppercase">{label}</div>
      <div className={`text-[18px] font-semibold tabular-nums ${alert ? "text-amber-300" : "text-white/90"}`}>
        {value}
      </div>
    </div>
  );
}

function RepairSummary({ plan }: { plan: RepairPlan }): JSX.Element {
  const rows: Array<[string, string]> = [
    ["Broken lines removed", formatCount(plan.removeBroken)],
    ["Duplicates removed", formatCount(plan.removeDuplicates)],
    ["Incomplete records removed", formatCount(plan.removeIncomplete)],
    ["Records kept", formatCount(plan.keepRecords)],
    ["File size", `${formatBytes(plan.bytesBefore)} → ${formatBytes(plan.bytesAfter)}`],
  ];
  return (
    <>
      <p>
        The data file is rewritten from scratch with the lines below dropped. This is a preview — nothing has been
        written yet.
      </p>
      <dl className="divide-y divide-white/6 rounded-xl border border-white/10">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between px-3 py-1.5">
            <dt className="text-white/50">{label}</dt>
            <dd className="tabular-nums text-white/90">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-amber-200/70">Once the file is rewritten the removed lines are gone for good.</p>
    </>
  );
}

/**
 * Bevestiging voor alles wat niet terug te draaien is.
 *
 * Annuleren staat links en heeft de focus, zodat een enter-toets nooit per
 * ongeluk verwijdert; Escape doet hetzelfde. Loopt de opdracht eenmaal, dan
 * doen beide niets meer: annuleren kan alleen zolang er nog niets gebeurd is.
 */
function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  busy: boolean;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-white/12 bg-[#0d0f13] p-5 shadow-2xl">
        <h3 className="text-[14px] font-semibold text-white/90">{title}</h3>
        <div className="mt-3 space-y-2.5 text-[12px] leading-relaxed text-white/60">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} autoFocus disabled={busy} className={buttonClass}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy} className={dangerClass}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
