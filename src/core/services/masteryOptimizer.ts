/**
 * Bouwt een mastery-pagina van 30 punten voor een champion.
 *
 * Anders dan bij runes levert de client hier geen machineleesbare stats: een
 * mastery beschrijft zichzelf met een zin als "+1% Cooldown Reduction per rank".
 * We herkennen daarom trefwoorden in die tekst en wegen die per rol. Dat is
 * grover dan de rune-optimizer, maar het is eerlijk grof -- we doen niet alsof
 * we een precieze waarde kennen die er niet is.
 *
 * De verdeling volgt de klassieke 21/9: net genoeg punten per rij om de
 * volgende te openen, en wat overblijft in de diepste rij die je haalt.
 */
import type { JadeChampion } from "../jade/catalog";
import type { MasteryCatalog, MasteryPoints, MasteryTree, MasteryTreeType } from "../jade/masteries";
import { MASTERY_POINTS_TOTAL } from "../jade/masteries";

/** Klassieke verdeling: 21 punten in de hoofdboom, 9 in de tweede. */
const PRIMARY_POINTS = 21;

/** Welke bomen een rol gebruikt, in volgorde van belang. */
const TREES_BY_ROLE: Record<string, [MasteryTreeType, MasteryTreeType]> = {
  marksman: ["offense", "defense"],
  mage: ["offense", "utility"],
  assassin: ["offense", "defense"],
  fighter: ["offense", "defense"],
  tank: ["defense", "utility"],
  support: ["utility", "defense"],
  default: ["offense", "defense"],
};

/**
 * Trefwoorden uit de beschrijvingen, met hun gewicht per rol. Een mastery scoort
 * de som van alles wat erin voorkomt; wat nergens op matcht scoort nul en wordt
 * alleen gepakt als er niets beters in die rij staat.
 */
const KEYWORD_WEIGHTS: Record<string, Record<string, number>> = {
  marksman: {
    "attack damage": 10, "attack speed": 8, "critical": 8, "armor penetration": 9, lethality: 9,
    "damage dealt": 8, "life steal": 5, "movement speed": 4, health: 3, armor: 3, "magic resist": 2,
    "cooldown reduction": 4, minions: 3, "damage taken": 3,
  },
  mage: {
    "ability power": 10, "magic penetration": 10, "cooldown reduction": 9, "damage dealt": 8,
    mana: 5, "mana regen": 5, "spell vamp": 4, "movement speed": 4, health: 3, armor: 3,
    "magic resist": 3, "damage taken": 3,
  },
  assassin: {
    "attack damage": 8, "ability power": 8, "magic penetration": 9, "armor penetration": 9,
    lethality: 9, "damage dealt": 9, "movement speed": 6, "cooldown reduction": 6,
    health: 3, armor: 3, "damage taken": 3,
  },
  fighter: {
    "attack damage": 9, "attack speed": 6, "armor penetration": 7, lethality: 7, "damage dealt": 7,
    "life steal": 6, health: 6, armor: 6, "magic resist": 5, "damage taken": 6,
    "cooldown reduction": 5,
  },
  tank: {
    armor: 10, "magic resist": 9, health: 9, "health regen": 6, "damage taken": 9,
    "cooldown reduction": 5, "movement speed": 4, "crowd control": 6, "summoner spell": 3,
  },
  support: {
    "mana regen": 8, "cooldown reduction": 8, "movement speed": 7, gold: 8, ward: 8,
    "magic resist": 6, armor: 6, health: 5, "health regen": 5, "summoner spell": 5,
    "damage taken": 5, experience: 4,
  },
};

export interface MasteryPlan {
  championId: number | null;
  championName: string | null;
  role: string;
  points: MasteryPoints;
  perTree: Record<MasteryTreeType, number>;
  /** Leeg als de pagina geldig is; anders wat er mis is. */
  errors: string[];
}

function resolveRole(champion: JadeChampion | null, override?: string): string {
  if (override && TREES_BY_ROLE[override]) return override;
  for (const role of champion?.roles ?? []) {
    if (TREES_BY_ROLE[role]) return role;
  }
  return "default";
}

function scoreDescription(description: string, weights: Record<string, number>): number {
  const text = description.toLowerCase();
  let score = 0;
  for (const [keyword, weight] of Object.entries(weights)) {
    if (text.includes(keyword)) score += weight;
  }
  return score;
}

/**
 * Verdeelt tot `budget` extra punten over een boom en geeft terug hoeveel er
 * daadwerkelijk bij kwamen.
 *
 * Per rij zetten we precies zoveel punten als nodig is om de volgende rij te
 * openen -- zo zijn deze pagina's altijd gebouwd. In de laatste rij die we
 * bereiken gaat alles wat overblijft.
 *
 * `points` kan al gevuld zijn door een eerdere ronde; we tellen dat mee en
 * schrijven nooit over een maxRank heen.
 */
