/**
 * Electron main-proces: vensters, IPC en het jade://-protocol voor client-assets.
 *
 * Er zijn twee vensters. Het hoofdvenster is de app; het champion select-venster
 * is een popup die vanzelf verschijnt zodra je in select zit en weer verdwijnt
 * als het voorbij is -- zoals je van Porofessor gewend bent.
 */
import { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } from "electron";
import { Vensterplek } from "./vensterplek";
import { join } from "node:path";
import { JadeService } from "./service";
import type { RuneKind } from "../core/jade/runes";
import type { AppSnapshot } from "../shared/types";

let service: JadeService | null = null;
let plek: Vensterplek | null = null;
let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
/** True means click-through: every click goes to the game. */
let overlayVergrendeld = true;
/** Zodat we de popup niet bij elke update opnieuw naar voren duwen. */
let champSelectShown = false;

// Moet geregistreerd zijn voordat de app klaar is met opstarten.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "jade",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
    },
  },
]);

/**
 * Beide vensters draaien dezelfde interface; de hash bepaalt welke weergave er
 * getekend wordt. Zo hoeven we geen tweede bundel te bouwen.
 */
function loadRenderer(window: BrowserWindow, hash: string): void {
  // `void` silences the floating-promise warning but catches nothing. Close the
  // window while it is still loading -- which a hot reload does routinely -- and
  // loadURL rejects with "Object has been destroyed", straight into the global
  // unhandledRejection handler and out as an error dialog. Nothing is wrong when
  // that happens: the window we were loading into is simply gone.
  const stil = (err: Error): void => {
    if (window.isDestroyed()) return;
    console.warn(`[allmid] renderer laden mislukte: ${err.message}`);
  };
  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`).catch(stil);
  } else {
    window
      .loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash })
      .catch(stil);
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    ...plek!.plaats("main", { width: 1280, height: 820 }),
    minWidth: 1020,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: "#07080a",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  if (plek!.wasGemaximaliseerd("main")) mainWindow.maximize();
  plek!.volg("main", mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Without this the variable keeps pointing at a window that no longer exists.
  // A closed BrowserWindow is not null, so `mainWindow?.webContents` sails past
  // the optional check and throws "Object has been destroyed" -- which surfaced
  // as an error dialog every couple of seconds once the live game watcher
  // started pushing a snapshot that often.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Renderer errors are otherwise invisible: they land in a devtools console
  // nobody has open, and the window just sits there black.
  mainWindow.webContents.on("console-message", (details) => {
    if (details.level === "error") {
      console.error(`[renderer] ${details.sourceId}:${details.lineNumber} ${details.message}`);
    }
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, beschrijving, url) => {
    console.error(`[renderer] laden mislukt (${code}) ${beschrijving} -- ${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[renderer] proces weg:", details.reason);
  });

  // Externe links openen in de browser, niet in de app zelf.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell
      .openExternal(url)
      .catch((err: Error) =>
        console.warn(`[allmid] link openen mislukte: ${err.message}`),
      );
    return { action: "deny" };
  });

  loadRenderer(mainWindow, "main");
}

/**
 * The panel that sits on top of the game.
 *
 * Transparent, frameless and click-through, so it never swallows a click meant
 * for the game.
 *
 * Nothing external can draw over true exclusive fullscreen without injecting
 * code into the game process. Overwolf's platform does reach it, and Discord
 * still ships its old injecting overlay behind a setting for exactly that case.
 * We do neither, on purpose: Vanguard blocks injection into League by design,
 * and Riot has said the blocking is intended. So League has to run borderless --
 * or Fullscreen, which Windows quietly composites for DX11 games anyway.
 *
 * Unlocking makes it clickable so it can be dragged elsewhere; where it ends up
 * is remembered like any other window.
 */
/**
 * Push the overlay back to the top of the topmost pile.
 *
 * Being "always on top" is not a rank, it is a flag: every topmost window sits
 * in the same band, ordered by who claimed it last. A game taking the
 * foreground restacks that band, and a window that staked its claim minutes ago
 * loses it. Discord solves this by re-asserting on every foreground change; we
 * do it on the live poll we already run, which costs nothing extra.
 *
 * Off and on again, deliberately: setting the flag to a value it already holds
 * is a no-op on some Chromium paths, so it would never reach SetWindowPos.
 */
function herbevestigBovenaan(w: BrowserWindow): void {
  if (w.isDestroyed()) return;
  w.setAlwaysOnTop(false);
  w.setAlwaysOnTop(true, "screen-saver");
}

