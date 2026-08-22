/**
 * Kiest de beste rune-pagina die je met je huidige bezit kunt maken.
 *
 * Binnen een soort zijn alle slots identiek -- een glyph-slot is inwisselbaar met
 * elk ander glyph-slot. Daardoor is de optimale keuze simpelweg: sorteer je runes
 * op waarde en vul de slots van boven af, tot je aantallen op zijn. Dat is niet
 * een benadering maar echt de beste oplossing.
 *
 * De waardering zelf is voorlopig een heuristiek op basis van championrol. Zodra
 * we genoeg Classic-matches hebben verzameld, vervangen we die door winrates per
 * rune -- data die op dit moment nergens ter wereld bestaat.
 */
import type { JadeChampion } from "../jade/catalog";
import { RUNE_SLOTS, type OwnedRune, type Rune, type RuneCatalog, type RuneKind } from "../jade/runes";

/**
 * Gemiddeld championlevel waarop een game beslist wordt. Per-level-runes zijn
 * op level 1 zwakker en later sterker; dit is het omslagpunt waarmee we ze
 * eerlijk vergelijken met vaste runes.
 */
const SCALING_REFERENCE_LEVEL = 12;

type StatWeights = Record<string, number>;

/**
 * Goudwaarde per eenheid stat -- de standaardmaat waarmee League zelf items
 * balanceert. Zonder deze stap zijn statbedragen onvergelijkbaar: een rune geeft
 * "+1 Critical Chance" of "+1.3 Health per level", en die getallen zeggen los van
 * elkaar niets over welke sterker is.
 */
const GOLD_PER_UNIT: StatWeights = {
  "Attack Damage": 36,
  "Ability Power": 21.75,
  Health: 2.66,
  "Health Regen": 12,
  Mana: 1.4,
  "Mana Regen": 30,
  Armor: 20,
  "Magic Resist": 18,
  "Attack Speed": 25,
  "Critical Chance": 40,
  "Critical Damage": 8,
  "Cooldown Reduction": 40,
  "Movement Speed": 12,
  "Magic Penetration": 35,
  "Armor Penetration": 35,
  Lethality: 35,
  "Life Steal": 25,
};

/**
 * Hoe belangrijk een stat is voor een rol, als vermenigvuldiger op de goudwaarde.
 * 1.0 is neutraal: precies zoveel waard als het goud zegt.
 */
const ROLE_MULTIPLIERS: Record<string, StatWeights> = {
  marksman: {
    "Attack Damage": 1.5, "Attack Speed": 1.3, "Critical Chance": 1.3, "Critical Damage": 1.1,
    "Armor Penetration": 1.4, Lethality: 1.4, "Life Steal": 1.1,
    Armor: 0.9, "Magic Resist": 0.6, Health: 0.7, "Ability Power": 0.1,
  },
  mage: {
    "Ability Power": 1.5, "Magic Penetration": 1.6, "Cooldown Reduction": 1.3, "Mana Regen": 1.2,
    Mana: 1.1, Armor: 0.7, "Magic Resist": 0.8, Health: 0.8, "Attack Damage": 0.1,
  },
  assassin: {
    "Attack Damage": 1.3, "Ability Power": 1.3, "Magic Penetration": 1.5,
    "Armor Penetration": 1.5, Lethality: 1.5, "Movement Speed": 1.3,
    "Cooldown Reduction": 1.2, Armor: 0.8, Health: 0.8,
  },
  fighter: {
    "Attack Damage": 1.3, "Attack Speed": 1.1, "Armor Penetration": 1.2, Lethality: 1.2,
    Armor: 1.2, "Magic Resist": 1.1, Health: 1.2, "Life Steal": 1.2, "Cooldown Reduction": 1.1,
  },
  tank: {
    Armor: 1.5, "Magic Resist": 1.4, Health: 1.4, "Health Regen": 1.2,
    "Cooldown Reduction": 1.2, "Movement Speed": 1.1, "Attack Damage": 0.3, "Ability Power": 0.3,
  },
  support: {
    "Magic Resist": 1.3, Armor: 1.2, Health: 1.1, "Mana Regen": 1.5, "Cooldown Reduction": 1.4,
    "Movement Speed": 1.3, "Ability Power": 0.8, "Health Regen": 1.2, "Attack Damage": 0.2,
  },
};

const DEFAULT_MULTIPLIERS: StatWeights = {};

export interface RuneSlotChoice {
  rune: Rune;
  count: number;
}

