/**
 * Electron main-proces: vensters, IPC en het jade://-protocol voor client-assets.
 *
 * Er zijn twee vensters. Het hoofdvenster is de app; het champion select-venster
 * is een popup die vanzelf verschijnt zodra je in select zit en weer verdwijnt
 * als het voorbij is -- zoals je van Porofessor gewend bent.
 */
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { Vensterplek } from "./vensterplek";
import { join } from "node:path";
import { JadeService } from "./service";
import type { RuneKind } from "../core/jade/runes";
import type { AppSnapshot } from "../shared/types";

let service: JadeService | null = null;
let plek: Vensterplek | null = null;
let mainWindow: BrowserWindow | null = null;
/** Zodat we de popup niet bij elke update opnieuw naar voren duwen. */
let champSelectShown = false;

// Moet geregistreerd zijn voordat de app klaar is met opstarten.
protocol.registerSchemesAsPrivileged([
  { scheme: "jade", privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

/**
 * Beide vensters draaien dezelfde interface; de hash bepaalt welke weergave er
 * getekend wordt. Zo hoeven we geen tweede bundel te bouwen.
 */
function loadRenderer(window: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash });
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

  // Externe links openen in de browser, niet in de app zelf.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  loadRenderer(mainWindow, "main");
}

function syncChampSelectWindow(snapshot: AppSnapshot): void {
  const inSelect = Boolean(snapshot.champSelect);
  if (inSelect && !champSelectShown) {
    champSelectShown = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.showInactive();
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
        headers: { "content-type": asset.contentType, "cache-control": "max-age=86400" },
      });
    } catch {
      // Client net afgesloten terwijl de UI nog iconen opvroeg: geen icoon,
      // geen drama.
      return new Response("Client unavailable", { status: 503 });
    }
  });
}

function registerIpc(): void {
  ipcMain.handle("app:snapshot", () => service?.getSnapshot());
  ipcMain.handle("app:masteryTrees", () => service?.masteryTrees() ?? []);
  ipcMain.handle("app:runeCatalog", () => service?.runeCatalog() ?? []);
  ipcMain.handle("app:refresh", async () => {
    await Promise.all([service?.refreshOwnProfile(), service?.refreshLoadout()]);
    return service?.getSnapshot();
  });
  ipcMain.handle("app:crawl", async (_event, players?: number) => {
    await service?.crawlNow(players);
    return service?.getSnapshot();
  });
  ipcMain.handle(
    "runes:plan",
    (_event, championId: number | null, role?: string) => service?.planRunesFor(championId, role) ?? null,
  );
  ipcMain.handle("runes:apply", (_event, pageIndex: number, slots: Record<RuneKind, number[]>) =>
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
  ipcMain.handle("masteries:auto", (_event, championId: number | null) =>
    service?.autoApplyMasteries(championId),
  );
  ipcMain.handle("stats:tierList", (_event, position: string, minGames?: number) =>
    service?.tierList(position as never, minGames) ?? [],
  );
  ipcMain.handle("stats:champion", (_event, championId: number, position?: string) =>
    service?.championDetail(championId, position as never) ?? null,
  );
  ipcMain.handle("player:lookup", (_event, riotId: string) => service?.lookupPlayer(riotId) ?? null);

  // Vensterknoppen werken op het venster dat ze stuurt, zodat de popup zichzelf
  // kan sluiten zonder de hele app af te sluiten.
  ipcMain.on("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
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

void app.whenReady().then(() => {
  plek = new Vensterplek(app.getAppPath());
  service = new JadeService(app.getAppPath());
  registerAssetProtocol();
  registerIpc();
  createMainWindow();

  service.on("snapshot", (snapshot: AppSnapshot) => {
    mainWindow?.webContents.send("app:snapshot", snapshot);
    syncChampSelectWindow(snapshot);
  });
  void service.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  service?.dispose();
  if (process.platform !== "darwin") app.quit();
});

/**
 * Fouten die horen bij een client die weggaat -- geweigerde verbindingen,
 * afgebroken sockets. Die zijn normaal en mogen de app niet omleggen.
 */
const CONNECTION_ERRORS = /ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|socket hang up|EHOSTUNREACH/i;

function handleFatal(scope: string, error: unknown): void {
  const message = (error as Error)?.message ?? String(error);
  if (CONNECTION_ERRORS.test(message)) {
    console.warn(`[allmid] ${scope} (verbinding weg):`, message);
    return;
  }
  // Alles wat hier wél terechtkomt is een echte fout; die verbergen we niet.
  console.error(`[allmid] ${scope}:`, error);
  dialog.showErrorBox("AllMid", `Er ging iets mis (${scope}):

${message}`);
}

process.on("uncaughtException", (error) => handleFatal("uncaughtException", error));
process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));

// Onderdruk de certificaatwaarschuwing voor de lokale client, en alleen daarvoor.
app.on("certificate-error", (event, _webContents, url, _error, _cert, callback) => {
  if (url.startsWith("https://127.0.0.1:")) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});
