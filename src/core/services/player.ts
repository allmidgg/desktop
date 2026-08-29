/**
 * Speleranalyse: één speler, per modus apart gehouden.
 *
 * Alles komt uit de lokale client: die mag namens de ingelogde speler de publieke
 * matchhistorie en ranked-gegevens van willekeurige spelers opvragen. Daardoor
 * hebben we geen Riot API-key nodig -- wat belangrijk is, want de publieke API
 * kent de JADE-queues nog helemaal niet.
 */
import type { LcuClient } from "../lcu/connector";
import type { Game, MatchHistoryResponse, RankedStats, Summoner } from "../lcu/types";
import { JADE_RANKED_QUEUE_TYPE } from "../jade/ids";
import { modeOf } from "../modes/detect";
import { modeCollects, type CollectedMode } from "../modes/registry";
import type { ModeId } from "../modes/types";

/**
 * De client levert per opvraag maximaal twintig games.
 *
 * Let op: `begIndex` wordt door dit endpoint genegeerd -- je krijgt altijd
 * dezelfde twintig recentste games terug, ongeacht wat je meegeeft. Verder
 * bladeren kan dus niet, en dat is een grens van Riot, niet van ons.
 */
const PAGE_SIZE = 20;

export interface ChampionRecord {
  championId: number;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
}

export interface RankedSummary {
  tier: string;
  division: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  /** Weergavevorm, bijv. "Silver IV 80 LP". */
  label: string;
}

/** One mode's worth of a player's recent games. Never two modes' worth. */
export interface ModusSamenvatting {
  games: number;
  wins: number;
  winrate: number;
  kda: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  /** Meest recente games eerst: true = gewonnen. Voor het vormlijntje in de UI. */
  recentResults: boolean[];
  /** Positief = winstreak, negatief = verliesstreak. */
  streak: number;
  topChampions: ChampionRecord[];
}

export interface PlayerProfile {
  puuid: string;
  riotId: string;
  summonerLevel: number;
  profileIconId: number;
  /**
   * The Classic ranked ladder, and only that one.
   *
   * Classic ranked and modern solo queue are unrelated ladders that share
   * nothing but their tier names, so this figure is meaningless anywhere else. A
   * screen must therefore go through `rangVoor()` rather than read this field,
   * which is what keeps a Gold pill from appearing under a heading naming the
   * other game -- a wrong fact stated with a full emblem behind it.
   */
  rank: RankedSummary | null;
  /**
   * One summary per mode the player actually has games in.
   *
   * A mode with no games is absent rather than present-and-zero, because those
   * are different sentences: "no data" is honest and "0 games, 0.00 KDA" reads
   * as a measurement. Nothing fills a missing mode in from another one; see
   * `samenvatting()` in the renderer for why the hole is deliberate.
   */
  perModus: Partial<Record<CollectedMode, ModusSamenvatting>>;
}

export async function fetchCurrentSummoner(client: LcuClient): Promise<Summoner> {
  return client.get<Summoner>("/lol-summoner/v1/current-summoner");
}

/**
 * Riot ID to summoner.
 *
 * Not the obvious endpoint. /lol-summoner/v1/summoners?gameName=&tagLine= looks
 * like it should work and answers 400: "Unknown argument 'gameName' for
 * GetLolSummonerV1Summoners". It never worked, so neither did player search --
 * every lookup came back empty and the screen said "not found" for names that
 * plainly exist.
 *
 * The alias endpoint is the one that resolves a Riot ID, and it hands back a
 * puuid rather than a summoner, so that is a second hop.
 */
export async function fetchSummonerByRiotId(
  client: LcuClient,
  gameName: string,
  tagLine: string,
): Promise<Summoner | null> {
  const query = new URLSearchParams({ gameName, tagLine }).toString();
  const alias = await client.tryGet<{ puuid?: string }>("/lol-summoner/v1/alias/lookup?" + query);
  if (!alias?.puuid) return null;
  return client.tryGet<Summoner>(`/lol-summoner/v2/summoners/puuid/${alias.puuid}`);
}

/**
 * The mode of a game as it comes out of the match list.
 *
 * Exported so that the filter below and every label drawn on one of these rows
 * ask the same question of the same fields. Two callers resolving a mode from
 * two different subsets of the signals is how a game gets kept by one rule and
 * described by another, and that disagreement shows up as a plausible label
 * rather than as an error.
 *
 * Note the list form of a game carries exactly one participant -- you -- so the
 * champion veto here only ever sees your own pick. That is enough for it to do
 * its job, which is to refuse rather than to decide.
 */
export const modeOfGame = (game: Game): ModeId =>
  modeOf({
    queueId: game.queueId,
    mapId: game.mapId,
    gameMode: game.gameMode,
    championIds: game.participants.map((p) => p.championId),
  });

/**
 * Haalt de recente games van een speler op.
 *
 * We vragen door zolang er nieuwe games bij komen, maar stoppen zodra een
 * opvraag niets nieuws oplevert -- wat meteen gebeurt, omdat het endpoint niet
 * bladert. Zonder die controle stapelden dezelfde twintig games zich op en
 * telde een speler met twintig games er dertig.
 */
