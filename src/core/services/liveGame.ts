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
import { resolveMode } from "../modes/detect";
import { modeCollects, modeLabel } from "../modes/registry";
import type { ModeId } from "../modes/types";
import { berekenInzichten, gebeurtenissenVan, spelerSleutel, trinketLeeg } from "./liveInzichten";
import type {
  BuildStep, LiveGamePlayer, LiveGameSnapshot, OpnameRecord, OpnameSpeler, Position,
  Verloop, VerloopKolommen,
} from "../../shared/types";

/**
 * Seconds of game time between two readings of the scoreline.
 *
 * The poll runs every two seconds because that is what it takes to catch two
 * skill points taken in a row in the right order. That is a polling rate and not
 * a measuring rate: keeping every poll writes the same scoreline down thirty
 * times a minute. Priced on the median real Classic game -- 1,825 seconds, the
 * p50 over all 126,287 non-bot games in matches.jsonl -- the curve costs roughly
 * 133 KiB a game at two seconds, 27 KiB at ten, and 4.4 KiB at sixty.
 *
 * Sixty is the cheap answer and it is the wrong one, because the whole ask is
 * which minute it went wrong and a reading once a minute can only say which
 * minute it had already gone wrong by. Ten is where the sampling stops losing
 * anything real: over those same games the median laner farms 5.78 creeps a
 * minute on top, 5.43 bottom, 5.34 middle and 4.59 in the jungle, which is one
 * creep every 10.4 to 13.1 seconds. A ten-second grid therefore misses at most a
 * single creep, and can never miss a kill, a death or a level at all: those are
 * counters that only climb, so whatever happened in between is still standing in
 * the next reading.
 *
 * The support is the exception and is left out of that argument on purpose: at a
 * median 0.78 creeps a minute the grid is far finer than the thing being
 * measured, which costs nothing but means a support's creep curve is a staircase
 * of single steps rather than a slope. Anything reading it has to know that.
 */
const MONSTER_INTERVAL_SECONDEN = 10;

/**
 * The most readings one recording will ever hold.
 *
 * Not a limit on how long a game may be. The longest of the 130,095 games in
 * matches.jsonl ran 4,593 seconds, which is 460 readings at ten seconds, so
 * every real game on this disk fits under this at full detail. What it bounds is
 * a watcher left running against a client that never let go of the game -- the
 * one case where the loop has no natural end, and the one nothing else in here
 * guards against.
 */
const MAX_MONSTERS = 512;

const KOLOMNAMEN = ["kills", "deaths", "assists", "cs", "wards", "level"] as const;

const leegKolommen = (lengte: number): VerloopKolommen => ({
  kills: new Array<number | null>(lengte).fill(null),
  deaths: new Array<number | null>(lengte).fill(null),
  assists: new Array<number | null>(lengte).fill(null),
  cs: new Array<number | null>(lengte).fill(null),
  wards: new Array<number | null>(lengte).fill(null),
  level: new Array<number | null>(lengte).fill(null),
});

/**
 * Pad a seat's columns out to the reading count.
 *
 * Every column has to stay exactly as long as the time axis. Let one fall behind
 * and every reading after the gap sits at the wrong moment -- a curve that is
 * confidently and silently wrong, rather than one with a visible hole in it.
 */
const vulAanTot = (kolommen: VerloopKolommen, lengte: number): void => {
  for (const naam of KOLOMNAMEN) {
    while (kolommen[naam].length < lengte) kolommen[naam].push(null);
  }
};

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
 * What is kept from a finished game: see OpnameRecord in shared/types.
 *
 * No Riot IDs, no summoner names, no puuids. The build order of a champion in a
 * lane is the whole point; who was holding the mouse is not, and the same rule
 * already applies everywhere else here.
 *
 * ── Why this is now one line per game and not ten ────────────────────────────
 *
 * It used to be a record per player, and the events had nowhere to live: a kill
 * belongs to the game, not to a seat, and writing the same list ten times to
 * make it fit was not a shape, it was a workaround. Grouping was already being
 * done on recordedAt by anything that read the file, so the game was the record
 * all along.
 *
 * The reader still understands the old per-player lines. They carry no side and
 * no events, because nothing recorded them; that is a gap, not a value to fill
 * in later.
 */
