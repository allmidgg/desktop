/**
 * Eén schrijfketting per bestandspad, gedeeld door het hele proces.
 *
 * ── Waarom dit bestand bestaat ────────────────────────────────────────────────
 *
 * Twee onderdelen van de manager schrijven naar dezelfde matches.jsonl: de
 * draaiende service plakt er regels achteraan (MatchStore.add) en de Data-weergave
 * herschrijft hem in zijn geheel (MatchBrowser.applyEdits). Allebei hadden ze hun
 * eigen wachtrij, en twee wachtrijen zijn geen wachtrij: er is dan niets dat
 * verhindert dat een append landt terwijl de herschrijving zijn kopie al gemaakt
 * heeft. Die regel staat dan wel in het oude bestand maar niet in de kopie, en de
 * rename gooit hem weg -- terwijl de client allang 'accepted' terug heeft gekregen
 * en de game nooit meer aanbiedt. Permanent verlies, en het venster is ruim: er
 * zit een fsync over honderden megabytes in.
 *
 * De oplossing is bewust zo saai mogelijk: één module-level Map van pad naar de
 * lopende belofte. Wie naar hetzelfde pad schrijft komt daarmee in dezelfde
 * ketting terecht, ongeacht welk object of welke klasse het aanroept. Er is geen
 * registratie, geen eigenaar en geen levensloop om te beheren -- het pad ís de
 * sleutel.
 *
 * ── Twee lagen, want één was niet genoeg ──────────────────────────────────────
 *
 * Deze Map dekt alleen dít proces, en dat is de helft van het probleem. Op dezelfde
 * matches.jsonl staan gewoon meerdere processen: de manager, `npm run crawl`
 * (src/cli/crawl.ts, eigen MatchStore), `npm run upload` en de server. Een belofte
 * in een Map deelt niet over processen, dus die zagen elkaar niet.
 *
 * Dat kostte data. Gemeten met 40.000 records, een appender in een tweede proces en
 * vier keer `removeMany`: van 400 bevestigde games verdwenen er 27 (run 1) en 5
 * (run 2), zonder fout en zonder één kapotte regel. De herschrijving van
 * MatchBrowser kopieert naar een tijdelijk bestand en hernoemt; wat een ánder
 * proces tussen de laatste groottecontrole en die rename achter het oude bestand
 * plakt, staat niet in de kopie en gaat met de rename mee de prullenbak in --
 * terwijl de client allang 'accepted' mét fsync terug had. De groeilus in
 * `applyEditsLocked` kopieert de staart wel achterna, maar kan dat laatste venster
 * principieel niet sluiten: er is altijd een laatste meting en daarna nog werk.
 *
 * Daarom neemt `withWriteLock` sinds die meting twee sloten: eerst deze ketting, en
 * daarbinnen het lockbestand uit `src/core/services/fileLock.ts`. Beide zijn nodig
 * en de volgorde ligt vast:
 *
 *   - De ketting is goedkoop en houdt de aanroepers in dit proces netjes op één
 *     rij, zonder dat ze via het bestandssysteem om iets moeten vechten wat ze
 *     onderling ook kunnen verdelen.
 *   - Het lockbestand is het enige dat een ánder proces ziet.
 *
 * Deze volgorde is de enige in het hele programma -- fileLock wordt nergens buiten
 * dit slot om genomen om er daarna een ketting bij te pakken -- dus er is geen paar
 * sloten dat op elkaar kan gaan wachten. Dat fileLock zelf ook een in-proces
 * wachtrij heeft is geen dubbelop: die maakt hem veilig voor aanroepers die hem
 * rechtstreeks nemen (MatchStore in core, dat deze module niet kent en niet mag
 * kennen).
 *
 * ── Wat dit wél en niet is ────────────────────────────────────────────────────
 *
 * Wat het nog steeds niet dekt: een teksteditor van de gebruiker, of welk programma
 * dan ook dat het lockbestand niet kent. Daar beschermt alleen de
 * schrijf-naar-tijdelijk-bestand-en-hernoem van MatchBrowser tegen.
 *
 * ── Regels voor wie hem gebruikt ──────────────────────────────────────────────
 *
 * - Nooit `withWriteLock` aanroepen binnen een taak die het slot op hetzelfde pad
 *   al vasthoudt: de ketting is niet herintreedbaar en de tweede aanroep wacht dan
 *   op zichzelf. Dat geldt ook voor callbacks die vanuit zo'n taak worden
 *   aangeroepen (zie de invalidatiemelding in browser.ts).
 * - Houd het slot zo kort mogelijk vast, maar wél lang genoeg: het hoort de hele
 *   lees-wijzig-schrijf te dekken, niet alleen de schrijfactie zelf. Een controle
 *   "kennen we deze game al?" die buiten het slot valt is precies de race die we
 *   hier proberen te sluiten.
 * - `withWriteLock` kan nu gooien vóórdat je taak ook maar begonnen is: een
 *   `FileLockTimeout` betekent dat een ander proces de databank te lang bezet hield
 *   en dat er niets geschreven is. Laat die fout naar de aanroeper lopen -- de
 *   client krijgt dan géén 'accepted' en biedt de game gewoon opnieuw aan, en dat
 *   is oneindig veel beter dan zonder slot doorschrijven en er stilletjes een paar
 *   kwijtraken.
 */
import { resolve } from "node:path";
import { withFileLock } from "../../../../src/core/services/fileLock";

/** De stand van één pad: wat er loopt, en wie er nog achter staan. */
interface Chain {
  /**
   * De belofte waar de volgende taak achter aansluit. Deze wijst altijd naar een
   * belofte die niet kán afwijzen -- een mislukte schrijfactie mag de volgende
   * schrijver niet blokkeren, hij hoort alleen zijn eigen aanroeper te bereiken.
   */
  tail: Promise<void>;
  /** Aantal taken in deze ketting, inclusief de taak die nu draait. */
  pending: number;
  /** Of er op dit moment echt een taak aan het werk is. */
  running: boolean;
}

