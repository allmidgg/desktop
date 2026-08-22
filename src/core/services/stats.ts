/**
 * Statistiek over de verzamelde Classic-matches.
 *
 * Twee dingen maken dit lastiger dan "tel wins en deel door games":
 *
 * 1. Bij weinig data zegt een winrate niets. 3 van de 4 gewonnen is geen 75%.
 *    Daarom rapporteren we naast het rauwe percentage een naar 50% getrokken
 *    schatting (Bayesiaans gladgestreken), en tonen we in de UI het aantal games
 *    erbij zodat je zelf kunt zien hoe hard een getal is.
 *
 * 2. Een matchup is pas een matchup als beide champions in dezelfde lane staan.
 *    Een Ashe die tegen een Nasus in de toplane "wint" zegt niets over Ashe.
 */
import type { Position, StoredMatch } from "./matchStore";

/** Hoe sterk we naar 50% trekken. 20 komt neer op: bij 20 games telt de data half mee. */
const PRIOR_STRENGTH = 20;

/** Onder dit aantal games tonen we een matchup niet als advies. */
export const MIN_MATCHUP_GAMES = 8;

export interface WinRecord {
  games: number;
  wins: number;
  /** Ruwe winrate, 0-1. */
  winrate: number;
  /** Naar 50% getrokken winrate; bruikbaar om op te sorteren. */
  adjusted: number;
}

export interface ChampionStat extends WinRecord {
  championId: number;
  position: Position;
  /** Aandeel van alle games in deze positie waarin deze champion voorkomt. */
  pickRate: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
}

export interface MatchupStat extends WinRecord {
  championId: number;
  opponentId: number;
  position: Position;
}

export interface ItemStat extends WinRecord {
  itemId: number;
  /** Aandeel van de games van deze champion waarin het item in de eindbuild stond. */
  pickRate: number;
}

export interface SpellPairStat extends WinRecord {
  /** De twee summoner spells, altijd in dezelfde volgorde zodat ze te tellen zijn. */
  spells: [number, number];
  pickRate: number;
}

export interface PositionShare {
  position: Position;
  games: number;
  share: number;
}

function record(games: number, wins: number): WinRecord {
  return {
    games,
    wins,
    winrate: games ? wins / games : 0,
    adjusted: (wins + PRIOR_STRENGTH / 2) / (games + PRIOR_STRENGTH),
  };
}

interface Tally {
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
}

const emptyTally = (): Tally => ({ games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 });

export class JadeStats {
  /** "positie|champion" -> tally */
  private readonly champions = new Map<string, Tally>();
  /** "positie|champion|tegenstander" -> tally */
  private readonly matchups = new Map<string, Tally>();
  /** "positie|champion|item" -> tally */
  private readonly items = new Map<string, Tally>();
  /** "positie|champion|spellA-spellB" -> tally */
  private readonly spells = new Map<string, Tally>();
  /** positie -> aantal spelersloten */
  private readonly positionTotals = new Map<Position, number>();
  private matchCount = 0;

  static from(matches: StoredMatch[]): JadeStats {
    const stats = new JadeStats();
    for (const match of matches) stats.ingest(match);
    return stats;
  }

  get totalMatches(): number {
    return this.matchCount;
  }

