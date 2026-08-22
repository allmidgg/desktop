/**
 * Eén schrijver per bestandspad -- over procesgrenzen heen.
 *
 * ── Waarom dit bestand bestaat ────────────────────────────────────────────────
 *
 * `manager/src/main/data/writeQueue.ts` zet alle schrijvers op één pad achter
 * elkaar, maar alleen bínnen het proces dat hem laadt. Dat is precies de helft van
 * het probleem. In de praktijk staan er meerdere processen op dezelfde
 * matches.jsonl: de manager (MatchBrowser + zijn MatchStore), `npm run crawl`
 * (src/cli/crawl.ts, eigen MatchStore), `npm run upload` en de server. Die zien
 * elkaars wachtrij niet, want een belofte in een Map deelt niet over processen.
 *
 * Het gat is niet theoretisch. Gemeten met 40.000 records, een appender in een
 * tweede proces en vier keer `removeMany`:
 *
 *     zonder dit slot   400 games bevestigd -> 27 kwijt (run 1), 5 kwijt (run 2)
 *     met dit slot      400 games bevestigd -> 0 kwijt
 *
 * Geen fout, geen kapotte regel, geen spoor: de appends kregen 'accepted' mét
 * fsync en waren daarna weg. Dat komt doordat MatchBrowser herschrijft via
 * kopiëren-naar-tijdelijk-bestand-en-hernoemen. Tussen de laatste groottecontrole
 * en de `rename` zit nog een fsync over honderden megabytes; alles wat een ander
 * proces in dat venster achter het oude bestand plakt, staat niet in de kopie en
 * verdwijnt met de rename. De groeilus in `applyEditsLocked` kopieert de staart
 * netjes achterna, maar kan dat venster principieel niet sluiten -- er is altijd
 * een laatste meting en daarna nog werk. Dat vraagt een slot op
 * bestandssysteemniveau, en dat is dit bestand.
 *
 * Dit hoort in `src/core` en niet in de manager, omdat béíde kanten hem nodig
 * hebben: core (MatchStore) draait ook in de crawler en de server, en die kennen
 * de manager niet.
 *
 * ── Hoe het werkt ─────────────────────────────────────────────────────────────
 *
 * Een lockbestand `<pad>.lock`, aangemaakt met de vlag 'wx': die faalt met EEXIST
 * als het pad al bestaat. Dat is de enige atomaire operatie die elk
 * besturingssysteem en elke netwerkschijf op dezelfde manier begrijpen -- geen
 * `flock` (werkt niet op Windows), geen exclusieve open-modus (werkt niet op
 * netwerkschijven), geen native module (moet per Electron-versie hercompileerd
 * worden, en dat is precies waarom deze opslag JSONL is en geen SQLite).
 *
 * In het bestand staat wie hem heeft: pid, hostnaam, tijdstip, een label en een
 * willekeurig token. Het token is er voor het vrijgeven: we verwijderen het
 * lockbestand alleen als het nog steeds ónze inhoud heeft. Zonder dat zou een
 * proces dat zijn slot (terecht of onterecht) afgepakt heeft gekregen bij het
 * opruimen het verse slot van zijn opvolger wegpoetsen -- en dan zijn er ineens
 * twee schrijvers die allebei denken alleen te zijn.
 *
 * ── De vier lastige gevallen, en wat we ermee doen ────────────────────────────
 *
 * 1. WACHTEN MET EEN BOVENGRENS. Wachten tot Sint-Juttemis is geen wachten maar
 *    vastlopen, en een vastgelopen manager ziet er voor de gebruiker precies zo
 *    uit als een kapotte manager. We wachten daarom hooguit `timeoutMs` (standaard
 *    twee minuten -- ruim boven de duur van een volledige herschrijving van een
 *    bestand van honderden MB's, inclusief fsync) en gooien daarna een
 *    `FileLockTimeout` met de pid van de houder erin. Zie punt 4 hieronder voor
 *    waarom gooien hier het goede antwoord is.
 *
 * 2. EEN VERWEESD SLOT MAG NIET EEUWIG BLOKKEREN. Een proces dat omvalt (crash,
 *    Taakbeheer, stroom eraf) ruimt zijn lockbestand niet op. Zonder tegenmaatregel
 *    is de databank daarna permanent onschrijfbaar en is de enige uitweg dat de
 *    gebruiker zelf een bestand weggooit waarvan hij het bestaan niet kent.
 *
 *    Twee onafhankelijke signalen, want elk op zich is te zwak:
 *      - LEEFTIJD. De houder ververst de tijdstempel van zijn lockbestand elke
 *        `HEARTBEAT_MS`. Blijft die tijdstempel staan, dan draait de houder niet
 *        meer (of hangt hij, en dan is doorgaan óók beter dan samen stilstaan).
 *      - LEEFT DE PID NOG? `process.kill(pid, 0)` verstuurt niets en vertelt
 *        alleen of het proces bestaat. Alleen zinvol op dezelfde host: een pid van
 *        een andere machine zegt hier niets, dus bij een netwerkschijf vallen we
 *        terug op alleen de leeftijd.
 *
 *    Overnemen gebeurt daarom in twee snelheden: is de houder aantoonbaar dood
 *    (zelfde host, pid weg), dan na `STALE_MS`; weten we het niet zeker, dan pas
 *    na `ABANDON_MS`. Die tweede grens is er voor pid-hergebruik (Windows deelt
 *    pids opnieuw uit, dus 'pid leeft' kan een wildvreemd proces zijn) en voor
 *    netwerkschijven. Een echte houder haalt die grens nooit: hij hartslaat elke
 *    twee seconden en al ons schrijfwerk is asynchroon, dus de lus blokkeert niet.
 *
 *    Het overnemen zelf hernoemt het oude lockbestand eerst opzij en verwijdert
 *    het daarna, in plaats van het meteen weg te gooien. Anders kan dit gebeuren:
 *    twee wachters zien tegelijk hetzelfde verweesde slot, wachter A gooit het weg
 *    en maakt meteen een nieuw slot aan, en wachter B gooit dát verse slot weg.
 *    Door te hernoemen mist de tweede zijn doelwit en verandert er niets. Het echte
 *    scheidsrechterschap blijft daarna gewoon de 'wx'-aanmaak: overnemen geeft je
 *    alleen het recht om het opnieuw te proberen, niet het slot zelf.
 *
 * 3. VRIJGEVEN MOET ALTIJD. `try/finally` om de taak heen, dus ook als hij gooit.
 *    Valt het proces halverwege om, dan is er geen `finally` meer; dan is punt 2 het
 *    vangnet. Voor de nette afsluiting hangt er daarnaast een `exit`-handler onder
 *    die de sloten die we nog vasthouden synchroon opruimt -- op `exit` mag niets
 *    meer asynchroon, vandaar de sync-variant.
 *
 * 4. HET SLOT NIET KRIJGEN IS EEN FOUT, GEEN SIGNAAL OM DOOR TE SCHRIJVEN.
 *    Doorschrijven zonder slot is exact de situatie die hierboven 27 games kostte,
 *    en dan zonder dat iemand het merkt. Beter hard falen: `MatchStore.add()` geeft
 *    de fout door aan de client, die géén 'accepted' krijgt en de game gewoon
 *    opnieuw aanbiedt -- niets kwijt. In de manager wordt het een foutmelding in
 *    beeld ("another process is writing to the database"), en de gebruiker probeert
 *    het zo weer. Een `FileLockTimeout` is dus altijd te herstellen, en stille
 *    schade nooit.
 *
 * ── Nooit twee keer binnen hetzelfde proces ───────────────────────────────────
 *
 * Twee keer hetzelfde slot nemen in één proces is een zekere vastloper: de tweede
 * aanmaak ziet ons eigen lockbestand en wacht op iets dat pas losgaat als de
 * tweede aanroep klaar is. Twee lagen voorkomen dat:
 *
 *   - Een wachtrij per pad binnen dit proces (dezelfde vorm als writeQueue.ts).
 *     Gelijktijdige aanroepers in één proces vechten dus niet via het
 *     bestandssysteem om een slot dat ze onderling ook gewoon kunnen verdelen; er
 *     is per proces hooguit één lockbestand-aanvraag tegelijk per pad.
 *   - `AsyncLocalStorage` onthoudt welke paden de lopende taak al vasthoudt. Neemt
 *     code binnen zo'n taak hetzelfde slot nog eens -- de gewone manier waarop dit
 *     gebeurt: `withWriteLock` in de manager houdt het slot en roept iets aan dat
 *     zelf ook `MatchStore.add()` doet -- dan voeren we de taak direct uit in plaats
 *     van te wachten. Dat is veilig, want de buitenste houder heeft de exclusieve
 *     toegang al; het alternatief (gooien) zou een aanroepketen breken die
 *     inhoudelijk niets fout doet, en wachten zou vastlopen.
 *
 * Er zijn twee plekken waar een in-proces wachtrij met dit slot gecombineerd wordt:
 * `withWriteLock` in de manager en `MatchStore.chain()` in core. Die twee rijen zijn
 * verschillend, en dat maakt de volgorde een eis in plaats van een smaak.
 *
 * Zet je in beide de rij buitenom en dit slot daarbinnen, dan sluit er een cyclus:
 * de houder van rij A plus het slot roept iets aan dat achteraan rij B moet, terwijl
 * vooraan rij B iets staat dat op het slot wacht. Nagemeten: dat hangt permanent,
 * want wachten op een rij kent geen klok -- er komt zelfs geen FileLockTimeout.
 *
 * `MatchStore.chain()` legt daarom het slot BUITEN zijn rij. Dit slot is
 * herintreedbaar, dus buitenom leggen kost niets en sluit de cyclus uit. Bouw je een
 * derde combinatie, houd dan dezelfde volgorde aan: slot buiten, rij binnen.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

/** Hoe vaak de houder de tijdstempel van zijn lockbestand ververst. */
const HEARTBEAT_MS = 2_000;
/**
 * Hoe lang een lockbestand stil mag zijn voordat we het als verweesd beschouwen,
 * mits de houder aantoonbaar dood is. Tien gemiste hartslagen: ruim genoeg dat een
 * drukke event-loop hem niet per ongeluk haalt.
 */
