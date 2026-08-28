/**
 * De automatische updater.
 *
 * Twee dingen die dit anders maken dan de standaardopzet, en allebei omdat dit
 * een companion is die naast een game draait.
 *
 * Eén: er wordt nooit herstart zonder dat de gebruiker dat zegt. De standaard
 * van electron-updater is installeren-en-herstarten bij het afsluiten, en dat
 * is precies fout voor een app die in de tray leeft -- die sluit je nooit af,
 * dus die update landt nooit. Wij halen hem binnen en zeggen dat hij klaar is;
 * jij kiest wanneer.
 *
 * Twee: nooit tijdens een game. Een download die je framerate kost tijdens een
 * teamfight is erger dan een dag oude versie.
 */
import { app } from "electron";
import type { UpdateInfo } from "electron-updater";

/** Wat de rest van de app van de updater hoeft te weten. */
export interface UpdateStand {
  /** Waar we in het proces zitten. */
  fase: "uit" | "kijken" | "actueel" | "downloaden" | "klaar" | "fout";
  /** De versie die klaarstaat, als die er is. */
  versie: string | null;
  /** Voortgang van de download, 0-100. */
  voortgang: number;
  /** Waarom het misging, in mensentaal. */
  fout: string | null;
}

export const LEGE_UPDATE: UpdateStand = {
  fase: "uit",
  versie: null,
  voortgang: 0,
  fout: null,
};

/** Elke zes uur. Vaker heeft geen zin voor een app die per week uitkomt. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export class Updater {
  private stand: UpdateStand = { ...LEGE_UPDATE };
  private timer: NodeJS.Timeout | null = null;
  private bezig = false;
  /** Geleverd door de eigenaar: mag er nu gekeken worden? */
  private mag: () => boolean = () => true;

  constructor(private readonly opStand: (stand: UpdateStand) => void) {}

  /**
   * Start de updater, tenzij dit een ontwikkelversie is.
   *
   * In dev bestaat er geen geïnstalleerde app om te vervangen; electron-updater
   * gooit daar een fout over die niets betekent. Dus doen we daar niets, en
   * blijft de fase "uit" -- wat de UI ook zo toont.
   */
  async start(magNu: () => boolean): Promise<void> {
    this.mag = magNu;
    if (!app.isPackaged) return;

    // Pas hier importeren: de module trekt netwerkcode mee die een dev-start
    // nergens voor nodig heeft.
    const { autoUpdater } = await import("electron-updater");

    // Zelf downloaden zodra er iets is, maar nooit zelf installeren.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on("checking-for-update", () => this.zet({ fase: "kijken", fout: null }));
    autoUpdater.on("update-not-available", () => this.zet({ fase: "actueel", fout: null }));
    autoUpdater.on("update-available", (info: UpdateInfo) =>
      this.zet({ fase: "downloaden", versie: info.version, voortgang: 0, fout: null }),
    );
    autoUpdater.on("download-progress", (p: { percent: number }) =>
      this.zet({ voortgang: Math.round(p.percent) }),
    );
    autoUpdater.on("update-downloaded", (info: UpdateInfo) =>
      this.zet({ fase: "klaar", versie: info.version, voortgang: 100, fout: null }),
    );
    autoUpdater.on("error", (err: Error) => {
      // Geen netwerk is geen storing. Dat gebeurt continu op een laptop die
      // net wakker wordt, en het hoort geen rode melding op te leveren.
      const stil = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::/i.test(err.message);
      this.zet(stil ? { fase: "actueel", fout: null } : { fase: "fout", fout: err.message });
    });

    await this.kijk();
    this.timer = setInterval(() => void this.kijk(), INTERVAL_MS);
  }

  /** Kijkt of er iets nieuwers is, tenzij dat nu onhandig uitkomt. */
  async kijk(): Promise<void> {
    if (!app.isPackaged || this.bezig) return;
    // Niet tijdens een game, en niet als er al iets klaarstaat.
    if (!this.mag() || this.stand.fase === "klaar") return;
    this.bezig = true;
    try {
      const { autoUpdater } = await import("electron-updater");
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.zet({ fase: "fout", fout: (err as Error).message });
    } finally {
      this.bezig = false;
    }
  }

  /**
   * Installeren en herstarten. Alleen op verzoek.
   *
   * `isSilent` false zodat de installer zichtbaar is -- dezelfde belofte als de
   * eerste installatie doet -- en `isForceRunAfter` zodat de app daarna weer
   * opkomt in plaats van dat je hem zelf moet starten.
   */
  async installeerNu(): Promise<void> {
    if (this.stand.fase !== "klaar") return;
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.quitAndInstall(false, true);
  }

  get huidig(): UpdateStand {
    return this.stand;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private zet(patch: Partial<UpdateStand>): void {
    this.stand = { ...this.stand, ...patch };
    this.opStand(this.stand);
  }
}
