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
import { JADE_CHAMPION_OFFSET, JADE_ITEM_OFFSET, JADE_QUEUES } from "../jade/ids";
import type { Position, StoredMatch } from "./matchStore";

/** Hoe sterk we naar 50% trekken. 20 komt neer op: bij 20 games telt de data half mee. */
const PRIOR_STRENGTH = 20;

/** Onder dit aantal games tonen we een matchup niet als advies. */
export const MIN_MATCHUP_GAMES = 8;

/**
 * Hoe vaak een champion minstens in die lane moet staan om als matchup te tellen,
 * als deel van alle spelersloten daar.
 *
 * Zonder deze eis kwam Kog'Maw er in de botlane uit als winnend tegen Ryze, Nunu,
 * Alistar, Veigar en Lulu. Dat waren echte games -- 19 tot 40 stuks -- maar geen
 * van die vijf haalt 1% van de botlane, en Ryze staat er 36e met 0,37%. Je krijgt
 * ze dus nooit tegenover je, en een lijst met alleen namen die je nooit ziet is
 * geen advies. De botlane is in de praktijk negen ADC's die samen 72% van de lane
 * vullen; die wil je zien.
 */
export const MIN_LANE_SHARE = 0.01;

/**
 * Hoe groot een matchup minstens moet zijn ten opzichte van je eigen lane-games.
 *
 * Een vaste ondergrens van 8 werkt averechts bij een veelgespeelde champion: met
 * 6.627 botgames is een reeks van 26 ruis die dankzij de sortering op winrate
 * juist bovenaan belandt. Deze eis schaalt mee -- Ezreal moet 320 games hebben,
 * een champion met 300 lane-games houdt gewoon de ondergrens van 8.
 */
export const MIN_MATCHUP_SHARE = 0.01;

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
  /**
   * Totals, with the seconds they were earned over, rather than finished rates.
   *
   * A rate has to be divided at the very end. Averaging each game's own CS per
   * minute would give a 19-minute stomp the same weight as a 48-minute slog;
   * dividing total CS by total seconds weighs every minute once, which is what
   * "CS per minute for this champion" actually means.
   *
   * These three were in the published aggregate all along -- CHAMPION_FIELDS has
   * named them since the first version -- and were read straight past. Without
   * them the app can say who wins on a champion but not what a normal game of
   * one looks like, and a number like 6.2 CS per minute means nothing until
   * there is something to hold it against.
   */
  cs: number;
  gold: number;
  seconden: number;
}

/**
 * What a champion normally does in a lane, across every recorded game of it.
 *
 * Kept apart from ChampionStat because these are rates over totals rather than
 * per-game averages, and because the only thing they exist for is standing
 * beside a single game of your own.
 */
export interface ChampionBaseline {
  championId: number;
  position: Position;
  /** Games behind the averages. Never drop it: it is what makes them readable. */
  games: number;
  /** Average length of those games in minutes -- what the rates are per. */
  minutes: number;
  csPerMin: number;
  goldPerMin: number;
  kills: number;
  deaths: number;
  assists: number;
  /** (kills + assists) / deaths over the totals, the same rule as the tier list. */
  kda: number;
}


/**
 * The pre-counted tallies published at allmid.gg/data/app-stats.json.
 *
 * Field order is not decoration: the arrays are read positionally, and `velden`
 * in the file records which order was used. Check it before trusting the numbers,
 * because a silent reorder would turn deaths into assists without any error.
 */
export interface AggregateStats {
  /** When the counting ran. */
  generatedAt: string;
  /** Timestamp of the newest game in it: how fresh the numbers actually are. */
  newestGame: string;
  games: number;
  players: number;
  velden: { champions: string[]; paar: string[] };
  positionTotals: Record<string, number>;
  champions: Record<string, number[]>;
  matchups: Record<string, number[]>;
  items: Record<string, number[]>;
  spells: Record<string, number[]>;
}

/** The lanes a player is ever tallied in; UNKNOWN is never counted. */
const BASELINE_LANES: readonly Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];

const CHAMPION_FIELDS = ["games", "wins", "kills", "deaths", "assists", "cs", "gold", "seconden"];
const PAIR_FIELDS = ["games", "wins"];

const emptyTally = (): Tally => ({
  games: 0,
  wins: 0,
  kills: 0,
  deaths: 0,
  assists: 0,
  cs: 0,
  gold: 0,
  seconden: 0,
});