export async function fetchRecentGames(
  client: LcuClient,
  puuid: string,
  limit = 20,
  maxScan = 100,
): Promise<Game[]> {
  const found: Game[] = [];
  const seen = new Set<number>();

  for (let begin = 0; begin < maxScan && found.length < limit; begin += PAGE_SIZE) {
    const end = begin + PAGE_SIZE - 1;
    const res = await client.tryGet<MatchHistoryResponse>(
      `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=${begin}&endIndex=${end}`,
    );
    const page = res?.games?.games ?? [];
    if (page.length === 0) break;

    let added = 0;
    for (const game of page) {
      if (seen.has(game.gameId)) continue;
      seen.add(game.gameId);
      // Your own history, so the mode filter comes off here -- and only here.
      // Reading back the games you played is what every companion app does;
      // walking the match histories of strangers into a shared aggregate is the
      // thing Riot's policy is about, and that filter stays shut in crawler.ts.
      //
      // Games in a mode we do not collect are still skipped: their numbers have
      // no tally to enter, so putting them beside averages they were never part
      // of would be worse than leaving them out.
      if (modeCollects(modeOfGame(game))) {
        found.push(game);
        added++;
      }
    }
    // Niets nieuws in deze opvraag: verder vragen levert alleen herhaling op.
    if (added === 0) break;
  }
  return found.slice(0, limit);
}

export async function fetchJadeRank(client: LcuClient, puuid: string): Promise<RankedSummary | null> {
  const stats = await client.tryGet<RankedStats>(`/lol-ranked/v1/ranked-stats/${puuid}`);
  const entry = stats?.queueMap?.[JADE_RANKED_QUEUE_TYPE];
  if (!entry?.tier || entry.tier === "NONE") return null;
  const tier = titleCase(entry.tier);
  const division = entry.division ?? "";
  return {
    tier,
    division,
    leaguePoints: entry.leaguePoints ?? 0,
    wins: entry.wins ?? 0,
    losses: entry.losses ?? 0,
    label: `${tier} ${division} ${entry.leaguePoints ?? 0} LP`.replace(/\s+/g, " ").trim(),
  };
}

/** Zoekt de deelnemer die bij een puuid hoort; beide lijsten zijn gekoppeld via participantId. */
export function participantOf(game: Game, puuid: string) {
  const identity = game.participantIdentities.find((i) => i.player?.puuid === puuid);
  if (!identity) return null;
  const participant = game.participants.find((p) => p.participantId === identity.participantId);
  return participant ? { participant, identity } : null;
}

/**
 * Vat een lijst games samen tot de cijfers die je in champ select wilt zien.
 *
 * The caller decides what the list is. This function averages whatever it gets,
 * which is exactly why it must never be handed two modes at once: it has no way
 * to notice, and the result would look like an ordinary set of numbers.
 */
export function summarizeGames(games: Game[], puuid: string): ModusSamenvatting {
  const perChampion = new Map<number, ChampionRecord>();
  const results: boolean[] = [];
  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;

  for (const game of games) {
    const found = participantOf(game, puuid);
    if (!found) continue;
    const { participant } = found;
    const s = participant.stats;

    results.push(s.win);
    if (s.win) wins++;
    kills += s.kills;
    deaths += s.deaths;
    assists += s.assists;

    const rec = perChampion.get(participant.championId) ?? {
      championId: participant.championId,
      games: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
    };
    rec.games++;
    if (s.win) rec.wins++;
    rec.kills += s.kills;
    rec.deaths += s.deaths;
    rec.assists += s.assists;
    perChampion.set(participant.championId, rec);
  }

  const total = results.length;
  return {
    games: total,
    wins,
    winrate: total ? wins / total : 0,
    kda: deaths === 0 ? kills + assists : (kills + assists) / deaths,
    avgKills: total ? kills / total : 0,
    avgDeaths: total ? deaths / total : 0,
    avgAssists: total ? assists / total : 0,
    recentResults: results,
    streak: currentStreak(results),
    topChampions: [...perChampion.values()]
      .sort((a, b) => b.games - a.games || b.wins - a.wins)
      .slice(0, 5),
  };
}

/**
 * Splits a match list by mode and summarises each half separately.
 *
 * The split happens before any arithmetic, and that order is the whole point: a
 * single average over both modes is not a number about anything. A player with
 * Classic and modern games gets two summaries; a player with one mode gets one,
 * and the other mode is absent rather than zero.
 */
export function summarizePerMode(
  games: Game[],
  puuid: string,
): Partial<Record<CollectedMode, ModusSamenvatting>> {
  const perMode = new Map<CollectedMode, Game[]>();
  for (const game of games) {
    const mode = modeOfGame(game);
    if (!modeCollects(mode)) continue;
    const list = perMode.get(mode);
    if (list) list.push(game);
    else perMode.set(mode, [game]);
  }
  const result: Partial<Record<CollectedMode, ModusSamenvatting>> = {};
  for (const [mode, list] of perMode) result[mode] = summarizeGames(list, puuid);
  return result;
}

/** Telt de reeks vanaf de meest recente game: 3 = drie op rij gewonnen, -2 = twee verloren. */
function currentStreak(results: boolean[]): number {
  const first = results[0];
  if (first === undefined) return 0;
  let count = 0;
  for (const won of results) {
    if (won !== first) break;
    count++;
  }
  return first ? count : -count;
}

export async function buildPlayerProfile(
  client: LcuClient,
  puuid: string,
  gamesToScan = 20,
): Promise<PlayerProfile> {
  const [summoner, rank, games] = await Promise.all([
    client.tryGet<Summoner>(`/lol-summoner/v2/summoners/puuid/${puuid}`),
    fetchJadeRank(client, puuid),
    fetchRecentGames(client, puuid, gamesToScan),
  ]);
  return {
    puuid,
    riotId: summoner ? `${summoner.gameName}#${summoner.tagLine}` : puuid.slice(0, 8),
    summonerLevel: summoner?.summonerLevel ?? 0,
    profileIconId: summoner?.profileIconId ?? 0,
    rank,
    perModus: summarizePerMode(games, puuid),
  };
}

const titleCase = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase();