const STALE_MS = 20_000;
/**
 * En hoe lang als we het níét zeker weten (andere host, onleesbaar lockbestand, of
 * een pid die leeft maar hergebruikt kan zijn). Dertig gemiste hartslagen op rij
 * haalt geen enkele levende houder.
 */
const ABANDON_MS = 60_000;
/** Bovengrens aan het wachten. Zie punt 1 hierboven. */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Hoe vaak we kijken of het slot al vrij is. Kort genoeg dat een korte append
 * niemand merkbaar ophoudt, met wat ruis erbij zodat twee wachters niet eeuwig in
 * hetzelfde ritme naast elkaar blijven grijpen.
 */
const POLL_MS = 25;
const POLL_JITTER_MS = 40;
/**
 * Hoe vaak we een bestandsactie op het lockbestand opnieuw proberen.
 *
 * Zelfde aantal en dezelfde oplopende pauze als `appendDurably()` in matchStore.ts
 * en `swapIntoPlace()` in de manager, want het is dezelfde oorzaak: op Windows
 * houden een virusscanner en de zoekindexer een net aangemaakt bestand kortstondig
 * vast, en zolang dat duurt faalt élke poging het te openen, te hernoemen of te
 * verwijderen met EPERM, EACCES of EBUSY. Uitgerekend een lockbestand krijgt die
 * aandacht: het is klein, het is nieuw, en het wordt meteen weer weggegooid.
 */
