/**
 * Lezen en schrijven van je Classic mastery- en rune-pagina's.
 *
 * De client bewaart die niet in de perks-plugin (waar de moderne runes zitten)
 * maar als slots in je account-loadout:
 *
 *   MASTERY_PAGE_3_MASTERY_17     een van de 30 puntslots van pagina 3
 *   RUNE_PAGE_1_BLUE_4            het vierde glyph-slot van rune-pagina 1
 *   ACTIVE_MASTERY_PAGE           welke pagina actief is
 *
 * Schrijven gaat met PATCH op de loadout. Omdat dat je echte pagina's aanpast,
 * maakt `backupLoadout()` eerst een kopie weg naar schijf.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LcuClient } from "../lcu/connector";
import { MasteryCatalog, MASTERY_SLOTS_PER_PAGE, type MasteryPoints } from "../jade/masteries";
import { RUNE_SLOTS, type RuneCatalog, type RuneKind } from "../jade/runes";

export interface LoadoutSlot {
  contentId: string;
  data: Record<string, unknown>;
  inventoryType: string;
  itemId: number;
}

export interface Loadout {
  id: string;
  scope: string;
  scopeItemId: number | null;
  name: string;
  loadout: Record<string, LoadoutSlot>;
}

export interface MasteryPageInfo {
  index: number;
  name: string;
  points: MasteryPoints;
  pointsSpent: number;
  isActive: boolean;
  isEmpty: boolean;
  /** Door Riot meegeleverde pagina. Die laten we met rust. */
  isPreset: boolean;
}

export interface RunePageInfo {
  index: number;
  name: string;
  /** Per soort de rune-ID's per slot; 0 is leeg. */
  slots: Record<RuneKind, number[]>;
  isActive: boolean;
  isEmpty: boolean;
  isPreset: boolean;
}

export async function fetchAccountLoadout(client: LcuClient): Promise<Loadout> {
  const loadouts = await client.get<Loadout[]>("/lol-loadouts/v4/loadouts/scope/account");
  const account = loadouts[0];
  if (!account) throw new Error("Geen account-loadout gevonden in de client.");
  return account;
}

const slotValue = (loadout: Loadout, key: string): number => loadout.loadout[key]?.itemId ?? 0;

