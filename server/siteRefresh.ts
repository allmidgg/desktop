/**
 * Verversing van de gepubliceerde site, aangedreven door binnenkomende games.
 *
 * ── Waarom dit bestand bestaat ───────────────────────────────────────────────
 *
 * De cijfers op allmid.gg zitten ingebakken in bestanden: site/data/*.json wordt
 * gegenereerd uit matches.jsonl, en site/index.html wordt daar weer uit gebakken.
 * Zolang niemand die keten met de hand doorloopt veroudert de site vanaf de eerste
 * game die binnenkomt. Dit bestand doorloopt hem vanzelf.
 *
 * Alles hieronder draait om één spanning: de doorloop kost ~9 seconden over 307 MB
 * en de uploads mogen daar niets van merken. Vandaar de vier keuzes die de rest van
 * dit bestand vormgeven:
 *
 *   1. Een drempel én een tijdsondergrens, niet elke upload  -- zie MOET_VERVERSEN
 *   2. Nooit twee tegelijk, en niet stapelen                 -- zie overweeg()
 *   3. Alles in kindprocessen, nooit in de serverlus         -- zie draaiProces()
 *   4. Een halve doorloop mag de site nooit raken            -- zie promoveer()
 *
 * ── Het padprobleem, en waarom het zo is opgelost ────────────────────────────
 *
 * Op de server staan drie dingen op drie plekken: de repo in C:\allmid\desktop, de
 * database in C:\allmid\server-data en de gepubliceerde site in C:\inetpub\allmid.
 * De generator schrijft in de repo, IIS serveert uit inetpub.
 *
 * refresh.mjs kán rechtstreeks naar C:\inetpub\allmid\data schrijven -- hij heeft
 * er een --out voor. Toch gebeurt dat hier niet, om drie redenen:
 *
 *   - Het lost maar de helft op. build.mjs leest site/data/*.json en schrijft
 *     site/index.html, allebei relatief aan zijn eigen locatie in de repo. De HTML
 *     kan dus sowieso alleen in de repo ontstaan en moet daarna alsnog gekopieerd
 *     worden. Dan liever één weg naar buiten dan twee.
 *   - Rechtstreeks schrijven is niet atomair. refresh.mjs doet drie losse
 *     writeFileSync'en; halverwege omvallen zou een live site met een halve
 *     champions.json opleveren. In de repo is dat een kapotte werkkopie, in
 *     inetpub is het een kapotte website.
 *   - Er hoort meer dan JSON in inetpub, en niet alles uit site/ mag mee. De
 *     ontwerpvarianten (site\_var-*.html) moeten er expliciet buiten blijven en
 *     web.config moet erin. Die kennis staat al in deploy\publish.ps1.
 *
 * Daarom: genereren in de repo, en het naar buiten brengen overlaten aan
 * publish.ps1 -- met -SkipBuild, want de HTML hebben we hier dan al gebouwd en zo
 * zien we het resultaat van die stap zelf. Robocopy in Node nabouwen zou betekenen
 * dat die uitsluitingslijst op twee plaatsen staat, en dat is precies hoe een
 * ontwerpvariant later stilletjes op een publieke site belandt.
 *
 * ── Instellen ────────────────────────────────────────────────────────────────
 *
 *   ALLMID_SITE_REFRESH=1        aanzetten. STANDAARD UIT: wie de server op zijn
 *                                laptop draait heeft geen site en hoort hier niets
 *                                van te merken.
 *   ALLMID_SITE_OUT=C:\inetpub\allmid   waar de site gepubliceerd wordt. Leeg =
 *                                alleen de repo bijwerken, geen publicatie.
 *   ALLMID_SITE_REPO=...         waar de repo staat. Standaard afgeleid van dit
 *                                bestand, dus onafhankelijk van de werkmap.
 *   ALLMID_SITE_EVERY=2000       drempel in nieuwe games.
 *   ALLMID_SITE_MIN_MINUTES=30   tijdsondergrens tussen twee doorlopen.
 *   ALLMID_SITE_MAX_MINUTES=360  bovengrens: hoe lang de site hooguit veroudert
 *                                als er wél iets binnenkomt maar te weinig.
 *   ALLMID_SITE_TIMEOUT_MINUTES=20  daarna wordt een kind afgeschoten.
 *   ALLMID_SITE_TMP=...          werkmap voor de generator. Moet op hetzelfde
 *                                volume als de repo staan, anders is de laatste
 *                                stap (rename) geen wissel meer maar een kopie.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { constants as osConstants, setPriority } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** De drie bestanden die refresh.mjs schrijft. Alle drie of geen. */
