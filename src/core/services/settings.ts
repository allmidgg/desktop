/**
 * Instellingen die tussen sessies bewaard blijven.
 *
 * Bewust een klein, plat bestand: je moet het met een teksteditor kunnen openen
 * en begrijpen. Een onleesbaar bestand is geen fout maar een reden om terug te
 * vallen op de standaardwaarden.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CollectedMode } from "../modes/registry";

/**
 * Wat de interface mag zien en mag wijzigen.
 *
 * Alles in deze vorm gaat over IPC naar de renderer en staat dus effectief in
 * het venster. Dat is precies de bedoeling voor deze drie: een schakelaar die je
 * niet kunt zien is geen schakelaar.
 */
export interface Settings {
  /**
   * Toon het paneel over de game heen zolang er een Classic-game draait.
   *
   * Standaard uit. Een overlay die ongevraagd over iemands game verschijnt is
   * iets wat je aanzet, niet iets wat je midden in een gevecht ontdekt. En hij
   * werkt alleen als League borderless of windowed draait -- over exclusive
   * fullscreen kan geen enkele overlay tekenen.
   */
  overlay: boolean;
  /** Zet automatisch de beste masteries zodra je een champion pickt. */
  autoMasteries: boolean;
  /**
   * Deelt de games die de crawler tegenkomt met de gedeelde verzamelserver.
   *
   * Standaard aan, en dat is een keuze met een reden. De statistiek in deze app
   * bestáát alleen doordat mensen meedoen -- niemand anders verzamelt Classic,
   * dus een gebruiker die niets deelt teert op de ronde van iemand anders. Wat
   * er over de lijn gaat is bovendien dezelfde uitslag die alle tien de spelers
   * na afloop in hun eigen client zien: champions, KDA, items, puuids. Geen
   * inloggegevens, niets uit je client dat niet al in die game zat.
   *
   * Zou hier wél accountdata in zitten, dan was opt-in de enige eerlijke stand.
   * Nu is dat niet zo, en dan weegt "de database groeit alleen als mensen
   * meedoen" zwaarder -- mits het zichtbaar is en met één klik uit kan. Dat
   * laatste is geen bijzaak maar de voorwaarde waaronder dit standaard aan mag.
   */
  shareMatches: boolean;
  /**
   * Waar die games heen gaan. Leeg betekent: nergens heen, dus ook geen
   * verkeer. Wie zijn eigen verzamelserver draait vult hier dat adres in.
   */
  uploadServer: string;
  /**
   * Sluiten met het kruisje verbergt de app in plaats van hem af te sluiten.
   *
   * Standaard aan, want dit is een companion: hij hoort te blijven kijken of er
   * een champion select begint. Wie hem echt weg wil heeft Afsluiten in het
   * tray-menu -- en dat staat er expliciet in, omdat een kruisje dat niet sluit
   * anders aanvoelt als software die je niet laat gaan.
   */
  /**
   * Which game the tier list, the profile and the meta screen describe.
   *
   * A choice the reader made, so it outlives the window: without it the switch
   * silently reset to the default on every start, and someone who plays modern
   * would have had to set it again every time.
   *
   * The default is modern, and it is a flat default rather than a look at what
   * is in the database. Deriving it would mean that on this machine -- 130,197
   * Classic games and no modern ones yet -- the app opens on Classic and keeps
   * doing so until the modern side fills up, which is exactly the framing this
   * whole reframe was meant to turn around. The switch is on screen either way.
   */
  bladerModus: CollectedMode;
  sluitNaarTray: boolean;
  /**
   * Meestarten met Windows.
   *
   * Standaard uit. Iets in andermans opstartlijst zetten is een keuze die de
   * gebruiker maakt, niet een die je voor hem maakt bij de installatie.
   */
  startMetWindows: boolean;
  /**
   * Verborgen starten: alleen het tray-icoon, geen venster.
   *
   * Alleen zinnig samen met startMetWindows -- anders start je de app met de
   * hand en verschijnt er niets, wat als kapot voelt.
   */
  startVerborgen: boolean;
}

/**
 * Wat er écht in settings.json staat.
 *
 * De sleutel zit hier wel bij en in `Settings` niet, en dat is opzet. Het is
 * geen wachtwoord van de gebruiker maar een schrijfkaartje voor de
 * verzamelserver: er hoort niets anders mee open te gaan dan "mag matches
 * aanbieden". Toch houden we hem uit `Settings`, want daarmee blijft hij uit de
 * momentopname, uit de renderer en uit alles wat die renderer ooit zou kunnen
 * loggen of tonen.
 *
 * Op schijf blijft hij leesbaar. .gitignore houdt settings.json buiten de repo,
 * maar niet buiten een zipje van je datamap of een screenshot in een bugmelding.
 * De echte bescherming is daarom niet de vindplaats maar de omvang van de
 * schade: lekt dit kaartje, dan kan iemand rommel aanbieden bij de server --
 * vervelend voor de beheerder, niet voor de gebruiker. Wie dat nog te veel vindt
 * zet ALLMID_KEY in de omgeving; die wint van het bestand en raakt de schijf
 * nooit.
 */
