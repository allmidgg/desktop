/**
 * Turns what the running game reports into something the app can show.
 *
 * The Live Client Data API is a separate server from the LCU: it only exists
 * while a game is in progress, and it speaks in display names rather than ids.
 * "Nasus", "Ionian Boots of Lucidity", "UTILITY". Everything else in this
 * codebase works in Jade ids, so this is where the two meet.
 *
 * It is also the only place the skill order can come from. A finished match
 * records which levels a champion ended on, never the order they were taken in,
 * so the only way to learn that Nasus goes Q-E-Q-W is to watch it happen.
 */
import type { LiveGameData, LivePlayer } from "../lcu/liveClient";
import { SkillOrderRecorder } from "../lcu/liveClient";
import { berekenInzichten, spelerSleutel, trinketLeeg } from "./liveInzichten";
import type { BuildStep, LiveGamePlayer, LiveGameSnapshot, Position } from "../../shared/types";

/**
 * Names come back in more shapes than you would like: "Nasus", "Jade_Nasus",
 * "Nunu &amp; Willump", "Cho'Gath". Strip it down to letters and digits so all
 * of those land on the same key.
 */
export const normaliseerNaam = (naam: string): string =>
  naam
    .toLowerCase()
    .replace(/^jade[_-]?/, "")
    .replace(/&amp;/g, "")
    .replace(/[^a-z0-9]/g, "");

/**
 * The running game uses Riot's own role names, which do not match ours in one
 * place: support is "UTILITY" there. Getting this wrong would silently look up
 * the wrong lane's numbers, which is worse than showing none.
 */
const POSITIES: Record<string, Position> = {
  TOP: "TOP",
  JUNGLE: "JUNGLE",
  MIDDLE: "MIDDLE",
  MID: "MIDDLE",
  BOTTOM: "BOTTOM",
  BOT: "BOTTOM",
  UTILITY: "SUPPORT",
  SUPPORT: "SUPPORT",
};

export const teamVan = (team: string): LiveGamePlayer["team"] =>
  team === "ORDER" || team === "CHAOS" ? team : "UNKNOWN";

/**
 * What is kept from a finished game.
 *
 * No Riot IDs, no summoner names, no puuids. The build order of a champion in a
 * lane is the whole point; who was holding the mouse is not, and the same rule
 * already applies everywhere else here.
 */
export interface BuildOrderRecord {
  recordedAt: number;
  gameMode: string;
  mapNumber: number;
  gameLengthSeconds: number;
  championId: number | null;
  championName: string;
  position: Position | null;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  build: BuildStep[];
  /** Only ever present for the player who was at the keyboard. */
  skillOrder?: string[];
}

export interface ChampionZoeker {
  /** Jade champion id for a display name or alias, or null. */
  (naam: string): number | null;
}

/**
 * Reads one game and keeps what has to be remembered across polls.
 *
 * Only the skill order needs remembering: everything else the client reports is
 * already the current state.
 */
export class LiveGameWatcher {
  private readonly recorder = new SkillOrderRecorder();
  /** Game time at the previous poll, used to notice a new game. */
  private laatsteTijd: number | null = null;
  /**
   * Per player, every item seen appearing and when.
   *
   * Keyed on Riot ID because that is the only field that stays put: champion
   * names repeat across teams in some modes and the array order is not promised.
   */
  private readonly builds = new Map<string, BuildStep[]>();
  /**
   * How many of each item a player held at the previous poll.
   *
   * Counts rather than presence, because two Long Swords are two purchases and
   * a set would record one. That matters exactly where build orders are most
   * useful -- the early components.
   */
  private readonly vorigeInventaris = new Map<string, Map<number, number>>();
  /** The last thing we saw, so a finished game can still be written down. */
  private laatsteSnapshot: LiveGameSnapshot | null = null;

  constructor(
    private readonly zoekChampion: ChampionZoeker,
    /** Item prices, for the value a player is carrying. Unknown counts as zero. */
    private readonly prijsVan: (itemId: number) => number = () => 0,
  ) {}