const UITVOER = ["meta.json", "champions.json", "builds.json"] as const;

const HIER = dirname(fileURLToPath(import.meta.url)); // server/

export interface SiteRefreshStatus {
  enabled: boolean;
  running: boolean;
  /** Wanneer de laatste geslaagde doorloop klaar was, of wat de gepubliceerde meta.json zegt. */
  lastRefreshAt: string | null;
  /** Hoeveel games er in die doorloop zaten -- het getal dat de site nú toont. */
  gamesAtLastRefresh: number | null;
  /** Hoeveel games er sindsdien bij zijn gekomen en dus nog niet op de site staan. */
  pendingGames: number;
  lastDurationMs: number | null;
  lastError: string | null;
  runs: number;
  failures: number;
  threshold: number;
  minMinutes: number;
  maxMinutes: number;
}

interface Instellingen {
  aan: boolean;
  repo: string;
  uit: string | null;
  tmp: string;
  drempel: number;
  minMs: number;
  maxMs: number;
  timeoutMs: number;
}

function getal(naam: string, standaard: number): number {
  const rauw = process.env[naam];
  if (rauw === undefined || rauw.trim() === "") return standaard;
  const waarde = Number(rauw);
  // Nul is toegestaan en betekent "geen wachttijd" -- handig om dit met de hand
  // door te meten. Negatief of onzin is een typefout, en dan is de standaard
  // veiliger dan raden wat er bedoeld werd.
  if (!Number.isFinite(waarde) || waarde < 0) {
    console.warn(`[site] ${naam}=${rauw} is geen bruikbaar getal; ${standaard} aangehouden`);
    return standaard;
  }
  return waarde;
}

/**
 * Standaard uit, en alleen "1/on/true/ja" zet hem aan.
 *
 * Bewust niet "aan zodra ALLMID_SITE_OUT gezet is": dan zou een verkeerd overgenomen
 * omgevingsvariabele stilletjes een robocopy /MIR op een map in gang zetten. Dit
 * hoort een bewuste handeling te zijn.
 */
function aanZetter(): boolean {
  const rauw = (process.env.ALLMID_SITE_REFRESH ?? "").trim().toLowerCase();
  return rauw === "1" || rauw === "on" || rauw === "true" || rauw === "ja" || rauw === "aan";
}

