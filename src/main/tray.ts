/**
 * Het tray-icoon: waar AllMid woont als er geen venster open is.
 *
 * Dit is een companion, geen programma dat je "gebruikt". Hij hoort te wachten
 * tot er een champion select begint en dan vanzelf te verschijnen. Dat kan
 * alleen als sluiten niet hetzelfde is als afsluiten -- vandaar het kruisje dat
 * verbergt, en vandaar dit icoon, want software die je niet kunt zien en niet
 * kunt afsluiten is spyware.
 *
 * Het icoon is build/icon.png, hetzelfde beeld als op de taakbalk en in de
 * installer -- iemand die het in de tray ziet herkent het terug. Er staat een
 * getekende versie van het merk als achtervang onder, zodat een ontbrekend
 * bestand nooit een lege tray oplevert.
 */
import { Menu, Tray, app, nativeImage, type NativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** De M, als SVG, op de maat die Windows voor een tray-icoon wil. */
const MERK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 120 118">
  <path d="M14 102 L33 20 L60 60 L87 20 L106 102" fill="none" stroke="#b89a4d"
        stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M60 60 L60 104" fill="none" stroke="#f4e6ba" stroke-width="12" stroke-linecap="round"/>
  <circle cx="60" cy="104" r="7" fill="#f7edc9"/>
</svg>`;

/**
 * Windows schaalt een tray-icoon zelf, maar alleen netjes vanaf een scherpe
 * bron. Twee keer zo groot inladen en laten terugschalen scheelt de trapjes.
 */
function merkIcoon(): NativeImage {
  // Het echte icoon als het er is: dat is hetzelfde beeld als op de taakbalk en
  // in de installer, en dus herkent iemand het terug. De getekende versie
  // hieronder is de achtervang, zodat een ontbrekend bestand nooit een lege
  // tray oplevert.
  const bestand = join(app.getAppPath(), "build", "icon.png");
  if (existsSync(bestand)) {
    const echt = nativeImage.createFromPath(bestand);
    if (!echt.isEmpty()) return echt.resize({ width: 16, height: 16 });
  }
  const groot = MERK_SVG.replace('width="32" height="32"', 'width="64" height="64"');
  const beeld = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(groot, "utf8").toString("base64")}`,
  );
  return beeld.resize({ width: 16, height: 16 });
}

export interface TrayActies {
  /** Venster tonen en naar voren halen. */
  toon: () => void;
  /** De overlay aan- of uitzetten. */
  wisselOverlay: () => void;
  /** Echt afsluiten, niet verbergen. */
  sluitAf: () => void;
}

export class AllMidTray {
  private tray: Tray | null = null;
  /** Wat er in de tooltip staat; los gehouden zodat het menu niet herbouwd hoeft. */
  private stand = "Waiting for the League client...";
  private overlayAan = false;

  constructor(private readonly acties: TrayActies) {}

  /** Maakt het icoon aan. Faalt stil: geen tray is vervelend, geen reden te stoppen. */
  start(): void {
    if (this.tray) return;
    try {
      this.tray = new Tray(merkIcoon());
    } catch (err) {
      console.warn("[allmid] tray-icoon mislukte:", (err as Error).message);
      return;
    }
    // Dubbelklikken op het icoon opent het venster: dat is wat iedereen op
    // Windows als eerste probeert.
    this.tray.on("double-click", () => this.acties.toon());
    this.tray.on("click", () => this.acties.toon());
    this.herbouw();
  }

  /** De regel onder de titel in de tooltip en bovenaan het menu. */
  zetStand(tekst: string): void {
    if (this.stand === tekst) return;
    this.stand = tekst;
    this.herbouw();
  }

  /** Houdt het vinkje in het menu gelijk aan de echte instelling. */
  zetOverlay(aan: boolean): void {
    if (this.overlayAan === aan) return;
    this.overlayAan = aan;
    this.herbouw();
  }

  private herbouw(): void {
    const tray = this.tray;
    if (!tray) return;
    tray.setToolTip(`AllMid -- ${this.stand}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        // De stand staat bovenaan en is uitgeschakeld: het is informatie, geen
        // knop. Zo zie je bij het openen van het menu meteen of de app iets doet.
        { label: this.stand, enabled: false },
        { type: "separator" },
        { label: "Open AllMid", click: () => this.acties.toon() },
        {
          label: "In-game overlay",
          type: "checkbox",
          checked: this.overlayAan,
          click: () => this.acties.wisselOverlay(),
        },
        { type: "separator" },
        // Expliciet "Quit", want een kruisje dat verbergt hoort een echte uitweg
        // te hebben en die moet vindbaar zijn.
        { label: "Quit AllMid", click: () => this.acties.sluitAf() },
      ]),
    );
  }

  stop(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
