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

/**
 * One purchase, with what it actually cost and what was in hand afterwards.
 */
export interface Aankoop {
  stap: BuildStep;
  /**
   * Gold this purchase added on top of what was already owned.
   *
   * The catalogue's price is the total price -- the number the shop puts on the
   * icon -- so an Infinity Edge quotes the B.F. Sword inside it. Adding the raw
   * prices of a purchase list therefore counts the same gold three or four times
   * over. What is charged here is the difference: the item's total minus the
   * totals of the components it swallowed, which telescopes to exactly the gold
   * that left the player's pocket at that moment.
   */
  bijbetaling: number;
  /** Gold committed to items after this purchase. */
  totaal: number;
  /** The components this purchase consumed, so a click can say where they went. */
  verbruikt: number[];
  /** What was in the inventory the instant after, finished items and loose parts alike. */
  bezit: number[];
}

/**
 * Walks a purchase list and works out what each step cost and what was held.
 *
 * Deliberately not built on top of bouwPad, which answers a different question:
 * bouwPad flattens a chain into one group, and a flattened chain has lost the
 * boundaries the arithmetic needs -- a Long Sword that became a B.F. Sword that
 * became an Infinity Edge appears three times in one group's history, and there
 * is no longer anything saying which of them paid for which. The consumption
 * rule is the same rule, applied one step at a time.
 *
 * An item the catalogue does not know prices at zero rather than at a guess.
 * That self-corrects: an unknown component charges nothing when it is bought and
 * subtracts nothing when it is consumed, so the running total is right again as
 * soon as a known item is finished.
 */
export function aankoopVerloop(
  stappen: BuildStep[],
  prijsVan: (itemId: number) => number,
  onderdelenVan: (itemId: number) => number[],
): Aankoop[] {
  const inventaris: number[] = [];
  const uit: Aankoop[] = [];
  let totaal = 0;

  for (const stap of stappen) {
    // Direct components only, the same as bouwPad: anything deeper is already
    // represented by the sub-assembly lying in the inventory.
    const nodig = [...onderdelenVan(stap.itemId)];
    const verbruikt: number[] = [];
    for (let i = 0; i < inventaris.length && nodig.length > 0; ) {
      const gehouden = inventaris[i];
      const j = gehouden === undefined ? -1 : nodig.indexOf(gehouden);
      if (j === -1 || gehouden === undefined) {
        i++;
        continue;
      }
      nodig.splice(j, 1);
      verbruikt.push(gehouden);
      inventaris.splice(i, 1);
    }

    const terug = verbruikt.reduce((som, id) => som + prijsVan(id), 0);
    // Never negative. A component priced above the thing it builds into means
    // the catalogue disagrees with itself, and a negative charge would draw a
    // player's spending going down, which never happens.
    const bijbetaling = Math.max(0, prijsVan(stap.itemId) - terug);
    totaal += bijbetaling;
    inventaris.push(stap.itemId);
    uit.push({ stap, bijbetaling, totaal, verbruikt, bezit: [...inventaris] });
  }

  return uit;
}

/** Gold committed by a given second. Zero before the first purchase. */
export function goudOp(aankopen: Aankoop[], seconde: number): number {
  let totaal = 0;
  for (const a of aankopen) {
    if (a.stap.at > seconde) break;
    totaal = a.totaal;
  }
  return totaal;
}

/** What was in the inventory at a given second, finished items and loose parts alike. */
export function bezitOp(aankopen: Aankoop[], seconde: number): number[] {
  let bezit: number[] = [];
  for (const a of aankopen) {
    if (a.stap.at > seconde) break;
    bezit = a.bezit;
  }
  return bezit;
}
