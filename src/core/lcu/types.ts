/** Vormen van de LCU-responses die we gebruiken, beperkt tot de velden die we lezen. */

export interface Summoner {
  puuid: string;
  gameName: string;
  tagLine: string;
  summonerId: number;
  summonerLevel: number;
  profileIconId: number;
}

export interface RankedQueueEntry {
  queueType: string;
  tier: string;
  division: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  isProvisional?: boolean;
  provisionalGamesRemaining?: number;
}

export interface RankedStats {
  queueMap: Record<string, RankedQueueEntry>;
  highestRankedEntry?: RankedQueueEntry;
}

export interface ParticipantStats {
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  champLevel: number;
  goldEarned: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  totalDamageDealtToChampions: number;
  /** Optioneel: oudere clients en sommige wachtrijen laten hem weg. */
  totalDamageTaken?: number;
  visionScore?: number;
  wardsPlaced?: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
  gameEndedInSurrender?: boolean;
}

export interface Participant {
  participantId: number;
  teamId: number;
  championId: number;
  spell1Id: number;
  spell2Id: number;
  stats: ParticipantStats;
  timeline?: { lane?: string; role?: string };
}

export interface ParticipantIdentity {
  participantId: number;
  player: {
    puuid: string;
    gameName: string;
    tagLine: string;
    summonerId: number;
    profileIcon: number;
  };
}

export interface Game {
  gameId: number;
  /**
   * The shard the game was played on, e.g. "EUW1". Optional because the list
   * form of a game carries less than the detail form, and because a caller that
   * builds a Game by hand should not have to invent one.
   */
  platformId?: string;
  gameCreation: number;
  gameCreationDate: string;
  gameDuration: number;
  gameMode: string;
  gameVersion: string;
  mapId: number;
  queueId: number;
  participants: Participant[];
  participantIdentities: ParticipantIdentity[];
  teams: Array<{
    teamId: number;
    win: string | boolean;
    bans: Array<{ championId: number; pickTurn: number }>;
  }>;
}

export interface MatchHistoryResponse {
  games: {
    games: Game[];
    gameCount?: number;
    gameIndexBegin?: number;
    gameIndexEnd?: number;
  };
}
