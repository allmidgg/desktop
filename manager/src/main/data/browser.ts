/**
 * Bladeren door, zoeken in en veranderen van de JSONL-matchdatabase.
 *
 * Dit is het enige stuk van de manager dat de databank mag overschrijven. Alles
 * eromheen (HTTP-routes, IPC, UI) mag stukgaan zonder dat er een byte verloren
 * gaat; hier niet. Vandaar dat de garanties expliciet opgeschreven staan --
 * wie hier iets verandert, moet ze alle zes kunnen blijven waarmaken.
 *
 * ── Wat dit bestand garandeert ────────────────────────────────────────────────
 *
 * 1. NOOIT ter plekke schrijven. Elke wijziging loopt via één primitieve
 *    (`applyEditsLocked`) die een compleet nieuw bestand naast het oude neerzet, dat
 *    naar schijf dwingt (fsync) en het pas dan omwisselt met één rename. Een
 *    crash halverwege laat het origineel onaangeroerd achter; hooguit blijft er
 *    een `.tmp-...` bestand liggen dat niemand iets doet.
 * 2. Regels die je niet aanraakt komen er byte-voor-byte weer uit. We kopiëren
 *    bytes, we serialiseren niet opnieuw. Een record dat velden bevat die deze
 *    versie van de code nog niet kent, overleeft dus elke bewerking -- ook de
 *    bewerking van zijn buurman.
 * 3. `repair()` gooit niets weg zonder kopie. Wat eruit gaat wordt eerst naar
 *    een quarantainebestand geschreven; mislukt dat, dan gaat de reparatie niet
 *    door. `dryRun` laat vooraf precies zien wat er zou sneuvelen. Het meten, het
 *    kopiëren naar quarantaine en het snijden vallen binnen hetzelfde slot (punt 4),
 *    zodat het mes op precies het bestand valt waarop gemeten is.
 * 4. Eén schrijver tegelijk op dit pad -- ook als die schrijver een ander object is --
 *    en het slot dekt de héle lees-wijzig-schrijf, niet alleen het schrijven.
 *    Alle acties van deze klasse lopen door een interne wachtrij, en elk pad dat de
 *    databank wijzigt neemt daarbovenop het gedeelde slot uit `writeQueue.ts` op het
 *    bestandspad. Dat slot hoort bij het pad en niet bij deze instantie, dus de
 *    uploader van de draaiende service -- die met losse appends in ditzelfde bestand
 *    schrijft -- komt in dezelfde ketting terecht.
 *
 *    Wat er binnen dat slot valt, per schrijfpad:
 *      - `update()` en `removeMany()`: de `ingestTail()` die de offsets oplevert, het
 *        opbouwen van de bewerkingen én het toepassen ervan.
 *      - `repair()`: de volledige scan van het bestand, het schrijven van de
 *        quarantaine en het toepassen.
 *      - `applyEditsLocked()`: de groottecontrole, de kopieerslag, de rename, het
 *        bijwerken van de index en de melding aan de luisteraars.
 *    Precies één plek neemt het slot -- `locked()` -- en alles daarbinnen gaat ervan
 *    uit dat het al gehouden wordt. Dat is geen stijlkeuze: de ketting is niet
 *    herintreedbaar (zie writeQueue.ts), dus een tweede aanroep vanuit een
 *    sloteigenaar wacht op zichzelf. Vandaar de naam van `applyEditsLocked`.
 *
 *    Hier heeft twee keer eerder iets optimistischers gestaan.
 *    Eerst: dat één interne wachtrij genoeg was. LolClassicService had zijn eigen
 *    wachtrij, en een append kon daardoor landen in het venster tussen de laatste
 *    groottecontrole en de rename -- een fsync over honderden megabytes lang.
 *    Daarna: dat een slot om de schrijfactie heen genoeg was. `repair()` scande het
 *    bestand er nog buiten; een uploader die zijn append in dat venster afmaakte,
 *    liet een regel achter die de scan nog als 'afgebroken' had genoteerd. De rename
 *    knipte dat inmiddels complete record vervolgens doormidden op de oude
 *    eindpositie. In beide gevallen had de client allang 'accepted' gekregen en zou
 *    hij de game nooit meer aanbieden. Buiten dit proces geldt de garantie nog steeds
 *    niet; zie de waarschuwing bij `applyEditsLocked`.
 *
 *    Zuivere lezers (`browse`, `get`, `facets`, `verify`, `exportSelection`) nemen
 *    het slot bewust níét. Ze zouden de UI achter elke upload zetten, en ze kunnen
 *    geen byte kwijtmaken. Leest zo'n lezer een offset die net verschoven is, dan
 *    maakt `toRecord` daar een 'invalid' record van in plaats van een verzonnen
 *    record -- de index wordt daar met opzet niet geloofd. Een lezer levert dus
 *    hooguit te weinig op, nooit iets verkeerds.
 * 5. Wie dit bestand in het geheugen heeft, hoort van elke wijziging. Na een
 *    geslaagde schrijfactie krijgen de luisteraars van `watch()` te horen wat er
 *    precies veranderde, nog vóórdat het slot losgaat. Zonder dat bleef de
 *    MatchStore van de draaiende service een verwijderde game 'kennen', zodat een
 *    client die hem opnieuw aanbood 'duplicate' terugkreeg en de game nooit meer
 *    terugkwam.
 * 6. Het lichaam van de records komt nooit en bloc in het geheugen. We houden
 *    per regel een handvol velden plus een byte-offset bij (~250 bytes/record,
 *    dus tientallen MB's voor een bestand van honderden MB's) en lezen alleen
 *    de regels van de zichtbare pagina echt uit.
 *
 * ── Waarom een index in plaats van het bestand inlezen ────────────────────────
 *
 * De opslag groeit voorbij de 124 MB. Dat past nog wel in het geheugen, maar
 * niet meer met marge, en de manager draait naast de rest van de app. Eén keer
 * langs het bestand lopen bij het starten en daarna alleen nog gerichte reads
 * op bekende offsets houdt het geheugengebruik plat en de UI snel: filteren en
 * sorteren gebeurt op de index, en pas de vijftig regels die in beeld komen
 * worden echt van schijf gehaald.
 */