function lees(): Instellingen {
  const repo = process.env.ALLMID_SITE_REPO?.trim() || resolve(HIER, "..");
  const uit = process.env.ALLMID_SITE_OUT?.trim();
  return {
    aan: aanZetter(),
    repo: isAbsolute(repo) ? repo : resolve(process.cwd(), repo),
    uit: uit ? (isAbsolute(uit) ? uit : resolve(process.cwd(), uit)) : null,
    tmp: process.env.ALLMID_SITE_TMP?.trim() || join(repo, ".site-refresh-tmp"),
    /**
     * ── De drempel: 2.000 nieuwe games ────────────────────────────────────────
     *
     * Bewust hoger dan REBUILD_AFTER_UPLOADS (500) in index.ts, want dat is een
     * andere som met een andere prijs. Die 500 hertelt JadeStats in het geheugen
     * voor /api/v1/stats: geen schijf, geen kindproces, en de clients vragen dat
     * cijfer live op. Deze doorloop leest 307 MB twee keer van schijf, bouwt de
     * HTML opnieuw en spiegelt daarna de hele site naar inetpub. Twee ordes
     * duurder, voor een pagina die niemand per seconde ververst.
     *
     * Waarom 2.000 en niet minder: op ~300.000 games is dat 0,67% van de dataset.
     * De site drukt winrates op één decimaal af; een aangroei van 0,67% kan zo'n
     * afgerond percentage bij geen enkele champion met een fatsoenlijke steekproef
     * verzetten. Vaker verversen levert dus letterlijk hetzelfde plaatje op.
     *
     * Waarom niet meer: bij het waargenomen crawltempo (~5.000 games per uur, zie
     * de meting in matchStore.ts) is 2.000 ongeveer 25 minuten achterstand. Dat is
     * de orde van grootte waarop iemand "de site loopt achter" nog niet merkt.
     *
     * Wat het kost: 2,5 doorlopen per uur × 9 s = ~25 s per uur, oftewel 0,7% van
     * de tijd. Met 500 zou dat 10 doorlopen per uur zijn: 90 s per uur, en het
     * bestand van 307 MB gaat twintig keer per uur door de paginacache waar de
     * appends van de verzamelaar zelf op leunen.
     */
    drempel: Math.max(1, getal("ALLMID_SITE_EVERY", 2_000)),
    /**
     * ── De tijdsondergrens: 30 minuten ────────────────────────────────────────
     *
     * De drempel alleen begrenst niets. Eén client mag 500 matches per verzoek
     * sturen en 120 verzoeken per minuut doen; tien clients die tegelijk hun
     * achterstand lozen halen die 2.000 in seconden, en dan staan er doorlopen op
     * elkaar te wachten terwijl de uploads doorkomen. De ondergrens maakt het
     * bovenste tempo onafhankelijk van hoe hard er geüpload wordt: hooguit twee
     * doorlopen per uur, samen 18 seconden.
     *
     * Het kost geen zichtbare versheid: 30 minuten is bij het crawltempo ~2.500
     * games, en die vallen om dezelfde reden weg als de drempel hierboven.
     *
     * Er zit nog een tweede reden onder. Elke doorloop eindigt in een robocopy
     * /MIR over de map die IIS op dat moment staat te serveren. Dat wil je een
     * paar keer per uur doen, niet een paar keer per minuut.
     */
    minMs: getal("ALLMID_SITE_MIN_MINUTES", 30) * 60_000,
    /**
     * ── De bovengrens: 6 uur ──────────────────────────────────────────────────
     *
     * Zonder deze grens bevriest de site bij een laag tempo. Draait er één client
     * die 50 games per dag aanlevert, dan duurt het veertig dagen voor de drempel
     * van 2.000 gehaald wordt en toont de pagina al die tijd oude cijfers. Staat er
     * iets klaar en is de laatste doorloop ouder dan dit, dan gaat hij toch.
     * Kosten in het slechtste geval: vier doorlopen per dag.
     */
    maxMs: getal("ALLMID_SITE_MAX_MINUTES", 360) * 60_000,
    /**
     * Een generator die vastloopt of het geheugen opeet mag niet eeuwig blijven
     * hangen; dan zou `lopend` nooit meer vrijkomen en verversde de site nooit meer.
     * 20 minuten is ruim twee ordes boven de gemeten 9 seconden, dus dit gaat alleen
     * af als er echt iets stuk is.
     */
    timeoutMs: getal("ALLMID_SITE_TIMEOUT_MINUTES", 20) * 60_000,
  };
}

interface Oordeel {
  nu: boolean;
  /** Over hoeveel ms het opnieuw zin heeft te kijken. Ontbreekt als er niets wacht. */
  wachtMs?: number;
}

/** Wat één geslaagde doorloop over zichzelf zegt. */
interface Momentopname {
  games: number;
  generatedAt: string | null;
}

/**
 * Leest de drie gegenereerde bestanden en kijkt of ze samen een geldige jaargang
 * vormen.
 *
 * Dit is de vervanging voor de atomiciteit die refresh.mjs niet heeft: dat script
 * doet drie losse writeFileSync'en, dus als het halverwege omvalt staat er een
 * nieuwe meta.json naast een oude builds.json. build.mjs bakt die twee daarna
 * gewoon samen in één pagina -- hij waarschuwt er wel over, maar hij stopt niet.
 *
 * Vandaar dat de drie bestanden pas de repo in mogen als ze alle drie bestaan,
 * alle drie parsen, en alle drie hetzelfde aantal games rapporteren. Dat laatste
 * is de scherpste controle die er is: refresh.mjs schrijft ze uit één bevroren
 * venster, dus ongelijke totalen betekenen per definitie dat er iets van een
 * vorige doorloop tussen zit.
 */
