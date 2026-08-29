/**
 * Wat League Classic (JADE) is, in getallen: de map, de queues, de ID-ruimte.
 *
 * Classic gebruikt eigen ID-ruimtes zodat de oude en de moderne versie van
 * dezelfde champion of item naast elkaar kunnen bestaan:
 *
 *   champions        60000 + basisId      Ashe 22   -> 60022
 *   items           770000 + basisId      Infinity Edge 3031 -> 773031
 *   summoner spells  "7" + basisId        Flash 4   -> 74,  Teleport 12 -> 712
 *
 * The classification of an id -- which of the two spaces it sits in -- lives in
 * ../ids/space.ts and is shared with the mode resolver, so there is one table
 * and not two. The predicates below are the Classic-shaped way of asking it,
 * kept because that is what the callers mean.
 */
import { spaceOf } from "../ids/space";

export const JADE_CHAMPION_OFFSET = 60_000;
export const JADE_ITEM_OFFSET = 770_000;
export const JADE_MAP_ID = 453;

/** Queues die op Classic Rift draaien. */
export const JADE_QUEUES = {
  NORMAL: 3260,
  NORMAL_ALT: 3262,
  RANKED_SOLO: 4310,
  BOT: 4320,
} as const;

export const JADE_QUEUE_IDS: readonly number[] = Object.values(JADE_QUEUES);
export const JADE_RANKED_QUEUE_TYPE = "JADE_RANKED_SOLO_5x5";

export const isJadeChampionId = (id: number): boolean => spaceOf("champion", id) === "jade";
export const isJadeItemId = (id: number): boolean => spaceOf("item", id) === "jade";

/**
 * The translation helpers that used to live here are gone, and their absence is
 * the point.
 *
 * toJadeChampionId, toBaseChampionId, toJadeItemId, toBaseItemId, toJadeSpellId
 * and toBaseSpellId were all functions from number to number within one kind,
 * which means every one of them could be applied to its own output. That is how
 * Promote once became 7720. The range guard that stopped it was an assumption
 * about Riot's numbering that we do not control, and it was already leaking:
 * toBaseSpellId(777) returned 77, which is Classic Heal.
 *
 * toJadeChampionId was also the single tool in this codebase for turning 22 into
 * 60022 -- the one move that makes a modern game find a Classic tally and report
 * full confidence about it. Removing it is not tidying; it is the measure.
 *
 * Classification lives in ../ids/space.ts and answers the question the app
 * actually asks: which space does this id belong to. Crossing between the spaces
 * is a lookup, carried on CatalogChampion.counterpartId and its two siblings,
 * computed once from the real indexes and confirmed against the name -- and null
 * wherever there is nothing to point at, which is 49 of the 162 Classic items
 * and 6 of the 16 Classic spells.
 */

/*
 * `isJadeGame` used to live here, and its last caller was the filter on your own
 * match history. It is gone rather than left lying about, because it answered a
 * yes/no question the app no longer asks: it took three signals and needed only
 * ONE of them to agree, so a game on map 453 in some future mode string was
 * Classic to it, and every game that was not Classic was nothing in particular.
 * resolveMode() weighs the same three signals against each other and can answer
 * "neither of the two, and here is why", which is the answer game 7953675289
 * needs. A helper that cannot give that answer would be reached for by the next
 * person writing a filter, and it would be wrong quietly.
 */
