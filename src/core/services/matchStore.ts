/**
 * Lokale matchdatabase voor League Classic.
 *
 * Er bestaat nergens ter wereld een dataset over deze modus, dus bouwen we er
 * zelf een. Elke game die we via de client tegenkomen wordt uitgekleed tot de
 * velden die er statistisch toe doen en weggeschreven als een regel JSON.
 *
 * Bewust geen database-engine: append-only JSONL heeft geen native modules
 * nodig (die per Electron-versie hercompileerd moeten worden), is met elke
 * teksteditor te inspecteren, en overleeft een crash halverwege het schrijven --
 * een kapotte laatste regel kost je één game, geen bestand.
 *
 * Dat laatste geldt alleen zolang de vólgende schrijver weet dat hij achter een
 * halve regel staat. Een append die halverwege afbreekt laat een record zonder
 * newline achter; wie daar blind achteraan plakt maakt van dat halve record plus
 * zijn eigen eerste record één onleesbare regel, en dan kost de breuk twee games
 * in plaats van één -- de tweede stilletjes, want `add()` zei gewoon 'accepted'.
 * Vandaar dat elke schrijfweg in dit bestand door `closeTruncatedLine()` gaat.
 */
import { mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import type { Game } from "../lcu/types";
import { isJadeGame } from "../jade/ids";
import { modeOf } from "../modes/detect";
import type { ModeId } from "../modes/types";
import { withFileLock } from "./fileLock";
import { MINIMALE_GAMEDUUR_SECONDEN } from "../../shared/types";

/**
 * Hoeveel bytes we per keer van schijf halen, en hoe groot een uitgaand blok
 * mag worden. Deze twee getallen zijn de enige buffers die met de bestands-
 * grootte te maken hebben: alles daarboven is per definitie begrensd, hoe groot
 * matches.jsonl ook wordt.
 */
const READ_CHUNK = 1 << 20;
const WRITE_CHUNK = 1 << 20;

/**
 * Hoe vaak we een mislukte schrijfactie opnieuw proberen, en hoe lang we daar
 * tussen wachten.
 *
 * Zelfde aantal en dezelfde oplopende pauze als `swapIntoPlace()` in de manager,
 * want het is dezelfde oorzaak: op Windows houdt een virusscanner of de zoek-
 * indexer een bestand kortstondig vast, en zolang dat duurt faalt élke poging het
 * te openen met EPERM, EACCES of EBUSY. Zes pogingen overbruggen samen ruim een
 * seconde; blijft het daarna mislukken, dan is er echt iets aan de hand en hoort
 * de aanroeper dat te horen in plaats van dat wij het wegpoetsen.
 */
const APPEND_RETRIES = 6;
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** De byte waar `readLines()` op splitst; de enige die een regel afsluit. */
const NEWLINE = 0x0a;

const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export type Position = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "SUPPORT" | "UNKNOWN";

export interface StoredPlayer {
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
  spells: [number, number];
  /**
   * Schade aan champions. Optioneel omdat elke match die hiervoor is opgeslagen
   * hem niet heeft -- de client stuurde hem wel mee, wij lieten hem vallen.
   *
   * Dit is het veld waar een naspel-scherm om draait. Zonder schade is er geen
   * MVP te berekenen, want kills alleen zeggen wie de laatste klap gaf en niet
   * wie het gevecht won.
   */
  damage?: number;
  /** Schade die je zelf opving. Samen met damage scheidt dit een tank van een carry. */
  damageTaken?: number;
  /** Vision score, als de client hem gaf. */
  vision?: number;
  /** Geplaatste wards. */
  wards?: number;
  /** Champion level aan het eind. */
  level?: number;
}

export interface StoredMatch {
  gameId: number;
  /** Of de game met een surrender eindigde. Ontbreekt op oudere records. */
  surrendered?: boolean;
  createdAt: number;
  duration: number;
  queueId: number;
  /**
   * Which mode this game was played in, decided once, when it was written.
   *
   * Absent on the 130,197 records that predate this field, and undefined means
   * "not written down" rather than "modern". Those records are all Classic and
   * their queue id proves it -- counted over the whole file: 126,340 on 4310,
   * 3,852 on 4320, 5 on 3262, and nothing else -- so modeOfStored() derives the
   * answer for them and the file itself is never rewritten.
   */
  mode?: ModeId;
  /**
   * The two signals the decision was made from, kept so it can be re-checked.
   *
   * They used to be discarded. queueId was the only survivor, which is why the
   * mode of an old record can only be recovered from a hand-written list of four
   * queue ids -- and the client already publishes Classic-adjacent queues that
   * are not on it (2450 and 3280, gameMode KIWI_JADE). A game stored today under
   * a queue Riot adds tomorrow would silently change mode between two versions
   * of the app, and there is no way back: the LCU keeps only a few months of
   * match history, so the evidence would be gone.
   *
   * Twelve bytes on a 2,504-byte record, against a question that cannot be asked
   * a second time.
   */
  gameMode?: string;
  mapId?: number;
  patch: string;
  players: StoredPlayer[];
}

/**
 * Riot beschrijft een positie met twee velden: lane plus role. Alleen samen
 * onderscheiden ze de botlane-carry van de support.
 */
export function toPosition(lane: string | undefined, role: string | undefined): Position {
  switch (lane) {
    case "TOP":
      return "TOP";
    case "JUNGLE":
      return "JUNGLE";
    case "MIDDLE":
      return "MIDDLE";
    case "BOTTOM":
      return role === "SUPPORT" ? "SUPPORT" : "BOTTOM";
    default:
      return "UNKNOWN";
  }
}

export function slimGame(game: Game): StoredMatch | null {
  // The gate is unchanged for now: this step only makes the record remember what
  // it already knew. Step 5 replaces this line with routing, and by then every
  // record written since today can answer for itself.
  if (!isJadeGame(game)) return null;
  // Remakes en vroege surrenders vertekenen elke statistiek.
  //
  // The threshold lives in shared/types, and not because it looks better there:
  // the screens have to explain why a game they cannot open is missing, and that
  // sentence is only true while they quote this number instead of restating it.
  // Written down twice it drifts, and then a screen gives the wrong reason with
  // complete confidence.
  if (game.gameDuration < MINIMALE_GAMEDUUR_SECONDEN) return null;

  const identityByParticipant = new Map(
    game.participantIdentities.map((identity) => [identity.participantId, identity.player]),
  );

  const players: StoredPlayer[] = [];
  for (const participant of game.participants) {
    const player = identityByParticipant.get(participant.participantId);
    if (!player?.puuid) continue;
    const s = participant.stats;
    players.push({
      puuid: player.puuid,
      championId: participant.championId,
      teamId: participant.teamId,
      position: toPosition(participant.timeline?.lane, participant.timeline?.role),
      win: s.win,
      kills: s.kills,
      deaths: s.deaths,
      assists: s.assists,
      cs: (s.totalMinionsKilled ?? 0) + (s.neutralMinionsKilled ?? 0),
      gold: s.goldEarned ?? 0,
      items: [s.item0, s.item1, s.item2, s.item3, s.item4, s.item5, s.item6],
      spells: [participant.spell1Id, participant.spell2Id],
      // De client stuurde deze al mee en ze werden weggegooid. Ze kosten samen
      // een handvol bytes per speler en ze zijn het verschil tussen een
      // scorebord en een naspel dat iets zegt.
      damage: s.totalDamageDealtToChampions,
      damageTaken: s.totalDamageTaken,
      vision: s.visionScore,
      wards: s.wardsPlaced,
      level: s.champLevel,
    });
  }
  if (players.length < 10) return null;

  return {
    gameId: game.gameId,
    createdAt: game.gameCreation,
    duration: game.gameDuration,
    // Een opgegeven game telt anders dan een uitgespeelde: hij eindigt eerder
    // en de cijfers erin zijn navenant lager.
    surrendered: game.participants[0]?.stats?.gameEndedInSurrender,
    queueId: game.queueId,
    // Decided here and nowhere else, while the client's own answer is still in
    // hand. Below this line gameMode and mapId only exist because we copied them.
    mode: modeOf({ queueId: game.queueId, mapId: game.mapId, gameMode: game.gameMode }),
    gameMode: game.gameMode,
    mapId: game.mapId,
    patch: game.gameVersion.split(".").slice(0, 2).join("."),
    players,
  };
}

/**
 * Loopt regel voor regel door een JSONL-bestand zonder het ooit in zijn geheel
 * in het geheugen te hebben.
 *
 * De vorige versie deed readFile + split("\n"): dat zette eerst het hele
 * bestand als één string in de heap en daarna nog eens alle regels los in een
 * array -- tweemaal de bestandsgrootte, allemaal tegelijk levend. Bij ~500 MB
 * loopt zo'n readFile bovendien tegen V8's maximale stringlengte aan en faalt
 * hij hard, ongeacht hoeveel RAM de machine heeft.
 *
 * Hier is er per moment hooguit één chunk plus één regel levend. `rest` vangt
 * de staart op van een chunk die midden in een regel eindigt. De stream doet
 * zelf de utf8-decodering, dus een meerbyte-teken dat over een chunkgrens valt
 * blijft heel.
 */
async function* readLines(path: string): AsyncGenerator<string, void, void> {
  const stream: AsyncIterable<string> = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: READ_CHUNK,
  });
  let rest = "";
  for await (const chunk of stream) {
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", from);
      if (newline === -1) break;
      const line = chunk.slice(from, newline);
      yield rest.length > 0 ? rest + line : line;
      rest = "";
      from = newline + 1;
    }
    rest += chunk.slice(from);
  }
  // Een laatste regel zonder afsluitende newline hoort er gewoon bij.
  if (rest.length > 0) yield rest;
}