  ingest(match: StoredMatch): void {
    this.matchCount++;
    for (const player of match.players) {
      if (player.position === "UNKNOWN") continue;

      const key = `${player.position}|${player.championId}`;
      const tally = this.champions.get(key) ?? emptyTally();
      tally.games++;
      if (player.win) tally.wins++;
      tally.kills += player.kills;
      tally.deaths += player.deaths;
      tally.assists += player.assists;
      this.champions.set(key, tally);

      this.positionTotals.set(player.position, (this.positionTotals.get(player.position) ?? 0) + 1);

      // Items uit de eindbuild. Slot 7 is het trinket-slot en zegt niets over de
      // build, en een item dubbel in de inventaris telt maar één keer mee.
      const built = new Set(player.items.slice(0, 6).filter((id) => id > 0));
      for (const itemId of built) {
        const itemKey = `${player.position}|${player.championId}|${itemId}`;
        const itemTally = this.items.get(itemKey) ?? emptyTally();
        itemTally.games++;
        if (player.win) itemTally.wins++;
        this.items.set(itemKey, itemTally);
      }

      // Summoner spells. Flash+Ignite en Ignite+Flash zijn dezelfde keuze, dus we
      // sorteren het paar voordat we het tellen.
      const [spellA, spellB] = [...player.spells].sort((a, b) => a - b);
      if (spellA && spellB) {
        const spellKey = `${player.position}|${player.championId}|${spellA}-${spellB}`;
        const spellTally = this.spells.get(spellKey) ?? emptyTally();
        spellTally.games++;
        if (player.win) spellTally.wins++;
        this.spells.set(spellKey, spellTally);
      }

      // De directe tegenstander is degene op dezelfde positie in het andere team.
      const opponent = match.players.find(
        (other) => other.teamId !== player.teamId && other.position === player.position,
      );
      if (!opponent) continue;
      const matchupKey = `${player.position}|${player.championId}|${opponent.championId}`;
      const matchupTally = this.matchups.get(matchupKey) ?? emptyTally();
      matchupTally.games++;
      if (player.win) matchupTally.wins++;
      this.matchups.set(matchupKey, matchupTally);
    }
  }

  championStat(championId: number, position: Position): ChampionStat | null {
    const tally = this.champions.get(`${position}|${championId}`);
    if (!tally) return null;
    const positionTotal = this.positionTotals.get(position) ?? 0;
    return {
      championId,
      position,
      ...record(tally.games, tally.wins),
      pickRate: positionTotal ? tally.games / positionTotal : 0,
      avgKills: tally.games ? tally.kills / tally.games : 0,
      avgDeaths: tally.games ? tally.deaths / tally.games : 0,
      avgAssists: tally.games ? tally.assists / tally.games : 0,
    };
  }

  /** De beste champions in een positie, gesorteerd op gladgestreken winrate. */
  tierList(position: Position, minGames = MIN_MATCHUP_GAMES): ChampionStat[] {
    const result: ChampionStat[] = [];
    for (const [key, tally] of this.champions) {
      const [pos, champ] = key.split("|");
      if (pos !== position || tally.games < minGames) continue;
      const stat = this.championStat(Number(champ), position);
      if (stat) result.push(stat);
    }
    return result.sort((a, b) => b.adjusted - a.adjusted);
  }

  matchup(championId: number, opponentId: number, position: Position): MatchupStat | null {
    const tally = this.matchups.get(`${position}|${championId}|${opponentId}`);
    if (!tally) return null;
    return { championId, opponentId, position, ...record(tally.games, tally.wins) };
  }

  /**
   * Champions die het goed doen tegen `opponentId` in een positie.
   * Handig in champion select zodra de tegenstander gepickt heeft.
   */
  countersFor(opponentId: number, position: Position, minGames = MIN_MATCHUP_GAMES): MatchupStat[] {
    const result: MatchupStat[] = [];
    for (const [key, tally] of this.matchups) {
      const [pos, champ, opponent] = key.split("|");
      if (pos !== position || opponent !== String(opponentId) || tally.games < minGames) continue;
      result.push({
        championId: Number(champ),
        opponentId,
        position: position,
        ...record(tally.games, tally.wins),
      });
    }
    return result.sort((a, b) => b.adjusted - a.adjusted);
  }

  /**
   * Welke items er in de eindbuild van een champion stonden, gesorteerd op hoe
   * vaak ze voorkomen.
   *
   * Let op wat dit wel en niet is: de matchdata bevat alleen de inventaris aan
   * het eind, niet de volgorde waarin er gekocht is. We kunnen dus zeggen wat er
   * gebouwd wordt, maar niet in welke volgorde -- en dat doen we dan ook niet.
   */
  itemStats(championId: number, position: Position, minGames = 5): ItemStat[] {
    const championGames = this.champions.get(`${position}|${championId}`)?.games ?? 0;
    if (championGames === 0) return [];

    const result: ItemStat[] = [];
    const prefix = `${position}|${championId}|`;
    for (const [key, tally] of this.items) {
      if (!key.startsWith(prefix) || tally.games < minGames) continue;
      const itemId = Number(key.slice(prefix.length));
      result.push({
        itemId,
        ...record(tally.games, tally.wins),
        pickRate: tally.games / championGames,
      });
    }
    return result.sort((a, b) => b.pickRate - a.pickRate);
  }

