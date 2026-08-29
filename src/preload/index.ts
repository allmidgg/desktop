/**
 * De enige brug tussen de UI en het main-proces.
 *
 * De renderer heeft geen Node-toegang; alles loopt via deze afgebakende lijst
 * functies. Dat houdt de aanvalsoppervlakte klein en maakt precies zichtbaar
 * wat de interface mag doen.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSnapshot, ApplyResult, ChampionDetail, GameDetail, MasteryPlanSummary, MasteryTreeInfo, Position,
  RuneInfo,
  RunePlanSummary, Settings, TierEntry,
} from "../shared/types";
import type { RuneKind } from "../core/jade/runes";
import type { CollectedMode } from "../core/modes/registry";
import type { PlayerProfile } from "../core/services/player";

const api = {
  getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke("app:snapshot"),
  refresh: (): Promise<AppSnapshot> => ipcRenderer.invoke("app:refresh"),
  getMasteryTrees: (): Promise<MasteryTreeInfo[]> => ipcRenderer.invoke("app:masteryTrees"),
  getRuneCatalog: (): Promise<RuneInfo[]> => ipcRenderer.invoke("app:runeCatalog"),

  planRunes: (championId: number | null, role?: string): Promise<RunePlanSummary | null> =>
    ipcRenderer.invoke("runes:plan", championId, role),
  applyRunes: (pageIndex: number, slots: Record<RuneKind, number[]>): Promise<ApplyResult> =>
    ipcRenderer.invoke("runes:apply", pageIndex, slots),
  activateMasteryPage: (pageIndex: number): Promise<ApplyResult> =>
    ipcRenderer.invoke("masteries:activate", pageIndex),
  gameDetail: (gameId: number): Promise<GameDetail | null> => ipcRenderer.invoke("game:detail", gameId),
  /**
   * Fires when a history timeline finishes being fetched, with its gameId.
   *
   * gameDetail answers straight away with `historie: { staat: "bezig" }` rather
   * than waiting on the client, so the game opens at once. This is how the screen
   * learns the curve has arrived: ask for the same detail again. A gameId that is
   * not the one on screen is meant to be ignored.
   */
  onGameTijdlijn: (handler: (gameId: number) => void): (() => void) => {
    const listener = (_event: unknown, gameId: number): void => handler(gameId);
    ipcRenderer.on("game:tijdlijn", listener);
    return () => ipcRenderer.removeListener("game:tijdlijn", listener);
  },
  /** Locked means click-through; unlocked lets you drag the overlay somewhere else. */
  lockOverlay: (locked: boolean): Promise<boolean> => ipcRenderer.invoke("overlay:lock", locked),
  onOverlayLocked: (fn: (locked: boolean) => void): (() => void) => {
    const handler = (_e: unknown, locked: boolean): void => fn(locked);
    ipcRenderer.on("overlay:locked", handler);
    return () => ipcRenderer.removeListener("overlay:locked", handler);
  },
  masteryPlan: (championId: number): Promise<MasteryPlanSummary | null> =>
    ipcRenderer.invoke("masteries:plan", championId),
  autoMasteries: (championId: number | null): Promise<ApplyResult> =>
    ipcRenderer.invoke("masteries:auto", championId),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke("settings:update", patch),
  uploadNow: (): Promise<AppSnapshot> => ipcRenderer.invoke("upload:now"),
  /** Installeert de klaargezette update en herstart. Doet niets als er niets klaarstaat. */
  installUpdate: (): Promise<void> => ipcRenderer.invoke("update:install"),
  /** Nu kijken of er iets nieuwers is, in plaats van op de zesuurstimer wachten. */
  checkUpdate: (): Promise<void> => ipcRenderer.invoke("update:check"),
  lookupPlayer: (riotId: string): Promise<PlayerProfile | null> =>
    ipcRenderer.invoke("player:lookup", riotId),
  /**
   * Mode first, and required.
   *
   * Not an optional trailing parameter with a sensible default, on purpose. An
   * optional mode is a mode somebody eventually forgets to pass, and a forgotten
   * mode does not fail -- it answers with a tier list built out of two games'
   * worth of different items, runes and map timers, which looks entirely
   * plausible and which nobody catches. Required and first is the one place the
   * compiler can enforce the rule the rest of the app can only promise.
   *
   * CollectedMode rather than ModeId for the same reason: a mode with no bucket
   * has no tier list, and that is a sentence a screen should print rather than a
   * request it should be able to make.
   */
  getTierList: (
    mode: CollectedMode,
    position: Position,
    minGames?: number,
  ): Promise<TierEntry[]> => ipcRenderer.invoke("stats:tierList", mode, position, minGames),
  getChampionDetail: (
    mode: CollectedMode,
    championId: number,
    position?: Position,
  ): Promise<ChampionDetail | null> =>
    ipcRenderer.invoke("stats:champion", mode, championId, position),

  /** Abonneert op statuswijzigingen; geeft een opzegfunctie terug. */
  onSnapshot: (handler: (snapshot: AppSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: AppSnapshot): void => handler(snapshot);
    ipcRenderer.on("app:snapshot", listener);
    return () => ipcRenderer.removeListener("app:snapshot", listener);
  },

  minimize: (): void => ipcRenderer.send("window:minimize"),
  maximize: (): void => ipcRenderer.send("window:maximize"),
  close: (): void => ipcRenderer.send("window:close"),
};

export type JadeApi = typeof api;

contextBridge.exposeInMainWorld("jade", api);