const IO_RETRIES = 6;
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

const HOST = hostname();

const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Het slot was niet te krijgen binnen de toegestane tijd.
 *
 * Een eigen klasse zodat een aanroeper dit kan onderscheiden van "de schijf is vol"
 * of "het record deugt niet": dit is het enige geval waarin niets geprobeerd is en
 * het gewoon opnieuw proberen zin heeft.
 */
export class FileLockTimeout extends Error {
  constructor(
    /** Het bestand waar het slot bij hoort (niet het lockbestand zelf). */
    readonly path: string,
    /** De pid van de houder, of null als het lockbestand onleesbaar was. */
    readonly holder: number | null,
    /** Hoe lang we gewacht hebben, in ms. */
    readonly waitedMs: number,
  ) {
    const who = holder === null ? "another process" : `process ${holder}`;
    super(
      `The match database is locked by ${who} and did not become available within ${Math.round(waitedMs / 1000)}s; ` +
        `nothing was written. Try again once that process is done.`,
    );
    this.name = "FileLockTimeout";
  }
}

export interface FileLockOptions {
  /** Bovengrens aan het wachten, in ms. Standaard twee minuten. */
  timeoutMs?: number;
  /** Komt in het lockbestand te staan, zodat je bij een verweesd slot ziet wie het was. */
  label?: string;
  /** Krijgt Engelse meldingen over wachten en overnemen; bedoeld voor het logboek van de aanroeper. */
  notice?: (text: string) => void;
}