  /** Welke summoner spells er op deze champion gedraaid worden. */
  spellStats(championId: number, position: Position, minGames = 5): SpellPairStat[] {
    const championGames = this.champions.get(`${position}|${championId}`)?.games ?? 0;
    if (championGames === 0) return [];

    const result: SpellPairStat[] = [];
    const prefix = `${position}|${championId}|`;
    for (const [key, tally] of this.spells) {
      if (!key.startsWith(prefix) || tally.games < minGames) continue;
      const [a, b] = key.slice(prefix.length).split("-").map(Number);
      if (a === undefined || b === undefined) continue;
      result.push({
        spells: [a, b],
        ...record(tally.games, tally.wins),
        pickRate: tally.games / championGames,
      });
    }
    return result.sort((a, b) => b.pickRate - a.pickRate);
  }

  /** Op welke posities een champion gespeeld wordt, en hoe vaak. */
  positionsFor(championId: number): PositionShare[] {
    const perPosition: PositionShare[] = [];
    let total = 0;
    for (const [key, tally] of this.champions) {
      const [position, champ] = key.split("|");
      if (champ !== String(championId)) continue;
      perPosition.push({ position: position as Position, games: tally.games, share: 0 });
      total += tally.games;
    }
    for (const entry of perPosition) entry.share = total ? entry.games / total : 0;
    return perPosition.sort((a, b) => b.games - a.games);
  }

  /**
   * Tegen wie deze champion het zwaar heeft: tegenstanders waar hij onder de 50%
   * tegen scoort. Het spiegelbeeld van countersFor().
   */
  strugglesAgainst(championId: number, position: Position, minGames = MIN_MATCHUP_GAMES): MatchupStat[] {
    const result: MatchupStat[] = [];
    const prefix = `${position}|${championId}|`;
    for (const [key, tally] of this.matchups) {
      if (!key.startsWith(prefix) || tally.games < minGames) continue;
      const opponentId = Number(key.slice(prefix.length));
      const stat = { championId, opponentId, position, ...record(tally.games, tally.wins) };
      if (stat.winrate < 0.5) result.push(stat);
    }
    return result.sort((a, b) => a.adjusted - b.adjusted);
  }

  /** Andersom: matchups die deze champion juist wint. */
  strongAgainst(championId: number, position: Position, minGames = MIN_MATCHUP_GAMES): MatchupStat[] {
    const result: MatchupStat[] = [];
    const prefix = `${position}|${championId}|`;
    for (const [key, tally] of this.matchups) {
      if (!key.startsWith(prefix) || tally.games < minGames) continue;
      const opponentId = Number(key.slice(prefix.length));
      const stat = { championId, opponentId, position, ...record(tally.games, tally.wins) };
      if (stat.winrate > 0.5) result.push(stat);
    }
    return result.sort((a, b) => b.adjusted - a.adjusted);
  }

  /** Hoeveel matchups hebben genoeg games om iets te durven zeggen? */
  coverage(minGames = MIN_MATCHUP_GAMES): { matchups: number; usable: number } {
    let usable = 0;
    for (const tally of this.matchups.values()) if (tally.games >= minGames) usable++;
    return { matchups: this.matchups.size, usable };
  }
}

/**
 * De positie waarop iemand het vaakst speelt, uit zijn eigen games.
 * In champion select weten we van tegenstanders niets -- behalve dit.
 */
export function likelyPosition(
  matches: StoredMatch[],
  puuid: string,
): { position: Position; share: number; games: number } | null {
  const counts = new Map<Position, number>();
  let total = 0;
  for (const match of matches) {
    const player = match.players.find((p) => p.puuid === puuid);
    if (!player || player.position === "UNKNOWN") continue;
    counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
    total++;
  }
  if (total === 0) return null;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!best) return null;
  return { position: best[0], share: best[1] / total, games: total };
}
