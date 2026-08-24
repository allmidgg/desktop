/**
 * Where each window opens, and where it opened last time.
 *
 * Two problems, one answer. A window that forgets its place reopens in the
 * middle of whichever screen Electron feels like, every single launch. And on a
 * two-monitor setup the useful default is not the middle of the primary screen
 * at all -- that is where League is running, and a stats window on top of the
 * game is the one place you do not want it.
 *
 * Remembered bounds are checked against the screens that exist right now.
 * Unplugging a monitor, or docking a laptop, would otherwise restore a window to
 * coordinates that no longer belong to anything, and it would open somewhere
 * invisible with no obvious way to get it back.
 */
import { screen, type BrowserWindow, type Rectangle } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type VensterSleutel = "main" | "champselect" | "overlay";

interface Onthouden {
  bounds: Rectangle;
  maximized?: boolean;
}

type Opslag = Partial<Record<VensterSleutel, Onthouden>>;

/** How much of a window has to land on a screen before we call it visible. */
const MIN_ZICHTBAAR = 120;

export class Vensterplek {
  private readonly bestand: string;
  private opslag: Opslag = {};

  constructor(dataRoot: string) {
    this.bestand = join(dataRoot, "data", "windows.json");
    try {
      if (existsSync(this.bestand)) this.opslag = JSON.parse(readFileSync(this.bestand, "utf8")) as Opslag;
    } catch {
      // A damaged file only costs the remembered position, so start fresh
      // rather than refusing to open a window.
      this.opslag = {};
    }
  }

  /**
   * The options to open a window with: remembered place, or a sensible first one.
   *
   * `standaard` is the size to use when there is nothing to remember; it is
   * never used to override a remembered size.
   */
  plaats(sleutel: VensterSleutel, standaard: { width: number; height: number }): Partial<Rectangle> {
    const onthouden = this.opslag[sleutel]?.bounds;
    if (onthouden && this.zichtbaarOpEenScherm(onthouden)) return onthouden;
    return this.eerstePlaats(standaard);
  }

  wasGemaximaliseerd(sleutel: VensterSleutel): boolean {
    return this.opslag[sleutel]?.maximized === true;
  }

  /**
   * Remember where a window ends up, from now until it closes.
   *
   * Saved on a delay because dragging a window fires these events continuously,
   * and writing a file on every pixel of a drag is a lot of writing for a value
   * only read at startup.
   */
  volg(sleutel: VensterSleutel, window: BrowserWindow): void {
    let timer: NodeJS.Timeout | null = null;
    const bewaar = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (window.isDestroyed()) return;
        // Ask for the normal bounds, not the current ones: a maximized window
        // would otherwise be remembered as filling the screen, and unmaximizing
        // after a restart would leave it with nowhere sensible to go.
        this.opslag[sleutel] = {
          bounds: window.getNormalBounds(),
          maximized: window.isMaximized(),
        };
        this.schrijf();
      }, 400);
    };
    // Listed one by one rather than looped: Electron types each event name
    // separately, so a loop over a union does not narrow to a single overload.
    window.on("resize", bewaar);
    window.on("move", bewaar);
    window.on("maximize", bewaar);
    window.on("unmaximize", bewaar);
    window.once("close", () => {
      if (timer) clearTimeout(timer);
      if (window.isDestroyed()) return;
      this.opslag[sleutel] = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
      this.schrijf();
    });
  }

  /** True when more than one screen is connected. */
  static meerdereSchermen(): boolean {
    return screen.getAllDisplays().length > 1;
  }

  /**
   * Where to open when there is nothing remembered.
   *
   * On a single screen: centred, the usual thing. On more than one: centred on a
   * screen that is not the primary one, because that is almost always where the
   * game is running full screen. This is a guess -- there is no way from here to
   * ask which monitor League is on -- but it is the right guess far more often
   * than it is wrong, and the moment the user moves the window we stop guessing.
   */
  private eerstePlaats(standaard: { width: number; height: number }): Partial<Rectangle> {
    const schermen = screen.getAllDisplays();
    const primair = screen.getPrimaryDisplay();
    const doel = schermen.find((s) => s.id !== primair.id) ?? primair;
    const werkgebied = doel.workArea;

    const width = Math.min(standaard.width, werkgebied.width);
    const height = Math.min(standaard.height, werkgebied.height);
    return {
      x: Math.round(werkgebied.x + (werkgebied.width - width) / 2),
      y: Math.round(werkgebied.y + (werkgebied.height - height) / 2),
      width,
      height,
    };
  }

  /** Does enough of this rectangle land on a screen that exists? */
  private zichtbaarOpEenScherm(b: Rectangle): boolean {
    return screen.getAllDisplays().some((s) => {
      const w = s.workArea;
      const overlapX = Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x);
      const overlapY = Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y);
      return overlapX >= MIN_ZICHTBAAR && overlapY >= MIN_ZICHTBAAR;
    });
  }

  private schrijf(): void {
    try {
      mkdirSync(dirname(this.bestand), { recursive: true });
      writeFileSync(this.bestand, JSON.stringify(this.opslag, null, 2), "utf8");
    } catch {
      // Losing the remembered position is a small annoyance; failing to write it
      // is not worth interrupting anyone over.
    }
  }
}
