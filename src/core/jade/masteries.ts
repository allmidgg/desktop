/**
 * Het masterysysteem van League Classic: drie bomen, 30 punten.
 *
 * De client publiceert de complete boom op /lol-game-data/assets/v1/jade-mastery-display.json,
 * inclusief maxRank per mastery en het aantal punten dat een rij vereist. Daardoor
 * kunnen we pagina's genereren en -- belangrijker -- vooraf controleren of ze
 * geldig zijn, in plaats van de client een ongeldige pagina te laten weigeren.
 *
 * Mastery-ID's coderen hun eigen positie: 732 = boom 7 (Utility), rij 3, kolom 2.
 */
import type { LcuClient } from "../lcu/connector";

export type MasteryTreeType = "offense" | "defense" | "utility";

export interface Mastery {
  id: number;
  name: string;
  description: string;
  maxRank: number;
  /** Nulgebaseerde rij binnen de boom. */
  rowIndex: number;
  tree: MasteryTreeType;
  /** Punten die je elders in deze boom moet hebben voordat de rij opengaat. */
  pointsRequired: number;
  /**
   * Sommige masteries gaan pas open als een andere mastery vol staat. Frenzy
   * vereist bijvoorbeeld Lethality op 2/2. De client weigert het punt anders
   * stilzwijgend -- die schrijft er een 0 en zegt niets.
   */
  requiresMastery: number | null;
  activeIconPath: string;
  inactiveIconPath: string;
}

export interface MasteryRow {
  pointsRequired: number;
  /** Vier kolommen; een lege kolom is null. */
  masteries: Array<Mastery | null>;
}

export interface MasteryTree {
  name: string;
  type: MasteryTreeType;
  rows: MasteryRow[];
}

/** Een pagina als "hoeveel punten in welke mastery". */
export type MasteryPoints = Map<number, number>;

export const MASTERY_POINTS_TOTAL = 30;
export const MASTERY_SLOTS_PER_PAGE = 30;

interface RawMastery {
  id: number;
  name: string;
  description: string;
  maxRank: number;
  rowIndex: number;
  requiresMastery?: number;
  activeIconPath: string;
  inactiveIconPath: string;
}

interface RawTree {
  name: string;
  type: MasteryTreeType;
  rows: Array<{ pointsRequired: number; masteries: Array<RawMastery | null> }>;
}

export class MasteryCatalog {
  private constructor(
    readonly trees: MasteryTree[],
    private readonly byId: Map<number, Mastery>,
  ) {}

  static async load(client: LcuClient): Promise<MasteryCatalog> {
    const raw = await client.get<{ trees: RawTree[] }>(
      "/lol-game-data/assets/v1/jade-mastery-display.json",
    );
    const byId = new Map<number, Mastery>();
    const trees: MasteryTree[] = raw.trees.map((tree) => ({
      name: tree.name,
      type: tree.type,
      rows: tree.rows.map((row) => ({
        pointsRequired: row.pointsRequired,
        masteries: row.masteries.map((m) => {
          if (!m) return null;
          const mastery: Mastery = {
            id: m.id,
            name: m.name,
            description: m.description,
            maxRank: m.maxRank,
            rowIndex: m.rowIndex,
            tree: tree.type,
            pointsRequired: row.pointsRequired,
            requiresMastery: m.requiresMastery ?? null,
            activeIconPath: m.activeIconPath,
            inactiveIconPath: m.inactiveIconPath,
          };
          byId.set(m.id, mastery);
          return mastery;
        }),
      })),
    }));
    return new MasteryCatalog(trees, byId);
  }

  get(id: number): Mastery | undefined {
    return this.byId.get(id);
  }

  name(id: number): string {
    return this.byId.get(id)?.name ?? `Mastery ${id}`;
  }

  all(): Mastery[] {
    return [...this.byId.values()];
  }

  tree(type: MasteryTreeType): MasteryTree | undefined {
    return this.trees.find((t) => t.type === type);
  }

  /** Punten per boom, zoals de client die onderaan elke boom toont. */
  pointsPerTree(points: MasteryPoints): Record<MasteryTreeType, number> {
    const totals: Record<MasteryTreeType, number> = { offense: 0, defense: 0, utility: 0 };
    for (const [id, spent] of points) {
      const mastery = this.byId.get(id);
      if (mastery) totals[mastery.tree] += spent;
    }
    return totals;
  }

