/**
 * Het runesysteem van League Classic: Marks, Seals, Glyphs en Quintessences.
 *
 * Anders dan masteries moeten runes gekocht worden, en je bezit er een bepaald
 * aantal van. Een pagina die runes gebruikt die je niet hebt, is onbruikbaar --
 * dus houdt alles hier rekening met je inventaris.
 *
 * De rune-ID's volgen dezelfde offset als items: 775279 is rune 5279.
 */
import type { LcuClient } from "../lcu/connector";

export type RuneKind = "mark" | "seal" | "glyph" | "quintessence";

/** De slots op een pagina, met hun kleur en aantal. */
export const RUNE_SLOTS: Record<RuneKind, { slotKey: string; count: number; inventoryType: string }> = {
  mark: { slotKey: "RED", count: 9, inventoryType: "JADE_RUNE_MARK" },
  seal: { slotKey: "YELLOW", count: 9, inventoryType: "JADE_RUNE_SEAL" },
  glyph: { slotKey: "BLUE", count: 9, inventoryType: "JADE_RUNE_GLYPH" },
  quintessence: { slotKey: "QUINT", count: 3, inventoryType: "JADE_RUNE_QUINTESSENCE" },
};

const KIND_BY_RAW_TYPE: Record<string, RuneKind> = {
  kMark: "mark",
  kSeal: "seal",
  kGlyph: "glyph",
  kQuintessence: "quintessence",
};

export interface Rune {
  id: number;
  kind: RuneKind;
  title: string;
  tooltip: string;
  /** Statnaam -> waarde, bijv. { "Magic Resist": 1.4 }. */
  stats: Record<string, number>;
  /** True als de waarde per level schaalt in plaats van vast te zijn. */
  isPerLevel: boolean;
  /** Riot markeert zwakkere varianten ("Minor ...") zelf als lage kwaliteit. */
  isLowQuality: boolean;
  iconPath: string;
}

export interface OwnedRune {
  rune: Rune;
  quantity: number;
}

interface RawRune {
  id: number;
  type: string;
  title: string;
  tooltip: string;
  statName?: string;
  amount?: number;
  stats?: Record<string, number>;
  isPerLevel?: boolean;
  isLowQuality?: boolean;
  iconPath?: string;
}

interface RawInventoryItem {
  itemId: number;
  quantity: number;
  owned: boolean;
}

export class RuneCatalog {
  private constructor(
    private readonly byId: Map<number, Rune>,
    /** Aantal exemplaren per rune-ID dat de speler bezit. */
    private readonly owned: Map<number, number>,
  ) {}

  static async load(client: LcuClient): Promise<RuneCatalog> {
    const raw = await client.get<RawRune[]>("/lol-game-data/assets/v1/jade-perks.json");
    const byId = new Map<number, Rune>();
    for (const r of raw) {
      const kind = KIND_BY_RAW_TYPE[r.type];
      if (!kind) continue;
      byId.set(r.id, {
        id: r.id,
        kind,
        title: r.title,
        tooltip: r.tooltip,
        stats: r.stats ?? (r.statName && r.amount !== undefined ? { [r.statName]: r.amount } : {}),
        isPerLevel: r.isPerLevel ?? false,
        isLowQuality: r.isLowQuality ?? false,
        iconPath: r.iconPath ?? "",
      });
    }

    // Inventaris per type ophalen; een leeg type levert gewoon niets op.
    const owned = new Map<number, number>();
    await Promise.all(
      Object.values(RUNE_SLOTS).map(async ({ inventoryType }) => {
        const items = await client.tryGet<RawInventoryItem[]>(
          `/lol-inventory/v2/inventory/${inventoryType}`,
        );
        for (const item of items ?? []) {
          if (item.owned) owned.set(item.itemId, (owned.get(item.itemId) ?? 0) + item.quantity);
        }
      }),
    );

    return new RuneCatalog(byId, owned);
  }

  get(id: number): Rune | undefined {
    return this.byId.get(id);
  }

  title(id: number): string {
    return this.byId.get(id)?.title ?? (id > 0 ? `Rune ${id}` : "leeg");
  }

  all(kind?: RuneKind): Rune[] {
    const runes = [...this.byId.values()];
    return kind ? runes.filter((r) => r.kind === kind) : runes;
  }

  quantityOwned(id: number): number {
    return this.owned.get(id) ?? 0;
  }

  /** Alles wat je bezit, aflopend op aantal -- runes waar je er negen van hebt zijn het bruikbaarst. */
  ownedRunes(kind?: RuneKind): OwnedRune[] {
    const result: OwnedRune[] = [];
    for (const [id, quantity] of this.owned) {
      const rune = this.byId.get(id);
      if (!rune || quantity <= 0) continue;
      if (kind && rune.kind !== kind) continue;
      result.push({ rune, quantity });
    }
    return result.sort((a, b) => b.quantity - a.quantity || a.rune.title.localeCompare(b.rune.title));
  }

  /**
   * Controleert of een pagina te maken is met wat je bezit.
   * `page` is per soort een lijst rune-ID's, een per slot (0 = leeg).
   */
  validate(page: Record<RuneKind, number[]>): string[] {
    const errors: string[] = [];
    for (const kind of Object.keys(RUNE_SLOTS) as RuneKind[]) {
      const slots = page[kind] ?? [];
      const expected = RUNE_SLOTS[kind].count;
      if (slots.length > expected) {
        errors.push(`${kind}: ${slots.length} runes voor ${expected} slots`);
      }
      const used = new Map<number, number>();
      for (const id of slots) {
        if (!id) continue;
        const rune = this.byId.get(id);
        if (!rune) {
          errors.push(`Onbekende rune ${id}`);
          continue;
        }
        if (rune.kind !== kind) {
          errors.push(`${rune.title} is een ${rune.kind} en past niet in een ${kind}-slot`);
        }
        used.set(id, (used.get(id) ?? 0) + 1);
      }
      for (const [id, count] of used) {
        const have = this.quantityOwned(id);
        if (count > have) {
          errors.push(`${this.title(id)}: ${count} nodig, je bezit er ${have}`);
        }
      }
    }
    return errors;
  }
}