/** Wat er in het lockbestand staat. */
interface LockRecord {
  pid: number;
  host: string;
  /** Willekeurig per slotname; bewijst bij het vrijgeven dat het lockbestand nog van ons is. */
  token: string;
  since: number;
  label: string;
}

/** Wat we van een bestaand lockbestand konden aflezen. */
interface Holder {
  /** Null als het lockbestand onleesbaar of half geschreven was. */
  record: LockRecord | null;
  /** Hoe lang de tijdstempel al niet meer is bijgewerkt. */
  ageMs: number;
}

/** Een slot dat dit proces nu vasthoudt. */
interface HeldLock {
  lockPath: string;
  token: string;
  heartbeat: NodeJS.Timeout;
}

/** In-proces wachtrij per pad; zie "Nooit twee keer binnen hetzelfde proces". */
interface Chain {
  tail: Promise<void>;
  pending: number;
}

const chains = new Map<string, Chain>();
const held = new Map<string, HeldLock>();
/** Welke paden de lopende taak al vasthoudt; erft mee in alles wat eronder draait. */
const owned = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Het pad naar één sleutel.
 *
 * Gelijk aan `keyFor` in writeQueue.ts en om dezelfde reden: twee aanroepers die
 * hetzelfde bestand anders opschrijven horen in dezelfde ketting te belanden, en op
 * Windows is `C:\data\matches.jsonl` hetzelfde bestand als `c:\data\Matches.jsonl`.
 */
function keyFor(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/**
 * Waar het lockbestand van dit pad staat.
 *
 * Naast het bestand zelf en niet in een tijdelijke map: het slot hoort bij de data,
 * dus als de databank op een netwerkschijf staat moet het slot daar ook staan --
 * anders sluiten twee machines elkaar niet uit. Het achtervoegsel botst met niets:
 * MatchBrowser ruimt `matches.jsonl.tmp-*` op, niet `.lock`.
 */
export function lockPathFor(path: string): string {
  return `${resolve(path)}.lock`;
}

/** Of dít proces het slot op dit pad nu vasthoudt. */
export function isFileLockHeld(path: string): boolean {
  return held.has(keyFor(path));
}

/** Of de lopende taak het slot op dit pad zelf al vasthoudt (en het dus niet nog eens hoeft te nemen). */
export function holdsFileLock(path: string): boolean {
  return owned.getStore()?.has(keyFor(path)) ?? false;
}

function parseRecord(text: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.pid !== "number" || typeof raw.host !== "string" || typeof raw.token !== "string") return null;
    return {
      pid: raw.pid,
      host: raw.host,
      token: raw.token,
      since: typeof raw.since === "number" ? raw.since : 0,
      label: typeof raw.label === "string" ? raw.label : "",
    };
  } catch {
    // Half geschreven of met de hand aangepast: onbruikbaar, maar de leeftijd telt nog.
    return null;
  }
}

/**
 * Bestaat dit proces nog?
 *
 * Signaal 0 stuurt niets en test alleen het bestaan. EPERM betekent "hij bestaat,
 * maar hij is niet van jou" -- dus levend. Alleen te vertrouwen op onze eigen host.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** Voert een bestandsactie uit en heeft geduld met de virusscanner. Zie IO_RETRIES. */
async function withRetry<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (!TRANSIENT_CODES.has(errorCode(error)) || attempt >= IO_RETRIES) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

/**
 * Probeert het lockbestand aan te maken. `false` betekent: iemand anders was er al.
 *
 * 'wx' is hier het hele mechanisme: aanmaken-als-het-nog-niet-bestaat is één
 * ondeelbare stap van het bestandssysteem, dus er kan er maar één winnen -- ook als
 * de twee kandidaten losse processen op verschillende machines zijn.
 */
