/**
 * De Live Client Data API: de spelclient zelf, tijdens een lopende game.
 *
 * Dit is een andere server dan de LCU. Hij draait alleen als er een game bezig
 * is, luistert op een vaste poort, en vraagt geen authenticatie -- wel een
 * self-signed certificaat.
 *
 * Waarom hij ertoe doet: dit is de enige plek waar de **skill-volgorde** te zien
 * is. De matchhistorie legt niet vast in welke volgorde iemand zijn abilities
 * levelt, dus als we dat willen weten moeten we tijdens de game meekijken.
 */
import { Agent, fetch as undiciFetch } from "undici";

const PORT = 2999;
const BASE = `https://127.0.0.1:${PORT}/liveclientdata`;

export interface LiveAbility {
  abilityLevel: number;
  displayName: string;
  id: string;
}

export interface LiveActivePlayer {
  summonerName: string;
  level: number;
  currentGold: number;
  abilities: Record<string, LiveAbility>;
  championStats: Record<string, number>;
}

export interface LivePlayer {
  championName: string;
  summonerName: string;
  riotId?: string;
  team: string;
  position?: string;
  level: number;
  isDead: boolean;
  respawnTimer: number;
  items: Array<{ itemID: number; displayName: string; slot: number; count: number }>;
  summonerSpells: Record<string, { displayName: string; rawDescription?: string }>;
  scores: { kills: number; deaths: number; assists: number; creepScore: number; wardScore: number };
  /** Alleen gevuld voor jezelf; van anderen geeft de client dit niet prijs. */
  runes?: Record<string, unknown>;
}

export interface LiveGameData {
  gameData: { gameMode: string; gameTime: number; mapNumber: number; mapName: string };
  activePlayer: LiveActivePlayer;
  allPlayers: LivePlayer[];
  events: { Events: Array<Record<string, unknown>> };
}

export class LiveClient {
  private readonly agent = new Agent({ connect: { rejectUnauthorized: false } });

  /** Null als er geen game draait; dat is de normale toestand, geen fout. */
  async get<T>(path: string): Promise<T | null> {
    try {
      const res = await undiciFetch(`${BASE}${path}`, { dispatcher: this.agent });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  allGameData(): Promise<LiveGameData | null> {
    return this.get<LiveGameData>("/allgamedata");
  }

  activePlayer(): Promise<LiveActivePlayer | null> {
    return this.get<LiveActivePlayer>("/activeplayer");
  }

  playerList(): Promise<LivePlayer[] | null> {
    return this.get<LivePlayer[]>("/playerlist");
  }

  /** Draait er een game? */
  async isInGame(): Promise<boolean> {
    return (await this.get<unknown>("/gamestats")) !== null;
  }
}

/**
 * De volgorde waarin abilities gelevel worden.
 *
 * De API geeft alleen de *huidige* levels, niet de historie. Door tijdens de
 * game te blijven kijken en elke verhoging te noteren, bouwen we de volgorde
 * alsnog op: Q, W, Q, E, Q, R, ...
 */
export class SkillOrderRecorder {
  private readonly levels = new Map<string, number>();
  private readonly order: string[] = [];

  /** Verwerkt een momentopname en geeft terug welke skills erbij kwamen. */
  observe(abilities: Record<string, LiveAbility> | undefined): string[] {
    if (!abilities) return [];
    const added: string[] = [];
    for (const key of ["Q", "W", "E", "R"]) {
      const level = abilities[key]?.abilityLevel ?? 0;
      const known = this.levels.get(key) ?? 0;
      // Bij een sprong van meer dan een level (we misten een meting) noteren we
      // ze alle, want de volgorde onderling is dan alsnog de beste schatting.
      for (let i = known; i < level; i++) {
        this.order.push(key);
        added.push(key);
      }
      if (level > known) this.levels.set(key, level);
    }
    return added;
  }

  get skillOrder(): string[] {
    return [...this.order];
  }

  /** Compacte weergave: "Q W Q E Q R" -> de eerste levels die ertoe doen. */
  summary(count = 6): string {
    return this.order.slice(0, count).join(" ");
  }
}