import { mkdir, open as openFile, readdir, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { defaultStorePath } from "../../../../src/core/services/matchStore";
import type { Position, StoredMatch } from "../../../../src/core/services/matchStore";
import { isWriting, withWriteLock } from "./writeQueue";

/** Leesblok voor het scannen en kopiëren; groot genoeg om de syscall-kosten te verdrinken. */
const READ_CHUNK = 1 << 20;
/** Boven deze lengte is een 'regel' geen record meer maar een ongeluk; we weigeren hem in het geheugen te trekken. */
const MAX_LINE_BYTES = 4 << 20;
/** Losse regels vlak bij elkaar halen we in één read op; dit is het gat dat we daarbij overbruggen. */
const COALESCE_GAP = 64 * 1024;
/** Bovengrens aan wat zo'n gecombineerde read mag kosten. */
const COALESCE_MAX = 8 << 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Rapportages zijn UI-materiaal, geen logboek: meer dan dit leest niemand. */
const MAX_ISSUES = 200;
const PREVIEW_CHARS = 160;
const SWAP_RETRIES = 6;
/** Hoe vaak we een groeiende staart nog achterna kopiëren voordat we het opgeven. */
const GROWTH_ROUNDS = 8;

/** Volgorde is vast: de index pakt de positie als drie bits achter het champion-id. */
const POSITIONS: readonly Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT", "UNKNOWN"];
const UNKNOWN_SLOT = POSITIONS.length - 1;

/* ─────────────────────────────── publieke types ─────────────────────────────── */

/**
 * Hoe leesbaar een regel is.
 *
 * Het onderscheid tussen 'suspect' en 'invalid' is de kern van het reparatiebeleid:
 * een suspect record heeft een bruikbare gameId en is dus met de hand te corrigeren,
 * een invalid regel is nergens meer aan op te hangen.
 */
export type RecordStatus = "valid" | "suspect" | "invalid";

export type SortKey = "date" | "duration" | "gameId" | "patch";
export type SortOrder = "asc" | "desc";

export interface BrowseFilter {
  /** Matcht als één speler dit kampioen speelde. Samen met `position`: diezelfde speler. */
  champion?: number;
  position?: Position;
  queueId?: number;
  patch?: string;
  /** Epoch-ms, beide grenzen inclusief; de aanroeper bepaalt zelf wat 'eind van de dag' is. */
  from?: number;
  to?: number;
  minDuration?: number;
  maxDuration?: number;
  gameId?: number;
  /** Standaard 'all'; 'suspect' laat precies de records zien die aandacht nodig hebben. */
  status?: RecordStatus | "all";
}

export interface BrowseQuery {
  filter?: BrowseFilter;
  sort?: SortKey;
  order?: SortOrder;
  offset?: number;
  /** Gekapt op 500: verder dan dat scrollt niemand, en het is de rem op een dure read. */
  limit?: number;
}

/**
 * Eén regel zoals de UI hem krijgt.
 *
 * `match` is het geparste record zelf, niet een genormaliseerde kopie: wie dit
 * ophaalt, aanpast en terugstuurt naar `update()` verliest geen velden die deze
 * versie van de code niet kent.
 */
export interface BrowseRecord {
  gameId: number | null;
  /** 1-gebaseerd regelnummer in het bestand, zoals een teksteditor het toont. */
  line: number;
  bytes: number;
  status: RecordStatus;
  match: StoredMatch | null;
  /** Alleen gevuld als het record niet als match te lezen is, afgekapt voor de UI. */
  raw: string | null;
  /** Engelse uitleg bij status !== 'valid'; komt letterlijk in beeld. */
  problem: string | null;
}

export interface BrowsePage {
  /** Aantal records dat aan het filter voldoet, niet het aantal op deze pagina. */
  total: number;
  offset: number;
  limit: number;
  records: BrowseRecord[];
}

/** Wat de UI nodig heeft om zijn filters te vullen; komt uit de index, niet van schijf. */
export interface BrowseFacets {
  records: number;
  valid: number;
  suspect: number;
  invalid: number;
  /** Nieuwste patch eerst. */
  patches: string[];
  queues: number[];
  champions: number[];
  oldest: number | null;
  newest: number | null;
  bytes: number;
}

export interface WriteResult {
  removed: number;
  replaced: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Aantal geïndexeerde regels na afloop. */
  records: number;
}

/**
 * Wat er zojuist met het bestand gebeurd is, precies genoeg om een geheugenbeeld
 * bij te werken zonder het bestand opnieuw in te lezen.
 *
 * Dat laatste is het hele punt: de draaiende service houdt honderdduizenden games
 * in een Map, en die na elke verwijdering van één record opnieuw van schijf halen
 * kost honderden megabytes aan leeswerk voor een wijziging van één regel.
 */
export interface DatabaseChange {
  /** gameIds die niet meer in het bestand staan. Ontdubbeld. */
  removed: readonly number[];
  /** Records zoals ze er nu staan, na een bewerking. */
  replaced: readonly StoredMatch[];
  /**
   * De wijziging is niet per record te beschrijven; de luisteraar moet zijn beeld
   * opnieuw opbouwen. Alleen `repair()` zet dit: die verwijdert ook regels zonder
   * bruikbare gameId, en bij dubbele gameIds verdwijnt wél een regel maar niet de
   * game -- 'removed' zou dan liegen, en een leugen is hier erger dan traag.
   */
  wholesale: boolean;
}

/**
 * Wordt aangeroepen ná een geslaagde schrijfactie, terwijl het schrijfslot op het
 * pad nog vastgehouden wordt.
 *
 * Dat is met opzet: wie achter ons in de wachtrij staat (een upload bijvoorbeeld)
 * ziet daardoor gegarandeerd het bijgewerkte beeld en niet het oude. De prijs is
 * een harde regel voor de luisteraar: hij mag zelf niet naar hetzelfde pad
 * schrijven via `withWriteLock`, want dan wacht hij op zichzelf.
 */
export type DatabaseListener = (change: DatabaseChange) => void | Promise<void>;

export type IssueKind =
  | "unparsable"
  | "not-an-object"
  | "no-game-id"
  | "malformed"
  | "duplicate-id"
  | "oversized"
  | "unterminated";

export interface IntegrityIssue {
  line: number;
  offset: number;
  bytes: number;
  kind: IssueKind;
  gameId: number | null;
  /** Engelse uitleg voor de UI. */
  detail: string;
  preview: string;
}

export interface IntegrityReport {
  path: string;
  bytes: number;
  /** Alle regels, inclusief lege. */
  lines: number;
  blank: number;
  valid: number;
  suspect: number;
  invalid: number;
  /** Regels die een gameId herhalen; de eerste voorkomens tellen niet mee. */
  duplicates: number;
  uniqueGameIds: number;
  /** De laatste regel mist een newline -- meestal een afgebroken append. */
  unterminatedTail: boolean;
  issues: IntegrityIssue[];
  issuesTruncated: boolean;
  durationMs: number;
}

export interface RepairOptions {
  /** Rapporteer wat er zou gebeuren zonder ook maar iets te schrijven. */
  dryRun?: boolean;
  /** Ook records weghalen die wél een gameId hebben maar niet de juiste vorm. Standaard nee. */
  dropSuspect?: boolean;
}

export interface RemovedLine {
  line: number;
  bytes: number;
  gameId: number | null;
  reason: string;
  preview: string;
}

export interface RepairReport {
  dryRun: boolean;
  removed: number;
  kept: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Waar de verwijderde regels naartoe zijn; null bij een dryRun of als er niets weg hoefde. */
  quarantinePath: string | null;
  details: RemovedLine[];
  detailsTruncated: boolean;
}

export interface ExportOptions {
  /** Doelbestand. Mag nooit de databank zelf zijn; dat weigeren we. */
  destination: string;
  query?: BrowseQuery;
  pretty?: boolean;
  /** Neem ook records mee die niet de juiste vorm hebben. Standaard nee. */
  includeSuspect?: boolean;
}

export interface ExportResult {
  path: string;
  records: number;
  /** Overgeslagen omdat ze niet leesbaar waren. */
  skipped: number;
  bytes: number;
}

export type BrowserLog = (level: "info" | "warn" | "error", message: string) => void;

/* ─────────────────────────── interne index-structuur ────────────────────────── */

/** Alles wat we van een regel onthouden zonder hem in het geheugen te houden. */
interface EntryFields {
  gameId: number | null;
  createdAt: number;
  duration: number;
  queueId: number;
  patch: string;
  /** Per speler `championId << 3 | positie`, zodat champion+positie samen te filteren zijn. */
  slots: number[];
  status: RecordStatus;
  problem: string;
}

interface IndexEntry extends EntryFields {
  /** Bytepositie van het begin van de regel. */
  start: number;
  /** Bytepositie van het begin van de volgende regel; de terminator zit er dus in. */
  end: number;
  /** Bytes van de inhoud zelf, zonder de afsluitende newline. */
  size: number;
  line: number;
}

/**
 * Eén bewerking op het bestand: het bereik [start, end) verdwijnt, en er komen
 * eventueel andere bytes voor in de plaats.
 *
 * Invariant waar `applyShift` op leunt: een bewerking dekt precies één regel, en
 * `replacement` eindigt op een newline.
 */
interface LineEdit {
  start: number;
  end: number;
  replacement: Buffer | null;
  /** Alleen bij een vervanging: waarmee de index-regel opnieuw gevuld wordt. */
  fields: EntryFields | null;
}

interface LineRef {
  line: number;
  start: number;
  end: number;
  size: number;
  /** Leeg als de regel te lang was om te lezen; kijk dan naar `oversized`. */
  text: string;
  oversized: boolean;
  terminated: boolean;
}

interface ScanResult {
  scannedTo: number;
  nextLine: number;
  /** Beginpositie van een laatste regel zonder newline, anders null. */
  unterminatedStart: number | null;
}

/** Een bereik in het bestand; genoeg om een regel terug te vinden zonder hem te bewaren. */
interface Span {
  start: number;
  size: number;
}

/** Een regel die `repair()` eruit wil hebben. Bewust zonder tekst: het kunnen er honderdduizend zijn. */
interface DoomedLine {
  start: number;
  end: number;
  size: number;
  line: number;
  gameId: number | null;
  /** Engelse uitleg, komt in het rapport. */
  reason: string;
  /** Lege regels hoeven niet in quarantaine; er valt niets te bewaren. */
  blank: boolean;
}

/* ───────────────────────────── kleine hulpstukken ───────────────────────────── */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const asArray = (value: unknown): readonly unknown[] | null => (Array.isArray(value) ? (value as unknown[]) : null);

const errorCode = (error: unknown): string =>
  isObject(error) && typeof error.code === "string" ? error.code : "";

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const preview = (text: string): string =>
  text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;

/**
 * Of twee paden hetzelfde bestand aanwijzen.
 *
 * Moet dezelfde normalisatie doen als `keyFor` in writeQueue.ts, anders zit er licht
 * tussen "dit is de databank" en "dit is de schrijfketting van de databank". Windows
 * kijkt niet naar hoofdletters: `C:\data\matches.jsonl` en `C:\DATA\MATCHES.JSONL`
 * zijn daar één bestand. Een vergelijking die dat verschil wél maakt, verklaart een
 * export over de databank heen voor onschuldig en vervangt hem door een JSON-array.
 *
 * Bewust een kopie en geen import: `keyFor` is niet geëxporteerd. Verandert de
 * normalisatie daar, dan hoort deze mee te veranderen.
 */
const samePath = (a: string, b: string): boolean => {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/**
 * Bytes naar tekst, met de twee dingen die een handmatig bewerkt bestand oplevert:
 * een BOM van een teksteditor en Windows-regeleindes. Beide zouden JSON.parse
 * laten struikelen, en een struikelende parse is bij ons een regel die 'kapot'
 * heet -- dat wil je niet op een bestand dat gewoon in Kladblok geopend is.
 */
function decodeLine(bytes: Buffer): string {
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  return text;
}

function positionSlot(value: unknown): number {
  if (typeof value !== "string") return UNKNOWN_SLOT;
  const index = (POSITIONS as readonly string[]).indexOf(value);
  return index < 0 ? UNKNOWN_SLOT : index;
}

/**
 * Patches vergelijken als getallenreeks. "14.10" hoort ná "14.9", en juist die
 * twee komen in dit spel om de twee weken langs.
 */
function comparePatch(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = Number.parseInt(left[i] ?? "", 10);
    const y = Number.parseInt(right[i] ?? "", 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}

/* ──────────────────────────────── validatie ─────────────────────────────────── */

/**
 * Wat er mis is met een speler, of "" als er niets mis is.
 *
 * Bewust in Engels geformuleerd: deze tekst komt via het rapport zo in beeld.
 */
function problemWithPlayer(value: unknown): string {
  if (!isObject(value)) return "not an object";
  if (typeof value.puuid !== "string" || value.puuid === "") return "missing puuid";
  if (!isNumber(value.championId)) return "missing championId";
  if (!isNumber(value.teamId)) return "missing teamId";
  if (!(POSITIONS as readonly string[]).includes(typeof value.position === "string" ? value.position : ""))
    return "unknown position";
  if (typeof value.win !== "boolean") return "missing win flag";
  for (const key of ["kills", "deaths", "assists", "cs", "gold"] as const) {
    if (!isNumber(value[key])) return `missing ${key}`;
  }
  const items = asArray(value.items);
  if (!items || !items.every(isNumber)) return "items are not a list of numbers";
  const spells = asArray(value.spells);
  if (!spells || spells.length !== 2 || !spells.every(isNumber)) return "spells are not two numbers";
  return "";
}

/**
 * Wat er mis is met een record, of "" als het klopt.
 *
 * Dit is de enige plek waar de vorm van een StoredMatch wordt vastgelegd; zowel
 * de typeguard, de index als de integriteitscontrole leunen erop. Eén definitie,
 * dus geen kans dat de controle strenger is dan de reparatie of andersom.
 */
function problemWithMatch(value: Record<string, unknown>): string {
  if (!isNumber(value.gameId)) return "field 'gameId' is missing or not a number";
  if (!isNumber(value.createdAt)) return "field 'createdAt' is missing or not a number";
  if (!isNumber(value.duration)) return "field 'duration' is missing or not a number";
  if (!isNumber(value.queueId)) return "field 'queueId' is missing or not a number";
  if (typeof value.patch !== "string") return "field 'patch' is missing or not text";
  const players = asArray(value.players);
  if (!players) return "field 'players' is missing or not a list";
  if (players.length === 0) return "field 'players' is empty";
  for (let i = 0; i < players.length; i++) {
    const problem = problemWithPlayer(players[i]);
    if (problem) return `player ${i + 1}: ${problem}`;
  }
  return "";
}

/**
 * Of iets een bruikbaar record is.
 *
 * Let op wat er níét gebeurt: we bouwen geen genormaliseerde kopie. Onbekende
 * extra velden mogen blijven bestaan -- ze zijn ooit door iemand weggeschreven
 * en het is niet aan de bladerlaag om ze op te ruimen.
 */
export function isStoredMatch(value: unknown): value is StoredMatch {
  return isObject(value) && problemWithMatch(value) === "";
}

function slotsOf(players: unknown): number[] {
  const list = asArray(players);
  if (!list) return [];
  const slots: number[] = [];
  for (const player of list) {
    if (!isObject(player)) continue;
    const champion = isNumber(player.championId) ? player.championId : 0;
    slots.push((champion << 3) | positionSlot(player.position));
  }
  return slots;
}

const unusable = (problem: string): EntryFields => ({
  gameId: null,
  createdAt: 0,
  duration: 0,
  queueId: -1,
  patch: "",
  slots: [],
  status: "invalid",
  problem,
});

/**
 * Eén regel tekst omzetten naar wat de index ervan onthoudt.
 *
 * Een record dat parseert maar niet de juiste vorm heeft blijft 'suspect' in
 * plaats van 'invalid', zolang er een gameId in zit. Zo'n record blijft gewoon
 * doorbladerbaar en met de hand te repareren, en `repair()` laat het met rust
 * tenzij je er expliciet om vraagt. Wat weg mag moet aantoonbaar kapot zijn.
 */
function describe(text: string, oversized: boolean): EntryFields {
  if (oversized) return unusable("line is too long to be a match record");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return unusable("not valid JSON");
  }
  if (!isObject(value)) return unusable("not a JSON object");
  if (!isNumber(value.gameId)) return unusable("no usable gameId");

  const problem = problemWithMatch(value);
  return {
    gameId: value.gameId,
    createdAt: isNumber(value.createdAt) ? value.createdAt : 0,
    duration: isNumber(value.duration) ? value.duration : 0,
    queueId: isNumber(value.queueId) ? value.queueId : -1,
    patch: typeof value.patch === "string" ? value.patch : "",
    slots: slotsOf(value.players),
    status: problem === "" ? "valid" : "suspect",
    problem,
  };
}

/* ──────────────────────────── bestand-primitieven ───────────────────────────── */

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written);
    if (result.bytesWritten === 0) throw new Error("Could not write to the temporary file; the disk may be full");
    written += result.bytesWritten;
  }
}

