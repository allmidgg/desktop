/**
 * Which id space a number belongs to, per kind.
 *
 * Per kind and not per game, and that is not tidiness. Game 7953675289 carries
 * champion ids in the base space and item ids in the Jade space at the same
 * time, so a single "this game's id space" would have to be wrong about one of
 * them.
 *
 * Riot does not translate between the two; it publishes both spaces side by side
 * in the same asset file. The client's own summoner-spells.json lists Flash
 * twice -- as 4 with Summoner_flash.png and as 74 with
 * S3_Summoner_flash.project_jade.png -- and lists Promote only once, as 720. So
 * 74 is not derived from 4: it is its own id with its own icon, and 720 has no
 * counterpart at all.
 *
 * This module classifies. It does not convert. The functions that used to turn
 * one space's id into the other's are gone; see the note in ../jade/ids.ts for
 * why their absence is the measure rather than the tidying.
 */
import type { KnownModeId } from "../modes/types";

export type IdKind = "champion" | "item" | "spell";
export type IdSpace = "base" | "jade";

const JADE_BAND: Record<IdKind, { min: number; max: number }> = {
  champion: { min: 60_000, max: 70_000 },
  // Shared with Classic runes: runes.ts notes that rune 5279 is 775279. Only
  // ever ask this about a value you already know to be an item id.
  item: { min: 770_000, max: 780_000 },
  spell: { min: 70, max: 800 },
};

/**
 * Which space this id sits in, or null when it sits in neither.
 *
 * Null is a real answer callers must handle: an empty item slot is 0, an
 * unpicked champion is -1, and the client's spell list carries a sentinel with
 * id 4294967295.
 */
export function spaceOf(kind: IdKind, id: number): IdSpace | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const band = JADE_BAND[kind];
  if (id >= band.min && id < band.max) return "jade";
  // Above the Jade band there is no base champion and no base spell -- only room
  // for a numbering we have never seen. Saying "base" about those would hand the
  // modern catalogue rows it has no business carrying.
  if (kind === "champion" && id >= JADE_BAND.champion.min) return null;
  if (kind === "spell" && id >= 100_000) return null;
  return "base";
}

/**
 * What each mode's ids are numbered in, per kind.
 *
 * The single table for this question. detect.ts uses the champion and item rows
 * as its veto and the catalogue uses all three to pick an index, and those two
 * answers have to be the same answer -- two copies of this table drifting apart
 * is how a mode ends up vetoed on one screen and looked up on another.
 *
 * The Jade spell space is measured the same way the others are: the client
 * publishes S3_*.project_jade.png icons for ids 71 to 777 and ordinary icons for
 * 1 to 55.
 */
export const MODE_SPACES: Record<
  KnownModeId,
  { champion: IdSpace; item: IdSpace; spell: IdSpace | null }
> = {
  "lol:jade": { champion: "jade", item: "jade", spell: "jade" },
  "lol:sr": { champion: "base", item: "base", spell: "base" },
  // Measured, not assumed: base champions with Jade items in the same game.
  // Spell is null because nothing has told us. Game 7953675289 is the only one
  // of these we have ever seen and it is not in the store, so there is no spell
  // id to read off. Guessing here would put a wrong icon on a screen with the
  // same confidence as a right one; null makes the lookup answer nothing.
  "lol:kiwi-jade": { champion: "base", item: "jade", spell: null },
};

/** The space a mode numbers this kind in, or null where we have never seen one. */
export const spaceForMode = (mode: KnownModeId, kind: IdKind): IdSpace | null =>
  MODE_SPACES[mode][kind];
