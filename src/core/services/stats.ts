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
import { JADE_CHAMPION_OFFSET, JADE_ITEM_OFFSET } from "../jade/ids";
import { modeOfStored } from "../modes/detect";
import { COLLECTED_MODES, queueCounts } from "../modes/registry";
import type { ModeId } from "../modes/types";
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
  /**
   * Which mode every tally in this file was counted over.
   *
   * The published file has never carried this and the app has never asked. All
   * 128,628 games in it are Classic, and the only thing standing between that
   * and a mixed file is one line in the upload server -- the championId range in
   * isValidMatch -- which is not there to separate modes and was never written
   * as a mode gate. Once that line changes for any reason, a mixed aggregate
   * downloads into every installation at once, and rebuildStats() prefers it
   * over the local store. This field is what makes that visible.
   *
   * Absent means lol:jade, and that default can only ever produce lol:jade. A
   * modern file has to say so out loud or fromAggregate refuses it, so a dropped
   * field can never promote Classic tallies into the modern set.
   *
   * site/data/refresh.mjs writes it. Any change to the id shift below happens in
   * the same commit as a change there: it is one decision written in two files.
   */
  modus?: ModeId;
  /**
   * Bumped whenever the shape changes in a way an older reader cannot follow.
   *
   * Absent means the shape published up to now, which is version 1. A file that
   * announces a version this build does not know is refused rather than read,
   * because the failure it prevents is silent: `velden` catches a reordered
   * array but nothing catches a field that changed meaning.
   */
  schemaVersion?: number;
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

/**
 * The newest aggregate shape this build can read.
 *
 * 2 is the first version that names its own mode. Everything published before it
 * said nothing, which is why an absent version reads as 1 and an absent mode
 * reads as lol:jade -- both are statements about files that already exist, not
 * guesses about files that might.
 */