async function readExact(handle: FileHandle, buffer: Buffer, position: number, length: number): Promise<void> {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw new Error("The database ended earlier than expected; reload the browser");
    done += bytesRead;
  }
}

/** Kopieert [from, to) van bron naar doel en geeft terug hoeveel bytes dat waren. */
async function copyRange(
  source: FileHandle,
  target: FileHandle,
  buffer: Buffer,
  from: number,
  to: number,
): Promise<number> {
  let position = from;
  while (position < to) {
    const want = Math.min(buffer.length, to - position);
    const { bytesRead } = await source.read(buffer, 0, want, position);
    if (bytesRead === 0) throw new Error("The database was truncated while it was being rewritten; nothing changed");
    await writeAll(target, buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return to - from;
}

/**
 * Het tijdelijke bestand op zijn plek zetten.
 *
 * Op Windows kan een rename mislukken zolang een virusscanner of de zoekindexer
 * het doelbestand nog even vasthoudt. Dat is bijna altijd binnen een tel voorbij,
 * dus we proberen het een paar keer opnieuw. Blijft het mislukken, dan gooien we:
 * het origineel is dan nog steeds ongeschonden.
 */
async function swapIntoPlace(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || attempt >= SWAP_RETRIES) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

/**
 * De map zelf naar schijf dwingen, zodat ook de nieuwe naam de stroomstoring
 * overleeft. Windows staat dit niet toe en heeft het ook niet nodig; daar is de
 * rename zelf al de duurzame stap.
 */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await openFile(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* Geen fsync op mappen op dit platform; dat is hier geen bezwaar. */
  }
}

/**
 * Loopt met een vaste buffer door het bestand en roept `visit` aan per regel.
 *
 * Dit is de enige lezer die het hele bestand aanraakt; index, controle en
 * reparatie gebruiken hem alle drie, zodat ze het per definitie eens zijn over
 * waar een regel begint en eindigt.
 */
async function scanLines(
  handle: FileHandle,
  from: number,
  firstLine: number,
  visit: (ref: LineRef) => void,
): Promise<ScanResult> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK);
  let position = from;
  let lineStart = from;
  let line = firstLine;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let oversized = false;

  const push = (slice: Buffer): void => {
    pendingBytes += slice.length;
    if (oversized) return;
    if (pendingBytes > MAX_LINE_BYTES) {
      // Een regel van megabytes is geen record meer. We laten de inhoud vallen,
      // maar blijven wel tellen: de offsets moeten kloppen, anders wordt een
      // latere herschrijving levensgevaarlijk.
      pending = [];
      oversized = true;
      return;
    }
    pending.push(Buffer.from(slice));
  };

  const flush = (end: number, terminated: boolean): void => {
    const text = oversized ? "" : decodeLine(Buffer.concat(pending, pendingBytes));
    visit({ line, start: lineStart, end, size: pendingBytes, text, oversized, terminated });
    line++;
    pending = [];
    pendingBytes = 0;
    oversized = false;
    lineStart = end;
  };

  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, position);
    if (bytesRead === 0) break;
    const view = buffer.subarray(0, bytesRead);
    let cursor = 0;
    while (cursor < bytesRead) {
      const newline = view.indexOf(0x0a, cursor);
      if (newline === -1) {
        push(view.subarray(cursor));
        break;
      }
      push(view.subarray(cursor, newline));
      flush(position + newline + 1, true);
      cursor = newline + 1;
    }
    position += bytesRead;
  }

  if (pendingBytes > 0) {
    const start = lineStart;
    flush(position, false);
    return { scannedTo: position, nextLine: line, unterminatedStart: start };
  }
  return { scannedTo: position, nextLine: line, unterminatedStart: null };
}

/* ──────────────────────── query's uit een URL trekken ───────────────────────── */

/**
 * Een BrowseQuery uit querystring-parameters halen.
 *
 * Woont hier en niet in de HTTP-route omdat de betekenis van de parameters bij
 * de datalaag hoort: wie de filters uitbreidt, hoeft niet ook nog een route te
 * zoeken. Onbegrepen waarden worden gemeld in plaats van stilzwijgend genegeerd,
 * zodat een route er een nette 400 van kan maken in plaats van de verkeerde
 * pagina te tonen.
 */
export function parseBrowseQuery(params: URLSearchParams): { query: BrowseQuery; problems: string[] } {
  const problems: string[] = [];
  const filter: BrowseFilter = {};

  const number = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      problems.push(`Parameter '${key}' must be a number`);
      return undefined;
    }
    return value;
  };

  const champion = number("champion");
  if (champion !== undefined) filter.champion = champion;
  const queueId = number("queue");
  if (queueId !== undefined) filter.queueId = queueId;
  const from = number("from");
  if (from !== undefined) filter.from = from;
  const to = number("to");
  if (to !== undefined) filter.to = to;
  const minDuration = number("minDuration");
  if (minDuration !== undefined) filter.minDuration = minDuration;
  const maxDuration = number("maxDuration");
  if (maxDuration !== undefined) filter.maxDuration = maxDuration;
  const gameId = number("gameId");
  if (gameId !== undefined) filter.gameId = gameId;

  const patch = params.get("patch");
  if (patch) filter.patch = patch;

  const position = params.get("position");
  if (position) {
    if ((POSITIONS as readonly string[]).includes(position)) filter.position = position as Position;
    else problems.push(`Unknown position '${position}'`);
  }

  const status = params.get("status");
  if (status) {
    if (status === "all" || status === "valid" || status === "suspect" || status === "invalid") filter.status = status;
    else problems.push(`Unknown status '${status}'`);
  }

  const query: BrowseQuery = { filter };
  const sort = params.get("sort");
  if (sort) {
    if (sort === "date" || sort === "duration" || sort === "gameId" || sort === "patch") query.sort = sort;
    else problems.push(`Unknown sort key '${sort}'`);
  }
  const order = params.get("order");
  if (order) {
    if (order === "asc" || order === "desc") query.order = order;
    else problems.push(`Parameter 'order' must be 'asc' or 'desc'`);
  }
  const offset = number("offset");
  if (offset !== undefined) query.offset = offset;
  const limit = number("limit");
  if (limit !== undefined) query.limit = limit;

  return { query, problems };
}