function keurUitvoer(map: string): Momentopname {
  let games: number | null = null;
  let generatedAt: string | null = null;

  for (const naam of UITVOER) {
    const pad = join(map, naam);
    if (!existsSync(pad)) throw new Error(`${naam} is niet geschreven`);
    if (statSync(pad).size === 0) throw new Error(`${naam} is leeg`);

    let inhoud: { totals?: { games?: unknown }; champions?: unknown; generatedAt?: unknown };
    try {
      inhoud = JSON.parse(readFileSync(pad, "utf8")) as typeof inhoud;
    } catch (fout) {
      throw new Error(`${naam} is geen geldige JSON: ${(fout as Error).message}`);
    }

    const aantal = inhoud.totals?.games;
    if (typeof aantal !== "number" || !Number.isFinite(aantal) || aantal <= 0) {
      throw new Error(`${naam} meldt geen bruikbaar aantal games`);
    }
    if (games === null) games = aantal;
    else if (games !== aantal) {
      throw new Error(`${naam} staat op ${aantal} games terwijl de vorige op ${games} stond`);
    }

    // champions.json hoort altijd het hele roster te bevatten, hoe klein de
    // database ook is; is dat leeg, dan is er iets grondig mis. builds.json krijgt
    // die eis bewust niet: daar komt een champion pas in bij 100 games in dezelfde
    // lane, dus op een verse of kleine database is leeg daar het juiste antwoord.
    if (naam === "champions.json") {
      const champions = inhoud.champions;
      if (typeof champions !== "object" || champions === null || Object.keys(champions).length === 0) {
        throw new Error(`${naam} bevat geen champions`);
      }
    }
    // meta.json komt als eerste langs en houdt de milliseconden; die datum is
    // ook wat leesGepubliceerd() bij een herstart terugleest, dus dan komt op
    // /health twee keer hetzelfde te staan in plaats van twee bijna-gelijke tijden.
    if (generatedAt === null && typeof inhoud.generatedAt === "string") generatedAt = inhoud.generatedAt;
  }

  return { games: games ?? 0, generatedAt };
}

/**
 * Wat er op dit moment gepubliceerd staat, gelezen uit meta.json.
 *
 * Hiermee overleeft de teller een herstart. Zonder dit begint `wacht` na elke
 * herstart weer op nul en zou een server die af en toe opnieuw start de drempel
 * nooit halen -- de site zou dan eeuwig oude cijfers tonen zonder dat er iets
 * misgaat wat je kunt zien. Het geeft bovendien meteen een eerlijk antwoord op
 * /health, ook als er in deze draai nog niet ververst is.
 */
function leesGepubliceerd(paden: string[]): Momentopname | null {
  for (const pad of paden) {
    try {
      if (!existsSync(pad)) continue;
      const meta = JSON.parse(readFileSync(pad, "utf8")) as {
        totals?: { games?: unknown; generatedAt?: unknown };
        generatedAt?: unknown;
      };
      const games = meta.totals?.games;
      if (typeof games !== "number" || !Number.isFinite(games)) continue;
      const wanneer = typeof meta.generatedAt === "string" ? meta.generatedAt : null;
      return { games, generatedAt: wanneer };
    } catch {
      // Onleesbaar is hier geen ramp: dan beginnen we gewoon zonder voorkennis.
    }
  }
  return null;
}

interface ProcesResultaat {
  code: number | null;
  staart: string;
  afgeschoten: boolean;
}