function allocateTree(
  tree: MasteryTree,
  budget: number,
  weights: Record<string, number>,
  points: MasteryPoints,
  catalog: MasteryCatalog,
): number {
  const inTree = (): number => {
    let total = 0;
    for (const row of tree.rows) {
      for (const mastery of row.masteries) {
        if (mastery) total += points.get(mastery.id) ?? 0;
      }
    }
    return total;
  };

  let spent = inTree();
  let added = 0;

  for (let index = 0; index < tree.rows.length; index++) {
    const row = tree.rows[index];
    if (!row) break;
    if (row.pointsRequired > spent) break; // rij niet geopend: dieper gaan heeft geen zin
    const remaining = budget - added;
    if (remaining <= 0) break;

    const next = tree.rows[index + 1];
    // Alleen masteries waarvan de vereiste vol staat tellen mee: de client
    // weigert de rest zonder iets te zeggen.
    const usable = row.masteries.filter(
      (m): m is NonNullable<typeof m> => m !== null && catalog.isUnlocked(m, points),
    );
    const free = usable.reduce((sum, m) => sum + (m.maxRank - (points.get(m.id) ?? 0)), 0);
    const needed = next ? Math.max(0, next.pointsRequired - spent) : remaining;
    let toSpend = Math.min(remaining, next ? needed : remaining, free);
    if (toSpend <= 0) continue;

    const ranked = usable
      .map((mastery) => ({ mastery, score: scoreDescription(mastery.description, weights) }))
      .sort((a, b) => b.score - a.score || b.mastery.maxRank - a.mastery.maxRank);

    for (const { mastery } of ranked) {
      if (toSpend <= 0) break;
      const already = points.get(mastery.id) ?? 0;
      const take = Math.min(mastery.maxRank - already, toSpend);
      if (take <= 0) continue;
      points.set(mastery.id, already + take);
      toSpend -= take;
      spent += take;
      added += take;
    }
  }
  return added;
}

/**
 * Verdeelt de laatste punten over elke plek die op dat moment legaal is: de rij
 * moet open zijn, de vereiste mastery vol, en de mastery zelf nog niet gemaxt.
 */
function fillRemaining(catalog: MasteryCatalog, points: MasteryPoints, budget: number): number {
  let added = 0;
  let progress = true;

  while (added < budget && progress) {
    progress = false;
    for (const tree of catalog.trees) {
      const inTree = tree.rows
        .flatMap((row) => row.masteries)
        .reduce((sum, m) => sum + (m ? (points.get(m.id) ?? 0) : 0), 0);

      for (const row of tree.rows) {
        if (row.pointsRequired > inTree) continue;
        for (const mastery of row.masteries) {
          if (!mastery || added >= budget) continue;
          const already = points.get(mastery.id) ?? 0;
          if (already >= mastery.maxRank) continue;
          if (!catalog.isUnlocked(mastery, points)) continue;
          points.set(mastery.id, already + 1);
          added++;
          progress = true;
          break;
        }
        if (added >= budget) break;
      }
      if (added >= budget) break;
    }
  }
  return added;
}

export function planMasteries(
  catalog: MasteryCatalog,
  champion: JadeChampion | null,
  roleOverride?: string,
): MasteryPlan {
  const role = resolveRole(champion, roleOverride);
  const [primaryType, secondaryType] = TREES_BY_ROLE[role] ?? TREES_BY_ROLE.default!;
  const weights = KEYWORD_WEIGHTS[role] ?? KEYWORD_WEIGHTS.marksman!;

  const points: MasteryPoints = new Map();
  const primary = catalog.tree(primaryType);
  const secondary = catalog.tree(secondaryType);

  let spent = primary ? allocateTree(primary, PRIMARY_POINTS, weights, points, catalog) : 0;
  if (secondary) spent += allocateTree(secondary, MASTERY_POINTS_TOTAL - spent, weights, points, catalog);

  // Blijft er iets liggen omdat een boom vol zat, dan gaat de rest naar de ander.
  if (spent < MASTERY_POINTS_TOTAL && primary) {
    spent += allocateTree(primary, MASTERY_POINTS_TOTAL - spent, weights, points, catalog);
  }

  // Laatste vangnet: elk punt dat nog over is gaat naar de eerste plek waar het
  // legaal past. Zonder dit levert een geblokkeerde rij een pagina van 29 op, en
  // dan staat er in de client "1/30 Points Available".
  if (spent < MASTERY_POINTS_TOTAL) {
    spent += fillRemaining(catalog, points, MASTERY_POINTS_TOTAL - spent);
  }

  return {
    championId: champion?.jadeId ?? null,
    championName: champion?.name ?? null,
    role,
    points,
    perTree: catalog.pointsPerTree(points),
    errors: catalog.validate(points),
  };
}