async function tryCreate(lockPath: string, record: LockRecord): Promise<boolean> {
  const body = `${JSON.stringify(record)}\n`;
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        // Inhoud én tijdstempel moeten kloppen vóórdat een ander proces dit
        // lockbestand kan beoordelen; daarom pas na de write teruggeven.
        await handle.writeFile(body, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") return false;
      if (code === "ENOENT") {
        // De map bestaat nog niet -- eerste schrijver op een verse installatie.
        await mkdir(dirname(lockPath), { recursive: true });
        continue;
      }
      if (!TRANSIENT_CODES.has(code) || attempt >= IO_RETRIES) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

/** Leest wie het slot heeft. `null` als het lockbestand er intussen niet meer is. */
async function inspect(lockPath: string): Promise<Holder | null> {
  try {
    const [text, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    // Een negatieve leeftijd betekent klokverschil (netwerkschijf); dan is 'net
    // aangeraakt' de veilige aanname, want die neemt niets over.
    const ageMs = Math.max(0, Date.now() - info.mtimeMs);
    return { record: parseRecord(text), ageMs };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    // Even niet te lezen (scanner) is geen reden om iets te concluderen: doe alsof
    // hij vers is, dan wachten we gewoon nog een ronde.
    return { record: null, ageMs: 0 };
  }
}

/** Mogen we dit slot afpakken? Zie punt 2 in de kop. */
function stealable(holder: Holder): boolean {
  const record = holder.record;
  // Onleesbaar: we weten niet van wie hij is, dus alleen de lange grens telt.
  if (record === null) return holder.ageMs > ABANDON_MS;
  // Van onszelf, terwijl `held` zegt dat we hem niet hebben: een restant van een
  // afgebroken poging. De in-proces wachtrij garandeert dat er geen andere taak in
  // dit proces mee bezig is, dus dit is per definitie afval.
  if (record.host === HOST && record.pid === process.pid) return true;
  // Zelfde machine en het proces bestaat niet meer: aantoonbaar verweesd.
  if (record.host === HOST && !pidAlive(record.pid)) return holder.ageMs > STALE_MS;
  // Andere machine, of een pid die leeft maar hergebruikt kan zijn: pas na de
  // lange grens, want hier kunnen we ons vergissen en dat kost data.
  return holder.ageMs > ABANDON_MS;
}

/**
 * Haalt een verweesd lockbestand weg.
 *
 * Eerst opzij hernoemen en dan pas verwijderen, zodat we onmogelijk het verse slot
 * van een ander kunnen wissen: wie ons voor is heeft zijn eigen bestand op de oude
 * naam staan, en onze `rename` mist dan zijn doel of pakt exact het bestand dat we
 * bekeken hebben. Mislukken mag: dan wint iemand anders de race en proberen we het
 * gewoon opnieuw.
 */
async function steal(lockPath: string): Promise<void> {
  const aside = `${lockPath}.stale-${process.pid}-${Date.now().toString(36)}`;
  try {
    await withRetry(() => rename(lockPath, aside));
  } catch {
    return;
  }
  await rm(aside, { force: true }).catch(() => undefined);
}

/** Wacht tot het lockbestand van ons is, of geeft het op met een `FileLockTimeout`. */
async function acquire(
  path: string,
  lockPath: string,
  record: LockRecord,
  timeoutMs: number,
  notice: ((text: string) => void) | undefined,
): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let announced = false;
  let lastPid: number | null = null;

  for (;;) {
    if (await tryCreate(lockPath, record)) return;

    const holder = await inspect(lockPath);
    // Net losgelaten tussen onze poging en onze blik: meteen opnieuw proberen.
    if (holder === null) continue;
    lastPid = holder.record?.pid ?? null;

    if (stealable(holder)) {
      const who = holder.record === null ? "an unreadable lock file" : `process ${holder.record.pid}`;
      notice?.(`Taking over a stale database lock left behind by ${who}`);
      await steal(lockPath);
      // Niet meteen `continue`: ook een overname moet de deadline respecteren,
      // anders draait een pad waar het overnemen structureel mislukt eindeloos rond.
    } else if (!announced) {
      announced = true;
      const who = holder.record === null ? "another process" : `process ${holder.record.pid}`;
      notice?.(`Waiting for ${who} to release the database`);
    }

    if (Date.now() >= deadline) throw new FileLockTimeout(path, lastPid, Date.now() - started);
    await delay(POLL_MS + Math.floor(Math.random() * POLL_JITTER_MS));
  }
}

/**
 * Geeft het slot vrij, maar alleen als het lockbestand nog van ons is.
 *
 * Het tokenvergelijk is het verschil tussen "ik ruim mijn eigen slot op" en "ik
 * gooi het slot van mijn opvolger weg". Dat tweede kan echt gebeuren: als ons slot
 * onterecht is overgenomen, staat er inmiddels een ander bestand op dezelfde naam.
 *
 * Gooit nooit. Een mislukte opruiming mag het resultaat van de taak niet
 * overschrijven -- en hij is ook niet fataal, want een achtergebleven lockbestand
 * wordt vanzelf als verweesd herkend.
 */
async function release(lockPath: string, token: string, notice: ((text: string) => void) | undefined): Promise<void> {
  try {
    const text = await withRetry(() => readFile(lockPath, "utf8"));
    const record = parseRecord(text);
    if (record !== null && record.token !== token) {
      notice?.("The database lock was taken over by another process while this write was running");
      return;
    }
    await withRetry(() => rm(lockPath, { force: true }));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    notice?.(`Could not clean up the database lock file: ${String(error)}`);
  }
}

/**
 * Synchroon opruimen bij het afsluiten.
 *
 * Op `exit` draait de event-loop niet meer, dus alles wat asynchroon is gebeurt
 * gewoon niet. Deze handler bestaat alleen om de gewone afsluiting netjes te
 * houden; bij een crash is er geen handler en doet de verweesd-detectie het werk.
 */
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const lock of held.values()) {
      try {
        const record = parseRecord(readFileSync(lock.lockPath, "utf8"));
        if (record !== null && record.token !== lock.token) continue;
        unlinkSync(lock.lockPath);
      } catch {
        /* Afsluiten mag hier nooit op stuklopen. */
      }
    }
  });
}

