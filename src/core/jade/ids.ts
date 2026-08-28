/**
 * ID-vertaling tussen League Classic (JADE) en het normale spel.
 *
 * Classic gebruikt eigen ID-ruimtes zodat de oude en de moderne versie van
 * dezelfde champion of item naast elkaar kunnen bestaan:
 *
 *   champions        60000 + basisId      Ashe 22   -> 60022
 *   items           770000 + basisId      Infinity Edge 3031 -> 773031
 *   summoner spells  "7" + basisId        Flash 4   -> 74,  Teleport 12 -> 712
 *
 * De champion- en itemtabellen worden bij het opstarten gevalideerd tegen de
 * asset-bestanden van de client (zie catalog.ts), dus als Riot deze afspraak ooit
 * verandert, merken we dat meteen in plaats van stilletjes verkeerde data te tonen.
 */

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

export const isJadeChampionId = (id: number): boolean => id > JADE_CHAMPION_OFFSET && id < 70_000;
export const isJadeItemId = (id: number): boolean => id > JADE_ITEM_OFFSET && id < 780_000;

export const toBaseChampionId = (jadeId: number): number =>
  isJadeChampionId(jadeId) ? jadeId - JADE_CHAMPION_OFFSET : jadeId;

export const toJadeChampionId = (baseId: number): number =>
  isJadeChampionId(baseId) ? baseId : baseId + JADE_CHAMPION_OFFSET;

export const toBaseItemId = (jadeId: number): number =>
  isJadeItemId(jadeId) ? jadeId - JADE_ITEM_OFFSET : jadeId;

export const toJadeItemId = (baseId: number): number =>
  isJadeItemId(baseId) ? baseId : baseId + JADE_ITEM_OFFSET;

/**
 * Summoner spells krijgen een "7" voor het basis-ID geplakt in plaats van een
 * optelling: Flash (4) wordt 74, Barrier (21) wordt 721. Een leeg slot is 0.
 */
export function toBaseSpellId(jadeId: number): number {
  if (jadeId <= 0) return 0;
  const digits = String(jadeId);
  if (digits.length < 2 || !digits.startsWith("7")) return jadeId;
  return Number(digits.slice(1));
}

/**
 * Ligt dit ID al in het Jade-bereik?
 *
 * Basis-spells zijn allemaal onder de 60 (Flash 4, Smite 11, Barrier 21) of ver
 * daarboven (2201, 2202). Tussen 70 en 799 zit dus niets anders dan een
 * Jade-ID, en dat maakt dit bereik een veilige toets.
 */
export const isJadeSpellId = (id: number): boolean => id >= 70 && id <= 799;

/**
 * Basis-ID naar Jade-ID: er gaat een 7 voor.
 *
 * Behalve als er al een voor staat. De spells die alleen in Classic bestaan --
 * Fortify 705, Rally 709, Surge 716, Promote 720, Revive 777 -- hebben geen
 * modern equivalent en dragen hun Jade-ID rechtstreeks in de assets. Die nog
 * eens prefixen maakte van Promote 7720, waarna de matchdata met 720 niets meer
 * kon vinden en er "Flash + 720" zonder icoon op het scherm stond.
 */
export const toJadeSpellId = (baseId: number): number =>
  isJadeSpellId(baseId) ? baseId : Number(`7${baseId}`);

/** Is dit een League Classic-game? Controleert mode en map, want beide kunnen los voorkomen. */
export const isJadeGame = (game: { gameMode?: string; mapId?: number; queueId?: number }): boolean =>
  game.gameMode === "JADE" ||
  game.mapId === JADE_MAP_ID ||
  (game.queueId !== undefined && JADE_QUEUE_IDS.includes(game.queueId));