function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...plek!.plaats("overlay", { width: 260, height: 240 }),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Not focusable while locked: a window that steals focus mid-fight is worse
    // than no window at all.
    focusable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      // A game covering this window makes Chromium call it occluded, and an
      // occluded renderer has its timers squeezed to about once a second. The
      // panel would not vanish, it would freeze -- which looks the same in a
      // bug report and is worse to debug.
      backgroundThrottling: false,
    },
  });

  // Windows has no z-order levels: Chromium collapses every one of them to a
  // plain "always on top" boolean. The string still matters for one thing --
  // "screen-saver" and "pop-up-menu" are the only two Electron does not push
  // below the taskbar. So it is the right value, for a reason that has nothing
  // to do with being "highest".
  herbevestigBovenaan(window);

  // forward:false, deliberately. With forwarding on, mouse moves still reach the
  // window, so CSS hover fires and the cursor turns into a text caret over the
  // panel -- which is what you saw. Off means the pointer belongs entirely to
  // the game.
  window.setIgnoreMouseEvents(true, { forward: false });
  plek!.volg("overlay", window);
  loadRenderer(window, "overlay");
  window.on("closed", () => {
    overlayWindow = null;
  });
  return window;
}

/**
 * Say where the overlay actually landed.
 *
 * A transparent click-through window that is on the wrong monitor, behind the
 * game, or simply drawing nothing all look the same from the outside: "it isn't
 * there". One line in the log separates them.
 */
function meldOverlayPlek(w: BrowserWindow): void {
  const bounds = w.getBounds();
  const op = screen.getDisplayMatching(bounds);
  const primair = screen.getPrimaryDisplay();
  console.log(
    "[overlay] shown",
    JSON.stringify({
      bounds,
      display: op.id,
      onPrimary: op.id === primair.id,
      displays: screen.getAllDisplays().length,
      scale: op.scaleFactor,
    }),
  );
}

/** Locked means click-through. Unlocked means you can grab it and move it. */
function zetOverlayVergrendeld(vergrendeld: boolean): void {
  overlayVergrendeld = vergrendeld;
  const w = overlayWindow;
  if (!w || w.isDestroyed()) return;
  w.setIgnoreMouseEvents(vergrendeld, { forward: false });
  w.setFocusable(!vergrendeld);
  if (!w.webContents.isDestroyed()) w.webContents.send("overlay:locked", vergrendeld);
}

/**
 * Show the overlay while a Classic game is running, and only then.
 *
 * There is nothing to say outside a game, and a panel hanging over the client
 * between matches is the kind of thing people uninstall an app over.
 */
function syncOverlayWindow(snapshot: AppSnapshot): void {
  const wil = Boolean(snapshot.liveGame?.isClassic) && snapshot.settings.overlay;
  if (wil) {
    overlayWindow ??= createOverlayWindow();
    if (!overlayWindow.isVisible()) {
      overlayWindow.showInactive();
      zetOverlayVergrendeld(overlayVergrendeld);
      meldOverlayPlek(overlayWindow);
    }
    // Every tick, not just the first: the game restacks the topmost band each
    // time it takes the foreground, and that happens more than once a game.
    herbevestigBovenaan(overlayWindow);
  } else if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide();
  }
}

function syncChampSelectWindow(snapshot: AppSnapshot): void {
  const inSelect = Boolean(snapshot.champSelect);
  if (inSelect && !champSelectShown) {
    champSelectShown = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // showInactive does nothing for a window that is already open but buried
      // behind the client, which is exactly the case that matters. moveTop
      // raises it without taking the keyboard, because you are still picking.
      mainWindow.showInactive();
      mainWindow.moveTop();
    }
  } else if (!inSelect) {
    champSelectShown = false;
  }
}

function registerAssetProtocol(): void {
  // De client serveert iconen achter een self-signed certificaat met Basic auth,
  // dus de UI kan ze niet rechtstreeks laden. Dit protocol haalt ze op via de
  // bestaande, geauthenticeerde verbinding.
  protocol.handle("jade", async (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname);
    try {
      const asset = await service?.fetchAsset(path);
      if (!asset) return new Response("Not found", { status: 404 });
      return new Response(asset.body, {
        headers: {
          "content-type": asset.contentType,
          "cache-control": "max-age=86400",
        },
      });
    } catch {
      // Client net afgesloten terwijl de UI nog iconen opvroeg: geen icoon,
      // geen drama.
      return new Response("Client unavailable", { status: 503 });
    }
  });
}

/**
 * Send to the window, if there still is one.
 *
 * Both checks earn their place: the window can be gone (destroyed) and its web
 * contents can be gone while the window object is still around, which happens
 * during a reload.
 */
function stuurNaarVenster(kanaal: string, lading: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send(kanaal, lading);
}