/**
 * How many recorded games a champion needs in a lane before its averages are
 * worth putting next to one game of yours.
 *
 * A per-minute average is a ratio of two totals, and over a handful of games it
 * moves further than any difference someone would read off it. Deze vloer
 * weigert in de praktijk echter niets: van de 315 champion-lane-paren in het
 * 128.628-game aggregaat zit er geen enkele onder de 30, en 139 zitten onder de
 * 1.000 -- Corki support staat op 35, Olaf support op 40, Sivir support op 44.
 * Juist de off-role picks komen er dus doorheen. Hij bestaat om een leeg of net
 * aangelegd aggregaat op te vangen; wat de lezer beschermt is de steekproef die
 * IjkBlok naast de gemiddelden afdrukt, niet dit getal.
 */
export const MIN_BASELINE_GAMES = 30;

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

  /**
   * Build the same stats from the community aggregate instead of local matches.
   *
   * Why this exists: a fresh install has an empty store, so every number in
   * champion select reads "not enough games" until the user has crawled thousands
   * of matches themselves. Meanwhile the counting has already been done centrally
   * over every game people chose to share. This hydrates the exact same Maps that
   * ingest() fills, so all query methods work unchanged.
   *
   * Deliberately NOT merged with the local store. The app uploads what it crawls,
   * so those games are already in here -- adding them again would count them twice.
   */
  static fromAggregate(raw: AggregateStats): JadeStats {
    const zelfde = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!zelfde(raw.velden?.champions ?? [], CHAMPION_FIELDS)) {
      throw new Error(`app-stats.json champion fields changed: ${JSON.stringify(raw.velden?.champions)}`);
    }
    if (!zelfde(raw.velden?.paar ?? [], PAIR_FIELDS)) {
      throw new Error(`app-stats.json pair fields changed: ${JSON.stringify(raw.velden?.paar)}`);
    }

    const stats = new JadeStats();
    stats.matchCount = raw.games;

    /**
     * The published file counts in base ids; everything in here is keyed by Jade
     * ids, because that is what the client hands us.
     *
     * Getting this wrong is silent. Every lookup simply misses and the app says
     * "not enough games" while reporting a database of 128,628 -- which is
     * exactly what happened, because the first version of this loaded the keys
     * as they came. Champions and their opponents shift by CHAMPION_OFFSET and
     * items by ITEM_OFFSET; summoner spells are already stored as Jade ids on
     * the other side, so those pass through untouched.
     */
    const deel = (sleutel: string): [string, string, string | undefined] => {
      const i = sleutel.indexOf("|");
      const j = sleutel.indexOf("|", i + 1);
      return j === -1
        ? [sleutel.slice(0, i), sleutel.slice(i + 1), undefined]
        : [sleutel.slice(0, i), sleutel.slice(i + 1, j), sleutel.slice(j + 1)];
    };
    const champSleutel = (sleutel: string): string => {
      const [lane, champ] = deel(sleutel);
      return `${lane}|${Number(champ) + JADE_CHAMPION_OFFSET}`;
    };
    const staartSleutel = (sleutel: string, verschuif: (staart: string) => string): string => {
      const [lane, champ, staart] = deel(sleutel);
      return `${lane}|${Number(champ) + JADE_CHAMPION_OFFSET}|${verschuif(staart ?? "")}`;
    };

    for (const [position, aantal] of Object.entries(raw.positionTotals)) {
      stats.positionTotals.set(position as Position, aantal);
    }
    const getal = (rij: number[], i: number, sleutel: string): number => {
      const x = rij[i];
      if (typeof x !== "number") throw new Error(`app-stats.json: ${sleutel} has no value at index ${i}`);
      return x;
    };
    for (const [sleutel, v] of Object.entries(raw.champions)) {
      stats.champions.set(champSleutel(sleutel), {
        games: getal(v, 0, sleutel),
        wins: getal(v, 1, sleutel),
        kills: getal(v, 2, sleutel),
        deaths: getal(v, 3, sleutel),
        assists: getal(v, 4, sleutel),
        // Indices 5 to 7 were being read straight past. CHAMPION_FIELDS has
        // always named them and the guard at the top of this method has always
        // insisted on them, so a file that reaches this line is guaranteed to
        // carry them and getal() may stay strict.
        cs: getal(v, 5, sleutel),
        gold: getal(v, 6, sleutel),
        seconden: getal(v, 7, sleutel),
      });
    }
    for (const [naam, doel, verschuif] of [
      ["matchups", stats.matchups, (x: string) => String(Number(x) + JADE_CHAMPION_OFFSET)],
      ["items", stats.items, (x: string) => String(Number(x) + JADE_ITEM_OFFSET)],
      // Spell pairs are written as Jade ids already ("74-712" is Flash+Teleport),
      // so only the champion in front of them needs shifting.
      ["spells", stats.spells, (x: string) => x],
    ] as const) {
      for (const [sleutel, v] of Object.entries(raw[naam])) {
        doel.set(staartSleutel(sleutel, verschuif), {
          games: getal(v, 0, sleutel),
          wins: getal(v, 1, sleutel),
          // Matchups, items and spell pairs are published as games and wins
          // only; everything below is zero because it was never counted, not
          // because it happened to be zero. Nothing reads these -- baseline()
          // works off the champions map alone -- and that is deliberate.
          kills: 0,
          deaths: 0,
          assists: 0,
          cs: 0,
          gold: 0,
          seconden: 0,
        });
      }
    }
    return stats;
  }


  get totalMatches(): number {
    return this.matchCount;
  }

  ingest(match: StoredMatch): void {
    if (match.queueId === JADE_QUEUES.BOT) return;
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
      tally.cs += player.cs;
      tally.gold += player.gold;
      // The match duration counted once per player slot, so it divides the
      // totals above exactly. Counting it once per match instead would inflate
      // every rate here by a factor of ten.
      tally.seconden += match.duration;
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

  /**
   * What this champion normally does in this lane, or null when too little is
   * behind it to be worth printing.
   *
   * Null rather than zeroes on purpose. A caller handed a number will draw it,
   * and "0.0 CS per minute is normal here" is worse than an empty space -- the
   * whole point of a baseline is that the reader can lean on it.
   */
  baseline(championId: number, position: Position): ChampionBaseline | null {
    return this.uitTally(championId, position, this.champions.get(`${position}|${championId}`));
  }

  /**
   * The same averages with every lane of one champion pooled.
   *
   * This exists because of a measured hole, not as a courtesy. Riot hands back a
   * position of UNKNOWN for 20,340 of the 130,086 stored games, and never for a
   * stray player: it is all ten at once, one game in eight, so a rule that scores
   * a player against his own lane would have nothing to score those games with.
   * Pooling the lanes keeps the yardstick honest for the champion even when the
   * lane is lost, and it is a real yardstick rather than a shrug -- a champion
   * sits in one lane for about seven of every ten of its games, so the pooled
   * figures land close to the lane figures for almost every pick.
   *
   * The lane is reported as UNKNOWN, which is exactly what it is here.
   */
  championBaseline(championId: number): ChampionBaseline | null {
    const totaal = emptyTally();
    for (const lane of BASELINE_LANES) {
      const tally = this.champions.get(`${lane}|${championId}`);
      if (!tally) continue;
      totaal.games += tally.games;
      totaal.wins += tally.wins;
      totaal.kills += tally.kills;
      totaal.deaths += tally.deaths;
      totaal.assists += tally.assists;
      totaal.cs += tally.cs;
      totaal.gold += tally.gold;
      totaal.seconden += tally.seconden;
    }
    return this.uitTally(championId, "UNKNOWN", totaal);
  }

  /** The arithmetic both baselines share, so the two can never drift apart. */
  private uitTally(championId: number, position: Position, tally: Tally | undefined): ChampionBaseline | null {
    if (!tally || tally.games < MIN_BASELINE_GAMES) return null;
    // Seconds are the denominator of every rate below. A tally that somehow
    // arrived without them would turn each one into Infinity and print it
    // without complaint, so the honest answer there is no baseline at all.
    if (tally.seconden <= 0) return null;

    const minuten = tally.seconden / 60;
    return {
      championId,
      position,
      games: tally.games,
      minutes: minuten / tally.games,
      csPerMin: tally.cs / minuten,
      goldPerMin: tally.gold / minuten,
      kills: tally.kills / tally.games,
      deaths: tally.deaths / tally.games,
      assists: tally.assists / tally.games,
      // The same rule toTierEntry uses in service.ts: a ratio of the totals. If
      // the two screens computed KDA differently the app would be arguing with
      // itself in front of the user.
      kda:
        tally.deaths === 0
          ? tally.kills + tally.assists
          : (tally.kills + tally.assists) / tally.deaths,
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
    return result.sort((a, b) => b.adjusted - a.adjusted || b.games - a.games || a.championId - b.championId);
  }

  /** Deel van alle spelersloten in die lane dat naar deze champion gaat. */
  private laneShare(position: Position, championId: number): number {
    const slots = this.positionTotals.get(position) ?? 0;
    if (!slots) return 0;
    return (this.champions.get(`${position}|${championId}`)?.games ?? 0) / slots;
  }

  /** De ondergrens voor een matchup van deze champion in deze lane. */
  private matchupFloor(position: Position, championId: number, minGames: number): number {
    const eigen = this.champions.get(`${position}|${championId}`)?.games ?? 0;
    return Math.max(minGames, Math.round(eigen * MIN_MATCHUP_SHARE));
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
      if (pos !== position || opponent !== String(opponentId)) continue;
      // Hier varieert de kandidaat, niet de tegenstander. De eis geldt dus voor
      // de kandidaat: geen counterpick voorstellen die daar nooit gespeeld wordt.
      const championId = Number(champ);
      if (this.laneShare(position, championId) < MIN_LANE_SHARE) continue;
      if (tally.games < this.matchupFloor(position, championId, minGames)) continue;
      result.push({
        championId,
        opponentId,
        position: position,
        ...record(tally.games, tally.wins),
      });
    }
    return result.sort((a, b) => b.adjusted - a.adjusted || b.games - a.games || a.championId - b.championId);
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
    return result.sort((a, b) => b.pickRate - a.pickRate || b.games - a.games || a.itemId - b.itemId);
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
    return result.sort((a, b) => b.pickRate - a.pickRate || b.games - a.games || a.spells[0] - b.spells[0] || a.spells[1] - b.spells[1]);
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
    return perPosition.sort((a, b) => b.games - a.games || a.position.localeCompare(b.position));
  }

  /**
   * Tegen wie deze champion het zwaar heeft: tegenstanders waar hij onder de 50%
   * tegen scoort. Het spiegelbeeld van countersFor().
   */
  strugglesAgainst(championId: number, position: Position, minGames = MIN_MATCHUP_GAMES): MatchupStat[] {
    const result: MatchupStat[] = [];
    const prefix = `${position}|${championId}|`;
    const floor = this.matchupFloor(position, championId, minGames);
    for (const [key, tally] of this.matchups) {
      if (!key.startsWith(prefix) || tally.games < floor) continue;
      const opponentId = Number(key.slice(prefix.length));
      // De tegenstander moet in deze lane thuishoren, anders staat er een naam
      // die je er nooit tegenover krijgt.
      if (this.laneShare(position, opponentId) < MIN_LANE_SHARE) continue;
      const stat = { championId, opponentId, position, ...record(tally.games, tally.wins) };
      if (stat.winrate < 0.5) result.push(stat);
    }
    return result.sort((a, b) => a.adjusted - b.adjusted || b.games - a.games || a.opponentId - b.opponentId);
  }

  /** Andersom: matchups die deze champion juist wint. */
  strongAgainst(championId: number, position: Position, minGames = MIN_MATCHUP_GAMES): MatchupStat[] {
    const result: MatchupStat[] = [];
    const prefix = `${position}|${championId}|`;
    const floor = this.matchupFloor(position, championId, minGames);
    for (const [key, tally] of this.matchups) {
      if (!key.startsWith(prefix) || tally.games < floor) continue;
      const opponentId = Number(key.slice(prefix.length));
      // De tegenstander moet in deze lane thuishoren, anders staat er een naam
      // die je er nooit tegenover krijgt.
      if (this.laneShare(position, opponentId) < MIN_LANE_SHARE) continue;
      const stat = { championId, opponentId, position, ...record(tally.games, tally.wins) };
      if (stat.winrate > 0.5) result.push(stat);
    }
    return result.sort((a, b) => b.adjusted - a.adjusted || b.games - a.games || a.opponentId - b.opponentId);
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
/**
 * Bots and hidden players all share this one. It is not a person.
 *
 * In the local store it turned up 7,915 times, more than seventy times the
 * busiest real account, because every bot in every Co-op vs AI game reports it.
 */
export const LEGE_PUUID = "00000000-0000-0000-0000-000000000000";

/**
 * Below this many games with a known position, we say nothing.
 *
 * The median player in a crawled store has been seen exactly once. "Plays mid
 * 100% of the time" off a single game is not a read on anyone, and presenting it
 * next to real numbers makes the whole card less trustworthy.
 */
export const MIN_POSITIE_GAMES = 4;

export function likelyPosition(
  matches: StoredMatch[],
  puuid: string,
): { position: Position; share: number; games: number } | null {
  if (!puuid || puuid === LEGE_PUUID) return null;
  const counts = new Map<Position, number>();
  let total = 0;
  for (const match of matches) {
    const player = match.players.find((p) => p.puuid === puuid);
    if (!player || player.position === "UNKNOWN") continue;
    counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
    total++;
  }
  if (total < MIN_POSITIE_GAMES) return null;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!best) return null;
  return { position: best[0], share: best[1] / total, games: total };
}
