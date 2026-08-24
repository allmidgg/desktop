/**
 * What the running game adds up to.
 *
 * Everything in here is arithmetic on things both teams can already see: gold
 * the scoreboard shows, minions you watched die, a dragon whose death put a
 * banner on all ten screens. That line matters. Riot's third-party policy
 * objects to "exposing information that's intentionally obfuscated (cooldowns or
 * timers)" and to "altering your field of intelligence (zoomhacks or global ult
 * alerts)", so enemy ability cooldowns and ward positions are deliberately absent
 * from this file -- and the client does not hand them over either.
 */
import type { LiveEvent } from "../lcu/liveClient";
import type { LiveGamePlayer, Position } from "../../shared/types";

/**
 * How long an objective stays down.
 *
 * These are Season 3 values and they are an assumption until somebody watches a
 * Classic game with a stopwatch: dragon six minutes, baron seven, inhibitor
 * five. They live here as named constants precisely because they are the part
 * most likely to be wrong.
 */
export const HERSTELTIJD: Record<string, number> = {
  dragon: 6 * 60,
  baron: 7 * 60,
  inhibitor: 5 * 60,
};

export interface TeamTotaal {
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  wards: number;
  /**
   * Gold value of everything the five of them are carrying.
   *
   * This stands in for a gold lead, which the running game does not give: the
   * live API reports gold only for the player at the keyboard, never for the
   * other nine. Item value is what is left, and it is presumably why Blitz ships
   * an "item value difference" overlay rather than a gold one.
   *
   * It is not the same number. Gold in the pocket and gold already spent both
   * count towards a lead; only the spent half shows up here.
   */
  itemWaarde: number;
}

export interface ObjectiefTimer {
  soort: "dragon" | "baron" | "inhibitor";
  /** What it was, when the game says so: "Air", "Barracks_T1_C1". */
  detail: string | null;
  /** Game time it died. */
  gevallenOp: number;
  /** Game time it comes back. */
  terugOp: number;
  /** Seconds from now, negative once it is already back. */
  overSeconden: number;
}

/** Everything derived, in one place, so the screen only has to render. */
export interface LiveInzichten {
  order: TeamTotaal;
  chaos: TeamTotaal;
  /** Positive when blue side carries more item gold. */
  itemVerschil: number;
  objectieven: ObjectiefTimer[];
  /** Per player key, the share of their team's kills they were part of. */
  killDeelname: Map<string, number>;
  /** Per player key, the gold sitting in their inventory. */
  itemWaarde: Map<string, number>;
}

const leegTotaal = (): TeamTotaal => ({ kills: 0, deaths: 0, assists: 0, cs: 0, wards: 0, itemWaarde: 0 });

/** The key a player is tracked under, matching what the watcher uses. */
export const spelerSleutel = (p: { riotId: string | null; team: string; championName: string }): string =>
  p.riotId || `${p.team}|${p.championName}`;

/**
 * Turn one poll into the numbers a scoreboard wants.
 *
 * `prijsVan` comes from the item catalogue; an unknown item counts as zero
 * rather than as a guess, the same rule the rune scoring uses.
 */
export function berekenInzichten(
  spelers: LiveGamePlayer[],
  events: LiveEvent[],
  gameTime: number,
  prijsVan: (itemId: number) => number,
): LiveInzichten {
  const order = leegTotaal();
  const chaos = leegTotaal();
  const itemWaarde = new Map<string, number>();

  for (const p of spelers) {
    const doel = p.team === "CHAOS" ? chaos : order;
    doel.kills += p.kills;
    doel.deaths += p.deaths;
    doel.assists += p.assists;
    doel.cs += p.cs;
    doel.wards += p.wards;

    const waarde = p.items.reduce((som, id) => som + prijsVan(id), 0);
    itemWaarde.set(spelerSleutel(p), waarde);
    doel.itemWaarde += waarde;
  }

  // Kill participation needs the team total, so it waits for the loop above.
  const killDeelname = new Map<string, number>();
  for (const p of spelers) {
    const totaal = p.team === "CHAOS" ? chaos.kills : order.kills;
    // Nobody has participated in nothing. Zero kills means no share, not 100%.
    killDeelname.set(spelerSleutel(p), totaal > 0 ? (p.kills + p.assists) / totaal : 0);
  }

  return {
    order,
    chaos,
    itemVerschil: order.itemWaarde - chaos.itemWaarde,
    objectieven: objectiefTimers(events, gameTime),
    killDeelname,
    itemWaarde,
  };
}

/**
 * Respawn timers for objectives that have actually been seen to die.
 *
 * Only from events, never from a schedule. A timer for something you did not
 * watch fall would be a guess dressed as a fact, and for the enemy jungle it
 * would be exactly the kind of hidden information the policy is about. Jungle
 * camps are absent for that reason: the client reports no event when one dies.
 */
export function objectiefTimers(events: LiveEvent[], gameTime: number): ObjectiefTimer[] {
  const laatste = new Map<string, ObjectiefTimer>();

  for (const e of events) {
    let soort: ObjectiefTimer["soort"] | null = null;
    let detail: string | null = null;
    if (e.EventName === "DragonKill") {
      soort = "dragon";
      detail = e.DragonType ?? null;
    } else if (e.EventName === "BaronKill") {
      soort = "baron";
    } else if (e.EventName === "InhibKilled") {
      soort = "inhibitor";
      detail = e.InhibKilled ?? null;
    }
    if (!soort) continue;

    const gevallenOp = e.EventTime ?? 0;
    const terugOp = gevallenOp + (HERSTELTIJD[soort] ?? 0);
    // One entry per inhibitor, but only one dragon and one baron: those two are
    // a single spawn, so a newer kill replaces the older timer.
    const sleutel = soort === "inhibitor" ? `inhibitor:${detail ?? ""}` : soort;
    const bestaand = laatste.get(sleutel);
    if (!bestaand || gevallenOp >= bestaand.gevallenOp) {
      laatste.set(sleutel, { soort, detail, gevallenOp, terugOp, overSeconden: terugOp - gameTime });
    }
  }

  return [...laatste.values()]
    .map((o) => ({ ...o, overSeconden: o.terugOp - gameTime }))
    .filter((o) => o.overSeconden > -30)
    .sort((a, b) => a.overSeconden - b.overSeconden);
}

/**
 * Whether the trinket slot is empty.
 *
 * Slot 6 is the trinket. This is your own inventory, which the game already
 * draws for you -- a reminder that it is unused is a nudge, not information you
 * were not given.
 */
export const trinketLeeg = (rauweItems: Array<{ slot: number; itemID: number }>): boolean =>
  !rauweItems.some((i) => i.slot === 6 && i.itemID > 0);

/** Lane order for anything that lists five positions. */
export const LANE_VOLGORDE: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];