export type BuildOrderRecord = OpnameRecord;

export interface ChampionZoeker {
  /**
   * The champion id a display name or alias stands for, in one mode's id space.
   *
   * The mode is a parameter and not a choice the lookup was built with, because
   * the running game is what says which mode it is and that is only known once a
   * poll has been read. Both spaces name the same 63 champions, so a lookup
   * spanning them would answer "Ashe" with whichever row was written last --
   * right by accident in one mode and wrong by accident in the other.
   */
  (naam: string, mode: ModeId): number | null;
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
  /**
   * The scoreline over time, one column per number per player.
   *
   * Keyed on the player rather than on the seat index for the same reason the
   * builds are: the client does not promise the order of allPlayers, and columns
   * filed under an index that shifted mid-game would splice two players' games
   * into one curve. Put into seat order once, at harvest, against a list that is
   * known and fixed by then.
   */
  private readonly verloopSpelers = new Map<string, VerloopKolommen>();
  /** Game time of each reading. The time axis every column is indexed against. */
  private readonly verloopTijden: number[] = [];
  /** Your own gold at each reading; null where the poll did not report it. */
  private readonly verloopGoud: Array<number | null> = [];
  /** Seconds currently aimed for between readings. Doubles at the reading cap. */
  private verloopInterval = MONSTER_INTERVAL_SECONDEN;
  /** Your gold at the most recent poll, so the closing reading has one too. */
  private laatsteGoud: number | null = null;