/**
 * Wanneer de bytes van een append naar de schijf zelf gedwongen worden.
 *
 * ── Waarom deze knop bestaat ─────────────────────────────────────────────────
 *
 * Een gewone append komt in de paginacache van het besturingssysteem terecht, niet
 * op de schijf. Dit proces mag daarna omvallen -- de bytes overleven dat -- maar
 * een stroomuitval of een harde reset niet. `add()` gaf tot nu toe terug zonder
 * ooit te fsync'en, dus de client kreeg 'accepted', zette de game in uploaded.json
 * en bood hem nooit meer aan, terwijl hij bij een stroomuitval nooit op schijf was
 * aangekomen. Dat is verlies dat niemand opmerkt, want beide kanten denken dat het
 * goed ging.
 *
 * ── Wat het kost (gemeten: Samsung 980 PRO NVMe, matches.jsonl van 185 MB) ────
 *
 *     append zonder fsync, 2,5 kB     p50 0,16 ms    p95 0,31 ms
 *     append mét fsync, 2,5 kB        p50 2,14 ms    p95 2,40 ms
 *     append zonder fsync, 54 kB      p50 0,20 ms    p95 0,36 ms
 *     append mét fsync, 54 kB         p50 2,09 ms    p95 2,32 ms
 *
 * De fsync kost ~2 ms en dat bedrag is vast: één regel en een blok van twintig
 * regels kosten hetzelfde, want je betaalt de flush van het apparaat en niet de
 * bytes. Daarmee is de keuze eenvoudig, want `add()` schrijft een hele partij in
 * één append -- de fsync is dus sowieso al één per partij en niet één per game.
 * De crawler roept `add()` één keer per speler aan met ~20 games erin: bij 5.000
 * games per uur zijn dat ~250 appends, samen een halve seconde per uur. Zelfs een
 * aanroeper die elke game apart zou aanbieden komt op ~10 seconden per uur uit. Dat
 * legt niets plat, en het valt weg naast de netwerkronde die aan elke crawl-stap
 * voorafgaat.
 *
 * Een teller die pas na N partijen fsync't is daarom expres niet gebouwd: die zou
 * geen meetbare winst opleveren en wél precies het gat terugbrengen waar dit tegen
 * beschermt -- `add()` zou weer 'ja' zeggen over bytes die nog nergens staan.
 *
 * "off" blijft over voor een wegwerp-import waarbij de aanroeper zelf weet dat hij
 * bij een crash gewoon opnieuw begint. Te zetten met ALLMID_FSYNC=0.
 */
