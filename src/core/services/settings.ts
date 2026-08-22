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

/**
 * Wat de interface mag zien en mag wijzigen.
 *
 * Alles in deze vorm gaat over IPC naar de renderer en staat dus effectief in
 * het venster. Dat is precies de bedoeling voor deze drie: een schakelaar die je
 * niet kunt zien is geen schakelaar.
 */
export interface Settings {
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
}

/**
 * Het adres van de verzamelserver van het project. Staat expliciet in de
 * instellingen in plaats van hard in de code, zodat je kunt zien waar je data
 * heen gaat en het kunt veranderen zonder de app opnieuw te bouwen.
 */
export const DEFAULT_UPLOAD_SERVER = "https://api.allmid.gg";

export const DEFAULT_SETTINGS: StoredSettings = {
  autoMasteries: false,
  shareMatches: true,
  uploadServer: DEFAULT_UPLOAD_SERVER,
  uploadKey: "",
};

/**
 * De velden die naar buiten mogen, veld voor veld overgenomen.
 *
 * Expres niet met rest-spread: komt er ooit een tweede geheim bij, dan valt dat
 * hier om met een typefout in plaats van dat het stilletjes meelift.
 */
export const publicSettings = (settings: StoredSettings): Settings => ({
  autoMasteries: settings.autoMasteries,
  shareMatches: settings.shareMatches,
  uploadServer: settings.uploadServer,
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
