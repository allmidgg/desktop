/**
 * Reading a list of purchases as a build.
 *
 * Lives in shared rather than core on purpose. The renderer needs it, and
 * anything under core/services drags in the League client along with undici --
 * importing it from a view took the renderer bundle from 326 KB to 1.3 MB. This
 * is pure data shuffling with no dependencies at all, so it belongs where both
 * sides can reach it.
 */
import type { BuildStep } from "./types";

/**
 * One finished item and the components that went into it, or a loose purchase.
 */
export interface BouwGroep {
  /** The item that now sits in the inventory. */
  af: BuildStep;
  /** What went into it, oldest first. Empty for something bought outright. */
  weg: BuildStep[];
}

/**
 * Reads a flat list of purchases as a build.
 *
 * A purchase list on its own is just things appearing: Long Sword, Vampiric
 * Scepter, Bilgewater Cutlass. Only the catalogue knows those are one item being
 * assembled rather than three unrelated buys, and that is the difference between
 * a log and something you can follow.
 *
 * Components are matched against what is actually still lying around, so a
 * Long Sword bought for a second item is not stolen by the first one that
 * happens to want one.
 */
export function bouwPad(
  stappen: BuildStep[],
  onderdelenVan: (itemId: number) => number[],
): BouwGroep[] {
  // What is in the inventory right now, each with the history that led to it.
  // A plain purchase is a group of one; an assembled item is a group carrying
  // everything that went into it.
  const inventaris: BouwGroep[] = [];

  /** The item a group currently represents. */
  const huidig = (g: BouwGroep): number => g.af.itemId;

  /** When this group started, so the result can be read chronologically. */
  const begin = (g: BouwGroep): number => g.weg[0]?.at ?? g.af.at;

  for (const stap of stappen) {
    // Direct components only. Anything deeper is already represented by the
    // sub-assembly sitting in the inventory, which is what makes a Long Sword
    // that became a B.F. Sword still reachable from an Infinity Edge.
    const nodig = [...onderdelenVan(stap.itemId)];
    const gepakt: BouwGroep[] = [];

    // Oldest first: the parts you have been carrying are the ones that get
    // built, which also keeps the finished chain in the order it happened.
    for (let i = 0; i < inventaris.length && nodig.length > 0; ) {
      const j = nodig.indexOf(huidig(inventaris[i]!));
      if (j === -1) {
        i++;
        continue;
      }
      nodig.splice(j, 1);
      gepakt.push(inventaris[i]!);
      inventaris.splice(i, 1);
    }

    // Nothing claimed means it was bought outright, or its parts were never seen
    // because the game was already running when we started watching.
    const weg = gepakt.sort((a, b) => begin(a) - begin(b)).flatMap((g) => [...g.weg, g.af]);

    inventaris.push({ af: stap, weg });
  }

  return inventaris.sort((a, b) => begin(a) - begin(b));
}