/** Welke paginanummers bestaan er, afgeleid uit de sleutels zelf. */
function pageIndexes(loadout: Loadout, prefix: string): number[] {
  const pattern = new RegExp(`^${prefix}_(\\d+)_`);
  const found = new Set<number>();
  for (const key of Object.keys(loadout.loadout)) {
    const match = pattern.exec(key);
    if (match?.[1]) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

export function readMasteryPages(loadout: Loadout, catalog: MasteryCatalog): MasteryPageInfo[] {
  const active = slotValue(loadout, "ACTIVE_MASTERY_PAGE");
  return pageIndexes(loadout, "MASTERY_PAGE").map((index) => {
    const slots = Array.from({ length: MASTERY_SLOTS_PER_PAGE }, (_, i) =>
      slotValue(loadout, `MASTERY_PAGE_${index}_MASTERY_${i + 1}`),
    );
    const points = catalog.fromSlots(slots);
    const pointsSpent = [...points.values()].reduce((sum, n) => sum + n, 0);
    const nameData = loadout.loadout[`MASTERY_PAGE_${index}_NAME`]?.data ?? {};
    return {
      index,
      name: pageName(nameData, `Mastery Page ${index}`),
      points,
      pointsSpent,
      isActive: index === active,
      isEmpty: pointsSpent === 0,
      isPreset: typeof nameData.nameKey === "string" && nameData.nameKey.length > 0,
    };
  });
}

export function readRunePages(loadout: Loadout): RunePageInfo[] {
  const active = slotValue(loadout, "ACTIVE_RUNE_PAGE");
  return pageIndexes(loadout, "RUNE_PAGE").map((index) => {
    const slots = {} as Record<RuneKind, number[]>;
    let filled = 0;
    for (const kind of Object.keys(RUNE_SLOTS) as RuneKind[]) {
      const { slotKey, count } = RUNE_SLOTS[kind];
      slots[kind] = Array.from({ length: count }, (_, i) =>
        slotValue(loadout, `RUNE_PAGE_${index}_${slotKey}_${i + 1}`),
      );
      filled += slots[kind].filter((id) => id > 0).length;
    }
    const nameData = loadout.loadout[`RUNE_PAGE_${index}_NAME`]?.data ?? {};
    return {
      index,
      name: pageName(nameData, `Rune Page ${index}`),
      slots,
      isActive: index === active,
      isEmpty: filled === 0,
      isPreset: typeof nameData.nameKey === "string" && nameData.nameKey.length > 0,
    };
  });
}

/**
 * Paginanamen komen in twee smaken: presets dragen een `nameKey` die naar een
 * vertaling verwijst, zelfgemaakte pagina's een letterlijke `name`.
 */
function pageName(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.name === "string" && data.name) return data.name;
  if (typeof data.nameKey === "string" && data.nameKey) {
    return data.nameKey.replace(/^jade_mastery_preset_/, "").replace(/_/g, " ");
  }
  return fallback;
}

/**
 * Schrijft de huidige loadout weg en geeft het pad terug.
 *
 * De map komt van buiten: afleiden uit de locatie van dit bestand ging mis zodra
 * de code gebundeld werd, en dan belandden je backups buiten het project.
 */
export async function backupLoadout(loadout: Loadout, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(directory, `loadout-${stamp}.json`);
  await writeFile(path, JSON.stringify(loadout, null, 2), "utf8");
  return path;
}

const masterySlot = (itemId: number): LoadoutSlot => ({
  contentId: "",
  data: {},
  inventoryType: "JADE_MASTERY",
  itemId,
});

/**
 * Bouwt de slots voor een mastery-pagina. Geeft alleen het stukje loadout terug
 * dat verandert -- de PATCH voegt dat samen met de rest.
 */
export function buildMasteryPagePatch(
  catalog: MasteryCatalog,
  pageIndex: number,
  points: MasteryPoints,
): Record<string, LoadoutSlot> {
  const errors = catalog.validate(points);
  if (errors.length > 0) {
    throw new Error(`Ongeldige mastery-pagina:\n  - ${errors.join("\n  - ")}`);
  }
  const slots = catalog.toSlots(points);
  const patch: Record<string, LoadoutSlot> = {};
  slots.forEach((itemId, i) => {
    patch[`MASTERY_PAGE_${pageIndex}_MASTERY_${i + 1}`] = masterySlot(itemId);
  });
  return patch;
}

export function buildRunePagePatch(
  catalog: RuneCatalog,
  pageIndex: number,
  page: Partial<Record<RuneKind, number[]>>,
): Record<string, LoadoutSlot> {
  const full = {} as Record<RuneKind, number[]>;
  for (const kind of Object.keys(RUNE_SLOTS) as RuneKind[]) {
    full[kind] = page[kind] ?? [];
  }
  const errors = catalog.validate(full);
  if (errors.length > 0) {
    throw new Error(`Ongeldige rune-pagina:\n  - ${errors.join("\n  - ")}`);
  }

  const patch: Record<string, LoadoutSlot> = {};
  for (const kind of Object.keys(RUNE_SLOTS) as RuneKind[]) {
    const { slotKey, count, inventoryType } = RUNE_SLOTS[kind];
    for (let i = 0; i < count; i++) {
      patch[`RUNE_PAGE_${pageIndex}_${slotKey}_${i + 1}`] = {
        contentId: "",
        data: {},
        inventoryType,
        itemId: full[kind][i] ?? 0,
      };
    }
  }
  return patch;
}

export function buildActivePagePatch(
  type: "mastery" | "rune",
  pageIndex: number,
): Record<string, LoadoutSlot> {
  const key = type === "mastery" ? "ACTIVE_MASTERY_PAGE" : "ACTIVE_RUNE_PAGE";
  const inventoryType = type === "mastery" ? "JADE_MASTERY_PAGE" : "JADE_RUNE_PAGE";
  return { [key]: { contentId: "", data: {}, inventoryType, itemId: pageIndex } };
}

/**
 * Stuurt de wijziging naar de client. Maakt eerst een backup, tenzij die al
 * gemaakt is voor deze reeks aanpassingen.
 */
export async function applyLoadoutPatch(
  client: LcuClient,
  loadout: Loadout,
  patch: Record<string, LoadoutSlot>,
  options: { backupDir?: string } = {},
): Promise<{ backupPath?: string }> {
  const backupPath = options.backupDir ? await backupLoadout(loadout, options.backupDir) : undefined;
  await client.patch(`/lol-loadouts/v4/loadouts/${loadout.id}`, { loadout: patch });
  return { backupPath };
}