function registerIpc(): void {
  ipcMain.handle("app:snapshot", () => service?.getSnapshot());
  ipcMain.handle("app:masteryTrees", () => service?.masteryTrees() ?? []);
  ipcMain.handle("app:runeCatalog", () => service?.runeCatalog() ?? []);
  ipcMain.handle("app:refresh", async () => {
    await Promise.all([
      service?.refreshOwnProfile(),
      service?.refreshLoadout(),
    ]);
    return service?.getSnapshot();
  });
  ipcMain.handle("app:crawl", async (_event, players?: number) => {
    await service?.crawlNow(players);
    return service?.getSnapshot();
  });
  ipcMain.handle(
    "runes:plan",
    (_event, championId: number | null, role?: string) =>
      service?.planRunesFor(championId, role) ?? null,
  );
  ipcMain.handle(
    "runes:apply",
    (_event, pageIndex: number, slots: Record<RuneKind, number[]>) =>
      service?.applyRunePlan(pageIndex, slots),
  );
  ipcMain.handle("masteries:activate", (_event, pageIndex: number) =>
    service?.activateMasteryPage(pageIndex),
  );
  ipcMain.handle("settings:update", (_event, patch: Record<string, unknown>) =>
    service?.updateSettings(patch as never),
  );
  // Handmatig delen. Geeft de momentopname terug zodat de knop meteen de nieuwe
  // stand toont, ook als het misging -- juist dan.
  ipcMain.handle("upload:now", async () => {
    await service?.uploadNow();
    return service?.getSnapshot();
  });
  ipcMain.handle("game:detail", (_event, gameId: number) => service?.gameDetail(gameId) ?? null);
  ipcMain.handle("overlay:lock", (_event, vergrendeld: boolean) => {
    zetOverlayVergrendeld(vergrendeld);
    return vergrendeld;
  });
  ipcMain.handle("masteries:plan", (_event, championId: number) =>
    service?.masteryPlanFor(championId) ?? null,
  );
  ipcMain.handle("masteries:auto", (_event, championId: number | null) =>
    service?.autoApplyMasteries(championId),
  );
  ipcMain.handle(
    "stats:tierList",
    (_event, position: string, minGames?: number) =>
      service?.tierList(position as never, minGames) ?? [],
  );
  ipcMain.handle(
    "stats:champion",
    (_event, championId: number, position?: string) =>
      service?.championDetail(championId, position as never) ?? null,
  );
  ipcMain.handle(
    "player:lookup",
    (_event, riotId: string) => service?.lookupPlayer(riotId) ?? null,
  );

  // Vensterknoppen werken op het venster dat ze stuurt, zodat de popup zichzelf
  // kan sluiten zonder de hele app af te sluiten.
  ipcMain.on("window:minimize", (event) =>
    BrowserWindow.fromWebContents(event.sender)?.minimize(),
  );
  ipcMain.on("window:maximize", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

// Chromium stops painting windows it believes are covered. A fullscreen game
// covers the overlay by definition, so without this the panel is throttled for
// exactly as long as it is useful.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// The .then body sets everything up; anything it throws would otherwise land
// in the global rejection handler and pop an error box before there is even a
// window to show it in front of.
void app
  .whenReady()
  .then(() => {
    plek = new Vensterplek(app.getAppPath());
    service = new JadeService(app.getAppPath());
    registerAssetProtocol();
    registerIpc();
    createMainWindow();

    service.on("snapshot", (snapshot: AppSnapshot) => {
      stuurNaarVenster("app:snapshot", snapshot);
      if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.webContents.isDestroyed()) {
        overlayWindow.webContents.send("app:snapshot", snapshot);
      }
      syncChampSelectWindow(snapshot);
      syncOverlayWindow(snapshot);
    });
    service
      .start()
      .catch((err: Error) => console.error("[allmid] start mislukte:", err));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  })
  .catch((err: Error) => console.error("[allmid] opstarten mislukte:", err));

app.on("window-all-closed", () => {
  service?.dispose();
  if (process.platform !== "darwin") app.quit();
});

/**
 * Fouten die horen bij een client die weggaat -- geweigerde verbindingen,
 * afgebroken sockets. Die zijn normaal en mogen de app niet omleggen.
 */
const CONNECTION_ERRORS =
  /ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|socket hang up|EHOSTUNREACH/i;

/**
 * Things that mean "the window went away", which is not a failure.
 *
 * They arrive as rejections from work that was still in flight when a window
 * closed or reloaded, and there is nothing for anyone to do about them.
 */
const WEG_ERRORS =
  /Object has been destroyed|Render frame was disposed|ERR_ABORTED/i;

function handleFatal(scope: string, error: unknown): void {
  const message = (error as Error)?.message ?? String(error);
  if (CONNECTION_ERRORS.test(message)) {
    console.warn(`[allmid] ${scope} (verbinding weg):`, message);
    return;
  }
  if (WEG_ERRORS.test(message)) {
    console.warn(`[allmid] ${scope} (venster weg):`, message);
    return;
  }
  // Alles wat hier wél terechtkomt is een echte fout; die verbergen we niet.
  console.error(`[allmid] ${scope}:`, error);
  dialog.showErrorBox(
    "AllMid",
    `Er ging iets mis (${scope}):

${message}`,
  );
}

process.on("uncaughtException", (error) =>
  handleFatal("uncaughtException", error),
);
process.on("unhandledRejection", (reason) =>
  handleFatal("unhandledRejection", reason),
);

// Onderdruk de certificaatwaarschuwing voor de lokale client, en alleen daarvoor.
app.on(
  "certificate-error",
  (event, _webContents, url, _error, _cert, callback) => {
    if (url.startsWith("https://127.0.0.1:")) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  },
);