/**
 * Draait één programma als kindproces en komt terug als het klaar is.
 *
 * Kindproces en niet in dit proces, en dat is de hele reden dat deze functie
 * bestaat. refresh.mjs houdt tijdens de doorloop miljoenen tellingen in het
 * geheugen; een OOM of een uitzondering daarin mag geen enkele upload meeslepen.
 * Zolang dit draait blijft de eventlus van de server gewoon vrij -- alleen de
 * regels die het kind uitspuugt komen langs, en dat is een handvol per doorloop.
 *
 * De uitvoer wordt doorgegeven én de staart ervan bewaard, begrensd op een paar
 * kilobyte: bij een fout wil je de laatste regels zien, en bij een generator die
 * in een lus megabytes logt wil je niet dat dit proces het geheugen vol trekt dat
 * we juist bij het kind wilden houden.
 */
function draaiProces(
  exe: string,
  argumenten: string[],
  werkmap: string,
  budgetMs: number,
  label: string,
): Promise<ProcesResultaat> {
  return new Promise((klaar) => {
    const kind = spawn(exe, argumenten, { cwd: werkmap, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    // Een doorloop van 9 seconden vol schijf-IO naast een server die verzoeken
    // moet beantwoorden: laat het besturingssysteem weten wie er voorrang heeft.
    // Mag mislukken (rechten), en dan is er niets aan de hand.
    try {
      setPriority(kind.pid ?? 0, osConstants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* niet erg */
    }

    let staart = "";
    let rest = "";
    const opUitvoer = (blok: Buffer): void => {
      const tekst = rest + blok.toString("utf8");
      const regels = tekst.split(/\r?\n/);
      rest = regels.pop() ?? "";
      for (const regel of regels) {
        if (!regel.trim()) continue;
        console.log(`[site:${label}] ${regel}`);
        staart = (staart + regel + "\n").slice(-4_000);
      }
    };
    kind.stdout.on("data", opUitvoer);
    kind.stderr.on("data", opUitvoer);

    let afgeschoten = false;
    const wekker = setTimeout(() => {
      afgeschoten = true;
      console.error(`[site] ${label} duurt langer dan ${Math.round(budgetMs / 60_000)} minuten; afgeschoten`);
      kind.kill();
      // Windows kent geen SIGTERM-beleefdheid; blijft hij hangen, dan hard.
      setTimeout(() => kind.kill("SIGKILL"), 5_000).unref();
    }, budgetMs);
    wekker.unref();

    const afronden = (code: number | null): void => {
      clearTimeout(wekker);
      if (rest.trim()) {
        console.log(`[site:${label}] ${rest}`);
        staart = (staart + rest + "\n").slice(-4_000);
      }
      klaar({ code, staart, afgeschoten });
    };

    kind.on("error", (fout) => {
      staart += `${fout.message}\n`;
      afronden(null);
    });
    kind.on("close", (code) => afronden(code));
  });
}

export class SiteRefresher {
  private readonly opties: Instellingen;
  private readonly database: string;
  private readonly gamesNu: () => number;

  private lopend = false;
  private wekker: NodeJS.Timeout | null = null;

  private wacht = 0;
  private laatsteEinde = 0;
  private laatsteMomentopname: Momentopname | null = null;
  private laatsteDuurMs: number | null = null;
  private laatsteFout: string | null = null;
  private doorlopen = 0;
  private mislukt = 0;
  /** Opeenvolgende mislukkingen; voedt de oplopende pauze in oordeel(). */
  private opRij = 0;

  constructor(database: string, gamesNu: () => number) {
    this.opties = lees();
    this.database = database;
    this.gamesNu = gamesNu;
  }

  /**
   * Kijkt wat er al gepubliceerd staat en meldt hoe de server ingesteld is.
   *
   * Alle grenzen worden bij het opstarten uitgeschreven, want dit is precies het
   * soort mechaniek waarvan je een half jaar later wilt kunnen zien waarom hij nu
   * wel of niet gelopen heeft.
   */
  start(): void {
    if (!this.opties.aan) {
      console.log("[site] automatische verversing staat uit (zet ALLMID_SITE_REFRESH=1 om hem aan te zetten)");
      return;
    }

    const kandidaten = [join(this.opties.repo, "site", "data", "meta.json")];
    // Wat inetpub toont is de waarheid over wat bezoekers zien; die gaat voor.
    if (this.opties.uit) kandidaten.unshift(join(this.opties.uit, "data", "meta.json"));

    this.laatsteMomentopname = leesGepubliceerd(kandidaten);
    if (this.laatsteMomentopname) {
      const wanneer = this.laatsteMomentopname.generatedAt;
      this.laatsteEinde = wanneer ? Date.parse(wanneer) || 0 : 0;
      this.wacht = Math.max(0, this.gamesNu() - this.laatsteMomentopname.games);
    }

    console.log(
      `[site] automatische verversing aan: elke ${this.opties.drempel} nieuwe games, ` +
        `hooguit eens per ${Math.round(this.opties.minMs / 60_000)} min, ` +
        `en sowieso binnen ${Math.round(this.opties.maxMs / 60_000)} min als er iets klaarstaat`,
    );
    console.log(`[site] repo ${this.opties.repo} -> ${this.opties.uit ?? "(niet publiceren, alleen de repo bijwerken)"}`);
    if (this.laatsteMomentopname) {
      console.log(
        `[site] gepubliceerd staat ${this.laatsteMomentopname.games} games ` +
          `(${this.laatsteMomentopname.generatedAt ?? "datum onbekend"}); ${this.wacht} games nog niet op de site`,
      );
    } else {
      console.log("[site] geen gepubliceerde meta.json gevonden; de eerste upload zet een doorloop in gang");
    }

    // Meteen kijken: staat er al een berg klaar (bijvoorbeeld omdat de server een
    // week uit heeft gestaan), dan hoeft daar geen upload op te wachten.
    this.overweeg();
  }

  /** Aanroepen met het aantal games dat een upload écht toevoegde. */
  noteUploads(nieuw: number): void {
    if (!this.opties.aan || nieuw <= 0) return;
    this.wacht += nieuw;
    this.overweeg();
  }

  status(): SiteRefreshStatus {
    return {
      enabled: this.opties.aan,
      running: this.lopend,
      lastRefreshAt: this.laatsteMomentopname?.generatedAt ?? null,
      gamesAtLastRefresh: this.laatsteMomentopname?.games ?? null,
      pendingGames: this.wacht,
      lastDurationMs: this.laatsteDuurMs,
      lastError: this.laatsteFout,
      runs: this.doorlopen,
      failures: this.mislukt,
      threshold: this.opties.drempel,
      minMinutes: Math.round(this.opties.minMs / 60_000),
      maxMinutes: Math.round(this.opties.maxMs / 60_000),
    };
  }

  /**
   * Mag er nu een doorloop, en zo nee, wanneer heeft het weer zin te kijken?
   *
   * De volgorde is niet vrijblijvend: de ondergrens staat vóór de drempel, zodat
   * een stortvloed uploads het tempo niet kan opdrijven. En hij staat ook vóór de
   * bovengrens, want anders zou een oplopende pauze na een mislukking meteen weer
   * door de bovengrens overruled worden.
   */
  private oordeel(nu: number): Oordeel {
    if (this.wacht <= 0) return { nu: false };

    // Na een mislukking oplopend wachten: 30, 60, 120, 240 minuten. Een generator
    // die stuk is (verkeerd pad, volle schijf) blijft anders elke ondergrens
    // opnieuw 9 seconden schijf staan lezen om weer dezelfde fout te vinden.
    //
    // De 10 seconden eronder zijn er voor het geval iemand de ondergrens op 0 zet:
    // een doorloop die meteen omvalt zou dan door de herkansing in draai() in een
    // strakke lus komen, en dat is precies de plaag waar dit tegen moet beschermen.
    const basis = this.opRij > 0 ? Math.max(this.opties.minMs, 10_000) : this.opties.minMs;
    const pauze = basis * 2 ** Math.min(this.opRij, 3);
    const sinds = nu - this.laatsteEinde;
    if (sinds < pauze) return { nu: false, wachtMs: pauze - sinds };

    if (this.wacht >= this.opties.drempel) return { nu: true };
    if (sinds >= this.opties.maxMs) return { nu: true };
    return { nu: false, wachtMs: this.opties.maxMs - sinds };
  }

  /**
   * Eén beslispunt, aangeroepen na elke upload, na elke doorloop en door de wekker.
   *
   * Loopt er al een, dan gebeurt er hier niets meer: twee generators tegelijk op
   * hetzelfde bestand van 307 MB is dubbel geheugen, dubbele schijf, en een race om
   * dezelfde drie uitvoerbestanden.
   *
   * "Nog eens doen zodra deze klaar is" heeft daarvoor geen aparte vlag nodig, en
   * dat is met opzet: `wacht` is de markering. Wat er tijdens een doorloop
   * binnenkomt is dat getal al opgehoogd door noteUploads(), en draai() komt in
   * zijn finally hier terug om opnieuw te oordelen. Een teller kan niet stapelen --
   * honderd uploads tijdens één doorloop leveren daarna één afweging op, geen
   * honderd wachtende doorlopen.
   */
  private overweeg(): void {
    if (!this.opties.aan) return;
    if (this.lopend) return;

    const oordeel = this.oordeel(Date.now());
    if (oordeel.nu) {
      void this.draai();
      return;
    }
    // Eén wekker, altijd de nieuwste berekening. Hij houdt het proces niet in
    // leven (unref), want dit is nooit een reden om niet af te sluiten.
    if (this.wekker) clearTimeout(this.wekker);
    this.wekker = null;
    if (oordeel.wachtMs !== undefined) {
      this.wekker = setTimeout(() => {
        this.wekker = null;
        this.overweeg();
      }, Math.min(oordeel.wachtMs, 2 ** 31 - 1));
      this.wekker.unref();
    }
  }

  private async draai(): Promise<void> {
    this.lopend = true;
    const begin = Date.now();

    try {
      await this.doorloop();
      this.doorlopen++;
      this.laatsteFout = null;
      this.opRij = 0;
    } catch (fout) {
      // Mislukken is niet fataal. De oude bestanden staan er nog (promoveer()
      // komt pas in beeld als álles goed gegaan is), `wacht` wordt niet
      // teruggezet, en bij de volgende gelegenheid gaat hij gewoon opnieuw.
      this.mislukt++;
      this.opRij++;
      this.laatsteFout = (fout as Error).message;
      console.error(`[site] verversing mislukt: ${this.laatsteFout}`);
      console.error(`[site] de gepubliceerde bestanden zijn niet aangeraakt; volgende poging bij de volgende drempel`);
    } finally {
      this.lopend = false;
      this.laatsteEinde = Date.now();
      this.laatsteDuurMs = this.laatsteEinde - begin;
      // Altijd opnieuw oordelen, geslaagd of niet: er kan tijdens deze doorloop
      // genoeg binnengekomen zijn voor de volgende, of er staat iets te wachten
      // op de bovengrens. Zonder deze regel blijft dat liggen tot de eerstvolgende
      // upload, en die hoeft nooit meer te komen.
      this.overweeg();
    }
  }

  private async doorloop(): Promise<void> {
    const { repo, tmp, uit, timeoutMs } = this.opties;

    if (!existsSync(this.database)) {
      throw new Error(`de database staat (nog) niet op ${this.database}`);
    }

    const begin = Date.now();
    const deadline = begin + timeoutMs;
    const rest = (): number => Math.max(1_000, deadline - Date.now());

    // Schone werkmap. Blijft er van een vorige keer iets liggen (hard afgeschoten
    // proces), dan zou een half bestand daaruit alsnog gepromoveerd kunnen worden.
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    try {
      // 1. De cijfers, naar de werkmap. Niet rechtstreeks naar site/data, want dan
      //    zou een mislukking halverwege de repo met een halve jaargang achterlaten.
      const generator = await draaiProces(
        process.execPath,
        [join(repo, "site", "data", "refresh.mjs"), "--in", this.database, "--out", tmp],
        repo,
        rest(),
        "refresh",
      );
      if (generator.code !== 0) {
        throw new Error(
          `refresh.mjs eindigde met code ${generator.code}${generator.afgeschoten ? " (afgeschoten)" : ""}: ` +
            kort(generator.staart),
        );
      }

      // 2. Pas nu geloven we het. Drie bestanden, één jaargang, of niets.
      const momentopname = keurUitvoer(tmp);

      // 3. De wissel.
      promoveer(tmp, join(repo, "site", "data"));

      // 4. De HTML, want de cijfers zitten er ingebakken. Alleen de JSON verversen
      //    laat de pagina oude getallen tonen.
      const bouw = await draaiProces(process.execPath, [join(repo, "site", "build.mjs")], repo, rest(), "build");
      if (bouw.code !== 0) {
        throw new Error(`build.mjs eindigde met code ${bouw.code}: ${kort(bouw.staart)}`);
      }

      // 5. Naar buiten. -SkipBuild omdat stap 4 dat al gedaan heeft; publish.ps1
      //    doet hier de robocopy /MIR, de uitsluitingen en web.config.
      //
      //    -NoPull is niet optioneel. Zonder die vlag doet publish.ps1 een
      //    git reset --hard op origin/main, en dat gooit precies de site/data weg
      //    die stap 3 er zojuist in heeft gepromoveerd plus de index.html van
      //    stap 4. Elke ronde zou de gepubliceerde site dan terugvallen op de
      //    momentopname uit de laatste commit -- ouder dan wat hier net geteld is.
      if (uit) {
        const publiceer = await draaiProces(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(repo, "deploy", "publish.ps1"),
            "-RepoRoot",
            repo,
            "-Target",
            uit,
            "-SkipBuild",
            "-NoPull",
          ],
          repo,
          rest(),
          "publish",
        );
        if (publiceer.code !== 0) {
          throw new Error(`publish.ps1 eindigde met code ${publiceer.code}: ${kort(publiceer.staart)}`);
        }
      }

      this.laatsteMomentopname = momentopname;
      /**
       * Wat er tijdens de doorloop binnenkwam telt niet mee: refresh.mjs bevriest
       * de bestandsgrootte bij het openen, dus die games staan er per definitie
       * niet in. Aftrekken in plaats van op nul zetten houdt de teller eerlijk --
       * anders zouden bij elke doorloop een paar honderd games stilzwijgend uit de
       * boekhouding vallen en zou de site systematisch achterlopen.
       */
      this.wacht = Math.max(0, this.gamesNu() - momentopname.games);
      console.log(
        `[site] ververst in ${((Date.now() - begin) / 1000).toFixed(1)}s: ${momentopname.games} games op de site` +
          (this.wacht > 0 ? `, ${this.wacht} alweer nieuw` : ""),
      );
    } finally {
      // Nooit laten slingeren: de werkmap staat in de repo en zou anders in
      // `git status` opduiken en bij een volgende doorloop in de weg zitten.
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** Laatste regel van de uitvoer van een kind, kort genoeg voor een logregel. */
function kort(staart: string): string {
  const regels = staart.trim().split("\n");
  return regels.slice(-3).join(" | ").slice(0, 400) || "(geen uitvoer)";
}

/**
 * Zet de goedgekeurde bestanden op hun plek.
 *
 * rename en niet copy: een rename binnen hetzelfde volume is één operatie op het
 * bestandssysteem, dus een lezer ziet óf het oude óf het nieuwe bestand en nooit
 * een half bestand. Daarom staat de werkmap standaard in de repo. MoveFileEx op
 * Windows valt over een volumegrens heen stilletjes terug op kopiëren-en-wissen,
 * en dan is die garantie weg zonder dat iets het meldt. Gaat er hier iets
 * mis (rechten, virusscanner), dan zijn de bestanden die al gewisseld waren nieuw
 * en de rest oud: alle drie leesbaar, hooguit uit twee jaargangen. build.mjs
 * merkt dat verschil zelf op en waarschuwt erover, en de volgende doorloop trekt
 * het recht.
 */
function promoveer(vanaf: string, naar: string): void {
  mkdirSync(naar, { recursive: true });
  for (const naam of UITVOER) renameSync(join(vanaf, naam), join(naar, naam));
}