export interface StoredSettings extends Settings {
  uploadKey: string;
  /**
   * The key for Riot's official API, which is a different kind of secret to the
   * one above and is treated as one.
   *
   * The upload key is a writing pass for our own server: leaking it lets someone
   * offer rubbish to the collector, which is a nuisance for whoever runs it. This
   * one is issued by Riot against a person's developer account, it is rate
   * limited per key, and abuse of it lands on the account it belongs to. So it
   * never reaches `Settings`, never reaches the renderer, and never reaches the
   * snapshot -- the same rule as the upload key, for a heavier reason.
   *
   * RIOT_API_KEY in the environment wins over the file and never touches disk,
   * which is the right way to hold a development key: those expire every 24
   * hours, so a value written into settings.json is stale by tomorrow anyway.
   */
  riotApiKey: string;
}

/**
 * Het adres van de verzamelserver van het project. Staat expliciet in de
 * instellingen in plaats van hard in de code, zodat je kunt zien waar je data
 * heen gaat en het kunt veranderen zonder de app opnieuw te bouwen.
 */
export const DEFAULT_UPLOAD_SERVER = "https://allmid.gg";

/**
 * Addresses that were shipped, are stored in people's settings, and do not work.
 *
 * api.allmid.gg was the default from the start and the hostname was never
 * created: it does not resolve, so every upload every user ever attempted failed
 * on DNS. Changing the default is not enough on its own, because the broken
 * value is sitting in settings.json on every machine that has ever run this.
 */
const DODE_SERVERS = new Set(["https://api.allmid.gg", "http://api.allmid.gg", "https://api.allmid.gg/"]);

export const DEFAULT_SETTINGS: StoredSettings = {
  // Off by default. An overlay that appears over someone's game without being
  // asked for is a thing you turn on, not something you discover mid-fight.
  overlay: false,
  autoMasteries: false,
  shareMatches: true,
  sluitNaarTray: true,
  startMetWindows: false,
  startVerborgen: true,
  uploadServer: DEFAULT_UPLOAD_SERVER,
  uploadKey: "",
  // Modern, on a fresh install and on every install that never chose. The app is
  // for League of Legends; Classic is one mode it can name.
  bladerModus: "lol:sr",
  riotApiKey: "",
};

/**
 * De velden die naar buiten mogen, veld voor veld overgenomen.
 *
 * Expres niet met rest-spread: komt er ooit een tweede geheim bij, dan valt dat
 * hier om met een typefout in plaats van dat het stilletjes meelift.
 */
export const publicSettings = (settings: StoredSettings): Settings => ({
  overlay: settings.overlay,
  autoMasteries: settings.autoMasteries,
  shareMatches: settings.shareMatches,
  uploadServer: settings.uploadServer,
  sluitNaarTray: settings.sluitNaarTray,
  startMetWindows: settings.startMetWindows,
  startVerborgen: settings.startVerborgen,
  bladerModus: settings.bladerModus,
  // riotApiKey is deliberately absent, and so is uploadKey. This function is
  // the boundary: adding a secret to StoredSettings and forgetting it here is a
  // compile error rather than a value that quietly reaches the window.
});

export class SettingsStore {
  private current: StoredSettings = { ...DEFAULT_SETTINGS };

  constructor(private readonly path: string) {}

  get value(): StoredSettings {
    return this.current;
  }

  /** Dezelfde instellingen, zonder de sleutel. Dit is wat de UI krijgt. */
  get shared(): Settings {
    return publicSettings(this.current);
  }

  async load(): Promise<StoredSettings> {
    if (!existsSync(this.path)) return this.current;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredSettings>;
      this.current = { ...DEFAULT_SETTINGS, ...raw };
      // Only a value nobody chose gets replaced. Someone running their own
      // server has picked that address deliberately and it stays put.
      if (DODE_SERVERS.has(this.current.uploadServer.trim())) {
        this.current.uploadServer = DEFAULT_UPLOAD_SERVER;
      }
    } catch {
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.current;
  }

  async update(patch: Partial<StoredSettings>): Promise<StoredSettings> {
    this.current = { ...this.current, ...patch };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.current, null, 2), "utf8");
    return this.current;
  }
}

export const defaultSettingsPath = (root: string): string => join(root, "data", "settings.json");