export type SyncMode = "append" | "off";

export interface MatchStoreOptions {
  /** Standaard "append": een geslaagde `add()` staat op schijf voordat hij terugkomt. */
  sync?: SyncMode;
}

function envSyncMode(): SyncMode {
  const raw = process.env.ALLMID_FSYNC?.trim().toLowerCase();
  return raw === "0" || raw === "off" || raw === "false" ? "off" : "append";
}

/**
 * Voert `task` uit en probeert het opnieuw zolang de fout van voorbijgaande aard is.
 *
 * Eén lus voor alle schijfacties hier, want ze hebben allemaal dezelfde vijand: de
 * virusscanner houdt het bestand vast en dan faalt élke opening met EPERM, of het
 * nu om een append, een flush, een rename of een blik op de laatste byte gaat.
 */
async function retrying<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (!TRANSIENT_CODES.has(errorCode(error)) || attempt >= APPEND_RETRIES) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

/**
 * Zet `body` achter het bestand aan en komt pas terug als dat echt gelukt is.
 * Geeft terug hoeveel bytes erbij gekomen zijn, zodat de aanroeper zijn beeld van
 * de bestandsgrootte kan bijwerken zonder er nog een keer voor naar schijf te gaan.
 *
 * `written` staat bewust buiten de lus. Een append die halverwege afbreekt heeft
 * al bytes op schijf staan; helemaal opnieuw beginnen zou die dubbel schrijven.
 * Door verder te tellen vanaf waar we gebleven waren maakt een geslaagde
 * herkansing het record alsnog netjes af. Lukt het na alle pogingen niet, dan
 * blijft er een afgekapte laatste regel staan -- die kost één game, en niet meer
 * dan één, omdat de volgende schrijver hem eerst afsluit (`closeTruncatedLine()`).
 */
async function appendDurably(path: string, body: string, sync: boolean): Promise<number> {
  const bytes = Buffer.from(body, "utf8");
  let written = 0;
  await retrying(async () => {
    const handle = await open(path, "a");
    try {
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
        if (bytesWritten === 0) throw new Error("Could not write to the match database; the disk may be full");
        written += bytesWritten;
      }
      // Pas ná deze regel staan de bytes er echt. Ervoor teruggeven laat de
      // aanroeper 'accepted' zeggen over iets dat een stroomuitval niet overleeft.
      if (sync) await handle.sync();
    } finally {
      await handle.close();
    }
  });
  return bytes.length;
}