  /**
   * Controleert of een pagina legaal is volgens de regels van het spel.
   * Geeft een lege lijst terug als alles klopt.
   */
  validate(points: MasteryPoints): string[] {
    const errors: string[] = [];
    let total = 0;

    for (const [id, spent] of points) {
      const mastery = this.byId.get(id);
      if (!mastery) {
        errors.push(`Onbekende mastery ${id}`);
        continue;
      }
      if (spent < 0) errors.push(`${mastery.name}: negatief aantal punten`);
      if (spent > mastery.maxRank) {
        errors.push(`${mastery.name}: ${spent} punten, maar maxRank is ${mastery.maxRank}`);
      }
      total += spent;
    }

    if (total > MASTERY_POINTS_TOTAL) {
      errors.push(`${total} punten uitgegeven, er zijn er maar ${MASTERY_POINTS_TOTAL}`);
    }

    // Een rij gaat pas open als er genoeg punten in de rijen erboven staan --
    // punten in dezelfde of een lagere rij tellen daar niet voor mee.
    for (const [id, spent] of points) {
      const mastery = this.byId.get(id);
      if (!mastery || spent === 0) continue;
      const above = this.pointsAboveRow(points, mastery.tree, mastery.rowIndex);
      if (above < mastery.pointsRequired) {
        errors.push(
          `${mastery.name} vereist ${mastery.pointsRequired} punten in de rijen erboven ` +
            `(${mastery.tree}), maar er staan er ${above}`,
        );
      }
    }
    // Een mastery met een vereiste gaat pas open als die vereiste vol staat.
    for (const [id, spent] of points) {
      const mastery = this.byId.get(id);
      if (!mastery?.requiresMastery || spent === 0) continue;
      const prerequisite = this.byId.get(mastery.requiresMastery);
      if (!prerequisite) continue;
      const have = points.get(prerequisite.id) ?? 0;
      if (have < prerequisite.maxRank) {
        errors.push(
          `${mastery.name} vereist ${prerequisite.name} op ${prerequisite.maxRank}/${prerequisite.maxRank}, ` +
            `maar die staat op ${have}`,
        );
      }
    }
    return errors;
  }

  /** Mag er nu een punt in deze mastery? Kijkt alleen naar de vereiste. */
  isUnlocked(mastery: Mastery, points: MasteryPoints): boolean {
    if (!mastery.requiresMastery) return true;
    const prerequisite = this.byId.get(mastery.requiresMastery);
    if (!prerequisite) return true;
    return (points.get(prerequisite.id) ?? 0) >= prerequisite.maxRank;
  }

  /** Punten in dezelfde boom, in rijen boven `rowIndex`. */
  private pointsAboveRow(points: MasteryPoints, tree: MasteryTreeType, rowIndex: number): number {
    let total = 0;
    for (const [id, spent] of points) {
      const mastery = this.byId.get(id);
      if (mastery && mastery.tree === tree && mastery.rowIndex < rowIndex) total += spent;
    }
    return total;
  }

  /**
   * Zet een pagina om naar de 30 slots die de client verwacht: een slot per
   * uitgegeven punt, oplopend op mastery-ID, en de rest gevuld met 0.
   * Dit is exact het formaat waarin de ingebouwde presets zijn opgeslagen.
   */
  toSlots(points: MasteryPoints): number[] {
    const slots: number[] = [];
    for (const id of [...points.keys()].sort((a, b) => a - b)) {
      const spent = points.get(id) ?? 0;
      for (let i = 0; i < spent; i++) slots.push(id);
    }
    if (slots.length > MASTERY_SLOTS_PER_PAGE) {
      throw new Error(`Pagina gebruikt ${slots.length} punten, maximaal ${MASTERY_SLOTS_PER_PAGE}`);
    }
    while (slots.length < MASTERY_SLOTS_PER_PAGE) slots.push(0);
    return slots;
  }

  /** De omgekeerde weg: 30 slots terug naar punten per mastery. */
  fromSlots(slots: Array<number | undefined>): MasteryPoints {
    const points: MasteryPoints = new Map();
    for (const slot of slots) {
      // 0 is een leeg slot; de ingebouwde presets gebruiken daarnaast -1.
      if (!slot || slot <= 0) continue;
      points.set(slot, (points.get(slot) ?? 0) + 1);
    }
    return points;
  }
}