/**
 * Waar de matchdatabank van een service staat.
 *
 * Bewust doorgegeven aan `defaultStorePath` in plaats van de indeling hier te
 * herhalen: twee helpers die allebei "het standaardpad" heten maar naar een ander
 * bestand wijzen, leveren precies wat we hierboven proberen uit te sluiten -- twee
 * schrijvers die denken dat ze alleen zijn.
 */
export const defaultDatabasePath = (dataRoot: string): string => defaultStorePath(dataRoot);

/* ─────────────────────────────── de bladeraar ───────────────────────────────── */

export class MatchBrowser {
  private entries: IndexEntry[] = [];
  /** Eerste voorkomen per gameId; dubbelen staan apart zodat de index licht blijft. */
  private firstById = new Map<number, IndexEntry>();
  private duplicateIds = new Set<number>();
  /** Patchnamen worden gedeeld: tienduizenden records kennen samen zo'n dertig patches. */
  private readonly patchPool = new Map<string, string>();
  private facetCache: BrowseFacets | null = null;

  /** Tot hoever het bestand geïndexeerd is; alles daarna is later aangeschoven. */
  private scanEnd = 0;
  private nextLine = 1;
  private unterminatedStart: number | null = null;
  private opened = false;

  /**
   * Alle bewerkingen van déze bladeraar staan achter elkaar in de rij.
   *
   * Niet vanwege snelheid, maar omdat een paginalezing offsets gebruikt die een
   * gelijktijdige herschrijving net verzet zou hebben. Serieel is hier simpelweg
   * de enige vorm die te beredeneren valt.
   *
   * Let op wat deze rij níét doet: hij geldt per instantie. Schrijvers búiten deze
   * klasse -- de uploader van de draaiende service -- komen er niet in. Daarvoor is
   * het gedeelde slot in `writeQueue.ts`, dat elke schrijfactie op dit pad in
   * dezelfde ketting zet; `locked()` is de enige plek die het neemt. Beide zijn
   * nodig: deze rij beschermt de index, dat slot beschermt het bestand.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /** Wie er bijgepraat wil worden als het bestand verandert. Zie `watch()`. */
  private readonly listeners = new Set<DatabaseListener>();

  constructor(
    private readonly path: string,
    private readonly log: BrowserLog = () => {},
  ) {}

  get file(): string {
    return this.path;
  }

  get loaded(): boolean {
    return this.opened;
  }

  /** Aantal geïndexeerde regels; goedkoop genoeg voor een periodieke summary(). */
  get size(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.scanEnd;
  }

  /** Epoch-ms van het jongste record, of null. Voor 'Last match' in de UI. */
  get newestAt(): number | null {
    let newest: number | null = null;
    for (const entry of this.entries) {
      if (entry.createdAt > 0 && (newest === null || entry.createdAt > newest)) newest = entry.createdAt;
    }
    return newest;
  }

  /**
   * Meldt een luisteraar aan die van elke geslaagde schrijfactie hoort.
   *
   * Hiervoor is dit er: de draaiende service houdt hetzelfde bestand in het
   * geheugen, en zonder deze melding blijft dat beeld staan op hoe het bestand er
   * vóór de bewerking uitzag. Een via de Data-weergave verwijderde game gold dan
   * nog steeds als 'bekend', dus een client die hem opnieuw aanbood kreeg
   * 'duplicate' en de game kwam nooit meer terug -- en de tellers van de service
   * bleven hem meetellen.
   *
   * Geeft terug hoe je hem weer afmeldt. Zie `DatabaseListener` voor de regel dat
   * een luisteraar niet naar hetzelfde pad mag schrijven.
   */
  watch(listener: DatabaseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Bouwt de index op. Mag traag zijn -- dit is precies waar start() de tijd voor krijgt. */
  async load(): Promise<void> {
    if (this.opened) return;
    await this.run(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await this.sweepTemporaries();
      await this.rebuild();
      this.opened = true;
      this.log("info", `Indexed ${this.entries.length} records (${Math.round(this.scanEnd / 1e6)} MB)`);
    });
  }

  /** Geeft de index vrij. Er staan geen bestanden open, dus meer dan dit is er niet. */
  async close(): Promise<void> {
    await this.run(async () => {
      this.entries = [];
      this.firstById = new Map();
      this.duplicateIds = new Set();
      this.patchPool.clear();
      this.facetCache = null;
      this.scanEnd = 0;
      this.nextLine = 1;
      this.unterminatedStart = null;
      this.opened = false;
    });
  }

  /**
   * Neemt regels op die er sinds de laatste keer bij zijn geschreven.
   *
   * De uploader schrijft er tijdens het bladeren gewoon achteraan; dat is precies
   * waarom JSONL gekozen is. We hoeven dan alleen de staart te lezen, niet het
   * hele bestand opnieuw.
   */
  async refresh(): Promise<boolean> {
    this.assertOpen();
    return this.run(() => this.ingestTail());
  }

  async facets(): Promise<BrowseFacets> {
    this.assertOpen();
    return this.run(async () => {
      await this.ingestTail();
      return this.computeFacets();
    });
  }