  /**
   * A new game means a new recording.
   *
   * Detected on game time running backwards. The API has no game id, and two
   * games in a row would otherwise share one skill order -- the second appended
   * to the first, which reads as a champion levelling Q eight times.
   */
  private misschienNieuweGame(gameTime: number): void {
    // Within one game the clock only moves forward. The one second of slack
    // absorbs the client reporting a value that rounds down between polls.
    const zelfdeGame = this.laatsteTijd !== null && gameTime + 1 >= this.laatsteTijd;
    if (!zelfdeGame) {
      this.recorder.reset();
      this.builds.clear();
      this.vorigeInventaris.clear();
    }
    this.laatsteTijd = gameTime;
  }

  reset(): void {
    this.recorder.reset();
    this.builds.clear();
    this.vorigeInventaris.clear();
    this.laatsteTijd = null;
    this.laatsteSnapshot = null;
  }

  /**
   * Note anything that was not in the inventory a moment ago.
   *
   * Only appearances are recorded, never disappearances, and that is deliberate.
   * When three components turn into one finished item the components vanish, but
   * nobody sold anything -- the purchase sequence is exactly the list of things
   * that showed up. What this cannot separate is a real sale or an undo in the
   * shop, so a rare extra entry is possible. Better than dropping the genuine
   * component buys, which are most of what a build order actually is.
   */
  private noteerAankopen(sleutel: string, items: number[], gameTime: number): BuildStep[] {
    const nu = new Map<number, number>();
    for (const id of items) nu.set(id, (nu.get(id) ?? 0) + 1);

    // No previous reading means the first sighting, and then everything in the
    // inventory counts as bought right now. Joining a game already in progress
    // therefore starts the record mid-build, which is why the timestamps say
    // more than the count does.
    const vorige = this.vorigeInventaris.get(sleutel) ?? new Map<number, number>();
    const lijst = this.builds.get(sleutel) ?? [];

    // Walk items in slot order so several purchases between two polls keep the
    // order the client shows them in.
    const gezien = new Map<number, number>();
    for (const id of items) {
      const nummer = (gezien.get(id) ?? 0) + 1;
      gezien.set(id, nummer);
      if (nummer > (vorige.get(id) ?? 0)) lijst.push({ itemId: id, at: gameTime });
    }

    this.vorigeInventaris.set(sleutel, nu);
    this.builds.set(sleutel, lijst);
    return lijst;
  }

  get skillOrder(): string[] {
    return this.recorder.skillOrder;
  }

  /**
   * The finished game, ready to keep.
   *
   * Returns nothing for anything that is not a real Classic game long enough to
   * have a build in it. Two minutes filters out remakes and the odd reconnect,
   * where the first-sighting rule would otherwise record a full inventory as if
   * it were bought in one instant.
   */
  oogst(minimaalSeconden = 120): BuildOrderRecord[] {
    const laatste = this.laatsteSnapshot;
    if (!laatste || !laatste.isClassic) return [];
    if (laatste.gameTimeSeconds < minimaalSeconden) return [];

    const nu = Date.now();
    return laatste.players
      .filter((p) => p.build.length > 0)
      .map((p) => ({
        recordedAt: nu,
        gameMode: laatste.mode,
        mapNumber: laatste.mapNumber,
        gameLengthSeconds: laatste.gameTimeSeconds,
        championId: p.championId,
        championName: p.championName,
        position: p.position,
        level: p.level,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        cs: p.cs,
        build: p.build,
        ...(p.isYou ? { skillOrder: laatste.skillOrder } : {}),
      }));
  }

