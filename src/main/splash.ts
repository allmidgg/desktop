/**
 * Het venstertje dat verschijnt terwijl AllMid opstart.
 *
 * Reden: de app doet bij het starten echt werk -- instellingen inlezen, de
 * matchdatabase openen, de catalogus laden, de gedeelde statistiek doorrekenen.
 * Dat duurt lang genoeg om als "er gebeurt niks" te voelen. Een leeg venster
 * dat een seconde later ineens vol staat is erger dan geen venster.
 *
 * Bewust helemaal zelfstandig: geen renderer, geen preload, geen React. Dit
 * moet er zijn vóórdat er iets geladen is, dus het is één string HTML in een
 * frameloos venster. Duurt niets en kan niet stukgaan op iets wat nog niet
 * bestaat.
 */
import { BrowserWindow, screen } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Waar het achtergrondbeeld staat, als het er is. */
function achtergrondPad(appPad: string): string | null {
  const pad = join(appPad, "site", "img", "splash.png");
  return existsSync(pad) ? pad : null;
}

/**
 * De inhoud, als losse HTML.
 *
 * Het merk is hetzelfde pad als in de tray en op de site: de M waarvan de
 * middenstok naar beneden duikt. Hier tekent hij zichzelf bij het opstarten,
 * wat precies lang genoeg duurt om de wachttijd te vullen zonder er een
 * animatie van te maken die om aandacht vraagt.
 */
function splashHtml(achtergrond: string | null): string {
  const dek = achtergrond
    ? `background-image:url("file://${achtergrond.replace(/\\/g, "/")}");background-size:cover;background-position:center;`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:100%; height:100%; overflow:hidden; background:#06080c; }
  .dek {
    position:absolute; inset:0; ${dek}
    opacity:.55;
  }
  .waas {
    position:absolute; inset:0;
    background:
      radial-gradient(70% 60% at 50% 45%, rgba(231,199,110,.07), transparent 70%),
      linear-gradient(180deg, rgba(6,8,12,.35), rgba(6,8,12,.9));
  }
  .mid {
    position:relative; height:100%;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:1.1rem;
    font-family:"Segoe UI",system-ui,sans-serif; color:#e9e6df;
  }
  svg { width:72px; height:72px; }
  /* De M tekent zichzelf. 1.1s: lang genoeg om te zien, kort genoeg om niet
     in de weg te zitten als het laden sneller klaar is. */
  .arm, .piek {
    stroke-dasharray:260; stroke-dashoffset:260;
    animation:teken 1.1s cubic-bezier(.22,1,.36,1) forwards;
  }
  .piek { animation-delay:.45s; }
  .punt { opacity:0; animation:opkomen .5s ease .95s forwards; }
  @keyframes teken { to { stroke-dashoffset:0; } }
  @keyframes opkomen { to { opacity:1; } }
  .naam { font-size:1.15rem; font-weight:600; letter-spacing:-.01em; }
  .naam em { font-style:normal; color:#e7c76e; }
  .stand {
    font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
    font-size:.68rem; letter-spacing:.14em; text-transform:uppercase; color:#6b6a67;
  }
  @media (prefers-reduced-motion:reduce) {
    .arm,.piek { animation:none; stroke-dashoffset:0; }
    .punt { animation:none; opacity:1; }
  }
</style></head>
<body>
  <div class="dek"></div><div class="waas"></div>
  <div class="mid">
    <svg viewBox="0 0 120 118" fill="none">
      <path class="arm" d="M14 102 L33 20 L60 60 L87 20 L106 102"
            stroke="#b89a4d" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
      <path class="piek" d="M60 60 L60 104" stroke="#f4e6ba" stroke-width="10" stroke-linecap="round"/>
      <circle class="punt" cx="60" cy="104" r="6.5" fill="#f7edc9"/>
    </svg>
    <div class="naam">All<em>Mid</em></div>
    <div class="stand">Starting up</div>
  </div>
</body></html>`;
}

export class Splash {
  private venster: BrowserWindow | null = null;

  /** Toont het venster, gecentreerd op het scherm waar de muis staat. */
  toon(appPad: string): void {
    if (this.venster) return;
    const werkgebied = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const breed = 420;
    const hoog = 260;

    this.venster = new BrowserWindow({
      width: breed,
      height: hoog,
      x: Math.round(werkgebied.x + (werkgebied.width - breed) / 2),
      y: Math.round(werkgebied.y + (werkgebied.height - hoog) / 2),
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#06080c",
      // Geen preload en geen node: er is hier niets uit te voeren.
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const html = splashHtml(achtergrondPad(appPad));
    void this.venster.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // showInactive: het hoofdvenster mag de focus krijgen zodra het klaar is,
    // en een splash die focus steelt maakt dat rommelig.
    this.venster.once("ready-to-show", () => this.venster?.showInactive());
  }

  /**
   * Weghalen.
   *
   * `minimaalMs` houdt hem even in beeld als het laden sneller ging dan de
   * animatie: een splash die na 200 ms wegflitst leest als een glitch.
   */
  sluit(minimaalMs = 0): void {
    const weg = (): void => {
      if (this.venster && !this.venster.isDestroyed()) this.venster.destroy();
      this.venster = null;
    };
    if (minimaalMs > 0) setTimeout(weg, minimaalMs);
    else weg();
  }

  get open(): boolean {
    return this.venster !== null && !this.venster.isDestroyed();
  }
}
