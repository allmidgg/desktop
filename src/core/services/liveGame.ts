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
import type { LiveGamePlayer, LiveGameSnapshot, Position } from "../../shared/types";

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

  constructor(private readonly zoekChampion: ChampionZoeker) {}

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
    if (!zelfdeGame) this.recorder.reset();
    this.laatsteTijd = gameTime;
  }

  reset(): void {
    this.recorder.reset();
    this.laatsteTijd = null;
  }

  get skillOrder(): string[] {
    return this.recorder.skillOrder;
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
    const spelers = (data.allPlayers ?? []).map((p) => this.speler(p, jij));

    let note: string | null = null;
    if (!isClassic) {
      note = `This is ${mode || "another mode"}, not Classic. Shown for convenience; nothing here is recorded.`;
    } else if (spelers.some((s) => s.championId === null)) {
      const onbekend = spelers.filter((s) => s.championId === null).map((s) => s.championName);
      note = `No stats for ${onbekend.join(", ")} -- the client reports a name we do not recognise.`;
    }

    return {
      mode,
      mapNumber,
      isClassic,
      gameTimeSeconds: gameTime,
      players: spelers,
      skillOrder: this.recorder.skillOrder,
      note,
    };
  }

  private speler(p: LivePlayer, jouwGenormaliseerdeNaam: string | null): LiveGamePlayer {
    const naam = p.riotId || p.summonerName || "";
    return {
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
      items: itemsVan(p),
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