  async browse(query: BrowseQuery = {}): Promise<BrowsePage> {
    this.assertOpen();
    return this.run(async () => {
      await this.ingestTail();
      const picked = this.select(query.filter);
      this.order(picked, query.sort ?? "date", query.order ?? "desc");
      const offset = Math.max(0, Math.floor(query.offset ?? 0));
      const limit = clamp(Math.floor(query.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
      const page = picked.slice(offset, offset + limit);
      return { total: picked.length, offset, limit, records: await this.readEntries(page) };
    });
  }

  /** Eén record, of null als die gameId niet in het bestand staat. */
  async get(gameId: number): Promise<BrowseRecord | null> {
    this.assertOpen();
    return this.run(async () => {
      await this.ingestTail();
      const entry = this.firstById.get(gameId);
      if (!entry) return null;
      const [record] = await this.readEntries([entry]);
      return record ?? null;
    });
  }

  /**
   * Vervangt één record.
   *
   * We schrijven de aangeleverde waarde weg, niet een kopie die wij hebben
   * samengesteld: zo verdwijnen velden die deze versie van de code niet kent niet
   * stilletjes uit de databank. JSON.stringify escapet elke newline, dus wat we
   * wegschrijven is per definitie precies één regel -- daar staat of valt JSONL mee.
   */
  async update(gameId: number, next: unknown): Promise<WriteResult> {
    this.assertOpen();
    return this.run(async () => {
      // De vormcontrole raakt het bestand niet en hoeft dus geen slot: een afgekeurd
      // record mag geen upload ophouden.
      if (!isStoredMatch(next)) {
        const problem = isObject(next) ? problemWithMatch(next) : "the body is not a JSON object";
        throw new Error(`Rejected: ${problem}`);
      }
      if (next.gameId !== gameId) {
        throw new Error(`Rejected: the record carries gameId ${next.gameId} but ${gameId} was addressed`);
      }
      // Vastgelegd in een const omdat TypeScript de versmalling van een parameter niet
      // meeneemt in de closure hieronder.
      const record: StoredMatch = next;

      // Vanaf hier gaat het over bytes op schijf, en dan geldt de regel uit
      // writeQueue.ts: het slot dekt de hele lees-wijzig-schrijf. `ingestTail()`
      // levert de offset op waar we straks overheen schrijven; buiten het slot zou
      // een append tussen die meting en de rename kunnen landen. Dat appends alleen
      // aan de staart groeien maakte dat vroeger toevallig ongevaarlijk -- een
      // gewoonte van de huidige schrijver, geen garantie van dit bestand.
      return this.locked(async () => {
        await this.ingestTail();
        if (this.duplicateIds.has(gameId)) {
          throw new Error(`Game ${gameId} appears more than once; run a repair before editing it`);
        }
        const entry = this.firstById.get(gameId);
        if (!entry) throw new Error(`Game ${gameId} is not in the database`);

        const json = JSON.stringify(record);
        const line = Buffer.from(`${json}\n`, "utf8");
        const fields = describe(json, false);
        // Het aangeleverde record en niet een kopie: de luisteraar zet precies dit in
        // zijn geheugen, dus het moet byte-voor-byte zijn wat er op schijf komt.
        const result = await this.applyEditsLocked(
          [{ start: entry.start, end: entry.end, replacement: line, fields }],
          { removed: [], replaced: [record], wholesale: false },
        );
        this.log("info", `Updated game ${gameId}`);
        return result;
      });
    });
  }

  /**
   * Haalt een record weg.
   *
   * Staat een gameId meer dan eens in het bestand -- wat op zichzelf al een defect
   * is -- dan gaan alle voorkomens eruit. 'Verwijder deze game' moet betekenen dat
   * hij daarna weg is, niet dat er nog een oude kopie achterblijft.
   */
  async remove(gameId: number): Promise<WriteResult> {
    return this.removeMany([gameId]);
  }

  /**
   * Meerdere records in één keer.
   *
   * Belangrijk genoeg om apart te bestaan: elke verwijdering kost een volledige
   * herschrijving van het bestand, dus vijftig losse aanroepen zouden vijftig keer
   * 124 MB kopiëren. Zo is het één keer.
   */
  async removeMany(gameIds: readonly number[]): Promise<WriteResult> {
    this.assertOpen();
    return this.run(() =>
      // Meten en toepassen onder hetzelfde slot: elke `start`/`end` hieronder komt uit
      // `ingestTail()`, en tussen die meting en de rename mag er niets aan het bestand
      // veranderen. Zie de opmerking bij `update()`.
      this.locked(async () => {
        await this.ingestTail();
        const wanted = new Set(gameIds);
        const edits: LineEdit[] = [];
        // Wat er echt verdwijnt, niet wat er gevraagd is: een gameId die niet in het
        // bestand staat mag de service niet als 'verwijderd' te horen krijgen.
        const gone = new Set<number>();
        for (const entry of this.entries) {
          if (entry.gameId !== null && wanted.has(entry.gameId)) {
            edits.push({ start: entry.start, end: entry.end, replacement: null, fields: null });
            gone.add(entry.gameId);
          }
        }
        if (edits.length === 0) {
          throw new Error(gameIds.length === 1 ? `Game ${gameIds[0]} is not in the database` : "No matching records");
        }
        const result = await this.applyEditsLocked(edits, { removed: [...gone], replaced: [], wholesale: false });
        this.log("info", `Removed ${result.removed} record(s)`);
        return result;
      }),
    );
  }

  /**
   * Leest het hele bestand na en rapporteert wat er niet klopt.
   *
   * Doet dit met een verse scan in plaats van met de index: zo vangt hij ook op
   * dat de index zelf naast de werkelijkheid is komen te staan (iemand die het
   * bestand buiten de app om bewerkt heeft, bijvoorbeeld). Duur, dus alleen op
   * verzoek van de gebruiker.
   */
  async verify(): Promise<IntegrityReport> {
    this.assertOpen();
    return this.run(async () => {
      const started = Date.now();
      const report: IntegrityReport = {
        path: this.path,
        bytes: (await this.fileSize()) ?? 0,
        lines: 0,
        blank: 0,
        valid: 0,
        suspect: 0,
        invalid: 0,
        duplicates: 0,
        uniqueGameIds: 0,
        unterminatedTail: false,
        issues: [],
        issuesTruncated: false,
        durationMs: 0,
      };
      const seen = new Set<number>();
      const note = (issue: IntegrityIssue): void => {
        if (report.issues.length < MAX_ISSUES) report.issues.push(issue);
        else report.issuesTruncated = true;
      };

      const handle = await openFile(this.path, "r").catch(() => null);
      if (!handle) {
        report.durationMs = Date.now() - started;
        return report;
      }
      try {
        const scan = await scanLines(handle, 0, 1, (ref) => {
          report.lines++;
          if (!ref.oversized && ref.text.trim() === "") {
            report.blank++;
            return;
          }
          const fields = describe(ref.text, ref.oversized);
          const base = { line: ref.line, offset: ref.start, bytes: ref.size, preview: preview(ref.text) };
          if (fields.status === "invalid") {
            report.invalid++;
            note({ ...base, kind: kindOf(fields.problem, ref.oversized), gameId: null, detail: fields.problem });
            return;
          }
          const gameId = fields.gameId;
          if (gameId !== null) {
            if (seen.has(gameId)) {
              report.duplicates++;
              note({ ...base, kind: "duplicate-id", gameId, detail: `game ${gameId} also appears earlier` });
            } else {
              seen.add(gameId);
            }
          }
          if (fields.status === "suspect") {
            report.suspect++;
            note({ ...base, kind: "malformed", gameId, detail: fields.problem });
          } else {
            report.valid++;
          }
        });
        if (scan.unterminatedStart !== null) {
          report.unterminatedTail = true;
          note({
            line: scan.nextLine - 1,
            offset: scan.unterminatedStart,
            bytes: scan.scannedTo - scan.unterminatedStart,
            kind: "unterminated",
            gameId: null,
            detail: "the last line has no newline; an append was probably interrupted",
            preview: "",
          });
        }
      } finally {
        await handle.close();
      }
      report.uniqueGameIds = seen.size;
      report.durationMs = Date.now() - started;
      return report;
    });
  }

  /**
   * Haalt kapotte regels eruit en vertelt wat er weg ging.
   *
   * Twee dingen die deze functie bewust niet doet. Hij verwijdert geen records die
   * alleen maar 'raar' zijn (zie `dropSuspect`) -- alleen wat aantoonbaar geen
   * record meer is. En hij gooit niets weg zonder kopie: alles wat sneuvelt gaat
   * eerst naar een quarantainebestand naast de databank. Lukt dát niet, dan gaat
   * de reparatie niet door.
   *
   * Bij dubbele gameIds blijft het laatste voorkomen staan, omdat dat ook is wat
   * MatchStore in het geheugen overhoudt: de laatst gelezen regel wint.
   *
   * De scan, de quarantaine en de herschrijving zitten samen in één slot. Dat is de
   * hele reden dat deze functie zo diep genest is: de bereiken die hieronder worden
   * uitgeknipt komen uit een scan, en een scan die buiten het slot loopt meet een
   * bestand dat daarna nog verandert. Een uploader die zijn append in dat venster
   * afmaakte, veranderde een 'afgebroken laatste regel' in een compleet record --
   * en de herschrijving sneed het vervolgens doormidden op de oude eindpositie.
   *
   * Ook een `dryRun` neemt het slot. Niet omdat hij iets kan slopen, maar omdat hij
   * anders midden in een lopende append kan scannen en een half geschreven regel als
   * 'kapot' rapporteert. Een rapport dat een gezond record aanwijst is erger dan een
   * rapport dat even op zich laat wachten.
   */
  async repair(options: RepairOptions = {}): Promise<RepairReport> {
    this.assertOpen();
    const dryRun = options.dryRun ?? false;
    const dropSuspect = options.dropSuspect ?? false;

    return this.run(() =>
      this.locked(async () => {
        await this.ingestTail();
        const bytesBefore = (await this.fileSize()) ?? 0;
        const doomed: DoomedLine[] = [];
        /** Per bewaarde regel alleen het bereik: de tekst zou het hele bestand zijn. */
        const keepers: DoomedLine[] = [];
        const lastById = new Map<number, number>();
        let kept = 0;

        const handle = await openFile(this.path, "r").catch(() => null);
        if (!handle) throw new Error("The database file does not exist");
        try {
          await scanLines(handle, 0, 1, (ref) => {
            if (!ref.oversized && ref.text.trim() === "") {
              doomed.push({ ...span(ref), gameId: null, reason: "blank line", blank: true });
              return;
            }
            const fields = describe(ref.text, ref.oversized);
            if (fields.status === "invalid" || (dropSuspect && fields.status === "suspect")) {
              doomed.push({ ...span(ref), gameId: fields.gameId, reason: fields.problem, blank: false });
              return;
            }
            kept++;
            if (fields.gameId !== null) {
              const previous = lastById.get(fields.gameId);
              if (previous !== undefined) {
                // Het laatste voorkomen wint, want dat is ook wat MatchStore in het
                // geheugen overhoudt als hij het bestand inleest.
                const older = keepers[previous];
                if (older) doomed.push(older);
                kept--;
              }
              lastById.set(fields.gameId, keepers.length);
            }
            keepers.push({
              ...span(ref),
              gameId: fields.gameId,
              reason: `superseded by a later copy of game ${fields.gameId ?? 0}`,
              blank: false,
            });
          });
        } finally {
          await handle.close();
        }
        doomed.sort((a, b) => a.start - b.start);

        if (doomed.length === 0) {
          return {
            dryRun,
            removed: 0,
            kept,
            bytesBefore,
            bytesAfter: bytesBefore,
            quarantinePath: null,
            details: [],
            detailsTruncated: false,
          };
        }

        // Voorbeelden voor het rapport: alleen de eerste paar, en per regel maar een
        // stukje. Een rapport hoort een mens te informeren, geen bestand te dupliceren.
        const shown = doomed.slice(0, MAX_ISSUES);
        const previews = await this.readRaw(shown, PREVIEW_CHARS * 4);
        const details: RemovedLine[] = shown.map((line, index) => ({
          line: line.line,
          bytes: line.size,
          gameId: line.gameId,
          reason: line.reason,
          preview: preview(previews[index] ?? ""),
        }));
        const detailsTruncated = doomed.length > shown.length;

        if (dryRun) {
          const freed = doomed.reduce((sum, line) => sum + (line.end - line.start), 0);
          return {
            dryRun,
            removed: doomed.length,
            kept,
            bytesBefore,
            bytesAfter: bytesBefore - freed,
            quarantinePath: null,
            details,
            detailsTruncated,
          };
        }

        // Eerst de kopie, dan pas het mes. Faalt het schrijven van de quarantaine,
        // dan is er nog niets gebeurd en houdt de gebruiker zijn kapotte bestand --
        // altijd beter dan een half opgeruimd bestand zonder vangnet. Ook dit kopiëren
        // valt binnen het slot: het leest dezelfde bereiken die de scan opleverde, dus
        // zodra het bestand ertussendoor mag veranderen bewaart de quarantaine iets
        // anders dan wat er straks weggeknipt wordt.
        const quarantinePath = `${this.path}.removed-${stamp()}.jsonl`;
        await this.quarantine(quarantinePath, doomed);

        // 'wholesale': een reparatie haalt ook regels weg die nooit een record waren,
        // en bij dubbele gameIds verdwijnt er wél een regel maar niet de game. Een
        // lijstje 'removed' zou daar de verkeerde indruk wekken; wie meeleest bouwt
        // zijn beeld hier dus liever opnieuw op.
        const result = await this.applyEditsLocked(
          doomed.map((line) => ({ start: line.start, end: line.end, replacement: null, fields: null })),
          { removed: [], replaced: [], wholesale: true },
          "rebuild",
        );
        this.log("warn", `Repair removed ${result.removed} line(s); a copy is in ${quarantinePath}`);
        return {
          dryRun,
          removed: result.removed,
          kept,
          bytesBefore,
          bytesAfter: result.bytesAfter,
          quarantinePath,
          details,
          detailsTruncated,
        };
      }),
    );
  }

  /**
   * Schrijft een selectie weg als één JSON-array.
   *
   * Streamt record voor record, zodat een export van de hele databank niet eerst
   * 124 MB aan JavaScript-objecten hoeft te worden. Gaat via hetzelfde tijdelijke
   * bestand en dezelfde omwisseling als de rest: een mislukte export laat nooit
   * een half bestand achter waar iemand later mee gaat rekenen.
   *
   * Neemt het slot op de databank níét: dit is een lezer (zie garantie 4 bovenaan).
   * Hij kan hooguit records overslaan als de offsets onder hem verschuiven, want
   * `toRecord` valideert elke regel opnieuw en levert dan 'invalid' op -- en die
   * gaan niet mee de export in.
   */
  async exportSelection(options: ExportOptions): Promise<ExportResult> {
    this.assertOpen();
    return this.run(async () => {
      const destination = resolve(options.destination);
      // De enige manier waarop deze functie data kan vernietigen, en dus de enige
      // controle die er echt toe doet. Hoofdletterongevoelig op Windows, want daar is
      // `MATCHES.JSONL` hetzelfde bestand als `matches.jsonl` -- een vergelijking die
      // dat verschil wél maakt, laat de databank vervangen door een JSON-array.
      // (De controle dekt de databank van déze bladeraar; wie hier ooit een pad van
      // buiten op loslaat, kijkt zelf of het niet de databank van een andere service
      // is.)
      if (samePath(destination, this.path)) throw new Error("Refusing to export over the database itself");

      await this.ingestTail();
      const picked = this.select(options.query?.filter);
      this.order(picked, options.query?.sort ?? "date", options.query?.order ?? "desc");
      const offset = Math.max(0, Math.floor(options.query?.offset ?? 0));
      const limit = options.query?.limit;
      const selection =
        limit === undefined ? picked.slice(offset) : picked.slice(offset, offset + Math.max(0, Math.floor(limit)));

      await mkdir(dirname(destination), { recursive: true });
      // Het slot ligt op het doelbestand en niet op de databank: twee services die
      // naar hetzelfde exportpad schrijven zouden elkaars bestand overschrijven.
      // Een cyclus kan hier niet ontstaan, want exporteren over de databank heen is
      // hierboven al geweigerd -- we houden dus nooit twee sloten op één pad.
      return withWriteLock(destination, async () => {
        const tempPath = `${destination}.tmp-${process.pid}-${Date.now().toString(36)}`;
        const target = await openFile(tempPath, "wx");
        let records = 0;
        let skipped = 0;
        let bytes = 0;
        try {
          const write = async (text: string): Promise<void> => {
            const chunk = Buffer.from(text, "utf8");
            await writeAll(target, chunk);
            bytes += chunk.length;
          };
          await write("[\n");
          for (let i = 0; i < selection.length; i += 200) {
            const batch = await this.readEntries(selection.slice(i, i + 200));
            for (const record of batch) {
              const usable =
                record.match !== null && (record.status === "valid" || (options.includeSuspect ?? false));
              if (!usable) {
                skipped++;
                continue;
              }
              const json = options.pretty ? JSON.stringify(record.match, null, 2) : JSON.stringify(record.match);
              await write(records === 0 ? json : `,\n${json}`);
              records++;
            }
          }
          await write("\n]\n");
          await target.sync();
        } catch (error) {
          await target.close();
          await rm(tempPath, { force: true });
          throw error;
        }
        await target.close();
        await swapIntoPlace(tempPath, destination);
        this.log("info", `Exported ${records} record(s) to ${destination}`);
        return { path: destination, records, skipped, bytes };
      });
    });
  }

  /* ───────────────────────────── interne werking ──────────────────────────── */

  private assertOpen(): void {
    if (!this.opened) throw new Error("The match browser has not been loaded yet");
  }

  /** Zet een taak achteraan de rij; een fout in de ene taak mag de volgende niet blokkeren. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * De enige plek in deze klasse die het gedeelde slot op de databank neemt.
   *
   * Eén plek, omdat de ketting niet herintreedbaar is (zie writeQueue.ts): wie het
   * slot al heeft en het nog eens neemt, wacht op zichzelf. Alles wat hieronder
   * draait -- `ingestTail`, `scanLines`, `quarantine`, `applyEditsLocked`, de melding
   * aan de luisteraars -- gaat er dus vanuit dat het slot al gehouden wordt en neemt
   * het zelf niet.
   *
   * De taak hoort de héle lees-wijzig-schrijf te omvatten en niet alleen het
   * schrijven. Een offset die buiten het slot gemeten is, is een offset die tegen de
   * tijd dat hij gebruikt wordt naar iets anders kan wijzen.
   */
  private async locked<T>(task: () => Promise<T>): Promise<T> {
    // Even melden dat we wachten. Een bewerking die achter een upload in de rij staat
    // lijkt vanuit de UI anders zomaar traag te zijn.
    if (isWriting(this.path)) this.log("info", "Waiting for another writer to release the database");
    return withWriteLock(this.path, task);
  }

  /**
   * Ruimt tijdelijke bestanden op van een herschrijving die nooit is afgemaakt.
   *
   * Zo'n bestand is een volledige kopie van de databank, dus na een crash staat er
   * zomaar 124 MB voor niets op schijf. Ze zijn per definitie waardeloos: bestaat
   * het tijdelijke bestand nog, dan is de rename niet gebeurd en is het origineel
   * dus nog compleet. Draait er onverhoopt een tweede manager die er wél mee bezig
   * is, dan mislukt hooguit zijn herschrijving -- en die laat het origineel met rust.
   */
  private async sweepTemporaries(): Promise<void> {
    const prefix = `${basename(this.path)}.tmp-`;
    try {
      const folder = dirname(this.path);
      const stale = (await readdir(folder)).filter((name) => name.startsWith(prefix));
      for (const name of stale) await rm(join(folder, name), { force: true }).catch(() => undefined);
      if (stale.length > 0) this.log("warn", `Cleaned up ${stale.length} leftover file(s) from an interrupted rewrite`);
    } catch {
      /* De map niet kunnen lezen is geen reden om niet te starten. */
    }
  }

  private async fileSize(): Promise<number | null> {
    try {
      return (await stat(this.path)).size;
    } catch {
      return null;
    }
  }

  private async rebuild(): Promise<void> {
    this.entries = [];
    this.patchPool.clear();
    this.scanEnd = 0;
    this.nextLine = 1;
    this.unterminatedStart = null;
    await this.indexFrom(0, 1);
    this.afterIndexChange();
  }

  private async indexFrom(from: number, firstLine: number): Promise<void> {
    const handle = await openFile(this.path, "r").catch(() => null);
    if (!handle) return;
    try {
      const scan = await scanLines(handle, from, firstLine, (ref) => {
        // Lege regels dragen niets bij en horen niet in een lijst met records.
        // Ze houden hun regelnummer wel, zodat een rapport naar hetzelfde nummer
        // wijst als de teksteditor van de gebruiker.
        if (!ref.oversized && ref.text.trim() === "") return;
        this.entries.push(this.entryFrom(ref));
      });
      this.scanEnd = scan.scannedTo;
      this.nextLine = scan.nextLine;
      this.unterminatedStart = scan.unterminatedStart;
    } finally {
      await handle.close();
    }
  }

  private entryFrom(ref: LineRef): IndexEntry {
    const fields = describe(ref.text, ref.oversized);
    const shared = this.patchPool.get(fields.patch);
    if (shared === undefined) this.patchPool.set(fields.patch, fields.patch);
    else fields.patch = shared;
    return { ...fields, start: ref.start, end: ref.end, size: ref.size, line: ref.line };
  }

  /** Herbouwt de opzoektabellen; één keer per wijziging is goedkoper dan ze bijhouden. */
  private afterIndexChange(): void {
    this.firstById = new Map();
    this.duplicateIds = new Set();
    for (const entry of this.entries) {
      if (entry.gameId === null) continue;
      if (this.firstById.has(entry.gameId)) this.duplicateIds.add(entry.gameId);
      else this.firstById.set(entry.gameId, entry);
    }
    this.facetCache = null;
  }

  /**
   * Leest bij wat er sinds de laatste scan is aangeschoven.
   *
   * Is het bestand gekrompen of vervangen, dan klopt geen enkele offset meer en
   * bouwen we de index opnieuw op. Dat is traag, maar het alternatief -- doorgaan
   * met offsets die ergens midden in een andere regel wijzen -- is hoe je een
   * databank sloopt.
   */
  private async ingestTail(): Promise<boolean> {
    const size = await this.fileSize();
    if (size === null) {
      if (this.entries.length === 0 && this.scanEnd === 0) return false;
      this.log("warn", "The database file disappeared; the index was cleared");
      await this.rebuild();
      return true;
    }
    if (size < this.scanEnd) {
      this.log("warn", "The database shrank outside the manager; rebuilding the index");
      await this.rebuild();
      return true;
    }
    if (size === this.scanEnd) return false;

    // Een laatste regel zonder newline kan door de nieuwe bytes alsnog compleet
    // zijn geworden. Die lezen we opnieuw in plaats van er blind achteraan te
    // plakken, anders zou hij twee keer in de index staan.
    let from = this.scanEnd;
    let line = this.nextLine;
    const last = this.entries[this.entries.length - 1];
    if (this.unterminatedStart !== null && last && last.start === this.unterminatedStart) {
      this.entries.pop();
      from = last.start;
      line = last.line;
    } else if (this.unterminatedStart !== null) {
      from = this.unterminatedStart;
      line = this.nextLine - 1;
    }
    await this.indexFrom(from, line);
    this.afterIndexChange();
    return true;
  }

  /** Filtert op de index; raakt geen schijf aan. */
  private select(filter: BrowseFilter | undefined): IndexEntry[] {
    if (!filter) return [...this.entries];
    const status = filter.status ?? "all";
    const champion = filter.champion;
    const position = filter.position === undefined ? -1 : positionSlot(filter.position);
    const wanted =
      champion !== undefined && position >= 0 ? (champion << 3) | position : champion !== undefined ? champion : -1;

    const picked: IndexEntry[] = [];
    for (const entry of this.entries) {
      if (status !== "all" && entry.status !== status) continue;
      if (filter.gameId !== undefined && entry.gameId !== filter.gameId) continue;
      if (filter.queueId !== undefined && entry.queueId !== filter.queueId) continue;
      if (filter.patch !== undefined && entry.patch !== filter.patch) continue;
      if (filter.from !== undefined && entry.createdAt < filter.from) continue;
      if (filter.to !== undefined && entry.createdAt > filter.to) continue;
      if (filter.minDuration !== undefined && entry.duration < filter.minDuration) continue;
      if (filter.maxDuration !== undefined && entry.duration > filter.maxDuration) continue;
      if (champion !== undefined || position >= 0) {
        let hit = false;
        for (const slot of entry.slots) {
          // Champion én positie samen betekenen dezelfde speler, niet twee losse
          // voorwaarden: 'Lux als support' hoort geen game te vinden waarin de
          // ene speler Lux mid speelt en een ander toevallig support is.
          if (champion !== undefined && position >= 0) hit = slot === wanted;
          else if (champion !== undefined) hit = slot >> 3 === champion;
          else hit = (slot & 7) === position;
          if (hit) break;
        }
        if (!hit) continue;
      }
      picked.push(entry);
    }
    return picked;
  }

  /** Sorteert ter plekke; bij gelijke sleutels wint de bestandsvolgorde, zodat pagineren stabiel is. */
  private order(entries: IndexEntry[], key: SortKey, order: SortOrder): void {
    const sign = order === "asc" ? 1 : -1;
    entries.sort((a, b) => {
      let difference = 0;
      switch (key) {
        case "date":
          difference = a.createdAt - b.createdAt;
          break;
        case "duration":
          difference = a.duration - b.duration;
          break;
        case "gameId":
          difference = (a.gameId ?? 0) - (b.gameId ?? 0);
          break;
        case "patch":
          difference = comparePatch(a.patch, b.patch);
          break;
      }
      return difference !== 0 ? difference * sign : a.start - b.start;
    });
  }

  private async readEntries(picked: readonly IndexEntry[]): Promise<BrowseRecord[]> {
    const texts = await this.readRaw(picked);
    return picked.map((entry, index) => toRecord(entry, texts[index] ?? ""));
  }

  /**
   * Haalt de gevraagde regels echt van schijf, in dezelfde volgorde als gevraagd.
   *
   * Regels die dicht bij elkaar liggen worden in één read opgehaald. Dat scheelt
   * bij de gebruikelijke bladermodus (op volgorde van het bestand) vijftig reads
   * per pagina, en het kost niets als de selectie wél verspreid staat.
   *
   * `cap` begrenst wat we per regel in het geheugen halen. Zonder die grens zou
   * één kapotte regel van een halve gigabyte -- precies het soort regel dat je
   * hier wilt kunnen inzien -- de app omleggen.
   */
  private async readRaw(spans: readonly Span[], cap: number = MAX_LINE_BYTES): Promise<string[]> {
    if (spans.length === 0) return [];
    const wanted = spans.map((span, index) => ({
      start: span.start,
      end: span.start + Math.min(span.size, cap),
      index,
    }));
    const byPosition = [...wanted].sort((a, b) => a.start - b.start);
    const out = new Array<string>(spans.length).fill("");

    const handle = await openFile(this.path, "r");
    try {
      let i = 0;
      while (i < byPosition.length) {
        const first = byPosition[i];
        if (!first) break;
        let last = i;
        let rangeEnd = first.end;
        for (;;) {
          const next = byPosition[last + 1];
          if (!next) break;
          if (next.start - rangeEnd > COALESCE_GAP) break;
          if (next.end - first.start > COALESCE_MAX) break;
          rangeEnd = Math.max(rangeEnd, next.end);
          last++;
        }
        const buffer = Buffer.allocUnsafe(rangeEnd - first.start);
        await readExact(handle, buffer, first.start, buffer.length);
        for (let k = i; k <= last; k++) {
          const item = byPosition[k];
          if (!item) continue;
          const from = item.start - first.start;
          out[item.index] = decodeLine(buffer.subarray(from, from + (item.end - item.start)));
        }
        i = last + 1;
      }
    } finally {
      await handle.close();
    }
    return out;
  }

  /**
   * Zet de te verwijderen regels veilig, vóórdat er iets verdwijnt.
   *
   * We kopiëren bytes in plaats van de geparste tekst: wat in quarantaine belandt
   * is dan letterlijk wat er stond, tot en met de rare tekens die de regel om te
   * beginnen kapot maakten. En het werkt ongeacht hoe groot zo'n regel is.
   */
  private async quarantine(destination: string, doomed: readonly DoomedLine[]): Promise<void> {
    const source = await openFile(this.path, "r");
    try {
      const target = await openFile(destination, "wx");
      try {
        const buffer = Buffer.allocUnsafe(READ_CHUNK);
        const newline = Buffer.from("\n", "utf8");
        for (const line of doomed) {
          if (line.blank) continue;
          await copyRange(source, target, buffer, line.start, line.end);
          // Een afgebroken laatste regel heeft geen terminator; die zetten we erbij,
          // anders plakt hij in het quarantainebestand aan zijn buurman vast.
          if (line.end - line.start === line.size) await writeAll(target, newline);
        }
        await target.sync();
      } catch (error) {
        await target.close().catch(() => undefined);
        await rm(destination, { force: true }).catch(() => undefined);
        throw error;
      }
      await target.close();
    } finally {
      await source.close().catch(() => undefined);
    }
  }

  private computeFacets(): BrowseFacets {
    if (this.facetCache) return this.facetCache;
    const patches = new Set<string>();
    const queues = new Set<number>();
    const champions = new Set<number>();
    let valid = 0;
    let suspect = 0;
    let invalid = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const entry of this.entries) {
      if (entry.status === "valid") valid++;
      else if (entry.status === "suspect") suspect++;
      else invalid++;
      if (entry.patch) patches.add(entry.patch);
      if (entry.queueId >= 0) queues.add(entry.queueId);
      for (const slot of entry.slots) champions.add(slot >> 3);
      if (entry.createdAt > 0) {
        if (oldest === null || entry.createdAt < oldest) oldest = entry.createdAt;
        if (newest === null || entry.createdAt > newest) newest = entry.createdAt;
      }
    }
    this.facetCache = {
      records: this.entries.length,
      valid,
      suspect,
      invalid,
      patches: [...patches].sort((a, b) => comparePatch(b, a)),
      queues: [...queues].sort((a, b) => a - b),
      champions: [...champions].filter((id) => id > 0).sort((a, b) => a - b),
      oldest,
      newest,
      bytes: this.scanEnd,
    };
    return this.facetCache;
  }

  /**
   * De enige plek waar dit bestand geschreven wordt.
   *
   * Werkwijze: kopieer het origineel byte voor byte naar een tijdelijk bestand in
   * dezelfde map, sla daarbij de bewerkte bereiken over, fsync, en wissel dan pas
   * om met één rename. Wat er ook misgaat -- volle schijf, stroomuitval, een fout
   * in de code hierboven -- het origineel is tot aan die rename ongewijzigd.
   *
   * Vier dingen die de aanroeper moet weten:
   *
   * - Het slot op dit pad moet al gehouden worden; vandaar de naam. Deze functie
   *   neemt het bewust niet zelf: de ketting is niet herintreedbaar (zie
   *   writeQueue.ts), en de aanroeper heeft het slot al nodig vóórdat hij zijn
   *   bewerkingen samenstelt. Dat is namelijk waar de offsets vandaan komen, en een
   *   offset die buiten het slot gemeten is kan bij aankomst iets anders aanwijzen.
   *   Nemen we het hier alsnog, dan wacht elke aanroeper op zichzelf. Enige plek die
   *   het neemt: `locked()`.
   * - De bewerkingen moeten oplopend en niet-overlappend zijn en elk precies één
   *   regel dekken. We controleren dat; de prijs van een fout is dat er bytes door
   *   elkaar geschud worden, en dan weiger ik liever te schrijven.
   * - `reindex` bepaalt hoe de index bijkomt. 'shift' schuift de offsets mee en
   *   mag alleen voor bewerkingen op regels die in de index staan; 'rebuild' leest
   *   opnieuw en is er voor reparaties, die ook regels raken die de index bewust
   *   heeft overgeslagen (lege regels bijvoorbeeld).
   * - Groeit het bestand tijdens het kopiëren, dan kopiëren we de nieuwe staart er
   *   alsnog achteraan, net zolang tot de grootte stabiel is. Dat is een vangnet
   *   voor schrijvers van buiten dit proces, en meer dan een vangnet is het niet:
   *   wat er in de laatste milliseconden vóór de rename bij komt gaat verloren,
   *   want zo'n schrijver houdt zijn handle op het oude bestand. Binnen dit proces
   *   kan het niet meer gebeuren -- het gedeelde slot dat de aanroeper vasthoudt zet
   *   elke append op dit pad in dezelfde ketting, ook als hij van de uploader van de
   *   draaiende service komt.
   *
   * Alles wat hierna nog komt -- het bijwerken van de index en de melding aan de
   * luisteraars -- valt nog binnen datzelfde slot. Wie achter ons in de rij staat
   * ziet daardoor het bestand én het geheugenbeeld in dezelfde toestand, en nooit
   * iets ertussenin.
   */
  private async applyEditsLocked(
    edits: readonly LineEdit[],
    change: DatabaseChange,
    reindex: "shift" | "rebuild" = "shift",
  ): Promise<WriteResult> {
    if (edits.length === 0) throw new Error("Nothing to write");

    const bytesBefore = await this.fileSize();
    if (bytesBefore === null) throw new Error("The database file does not exist");
    if (bytesBefore < this.scanEnd) {
      throw new Error("The database changed outside the manager; reload before writing");
    }

    const bound = reindex === "shift" ? this.scanEnd : bytesBefore;
    let previousEnd = 0;
    for (const edit of edits) {
      if (edit.start < previousEnd || edit.end < edit.start) {
        throw new Error("Internal error: edits are not in file order; nothing was written");
      }
      if (edit.end > bound) {
        throw new Error("Internal error: an edit points past the end of the file; nothing was written");
      }
      previousEnd = edit.end;
    }

    const tempPath = `${this.path}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const source = await openFile(this.path, "r");
    let target: FileHandle | null = null;
    let written = 0;
    try {
      // 'wx' faalt als het pad al bestaat: liever een fout dan het tijdelijke
      // bestand van een andere schrijver overhoop halen.
      target = await openFile(tempPath, "wx");
      const buffer = Buffer.allocUnsafe(READ_CHUNK);
      let cursor = 0;
      for (const edit of edits) {
        written += await copyRange(source, target, buffer, cursor, edit.start);
        if (edit.replacement) {
          await writeAll(target, edit.replacement);
          written += edit.replacement.length;
        }
        cursor = edit.end;
      }

      let end = bytesBefore;
      for (let round = 0; ; round++) {
        written += await copyRange(source, target, buffer, cursor, end);
        cursor = end;
        const now = await this.fileSize();
        if (now === null || now === end) break;
        if (now < end) throw new Error("The database shrank while it was being rewritten; nothing was changed");
        if (round >= GROWTH_ROUNDS) {
          throw new Error("The database keeps growing while it is being rewritten; nothing was changed");
        }
        end = now;
      }

      await target.sync();
      await target.close();
      target = null;
      // Windows vervangt een bestand niet zolang wij het zelf nog open hebben.
      await source.close();
      await swapIntoPlace(tempPath, this.path);
      await syncDirectory(dirname(this.path));
    } catch (error) {
      if (target) await target.close().catch(() => undefined);
      await source.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      this.log("error", `Rewrite failed, the database was left untouched: ${message(error)}`);
      throw error;
    }

    const removed = edits.filter((edit) => edit.replacement === null).length;
    const replaced = edits.length - removed;
    if (reindex === "rebuild") {
      await this.rebuild();
    } else {
      this.applyShift(edits);
      this.afterIndexChange();
      // Alles voorbij het geïndexeerde deel is tijdens de herschrijving aangeschoven.
      // Via ingestTail en niet via indexFrom, omdat alleen die weet raad weet met
      // een halve laatste regel waar net bytes achteraan zijn gekomen.
      await this.ingestTail();
    }

    // Nog binnen het slot: de eerstvolgende schrijver in de rij hoort het
    // bijgewerkte geheugenbeeld te zien, niet het beeld van vóór deze bewerking.
    await this.announce(change);

    return { removed, replaced, bytesBefore, bytesAfter: written, records: this.entries.length };
  }

  /**
   * Vertelt de luisteraars wat er veranderd is.
   *
   * Een luisteraar die gooit is zijn eigen probleem: de bewerking op schijf is dan
   * allang gelukt, en die terugdraaien om een geheugencache tevreden te stellen zou
   * de verhouding omdraaien. We melden het en gaan door met de volgende.
   */
  private async announce(change: DatabaseChange): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(change);
      } catch (error) {
        this.log("warn", `A listener could not process the change: ${message(error)}`);
      }
    }
  }

  /**
   * Schuift de index mee met wat er zojuist geschreven is.
   *
   * Het alternatief -- de hele index opnieuw opbouwen -- is een paar seconden per
   * verwijderde regel op een bestand van deze omvang. Meeschuiven is exact zolang
   * de invarianten van LineEdit gelden (op volgorde, niet overlappend, één regel
   * per bewerking), en die worden hierboven afgedwongen voordat er ook maar één
   * byte geschreven wordt.
   */
  private applyShift(edits: readonly LineEdit[]): void {
    const next: IndexEntry[] = [];
    const tail = this.unterminatedStart;
    // Een onafgemaakte laatste regel die zelf onder een bewerking valt is daarna
    // weg of vervangen door een regel mét newline; in beide gevallen is er geen
    // losse staart meer om rekening mee te houden.
    const tailEdited =
      tail !== null && edits.some((edit) => edit.start <= tail && tail < edit.end);
    let byteDelta = 0;
    let lineDelta = 0;
    let e = 0;

    const consume = (edit: LineEdit): void => {
      byteDelta += (edit.replacement?.length ?? 0) - (edit.end - edit.start);
      lineDelta += edit.replacement ? 0 : -1;
      e++;
    };

    for (const entry of this.entries) {
      while (e < edits.length) {
        const edit = edits[e];
        if (!edit || edit.end > entry.start) break;
        consume(edit);
      }
      const edit = edits[e];
      if (edit && entry.start >= edit.start && entry.start < edit.end) {
        if (edit.replacement && edit.fields) {
          const start = edit.start + byteDelta;
          next.push({
            ...edit.fields,
            start,
            end: start + edit.replacement.length,
            size: edit.replacement.length - 1,
            line: entry.line + lineDelta,
          });
        }
        continue;
      }
      entry.start += byteDelta;
      entry.end += byteDelta;
      entry.line += lineDelta;
      next.push(entry);
    }

    // Een bewerking op de laatste regel is nog niet meegeteld: de lus verrekent een
    // bewerking pas zodra hij een regel daarná tegenkomt. Zonder deze naloop zou
    // een verwijdering aan het einde van het bestand de tellers laten scheefstaan.
    while (e < edits.length) {
      const edit = edits[e];
      if (!edit) break;
      consume(edit);
    }

    this.entries = next;
    this.scanEnd += byteDelta;
    this.nextLine += lineDelta;
    this.unterminatedStart = tail === null || tailEdited ? null : tail + byteDelta;
  }
}

/* ──────────────────────────── laatste hulpstukken ───────────────────────────── */

const span = (ref: LineRef): { start: number; end: number; size: number; line: number } => ({
  start: ref.start,
  end: ref.end,
  size: ref.size,
  line: ref.line,
});

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Tijdstempel die als bestandsnaam mag: geen dubbele punten. */
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

function kindOf(problem: string, oversized: boolean): IssueKind {
  if (oversized) return "oversized";
  if (problem.startsWith("not valid JSON")) return "unparsable";
  if (problem.startsWith("not a JSON object")) return "not-an-object";
  if (problem.startsWith("no usable gameId")) return "no-game-id";
  return "malformed";
}

/**
 * Een geïndexeerde regel plus zijn tekst tot iets wat de UI kan tonen.
 *
 * De index wordt hier bewust niet geloofd: we valideren de regel opnieuw. Tussen
 * indexeren en lezen kan er van alles gebeurd zijn, en een record dat als 'valid'
 * in beeld komt terwijl het dat niet is, is precies het soort leugen waar iemand
 * later een bewerking op baseert.
 */
function toRecord(entry: IndexEntry, text: string): BrowseRecord {
  let value: unknown = null;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = null;
  }
  if (isStoredMatch(value)) {
    return { gameId: value.gameId, line: entry.line, bytes: entry.size, status: "valid", match: value, raw: null, problem: null };
  }
  const problem = isObject(value) ? problemWithMatch(value) : "the line is not a JSON object";
  const gameId = isObject(value) && isNumber(value.gameId) ? value.gameId : null;
  return {
    gameId,
    line: entry.line,
    bytes: entry.size,
    status: gameId === null ? "invalid" : "suspect",
    match: null,
    raw: preview(text),
    problem,
  };
}