const chains = new Map<string, Chain>();

/**
 * Wat je aan het bestandssysteem-slot mee kunt geven.
 *
 * Allemaal optioneel en met bruikbare standaardwaarden, zodat bestaande aanroepers
 * ongewijzigd blijven werken. `notice` is er voor de manager: die heeft een logboek
 * en kan daarmee "Waiting for process 1234 to release the database" in beeld
 * brengen in plaats van de gebruiker naar een stilstaande knop te laten kijken.
 */
export interface WriteLockOptions {
  /** Bovengrens aan het wachten op het lockbestand, in ms. */
  timeoutMs?: number;
  /** Komt in het lockbestand te staan; standaard "manager". */
  label?: string;
  /** Krijgt Engelse meldingen over wachten en over het overnemen van een verweesd slot. */
  notice?: (text: string) => void;
}

/** Doorgegeven zodat aanroepers "het slot was niet te krijgen" kunnen herkennen zonder core te importeren. */
export { FileLockTimeout } from "../../../../src/core/services/fileLock";

/**
 * Het pad naar één sleutel.
 *
 * `resolve` haalt relatieve paden en `..` weg, zodat twee aanroepers die hetzelfde
 * bestand anders opschrijven toch in dezelfde ketting belanden. Op Windows telt
 * ook de schrijfwijze niet mee: `C:\data\matches.jsonl` en `c:\data\Matches.jsonl`
 * zijn daar één bestand, en twee kettingen op één bestand is precies wat we hier
 * proberen te voorkomen.
 */
function keyFor(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/**
 * Voert `task` uit zodra alle eerder aangemelde taken op dit pad klaar zijn én geen
 * ánder proces meer op dit bestand schrijft.
 *
 * De belofte die je terugkrijgt is die van je eigen taak: een fout komt bij jou
 * terecht en nergens anders, en de ketting loopt gewoon door.
 *
 * Twee lagen, in deze volgorde (zie de kop van dit bestand):
 *
 *  1. De ketting hierboven -- iedereen in dit proces netjes achter elkaar.
 *  2. Het lockbestand uit `fileLock.ts` -- de andere processen op ditzelfde
 *     bestand. Dat gebeurt binnen de ketting en niet ernaast: zo vraagt dit proces
 *     het lockbestand hooguit één keer tegelijk per pad aan, en kan de niet-
 *     herintreedbare ketting hem onmogelijk twee keer proberen te nemen.
 *
 * `chain.running` staat daarom al aan tijdens het wachten op het lockbestand. Dat
 * is precies wat `isWriting()` moet vertellen: de UI hoort "we wachten op een
 * schrijver" te melden, ongeacht of die schrijver hier of in de crawler zit.
 */
export function withWriteLock<T>(path: string, task: () => Promise<T>, options: WriteLockOptions = {}): Promise<T> {
  const key = keyFor(path);
  const chain: Chain = chains.get(key) ?? { tail: Promise.resolve(), pending: 0, running: false };
  chains.set(key, chain);
  chain.pending++;

  const run = async (): Promise<T> => {
    chain.running = true;
    try {
      return await withFileLock(path, task, {
        timeoutMs: options.timeoutMs,
        label: options.label ?? "manager",
        notice: options.notice,
      });
    } finally {
      chain.running = false;
    }
  };

  const finish = (): void => {
    chain.pending--;
    // Leeg opruimen, maar alleen als deze ketting nog de actuele is: anders zou een
    // laatkomer die net een nieuwe ketting begon zijn eigen sleutel kwijtraken.
    if (chain.pending === 0 && chains.get(key) === chain) chains.delete(key);
  };

  // Twee keer dezelfde handler: of de voorganger nu slaagde of gooide, wij zijn aan
  // de beurt. Zonder de tweede zou één mislukte schrijfactie het pad voorgoed dicht
  // zetten.
  const started = chain.tail.then(run, run);
  chain.tail = started.then(finish, finish);
  return started;
}

/** Of er op dit moment een taak op dit pad aan het werk is. */
export function isWriting(path: string): boolean {
  return chains.get(keyFor(path))?.running ?? false;
}

/** Hoeveel taken er op dit pad in de rij staan, de lopende meegerekend. */
export function pendingWrites(path: string): number {
  return chains.get(keyFor(path))?.pending ?? 0;
}

/**
 * Wacht tot de ketting van dit pad leeg is.
 *
 * Bedoeld voor afsluiten: een service die stopt moet zijn lopende appends afmaken
 * voordat hij zijn geheugen loslaat. Wie hierop wacht hoort eerst te zorgen dat er
 * niets nieuws meer bijkomt (een vlag die nieuwe verzoeken weigert), anders wachten
 * we op een rij die zichzelf blijft aanvullen. `rounds` is daar de noodrem voor:
 * blijft er werk binnenstromen, dan geven we het na een eindig aantal rondes op in
 * plaats van het afsluiten van de app tegen te houden.
 */
export async function whenWritesFinish(path: string, rounds = 32): Promise<void> {
  const key = keyFor(path);
  for (let round = 0; round < rounds; round++) {
    const chain = chains.get(key);
    if (!chain) return;
    // De staart kan nooit afwijzen, dus dit hoeft niet in een try.
    await chain.tail;
    // Tijdens het wachten kan er werk bijgekomen zijn; dan staat er een nieuwe
    // staart klaar en gaan we nog een ronde.
    if (!chains.has(key)) return;
  }
}
