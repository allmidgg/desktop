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
  masteryPlan: (championId: number): Promise<MasteryPlanSummary | null> =>
    ipcRenderer.invoke("masteries:plan", championId),
  autoMasteries: (championId: number | null): Promise<ApplyResult> =>
    ipcRenderer.invoke("masteries:auto", championId),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke("settings:update", patch),
  uploadNow: (): Promise<AppSnapshot> => ipcRenderer.invoke("upload:now"),
  lookupPlayer: (riotId: string): Promise<PlayerProfile | null> =>
    ipcRenderer.invoke("player:lookup", riotId),
  getTierList: (position: Position, minGames?: number): Promise<TierEntry[]> =>
    ipcRenderer.invoke("stats:tierList", position, minGames),
  getChampionDetail: (championId: number, position?: Position): Promise<ChampionDetail | null> =>
    ipcRenderer.invoke("stats:champion", championId, position),

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