  constructor(
    private readonly zoekChampion: ChampionZoeker,
    /**
     * Item prices, for the value a player is carrying. Unknown counts as zero.
     *
     * Takes the mode for the same reason the champion lookup does: the two id
     * spaces number the same item differently, and a price looked up in the
     * wrong one is not a wrong number but no number at all -- every item comes
     * back zero and the whole gold column quietly reads nought.
     */
    private readonly prijsVan: (itemId: number, mode: ModeId) => number = () => 0,
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
      this.wisVerloop();
    }
    this.laatsteTijd = gameTime;
  }

  reset(): void {
    this.recorder.reset();
    this.builds.clear();
    this.vorigeInventaris.clear();
    this.wisVerloop();
    this.laatsteTijd = null;
    this.laatsteSnapshot = null;
  }

  private wisVerloop(): void {
    this.verloopSpelers.clear();
    this.verloopTijden.length = 0;
    this.verloopGoud.length = 0;
    this.verloopInterval = MONSTER_INTERVAL_SECONDEN;
    this.laatsteGoud = null;
  }

  /**
   * Keep this poll if enough game time has passed since the last one kept.
   *
   * Measured on the game clock and never on the wall clock, and that is what
   * makes a missed poll honest. If the client stops answering for forty seconds,
   * the next reading is written down once, at the second it actually happened,
   * and the gap stands in `tijden` as a jump from 120 to 175. Nothing is
   * interpolated across it: a straight line drawn through a gap is exactly the
   * flat stretch a reader takes for a quiet minute, and afterwards there is no
   * telling the invented one from a real one.
   */
  private bemonster(gameTime: number, spelers: LiveGamePlayer[], goud: number | null): void {
    const vorige = this.verloopTijden[this.verloopTijden.length - 1];
    if (vorige !== undefined && gameTime < vorige + this.verloopInterval) return;
    this.duwMonster(gameTime, spelers, goud);
    if (this.verloopTijden.length >= MAX_MONSTERS) this.halveerVerloop();
  }

  /** Append one reading, leaving every column exactly as long as `tijden`. */
  private duwMonster(gameTime: number, spelers: LiveGamePlayer[], goud: number | null): void {
    const lengte = this.verloopTijden.length + 1;
    this.verloopTijden.push(gameTime);
    this.verloopGoud.push(goud);

    for (const p of spelers) {
      const sleutel = spelerSleutel(p);
      let kolommen = this.verloopSpelers.get(sleutel);
      if (!kolommen) {
        // A seat first seen at reading n was not measured for the n before it,
        // which is what happens when the app starts watching a game that was
        // already running. Null rather than zero, so that never draws as a
        // player who spent ten minutes doing nothing.
        kolommen = leegKolommen(lengte - 1);
        this.verloopSpelers.set(sleutel, kolommen);
      }
      kolommen.kills.push(p.kills);
      kolommen.deaths.push(p.deaths);
      kolommen.assists.push(p.assists);
      kolommen.cs.push(p.cs);
      // Rounded on the way in. The ward figure is Riot's score rather than a
      // count, and this payload is not shy of decimals -- gameTime arrives in
      // the same response as 0.025671999901533127. Fifteen digits per seat per
      // reading buys nothing any chart can show.
      kolommen.wards.push(Math.round(p.wards));
      kolommen.level.push(p.level);
    }

    // A seat this poll did not list still needs its slot, or its columns stop
    // lining up with the time axis and every reading after the gap sits at the
    // wrong moment.
    for (const kolommen of this.verloopSpelers.values()) vulAanTot(kolommen, lengte);
  }

  /**
   * Halve the resolution rather than stop recording.
   *
   * A cap that simply stopped appending would end the curve mid-game, and a
   * curve that stops early draws as a game that ended early -- the one way of
   * being wrong that is worse than having no curve at all. Dropping every second
   * reading and doubling the interval keeps a curve that still spans the whole
   * game, at half the detail, with the count bounded for good.
   */
  private halveerVerloop(): void {
    const houd = <T>(rij: T[]): T[] => rij.filter((_, i) => i % 2 === 0);
    this.verloopTijden.splice(0, this.verloopTijden.length, ...houd(this.verloopTijden));
    this.verloopGoud.splice(0, this.verloopGoud.length, ...houd(this.verloopGoud));
    for (const kolommen of this.verloopSpelers.values()) {
      for (const naam of KOLOMNAMEN) {
        kolommen[naam].splice(0, kolommen[naam].length, ...houd(kolommen[naam]));
      }
    }
    this.verloopInterval *= 2;
  }

  /**
   * The readings, put into seat order.
   *
   * Seat order comes from the player list the record itself is built from, so
   * index i here is spelers[i] there and the same seat the events point at.
   * A seat the sampler never saw gets a column of nulls rather than being left
   * out, for the same reason no seat is ever dropped from spelers: an index that
   * shifts hands every later seat somebody else's game.
   */
  private verloopVoor(spelers: LiveGamePlayer[]): Verloop | undefined {
    if (this.verloopTijden.length === 0) return undefined;
    return {
      interval: this.verloopInterval,
      tijden: [...this.verloopTijden],
      goud: [...this.verloopGoud],
      spelers: spelers.map(
        (p) => this.verloopSpelers.get(spelerSleutel(p)) ?? leegKolommen(this.verloopTijden.length),
      ),
    };
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
  oogst(minimaalSeconden = 120): OpnameRecord | null {
    const laatste = this.laatsteSnapshot;
    if (!laatste || !laatste.isJade) return null;
    if (laatste.gameTimeSeconds < minimaalSeconden) return null;

    // Everyone is kept, including a seat that bought nothing. A timeline with a
    // hole where the fed jungler should be is worse than one that says he never
    // opened the shop, and the events refer to seats by index -- drop a seat and
    // every index after it points at the wrong player.
    const spelers: OpnameSpeler[] = laatste.players.map((p) => ({
      championId: p.championId,
      championName: p.championName,
      team: p.team,
      position: p.position,
      level: p.level,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      cs: p.cs,
      build: p.build,
      ...(p.isYou ? { skillOrder: laatste.skillOrder } : {}),
    }));

    // The last poll almost never lands on a cadence boundary, and the end of a
    // game is the part anyone reads hardest. Closing the curve on the final
    // reading is what makes it arrive at the same scoreline the record above
    // reports, instead of stopping up to ten seconds short of it.
    const laatsteMonster = this.verloopTijden[this.verloopTijden.length - 1];
    if (laatsteMonster !== undefined && laatste.gameTimeSeconds > laatsteMonster) {
      this.duwMonster(laatste.gameTimeSeconds, laatste.players, this.laatsteGoud);
    }

    const verloop = this.verloopVoor(laatste.players);

    return {
      recordedAt: Date.now(),
      gameMode: laatste.gameMode,
      mapNumber: laatste.mapNumber,
      gameLengthSeconds: laatste.gameTimeSeconds,
      spelers,
      gebeurtenissen: laatste.gebeurtenissen,
      ...(verloop ? { verloop } : {}),
    };
  }

  verwerk(data: LiveGameData, jouwNaam: string | null): LiveGameSnapshot {
    const gameTime = Math.max(0, Math.round(data.gameData?.gameTime ?? 0));
    this.misschienNieuweGame(gameTime);
    this.recorder.observe(data.activePlayer?.abilities);

    const mapNumber = data.gameData?.mapNumber ?? 0;
    const gameMode = data.gameData?.gameMode ?? "";
    // The live endpoint gives a map number and a mode string and nothing else,
    // which is exactly the pair the resolver is strongest on. Testing the map
    // number against one constant handed in from outside gave the right answer
    // only because 453 happens to carry a single mode: read out of the running
    // client on 2026-08-29, its 88 queues spread over 22 (map, mode) pairs, and
    // map 11 alone carries twelve different mode strings while map 12 carries
    // three. Either half on its own therefore narrows rather than decides, and
    // the old test could say nothing at all about what a game was when it was
    // not Classic -- which is now the question being asked.
    const mode = resolveMode({ mapId: mapNumber, gameMode }).mode;
    // Named after the mode id: `gameMode` on the line above is the literal string
    // "CLASSIC" for a modern Summoner's Rift game, so an `isClassic` here would be
    // false in exactly the games whose mode string reads CLASSIC. The two live
    // eleven lines apart, which is close enough for the wrong one to be reached
    // for and far enough that nobody would notice.
    const isJade = mode === "lol:jade";

    const jij = jouwNaam ? normaliseerNaam(jouwNaam) : null;
    const rauw = data.allPlayers ?? [];
    const spelers = rauw.map((p) => this.speler(p, jij, gameTime, mode));

    // The event feed speaks in names; the record we keep must not. Both the Riot
    // ID and the older summoner name are indexed because the feed is not
    // consistent about which one it uses, and a kill attributed to nobody is a
    // kill that vanishes off the timeline.
    const stoel = new Map<string, number>();
    rauw.forEach((p, i) => {
      for (const naam of [p.riotId, p.summonerName]) {
        if (!naam) continue;
        const sleutel = normaliseerNaam(naam);
        if (sleutel && !stoel.has(sleutel)) stoel.set(sleutel, i);
      }
    });
    const zoekStoel = (naam: string | undefined): number | null =>
      naam ? (stoel.get(normaliseerNaam(naam)) ?? null) : null;

    // Saying which mode this is NOT was the useful half only while the app was
    // Classic and everything else was the exception. Reversed, the useful half
    // is which mode it IS and whether we keep it, and those are three different
    // answers rather than two: a mode we recognise but never collect is not the
    // same fact as a mode we cannot place at all, and neither is the same as a
    // mode we do collect but do not record live.
    let note: string | null = null;
    if (!modeCollects(mode)) {
      note =
        mode === "unknown"
          ? `We cannot tell which mode this is${gameMode ? ` (the client says "${gameMode}")` : ""}. ` +
            `Shown for convenience; nothing here is recorded, because there is no mode to record it under.`
          : `This is ${modeLabel(mode)}. Shown for convenience; its games are not collected, ` +
            `so nothing here is recorded and no averages are drawn from it.`;
    } else if (!isJade) {
      // Tied to the same flag that gates the recorder below, so the sentence
      // cannot outlive the behaviour it describes.
      note = `This is ${modeLabel(mode)}. Shown live, but the build recorder only writes Classic games, so nothing here is kept.`;
    } else if (spelers.some((s) => s.championId === null)) {
      const onbekend = spelers.filter((s) => s.championId === null).map((s) => s.championName);
      note = `No stats for ${onbekend.join(", ")} -- the client reports a name we do not recognise.`;
    }

    // Derived numbers need every player read first, so they land here rather
    // than inside the per-player mapping.
    const events = data.events?.Events ?? [];
    const inzichten = berekenInzichten(spelers, events, gameTime, (id) => this.prijsVan(id, mode));
    for (const p of spelers) {
      const sleutel = spelerSleutel(p);
      p.itemWaarde = inzichten.itemWaarde.get(sleutel) ?? 0;
      p.killDeelname = inzichten.killDeelname.get(sleutel) ?? 0;
    }

    // The only gold figure that exists at all while a game runs: what is in your
    // own pocket right now. The client reports currentGold for the active player
    // and for nobody else, and it is gold in hand rather than gold earned, so it
    // drops every time you spend. Worth recording anyway -- your own gold read
    // against your own deaths is close to the whole question of which minute it
    // went wrong.
    const goud = data.activePlayer?.currentGold;
    this.laatsteGoud = typeof goud === "number" ? Math.round(goud) : null;
    // Only Classic games are ever harvested, so only Classic games are worth
    // measuring; sampling another mode would fill memory for a record oogst()
    // will refuse to return anyway.
    if (isJade) this.bemonster(gameTime, spelers, this.laatsteGoud);

    this.laatsteSnapshot = {
      mode,
      gameMode,
      mapNumber,
      isJade,
      gameTimeSeconds: gameTime,
      players: spelers,
      skillOrder: this.recorder.skillOrder,
      gebeurtenissen: gebeurtenissenVan(events, zoekStoel),
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

  private speler(
    p: LivePlayer,
    jouwGenormaliseerdeNaam: string | null,
    gameTime: number,
    /** The mode this poll turned out to be, so the name lands in the right space. */
    mode: ModeId,
  ): LiveGamePlayer {
    const naam = p.riotId || p.summonerName || "";
    const items = itemsVan(p);
    const sleutel = naam || `${p.team}|${p.championName}`;
    return {
      build: this.noteerAankopen(sleutel, items, gameTime),
      championId: this.zoekChampion(p.championName ?? "", mode),
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
 * Passed through untouched on purpose: the renderer looks items up in the index
 * for the mode being shown, the same as recent games do, so translating here
 * would only mean translating back one layer up -- and there is no longer a
 * function that would do it.
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

/**
 * Builds the name lookup from the champion list the app already holds.
 *
 * One index per mode, never one over the lot. Both spaces name the same 63
 * champions, so a single map would answer "Ashe" with whichever row happened to
 * be written last -- right by accident today, wrong by accident tomorrow, and
 * never visibly either. Keeping them apart here rather than filtering at the
 * call site is what makes the mode a question the caller has to answer instead
 * of one it can forget to ask.
 */
export function championZoeker(
  champions: Array<{ id: number; name: string; alias: string; mode: ModeId }>,
): ChampionZoeker {
  const perModus = new Map<ModeId, Map<string, number>>();
  for (const c of champions) {
    let perNaam = perModus.get(c.mode);
    if (!perNaam) perModus.set(c.mode, (perNaam = new Map()));
    perNaam.set(normaliseerNaam(c.name), c.id);
    perNaam.set(normaliseerNaam(c.alias), c.id);
  }
  return (naam, mode) => perModus.get(mode)?.get(normaliseerNaam(naam)) ?? null;
}