/** Dwingt alles wat er van dit bestand nog in de cache staat naar de schijf. */
async function syncFile(path: string): Promise<void> {
  await retrying(async () => {
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

/** Wat één blik op het bestand oplevert, zonder de inhoud aan te raken. */
interface FileTail {
  /** Grootte in bytes op het moment van kijken. */
  size: number;
  /** Of de laatste byte een newline is. Een leeg bestand telt als afgesloten. */
  terminated: boolean;
}

/**
 * Vraagt grootte en laatste byte op. Geeft `null` als het bestand er niet is.
 *
 * Bewust geen `readLines()` en zelfs geen laatste blok: we hoeven niet te weten
 * wát er staat, alleen of er nog een newline achter staat. Dat is één open, één
 * fstat en één byte lezen -- ongeveer een tiende milliseconde, ongeacht of het
 * bestand 3 kB of 500 MB groot is. Het hele bestand lezen om dit te weten zou de
 * reden ondermijnen waarom `add()` überhaupt goedkoop is.
 *
 * Lukt het lezen van die byte niet (het bestand kromp tussen fstat en read), dan
 * gaan we uit van 'niet afgesloten'. De prijs van die gok is één lege regel, die
 * `load()` overslaat; de prijs van de andere gok is een opgegeten game.
 */
async function inspectTail(path: string): Promise<FileTail | null> {
  return retrying(async () => {
    let handle: FileHandle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return { size, terminated: true };
      const last = Buffer.alloc(1);
      const { bytesRead } = await handle.read(last, 0, 1, size - 1);
      return { size, terminated: bytesRead === 1 && last[0] === NEWLINE };
    } finally {
      await handle.close();
    }
  });
}

/**
 * Serialiseert matches in blokken van ~1 MB in plaats van in één string.
 * Dezelfde reden als bij het lezen: één `join()` over de hele database is een
 * string ter grootte van het bestand, met dezelfde harde grens erachter.
 */
function* serialize(matches: readonly StoredMatch[]): Generator<string, void, void> {
  let block = "";
  for (const match of matches) {
    block += JSON.stringify(match) + "\n";
    if (block.length >= WRITE_CHUNK) {
      yield block;
      block = "";
    }
  }
  if (block.length > 0) yield block;
}

export class MatchStore {
  private readonly matches = new Map<number, StoredMatch>();
  /**
   * Elke puuid die we ooit gezien hebben; voedsel voor de crawler.
   *
   * Een Map en geen Set omdat we de opgeslagen instantie terug moeten kunnen
   * krijgen: zie `intern()`. Sleutel en waarde zijn dezelfde string.
   */
  private readonly puuids = new Map<string, string>();
  /** Kleine pool voor de handvol patch- en positielabels die eindeloos herhalen. */
  private readonly labels = new Map<string, string>();
  private loaded = false;
  private readonly syncMode: SyncMode;

  /**
   * Hoeveel bytes er stonden toen we voor het laatst keken, plus wat wij er sindsdien
   * zelf bij geschreven hebben.
   *
   * Alleen bedoeld om te merken dat het bestand kléiner is geworden. Groeien mag: de
   * uploader van de manager schrijft in ditzelfde bestand, dus een grotere grootte is
   * normaal en geen alarm -- maar die groei nemen we wél over (zie
   * `detectExternalChange()`), anders zakt dit getal onder de werkelijkheid en glipt
   * een latere krimp eronderdoor. Kleiner kan niet uit onszelf komen: dan heeft iemand
   * buiten dit proces geknipt, hersteld of verwijderd, en klopt ons geheugen niet meer
   * met de schijf.
   *
   * Blijft 0 tot `load()` iets gezien heeft, zodat een nog niet bestaand bestand
   * gewoon aangemaakt mag worden zonder waarschuwing.
   */
  private knownSize = 0;

  /**
   * De schrijfketting van deze store: waar de volgende schrijver achter aansluit.
   *
   * Nodig geworden door de omkering in `add()`. Zolang het indexeren vóór de
   * append gebeurde was de "kennen we deze game al?"-controle synchroon met het
   * opnemen ervan, en kon een tweede aanroeper er niet tussen komen. Nu de append
   * ervóór staat ligt er een await tussen kijken en opnemen, en zonder ketting
   * zouden twee gelijktijdige uploads naar dezelfde gameId allebei door de
   * controle glippen en allebei een regel schrijven. Dat is geen verlies, maar wel
   * twee regels waar er één hoort -- en het is precies de lees-wijzig-schrijf-race
   * die de manager met zijn eigen slot al dichtzet.
   *
   * Bewust een eigen ketting en niet die van de manager: core hoort niets van de
   * manager te weten. Deze ketting zit altijd BINNEN het bestandsslot -- zie
   * `chain()` voor waarom die volgorde vastligt en wat er gebeurt als je hem
   * omdraait.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    options: MatchStoreOptions = {},
  ) {
    this.syncMode = options.sync ?? envSyncMode();
  }

  /**
   * Voert `task` uit zodra de vorige schrijver op deze store klaar is.
   *
   * De staart slikt fouten (`noop, noop`) zodat een mislukte append alleen bij zijn
   * eigen aanroeper terechtkomt; zonder dat zou één EPERM de store voorgoed dicht
   * zetten voor alle volgende schrijvers.
   */
  /**
   * Zet een schrijfactie achteraan de rij, en pakt daarbinnen het slot op het
   * bestand zelf.
   *
   * Twee niveaus, en allebei nodig. De rij regelt de volgorde binnen dit proces.
   * Het slot regelt de volgorde tussen processen, en dat is hier geen theorie:
   * de crawler draait als los proces op hetzelfde matches.jsonl terwijl de
   * Server Manager datzelfde bestand herschrijft. Gemeten zonder slot, met twee
   * echte processen: van 1800 games die `add()` als 'accepted' bevestigd had
   * verdwenen er 1272 bij de eerstvolgende herschrijving. Geen fout, geen
   * kapotte regel -- ze waren gewoon weg, en de client had ze al afgevinkt.
   *
   * De volgorde is bewust rij-dan-slot en nergens andersom: twee sloten die in
   * wisselende volgorde genomen worden is precies hoe je een vastloper bouwt.
   * Neemt de aanroeper het slot al (de Server Manager doet dat tijdens een
   * herschrijving), dan loopt dit gewoon door -- `withFileLock` herkent zijn
   * eigen slot.
   */
  private chain<T>(task: () => Promise<T>): Promise<T> {
    const noop = (): void => {};
    // Slot buiten, rij binnen -- en die volgorde is geen smaak maar een eis.
    //
    // Andersom (rij buiten, slot binnen) sluit een cyclus met `withWriteLock` in
    // de manager, die zijn eigen rij op dezelfde manier om hetzelfde slot legt.
    // Houdt die het slot vast en roept hij binnen zijn taak `add()` aan, terwijl
    // vooraan onze rij een `add()` staat die van buiten die taak kwam, dan wacht
    // de een op de rij en de ander op het slot. Nagemeten: dat hangt permanent,
    // want het wachten op de rij kent geen klok -- zelfs na 150 seconden kwam er
    // geen enkele melding. Met het slot buitenom kan die cyclus niet bestaan.
    return withFileLock(
      this.path,
      () => {
        const started = this.tail.then(task, task);
        this.tail = started.then(noop, noop);
        return started;
      },
      { label: "matchStore" },
    );
  }

  get size(): number {
    return this.matches.size;
  }

  get knownPuuids(): string[] {
    return [...this.puuids.keys()];
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) {
      await mkdir(dirname(this.path), { recursive: true });
      return;
    }
    await this.readFromDisk();
  }

  /**
   * Vult het geheugen met wat er op dit moment in het bestand staat.
   *
   * Gooit eerst weg wat er was, want dit is ook de weg terug als het bestand
   * buiten ons om gekrompen is: dan is 'wat wij nog wisten' juist het probleem.
   * De poolen mogen mee leeg -- ze houden alleen instanties vast van strings die
   * hierna opnieuw langskomen.
   */
  private async readFromDisk(): Promise<void> {
    this.matches.clear();
    this.puuids.clear();
    this.labels.clear();
    let broken = 0;
    for await (const line of readLines(this.path)) {
      if (!line.trim()) continue;
      try {
        this.index(JSON.parse(line) as StoredMatch);
      } catch {
        // Eén kapotte regel kost één game, geen bestand -- precies waarvoor het
        // append-only formaat gekozen is. Tellen en doorlopen.
        broken++;
      }
    }
    if (broken > 0) console.warn(`[matchStore] ${broken} onleesbare regels overgeslagen`);
    // Ná het lezen meten: alles wat er tijdens het lezen bij geschreven is hebben
    // we meegenomen, dus dat hoort ook bij de grootte die we kennen.
    this.knownSize = (await inspectTail(this.path))?.size ?? 0;
  }

  /**
   * Kijkt vlak vóór een schrijfactie of het bestand nog is wat wij denken.
   *
   * Zonder deze controle maakt `open(path, "a")` een verdwenen bestand stilzwijgend
   * opnieuw aan, en gaat de store vrolijk verder met een geheugen dat over 50 games
   * beweert dat ze op schijf staan terwijl er één regel in het nieuwe bestand staat.
   * `has()` zegt dan ja, de server meldt ze via /known als aanwezig, en de client
   * biedt ze nooit meer aan: weg zonder één foutmelding. Hetzelfde geldt als iemand
   * het bestand terugzet uit een backup of de manager er regels uit knipt.
   *
   * Wat we eraan doen is niet 'doorgaan alsof er niets is', maar het melden en ons
   * geheugen opnieuw van schijf halen. Daarna weerspiegelt `has()` weer de schijf,
   * dus wat er niet meer in staat mag de crawler opnieuw aanbieden en komt het
   * vanzelf terug. Alleen doorgaan met een kloppend geheugen -- daar gaat het om.
   *
   * De grens van deze controle, eerlijk opgeschreven: we merken krimp en verdwijnen,
   * niet 'zelfde grootte, andere inhoud'. Daarvoor bestaat de meldweg van de manager
   * (`watch()` in browser.ts). Meer dan grootte en één byte willen we hier niet
   * kosten.
   */
  private async detectExternalChange(): Promise<FileTail | null> {
    const seen = await inspectTail(this.path);
    if (seen !== null && seen.size >= this.knownSize) {
      // De gemeten grootte wordt hier de nieuwe ondergrens, en niet alleen wat wij
      // er zelf in gestopt hebben. Zonder deze regel telt `knownSize` uitsluitend
      // onze eigen appends, terwijl de uploader van de manager in ditzelfde bestand
      // schrijft: na één vreemde append loopt ons getal permanent achter op de
      // schijf, en een latere krimp van hooguit dat bedrag komt dan nog altijd boven
      // `knownSize` uit en wordt niet gemeld. Gemeten: 30 vreemde games erbij, daarna
      // precies die bytes er weer af -- het bestand ging van 90.419 naar 14.969 bytes,
      // er kwam geen enkele waarschuwing, en `has()` bleef true voor onze eigen game
      // die mee was afgeknipt. De stat hebben we hier toch al in handen, dus dit
      // kost geen extra schijfactie.
      this.knownSize = seen.size;
      return seen;
    }

    if (this.knownSize === 0) {
      // Nog nooit iets gezien: het bestand mag gewoon aangemaakt worden.
      if (seen === null) await mkdir(dirname(this.path), { recursive: true });
      return seen;
    }

    console.warn(
      seen === null
        ? `[matchStore] The match database disappeared from ${this.path}; the index no longer matches the disk and is being rebuilt`
        : `[matchStore] The match database shrank from ${this.knownSize} to ${seen.size} bytes outside this process;` +
            ` the index no longer matches the disk and is being rebuilt`,
    );

    if (seen === null) {
      this.matches.clear();
      this.puuids.clear();
      this.labels.clear();
      this.knownSize = 0;
      await mkdir(dirname(this.path), { recursive: true });
      return null;
    }
    await this.readFromDisk();
    return inspectTail(this.path);
  }

  /**
   * Sluit een halve laatste regel af voordat er iets achteraan gaat.
   *
   * Dit is de kern van de reparatie. Een afgebroken append (stroomuitval, ENOSPC,
   * zes keer EPERM na een gedeeltelijke write) laat een record zonder newline
   * achter. Plakt de volgende append daar zijn eigen bytes tegenaan, dan zijn die
   * twee samen één regel, en `JSON.parse` maakt er niets van: het halve record én
   * de eerste hele game van de nieuwe partij zijn allebei weg, terwijl `add()`
   * netjes 'accepted' teruggaf. Eén newline ervoor kost één byte en houdt de schade
   * bij de ene game die al kapot was.
   *
   * ── Waarom we die staart afsluiten en niet afkappen ──────────────────────────
   *
   * De verleiding is om de halve regel meteen weg te snijden (truncate tot de
   * laatste newline). Dat doen we bewust niet:
   *
   *  1. 'Eindigt niet op een newline' betekent niet 'kapot'. Precies zo ziet een
   *     compléét record eruit waarvan alleen de afsluitende newline niet meer
   *     geland is -- `readLines()` levert die laatste regel gewoon af en `load()`
   *     telt hem mee. Afkappen zou daar een goede game vernietigen; een newline
   *     erachter maakt hem juist definitief goed.
   *  2. De staart hoeft niet van ons te zijn. De uploader van de manager schrijft
   *     in ditzelfde bestand vanuit een ander proces. Wat wij als 'half' zien kan
   *     een append zijn die dit moment nog bezig is. Afkappen snijdt dan een record
   *     doormidden waarvan een ander proces al 'accepted' heeft gezegd -- exact het
   *     ongeluk dat browser.ts in zijn kop beschrijft. Onze newline landt via
   *     O_APPEND altijd achter de bytes die er op dat moment staan en kan niets
   *     overschrijven; in het ergste geval staat er een lege regel, en die slaat
   *     `load()` over.
   *  3. Afkappen is onomkeerbaar en wij hebben geen quarantaine. De manager wél:
   *     `repair()` daar schrijft eerst een kopie weg van alles wat sneuvelt en laat
   *     vooraf zien wat het zou zijn. Zo'n halve regel is bovendien het enige spoor
   *     van wat er misging. Die weggooien in een pad dat elke game langsloopt is
   *     precies het soort slimmigheid dat een gebruiker nooit ziet gebeuren.
   *
   * Wat blijft liggen is dus hooguit één onleesbare regel per breuk, en `load()`
   * telt die zichtbaar op als "onleesbare regels overgeslagen". Opruimen doet
   * `compact()` hier, of `repair()` in de manager -- allebei op verzoek, met het
   * hele bestand in beeld, en niet ergens midden in een upload.
   */
  private async closeTruncatedLine(tail: FileTail | null): Promise<void> {
    if (tail === null || tail.terminated) return;
    console.warn(
      `[matchStore] The match database does not end in a newline; a previous write was cut short.` +
        ` Closing that line before appending, so the next game is not swallowed by it`,
    );
    // Met dezelfde duurzaamheid als de rest: gaat de newline bij een stroomuitval
    // alsnog verloren terwijl de records erna wél landen, dan hebben we niets
    // opgelost.
    this.knownSize = tail.size + (await appendDurably(this.path, "\n", this.syncMode === "append"));
  }

  has(gameId: number): boolean {
    return this.matches.has(gameId);
  }

  /**
   * One game by id, without walking the database to find it.
   *
   * The Map behind this is already keyed by gameId, so the scan that used to
   * stand in gameDetail was paying up to 130,127 comparisons for a lookup the
   * data structure answers for free. Measured on the real file: 1.39 ms to reach
   * the last record and 1.00 ms to conclude a game is absent, against 0.0001 ms
   * here. Small beside a 200 ms timeline fetch, which is exactly why it would
   * never have been noticed and never have been fixed.
   */
  get(gameId: number): StoredMatch | null {
    return this.matches.get(gameId) ?? null;
  }

  /**
   * Geeft de al bekende instantie van een string terug, of onthoudt deze.
   *
   * JSON.parse maakt van élk voorkomen een nieuwe string. Een puuid staat ruim
   * 700.000 keer in het bestand terwijl er maar ~230.000 verschillende zijn, en
   * er zijn maar zes positielabels en een handvol patches. Door na het parsen
   * naar de gedeelde instantie te wijzen gooien we die dubbelen meteen weg in
   * plaats van ze de hele draaitijd vast te houden. De waarde verandert niet,
   * alleen het object erachter -- onzichtbaar voor elke aanroeper.
   */
  private static intern<T extends string>(pool: Map<string, string>, value: T): T {
    const known = pool.get(value);
    if (known !== undefined) return known as T;
    pool.set(value, value);
    return value;
  }

  private index(match: StoredMatch): void {
    match.patch = MatchStore.intern(this.labels, match.patch);
    for (const player of match.players) {
      player.puuid = MatchStore.intern(this.puuids, player.puuid);
      player.position = MatchStore.intern(this.labels, player.position);
    }
    this.matches.set(match.gameId, match);
  }

  /**
   * Voegt toe wat nieuw is en geeft terug hoeveel games er echt bijkwamen.
   *
   * Eerst schrijven, dán pas indexeren. Andersom -- zoals dit stond -- kent het
   * geheugen de game al terwijl de append nog kan mislukken, en er is geen weg
   * terug: `has()` zegt vanaf dat moment ja en de schijf zegt nee. De client die de
   * game daarna opnieuw aanbiedt krijgt tot in de eeuwigheid 'duplicate' terug voor
   * iets dat nergens staat, en de game is stilletjes weg. Mislukt de append nu, dan
   * is het geheugen precies zoals het was en gaat de fout naar de aanroeper, die
   * het rustig opnieuw kan proberen.
   */
  /*
   * A note on counting, because comments elsewhere quote a number.
   *
   * matches.jsonl is append-only and holds one game per line, but the two counts
   * are not the same: as of today 130,095 lines carry 130,086 distinct gameIds.
   * Nine ids appear twice, from before this method took the file's own contents
   * as the truth rather than its in-memory index. The Map below keys on gameId,
   * so a duplicate line costs disk and nothing else -- but `wc -l` overstates
   * the database by nine, and any comment quoting a measurement should quote the
   * number the app would reproduce.
   */
  async add(incoming: StoredMatch[]): Promise<number> {
    return this.chain(async () => {
      if (incoming.length === 0) return 0;

      // Eerst kijken wat er op schijf staat, dán pas filteren. Andersom zou de
      // controle "ken ik deze al?" op een geheugen slaan dat na een krimp niet meer
      // klopt: juist de games die van schijf verdwenen zijn worden dan als bekend
      // weggefilterd, `fresh` blijft leeg, en de krimp valt nooit op -- terwijl de
      // client 'duplicate' hoort over een game die nergens meer staat.
      const tail = await this.detectExternalChange();
      await this.closeTruncatedLine(tail);

      const fresh = incoming.filter((match) => !this.matches.has(match.gameId));
      if (fresh.length === 0) return 0;

      const body = `${fresh.map((match) => JSON.stringify(match)).join("\n")}\n`;
      this.knownSize += await appendDurably(this.path, body, this.syncMode === "append");

      // Pas hier het geheugen bijwerken. `index()` interneert strings, en dat
      // verandert alleen wélke instantie een veld aanwijst, niet de waarde -- de
      // regels op schijf zijn dus hoe dan ook byte voor byte dezelfde als eerst.
      for (const match of fresh) this.index(match);
      return fresh.length;
    });
  }

  /**
   * Alle games als array.
   *
   * Dit is bewust blijven staan en dat kost wat. De aanroepers verwachten stuk
   * voor stuk een echte array -- `JadeStats.from(StoredMatch[])`,
   * `likelyPosition(matches, ...)`, `.filter()` in de uploader, `.sort()` in
   * service.ts -- dus een iterator teruggeven zou ze allemaal breken. De kosten:
   *
   *  - De records zelf moeten in de Map blijven, want `all()` is synchroon en
   *    kan dus niet opnieuw van schijf lezen. Bij 70.000 games is dat ~230 MB
   *    die de hele draaitijd vast blijft staan. Dát is nu de bodem van het
   *    geheugengebruik, niet meer het inlezen.
   *  - Elke aanroep kopieert daarbovenop ~70.000 pointers (~0,6 MB, kortstondig).
   *    Dat is peanuts naast het eerste punt, maar service.ts roept `all()` twee
   *    keer aan in dezelfde functie; wie daar langs komt kan dat opruimen.
   *
   * Wie geen array nodig heeft gebruikt `values()` en bespaart de kopie.
   */
  all(): StoredMatch[] {
    return [...this.matches.values()];
  }

  /**
   * Dezelfde games, maar als iterator: geen kopie, geen tweede array.
   * De migratieweg voor `all()`-aanroepers die alleen maar doorlopen.
   */
  values(): IterableIterator<StoredMatch> {
    return this.matches.values();
  }

  /**
   * Herschrijft het bestand zonder dubbele of kapotte regels.
   *
   * ── Waarom deze methode blijft bestaan, en waarom zo ─────────────────────────
   *
   * Ze heeft vandaag nul aanroepers, en weghalen was net zo goed te verdedigen
   * geweest. Toch blijft ze staan, om één reden: `closeTruncatedLine()` ruimt een
   * halve regel bewust níét op maar laat hem liggen. Als dit de enige opruimweg was
   * en we halen hem weg, dan heeft die keuze geen tegenhanger meer binnen dit
   * proces en stapelt het gruis zich op tot iemand de manager opstart. Een pad dat
   * op verzoek en met het hele bestand in beeld schoonmaakt, hoort erbij.
   *
   * Ze deed dat alleen op een manier die veel gevaarlijker was dan waar ze tegen
   * beschermde: `createWriteStream(this.path)` kapt het echte bestand meteen af tot
   * nul bytes en vult het daarna opnieuw. Een crash, een volle schijf of een EPERM
   * halverwege liet dus geen halve regel achter maar een halve database -- alles
   * wat nog niet teruggeschreven was, was weg. De hele database inruilen om één
   * kapotte regel op te ruimen is geen goede ruil.
   *
   * Nu gaat het via een tmp-bestand dat pas na een geslaagde fsync met één rename
   * op zijn plaats komt: dezelfde weg die de manager in `applyEditsLocked()` volgt.
   * Gaat er onderweg iets mis, dan is `matches.jsonl` geen byte veranderd en blijft
   * er hooguit een `.tmp-`bestand liggen dat we zelf opruimen.
   *
   * Loopt door dezelfde ketting als `add()`, want een append die middenin de rename
   * landt zou in het oude bestand terechtkomen en bij de wissel verdwijnen.
   */
  async compact(): Promise<void> {
    return this.chain(async () => {
      // Ook hier eerst kijken of het bestand nog van ons is. Compact schrijft het
      // geheugen over de schijf heen: heeft de manager er regels uit gehaald, dan
      // zouden we die zonder deze controle allemaal weer terugzetten.
      await this.detectExternalChange();

      const ordered = this.all().sort((a, b) => a.createdAt - b.createdAt);
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now().toString(36)}`;
      try {
        // Schrijven via een stream, zodat er nooit meer dan één blok tegelijk in de
        // heap staat en pipeline de tegendruk van de schijf afhandelt.
        await pipeline(serialize(ordered), createWriteStream(tmp, { encoding: "utf8" }));
        // Fsync vóór de rename, niet erna: anders kan de wissel wél op schijf staan
        // en de inhoud van het nieuwe bestand nog niet. "r+" omdat Windows schrijf-
        // rechten eist voor een flush. Wat we niet kunnen afdwingen is de duurzaam-
        // heid van de rename zelf -- daar bestaat op Windows geen directory-fsync
        // voor -- maar het ergste wat dat kost is dat het oude bestand terugkomt,
        // en dat is compleet.
        if (this.syncMode === "append") await syncFile(tmp);
        await retrying(() => rename(tmp, this.path));
      } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw error;
      }
      // Het bestand is met opzet kleiner geworden; zonder dit zou de eerstvolgende
      // `add()` dat als krimp van buiten melden en het net herschreven bestand
      // meteen weer inlezen.
      this.knownSize = (await inspectTail(this.path))?.size ?? 0;
    });
  }
}

export const defaultStorePath = (root: string): string => join(root, "data", "matches.jsonl");