export const AGGREGATE_SCHEMA_VERSION = 2;

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
  /**
   * positie -> aantal spelersloten
   *
   * This is the denominator under every pickRate and under laneShare(), and it
   * is the reason this class now carries a mode. It is keyed by position alone,
   * so two modes counted into one instance would grow it without growing any
   * numerator with it. Nothing throws, no winrate changes, and every pick rate
   * silently shrinks by the other mode's share. Worked through on the real
   * aggregate at the measured mode mix: 80 of the 102 champion-lane pairs that
   * clear MIN_LANE_SHARE drop below it and vanish from the matchup advice --
   * Fiddlesticks jungle on 14,570 games, Teemo top on 13,059, Soraka support on
   * 9,880. The games are all still there. The screen just stops saying anything
   * about them.
   *
   * One instance per mode is what makes that impossible. Putting the mode into
   * the keys instead would mean carrying a prefix through every scan in this
   * file -- the startsWith() in itemStats, spellStats, strugglesAgainst and
   * strongAgainst, and the bare iterations in countersFor, tierList,
   * positionsFor and coverage. Forget one and that loop walks into the other
   * mode's entries and returns them. Here there is no entry to walk into, and
   * not a single key changes shape.
   */
  private readonly positionTotals = new Map<Position, number>();
  private matchCount = 0;

  /**
   * The one mode every tally in this instance belongs to, fixed at construction.
   *
   * Costs nothing in memory: an instance holds only its own mode's entries, so
   * two of them come to the same total as one map with longer keys.
   */
  constructor(readonly mode: ModeId = "lol:jade") {}

  static from(matches: StoredMatch[], mode: ModeId = "lol:jade"): JadeStats {
    const stats = new JadeStats(mode);
    // No filter here: ingest() refuses anything from another mode itself, so
    // there is no version of this call that can mix.
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
  static fromAggregate(raw: AggregateStats, mode: ModeId = "lol:jade"): JadeStats {
    // Asked for rather than read, so a file arriving at the wrong door is refused
    // instead of absorbed. This closes the last path by which the 130,197 Classic
    // games could land in the modern set: a redirect, a misconfigured CDN, a
    // wrong path in the cache. rebuildStats() already catches and falls back.
    const fileMode: ModeId = raw.modus ?? "lol:jade";
    if (fileMode !== mode) {
      throw new Error(`app-stats holds ${fileMode} tallies, ${mode} was asked for`);
    }
    const versie = raw.schemaVersion ?? 1;
    if (versie > AGGREGATE_SCHEMA_VERSION) {
      throw new Error(`app-stats.json is schema ${versie}; this build reads up to ${AGGREGATE_SCHEMA_VERSION}`);
    }
    const zelfde = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!zelfde(raw.velden?.champions ?? [], CHAMPION_FIELDS)) {
      throw new Error(`app-stats.json champion fields changed: ${JSON.stringify(raw.velden?.champions)}`);
    }
    if (!zelfde(raw.velden?.paar ?? [], PAIR_FIELDS)) {
      throw new Error(`app-stats.json pair fields changed: ${JSON.stringify(raw.velden?.paar)}`);
    }

    const stats = new JadeStats(mode);
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
     *
     * How far apart the two sets of ids sit has a different answer per mode. The
     * published file counts in base ids either way; for Classic the client
     * speaks Jade ids so everything shifts, and for the modern game the client
     * already speaks base ids so nothing does. Shifting there anyway is not a
     * visible failure -- every lookup simply misses while the app reports a
     * database of tens of thousands, which is the bug described just above as
     * having already happened once. This is the same decision that
     * site/data/refresh.mjs makes when it subtracts on the way out.
     */
    const champOffset = mode === "lol:jade" ? JADE_CHAMPION_OFFSET : 0;
    const itemOffset = mode === "lol:jade" ? JADE_ITEM_OFFSET : 0;
    const deel = (sleutel: string): [string, string, string | undefined] => {
      const i = sleutel.indexOf("|");
      const j = sleutel.indexOf("|", i + 1);
      return j === -1
        ? [sleutel.slice(0, i), sleutel.slice(i + 1), undefined]
        : [sleutel.slice(0, i), sleutel.slice(i + 1, j), sleutel.slice(j + 1)];
    };
    const champSleutel = (sleutel: string): string => {
      const [lane, champ] = deel(sleutel);
      return `${lane}|${Number(champ) + champOffset}`;
    };
    const staartSleutel = (sleutel: string, verschuif: (staart: string) => string): string => {
      const [lane, champ, staart] = deel(sleutel);
      return `${lane}|${Number(champ) + champOffset}|${verschuif(staart ?? "")}`;
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
      ["matchups", stats.matchups, (x: string) => String(Number(x) + champOffset)],
      ["items", stats.items, (x: string) => String(Number(x) + itemOffset)],
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
    // One tally, one mode, and this throws rather than quietly skipping.
    //
    // Nasus top at 6.43 CS/min in Classic is measured against a different item
    // set, different runes, different map timers and a different champion pool
    // than Nasus top in the modern game. Added together the result is wrong and
    // looks completely ordinary, which is the whole danger: nobody reading the
    // number can tell. A caller that hands a JadeStats the wrong mode has a bug,
    // and what it costs is not one game but every average, every baseline and
    // every tier list built on this object. Skipping would hide exactly the
    // mistake that most needs to be loud.
    //
    // Loud is affordable because somebody catches it. Service.telLokaal() wraps
    // every call that reaches here from a store, counts the mode again from the
    // records that do belong to it, and publishes how many it had to leave out.
    // The user keeps a working app with honest numbers and a sentence saying
    // what happened; the caller that handed over the wrong game still gets the
    // stack trace in the log. Check that method before relaxing this throw --
    // the promise in this paragraph is only true while it is there.
    const mode = modeOfStored(match);
    if (mode !== this.mode) {
      throw new Error(
        `JadeStats(${this.mode}) was handed a ${mode} game (${match.gameId}, queue ${match.queueId}); ` +
          `statistics from two modes may never be added together`,
      );
    }
    // Bots play differently and customs are arranged rather than matched, so both
    // distort every average they touch. This used to name one queue by number --
    // 4320, the Classic bot queue. Asking the queue table instead covers bots and
    // customs in every mode, including the ones that do not exist yet, and
    // including the four modern bot queues that report gameMode SWIFTPLAY and
    // would sail straight past any test on the mode string.
    //
    // It also moves the count to after both refusals. It used to fire before the
    // player loop, so a game that produced no tally at all still raised the
    // denominator this class reports as its game count.
    if (!queueCounts(match.queueId)) return;
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
 * One JadeStats per mode, and the only way to reach one.
 *
 * The point of the class is that asking for statistics forces you to say which
 * game you mean. There is no default and no "current" mode in here on purpose: a
 * default is how a Classic game ends up judged against modern averages, and
 * nothing on the screen would show it -- SpelerIjklijn carries a game count and
 * a source but never a mode, so a baseline drawn from the wrong pool looks
 * exactly like a correct one.
 *
 * It holds only the modes we collect. Asking for lol:kiwi-jade or for the
 * unknown mode throws rather than handing back an empty bucket, because an empty
 * bucket answers null to everything and reads as "no data yet" instead of as
 * "you asked the wrong question".
 */
export class StatsPerModus {
  private readonly per = new Map<ModeId, JadeStats>();

  constructor() {
    for (const mode of COLLECTED_MODES) this.per.set(mode, new JadeStats(mode));
  }

  voor(mode: ModeId): JadeStats {
    const stats = this.per.get(mode);
    if (!stats) throw new Error(`no statistics bucket for mode ${mode}`);
    return stats;
  }

  /**
   * Swap in a freshly counted set. Refuses one counted for another mode.
   *
   * The guard is not paranoia about this file's own callers: fromAggregate()
   * builds its instance from a downloaded file, so this is the last place that
   * can notice a redirect, a stale CDN entry or a hand-edited cache path having
   * put one mode's tallies where the other mode's belong.
   */
  zet(mode: ModeId, stats: JadeStats): void {
    if (stats.mode !== mode) {
      throw new Error(`refusing ${stats.mode} statistics in the ${mode} slot`);
    }
    this.per.set(mode, stats);
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

/**
 * Hand this one mode's games, never two concatenated.
 *
 * There is no mode parameter because there is nothing to key: the answer is one
 * position per player, so a second mode's games would not land in a bucket of
 * their own, they would be added to the first mode's counts. Someone who plays
 * mid in Classic and support in the modern game then gets one "usual position"
 * that is true nowhere, and MIN_POSITIE_GAMES is cleared sooner by the mixture
 * -- so champ select places the unknown players more confidently while placing
 * them worse. Since step 5 each store holds exactly one mode, so passing
 * `stores.for(mode).all()` is all this needs; passing a merged array is the only
 * way to break it.
 */
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