  verwerk(data: LiveGameData, jouwNaam: string | null, mapId: number): LiveGameSnapshot {
    const gameTime = Math.max(0, Math.round(data.gameData?.gameTime ?? 0));
    this.misschienNieuweGame(gameTime);
    this.recorder.observe(data.activePlayer?.abilities);

    const mapNumber = data.gameData?.mapNumber ?? 0;
    const mode = data.gameData?.gameMode ?? "";
    // Two independent signals, and we want both to agree. The mode string is the
    // one Riot documents; the map number is the one that cannot be renamed.
    const isClassic = mapNumber === mapId || mode.toUpperCase() === "JADE";

    const jij = jouwNaam ? normaliseerNaam(jouwNaam) : null;
    const spelers = (data.allPlayers ?? []).map((p) => this.speler(p, jij, gameTime));

    let note: string | null = null;
    if (!isClassic) {
      note = `This is ${mode || "another mode"}, not Classic. Shown for convenience; nothing here is recorded.`;
    } else if (spelers.some((s) => s.championId === null)) {
      const onbekend = spelers.filter((s) => s.championId === null).map((s) => s.championName);
      note = `No stats for ${onbekend.join(", ")} -- the client reports a name we do not recognise.`;
    }

    // Derived numbers need every player read first, so they land here rather
    // than inside the per-player mapping.
    const inzichten = berekenInzichten(spelers, data.events?.Events ?? [], gameTime, this.prijsVan);
    for (const p of spelers) {
      const sleutel = spelerSleutel(p);
      p.itemWaarde = inzichten.itemWaarde.get(sleutel) ?? 0;
      p.killDeelname = inzichten.killDeelname.get(sleutel) ?? 0;
    }

    this.laatsteSnapshot = {
      mode,
      mapNumber,
      isClassic,
      gameTimeSeconds: gameTime,
      players: spelers,
      skillOrder: this.recorder.skillOrder,
      note,
      inzichten: {
        order: inzichten.order,
        chaos: inzichten.chaos,
        itemVerschil: inzichten.itemVerschil,
        objectieven: inzichten.objectieven,
      },
    };
    return this.laatsteSnapshot;
  }

  private speler(p: LivePlayer, jouwGenormaliseerdeNaam: string | null, gameTime: number): LiveGamePlayer {
    const naam = p.riotId || p.summonerName || "";
    const items = itemsVan(p);
    const sleutel = naam || `${p.team}|${p.championName}`;
    return {
      build: this.noteerAankopen(sleutel, items, gameTime),
      championId: this.zoekChampion(p.championName ?? ""),
      championName: p.championName ?? "",
      riotId: naam || null,
      team: teamVan(p.team ?? ""),
      position: POSITIES[(p.position ?? "").toUpperCase()] ?? null,
      level: p.level ?? 0,
      isDead: Boolean(p.isDead),
      respawnIn: Math.max(0, Math.round(p.respawnTimer ?? 0)),
      kills: p.scores?.kills ?? 0,
      deaths: p.scores?.deaths ?? 0,
      assists: p.scores?.assists ?? 0,
      cs: p.scores?.creepScore ?? 0,
      wards: p.scores?.wardScore ?? 0,
      items,
      // Filled in a moment, once every player has been read: both of these need
      // the whole team before they mean anything.
      itemWaarde: 0,
      killDeelname: 0,
      trinketLeeg: trinketLeeg(p.items ?? []),
      isYou: jouwGenormaliseerdeNaam !== null && normaliseerNaam(naam) === jouwGenormaliseerdeNaam,
    };
  }
}

/**
 * The six build slots, as the ids the client itself reports.
 *
 * Left as Jade ids on purpose: everything the renderer shows looks items up by
 * jadeId, the same as recent games do, so converting here would only mean
 * converting back one layer up.
 *
 * Slot 6 is the trinket and is dropped, the same rule the match counting uses,
 * so a live build and a finished one mean the same thing.
 */
export function itemsVan(p: LivePlayer): number[] {
  return (p.items ?? [])
    .filter((i) => i.slot < 6 && i.itemID > 0)
    .sort((a, b) => a.slot - b.slot)
    .map((i) => i.itemID);
}

/** Builds the name lookup from the champion list the app already holds. */
export function championZoeker(champions: Array<{ jadeId: number; name: string; alias: string }>): ChampionZoeker {
  const perNaam = new Map<string, number>();
  for (const c of champions) {
    perNaam.set(normaliseerNaam(c.name), c.jadeId);
    perNaam.set(normaliseerNaam(c.alias), c.jadeId);
  }
  return (naam: string) => perNaam.get(normaliseerNaam(naam)) ?? null;
}