/** Zet een taak achter de andere taken op dit pad in dit proces. */
function queue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const chain: Chain = chains.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  chains.set(key, chain);
  chain.pending++;

  const finish = (): void => {
    chain.pending--;
    if (chain.pending === 0 && chains.get(key) === chain) chains.delete(key);
  };

  // Twee keer dezelfde handler: of de voorganger nu slaagde of gooide, wij zijn aan
  // de beurt. Zonder de tweede zou één mislukte schrijfactie het pad voorgoed dicht
  // zetten.
  const started = chain.tail.then(task, task);
  chain.tail = started.then(finish, finish);
  return started;
}

/**
 * Voert `task` uit met exclusieve toegang tot `path`, over processen heen.
 *
 * Drie dingen om te weten:
 *
 * - Het slot dekt wat je erin zet, dus zet er de héle lees-wijzig-schrijf in en
 *   niet alleen de schrijfactie. Een controle "kennen we deze game al?" of een
 *   offset die je buiten het slot meet, is precies de race die dit dichtzet.
 * - Neemt code binnen de taak hetzelfde slot nog eens, dan gaat dat vanzelf goed:
 *   we voeren hem direct uit in plaats van op onszelf te wachten.
 * - Lukt het niet binnen `timeoutMs`, dan gooit dit een `FileLockTimeout` en is er
 *   niets geschreven. Vang die niet af om er alsnog zonder slot doorheen te gaan --
 *   dat is precies de bug waar dit bestand voor bestaat.
 */
export function withFileLock<T>(path: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const key = keyFor(path);
  const inherited = owned.getStore();
  // Al van ons: gewoon doorlopen. Wachten zou hier vastlopen op onszelf.
  if (inherited?.has(key) === true) return task();

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const notice = options.notice;

  return queue(key, async () => {
    const lockPath = lockPathFor(path);
    const record: LockRecord = {
      pid: process.pid,
      host: HOST,
      token: randomUUID(),
      since: Date.now(),
      label: options.label ?? "",
    };

    await acquire(path, lockPath, record, timeoutMs, notice);

    installExitHook();
    // De hartslag is het bewijs van leven waar andere processen op afgaan. `unref`
    // omdat een lopende timer anders een klaar proces open zou houden.
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockPath, now, now).catch(() => undefined);
    }, HEARTBEAT_MS);
    heartbeat.unref();
    held.set(key, { lockPath, token: record.token, heartbeat });

    const scope = new Set(inherited ?? []);
    scope.add(key);
    try {
      return await owned.run(scope, task);
    } finally {
      // Ook als de taak gooit. Eerst de hartslag stil, dan pas het bestand weg:
      // andersom zou een laatste tik het lockbestand van onze opvolger aanraken.
      clearInterval(heartbeat);
      held.delete(key);
      await release(lockPath, record.token, notice);
    }
  });
}