export interface RuneKindPlan {
  kind: RuneKind;
  slots: number;
  choices: RuneSlotChoice[];
  /** Slots die leeg blijven omdat je te weinig runes bezit. */
  emptySlots: number;
  /** Score van wat je nu kunt maken. */
  score: number;
  /** Score als je alles zou bezitten -- het verschil is wat een aankoop oplevert. */
  bestPossibleScore: number;
  /** De rune die je zou moeten kopen om het gat te dichten. */
  upgrade: Rune | null;
}

export interface RunePlan {
  champion: JadeChampion | null;
  role: string;
  kinds: RuneKindPlan[];
  /** Per soort de rune-ID's per slot, klaar om als pagina weggeschreven te worden. */
  slots: Record<RuneKind, number[]>;
  /** Optelsom van de statbonussen die deze pagina oplevert. */
  totalStats: Record<string, number>;
}

/** Kiest de rol waarvan we de wegingen gebruiken. */
export function resolveRole(champion: JadeChampion | null, override?: string): string {
  if (override && ROLE_MULTIPLIERS[override]) return override;
  for (const role of champion?.roles ?? []) {
    if (ROLE_MULTIPLIERS[role]) return role;
  }
  return "default";
}

/**
 * Waarde van een rune, uitgedrukt in goud. Per-level-runes worden doorgerekend
 * naar het referentielevel, zodat schalende en vaste runes vergelijkbaar zijn.
 *
 * Een stat zonder bekende goudwaarde telt als nul: liever niets aanbevelen dan
 * iets aanbevelen op basis van een verzonnen getal.
 */
function scoreRune(rune: Rune, multipliers: StatWeights): number {
  let score = 0;
  for (const [stat, amount] of Object.entries(rune.stats)) {
    const gold = GOLD_PER_UNIT[stat];
    if (gold === undefined) continue;
    const effective = amount * (rune.isPerLevel ? SCALING_REFERENCE_LEVEL : 1);
    score += effective * gold * (multipliers[stat] ?? 1);
  }
  return score;
}

/**
 * Bouwt het plan. `catalog` levert zowel de runes als je aantallen, dus het
 * resultaat is altijd iets wat je daadwerkelijk kunt instellen.
 */
export function planRunes(
  catalog: RuneCatalog,
  champion: JadeChampion | null,
  roleOverride?: string,
): RunePlan {
  const role = resolveRole(champion, roleOverride);
  const weights = ROLE_MULTIPLIERS[role] ?? DEFAULT_MULTIPLIERS;

  const kinds: RuneKindPlan[] = [];
  const slots = {} as Record<RuneKind, number[]>;
  const totalStats: Record<string, number> = {};

  for (const kind of Object.keys(RUNE_SLOTS) as RuneKind[]) {
    const slotCount = RUNE_SLOTS[kind].count;
    const owned: Array<OwnedRune & { score: number }> = catalog
      .ownedRunes(kind)
      .map((o) => ({ ...o, score: scoreRune(o.rune, weights) }))
      .filter((o) => o.score > 0)
      .sort((a, b) => b.score - a.score);

    const choices: RuneSlotChoice[] = [];
    const filled: number[] = [];
    let score = 0;

    for (const candidate of owned) {
      if (filled.length >= slotCount) break;
      const take = Math.min(candidate.quantity, slotCount - filled.length);
      choices.push({ rune: candidate.rune, count: take });
      for (let i = 0; i < take; i++) filled.push(candidate.rune.id);
      score += candidate.score * take;
      for (const [stat, amount] of Object.entries(candidate.rune.stats)) {
        const value = amount * take * (candidate.rune.isPerLevel ? SCALING_REFERENCE_LEVEL : 1);
        totalStats[stat] = (totalStats[stat] ?? 0) + value;
      }
    }

    const emptySlots = slotCount - filled.length;
    while (filled.length < slotCount) filled.push(0);
    slots[kind] = filled;

    // Wat zou er mogelijk zijn als bezit geen beperking was?
    const best = catalog
      .all(kind)
      .map((rune) => ({ rune, score: scoreRune(rune, weights) }))
      .sort((a, b) => b.score - a.score)[0];
    const bestPossibleScore = (best?.score ?? 0) * slotCount;
    const alreadyOptimal = choices.length === 1 && choices[0]?.rune.id === best?.rune.id && emptySlots === 0;

    kinds.push({
      kind,
      slots: slotCount,
      choices,
      emptySlots,
      score,
      bestPossibleScore,
      upgrade: alreadyOptimal ? null : (best?.rune ?? null),
    });
  }

  return { champion, role, kinds, slots, totalStats };
}
