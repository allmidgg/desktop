/**
 * Per-minute curves for games nobody was watching.
 *
 * ── What this buys ───────────────────────────────────────────────────────────
 *
 * The recording in data/buildorders.jsonl only exists for games this machine had
 * running, which is two of them. data/matches.jsonl holds 130,086 games. The gap
 * between those two numbers is the whole reason this file exists: match history
 * serves `/lol-match-history/v1/game-timelines/{gameId}`, and it serves it for
 * games this account never played. See core/lcu/timeline.ts for how that was
 * established, and the measurements at the bottom of this block for what it
 * costs.
 *
 * ── What it is not ───────────────────────────────────────────────────────────
 *
 * It is deliberately NOT an OpnameRecord and deliberately not a GameTijdlijn.
 * Four separate doc blocks in this repository state that a recording exists only
 * for games the app watched itself and that nothing backfills it, and they are
 * right: a recording samples every fifteen seconds, knows what was bought and
 * when, knows which seat was at the keyboard, and is the only source for any of
 * those. This is one frame a minute with no purchases, no skill levels, no ward
 * figure and no way to tell whose game it was. Pouring it into the recording
 * shape would make shared/dekking.ts report coverage for a recording that does
 * not exist and would let shared/build.ts read an empty build as a player who
 * bought nothing. So it travels as its own thing, beside the recording, and the
 * screen is told exactly which columns were measured and which were not.
 *
 * ── Measured against the running client, twelve games out of matches.jsonl ───
 *
 * Ten gameIds spread across the whole file (lines 1, 9k, 21k, 38k, 55k, 72k,
 * 90k, 108k, 125k, 130090) plus two repeats, every one of them a crawled game
 * belonging to strangers. All ten answered 200.
 *
 *   raw response      45.8 KB .. 101.4 KB   (mean 78.9 KB)
 *   frames            19 .. 41
 *   round trip        14 ms .. 258 ms
 *   an unknown gameId  404, so tryGet answers null rather than throwing
 *
 * And what this file actually writes, measured on six of those games after the
 * conversion below rather than estimated from the raw:
 *
 *   one cached line   11.9 KB .. 17.1 KB    (mean 14.9 KB, about 19% of raw)
 *
 * Where that 14.9 KB goes: the events are the biggest single share (60 to 96 of
 * them a game, seven fields each), then the three derived counters, then gold,
 * creeps and levels. About 1.7 KB of it is the ward column, which is 350 nulls a
 * game and could be dropped on write and rebuilt on read. That is not done,
 * because it would put a second shape between the file and memory to save 12% of
 * something that only grows when a person clicks a row.
 *
 * Seat order is not assumed. participantId 1..10 was checked against
 * matches.jsonl for all ten games: the final frame's minionsKilled plus
 * jungleMinionsKilled equalled the stored `cs` on all 100 seats exactly, not
 * approximately. On five of those games kills, deaths and assists accumulated
 * out of the CHAMPION_KILL events equalled the stored scoreline on all 50 seats
 * exactly as well, which is why those three columns are derived here rather than
 * left empty.
 *
 * Frames land within about 150 ms of the minute (0, 60017, 120047, ...) and the
 * last frame carries the true end clock instead of a round minute. So `tijden`
 * is built from the stamps and never from index times sixty -- the same rule
 * Verloop.interval already states.
 */
import { appendFileSync, readFileSync, statSync } from "node:fs";
import type { LcuClient } from "../lcu/connector";
import { fetchGameTimeline, type GameTimeline } from "../lcu/timeline";
import type {
  HistorieTijdlijn, HistorieUitslag, SpelGebeurtenis, Verloop, VerloopKolommen,
} from "../../shared/types";
import { laanmetingenUit } from "../../shared/matchtijdlijn";
import { sluitAfgebrokenRegel } from "./tijdlijn";

/** One frame a minute is what the endpoint serves; stated so a reader is not left guessing. */
const INTERVAL_SECONDEN = 60;

/**
 * How long we wait for one timeline before giving up on it.
 *
 * Ten seconds against a measured 14 to 258 ms, so this only ever fires when the
 * client is wedged rather than slow. The underlying request is not torn down --
 * LcuClient has no cancellation and giving it one would change every call in the
 * app -- so what the timeout really does is stop the queue waiting on it. A
 * response that arrives late is simply nobody's any more.
 */
const WACHT_MAX_MS = 10_000;

/**
 * One request at a time, and at most four waiting behind it.
 *
 * Clicking through ten games in five seconds must not become ten simultaneous
 * requests into a real person's client. At the measured round trip, serial
 * fetching still lands each one in well under a second, so a queue of one costs
 * the person clicking nothing he can see.
 *
 * The queue drops its OLDEST entry rather than refusing the newest, because the
 * newest is the game actually on screen and the oldest is a row that was
 * scrolled past. Dropping a request is not an error state: the row that was
 * dropped will ask again the moment somebody opens it.
 */
const GELIJKTIJDIG = 1;
const WACHTRIJ_MAX = 4;

/** A courtesy gap between two requests, the same pace the crawler probe uses. */
const PAUZE_MS = 60;

/* ────────────────────────── turning frames into columns ───────────────────── */

const leegOf = <T>(n: number, waarde: T): T[] => new Array<T>(n).fill(waarde);

/**
 * The per-minute series, in exactly the Verloop shape the charts already read.
 *
 * `aantalStoelen` comes from the stored match rather than from the frames, so a
 * timeline that is missing a seat still produces ten columns and the missing one
 * reads as null throughout rather than shifting everybody after it up by one.
 *
 * Three of the six columns are measured directly, three are not:
 *
 *   cs      minionsKilled + jungleMinionsKilled, exactly as the stored match
 *           counts it, which is why the two agreed on all 100 seats checked.
 *   level   straight off the frame.
 *   kills   accumulated out of the CHAMPION_KILL events up to and including the
 *   deaths  events attached to that frame, so the value at tijden[i] is the
 *   assists scoreline as it stood at that moment. Verified against the stored
 *           final scoreline on 50 seats.
 *   wards   null for every reading, for every seat, always. The timeline carries
 *           no ward and no vision figure of any kind. A zero here would draw as
 *           a player who warded nothing, which is a different claim.
 *
 * A kill with killerId 0 -- an execution, seen in four of the five games checked
 * -- still counts as a death for the victim and as a kill for nobody, which is
 * how the stored scoreline counts it too.
 */
export function verloopUitTimeline(
  timeline: GameTimeline,
  aantalStoelen: number,
  jouwStoel: number | null,
): Verloop {
  const frames = timeline.frames;
  const tijden = frames.map((f) => Math.round(f.timestamp / 1000));

  const spelers: VerloopKolommen[] = [];
  for (let stoel = 0; stoel < aantalStoelen; stoel++) {
    spelers.push({
      kills: [], deaths: [], assists: [],
      cs: [], level: [],
      // Never measured. See the block above.
      wards: leegOf(frames.length, null),
    });
  }

  // Running totals, one per seat. Kept outside the frame loop because a
  // scoreline is cumulative: what stands at minute twenty is every event since
  // minute zero, not the events of minute twenty.
  const kills = leegOf(aantalStoelen, 0);
  const deaths = leegOf(aantalStoelen, 0);
  const assists = leegOf(aantalStoelen, 0);
  /**
   * Add one to a seat's tally, ignoring anything that is not one of the seats.
   *
   * killerId 0 is the case that matters: an execution by a minion or a turret,
   * seen in four of the five games checked. Nobody is credited with the kill,
   * exactly as the stored scoreline has it, but the victim still gets the death.
   */
  const tel = (teller: number[], participantId: number): void => {
    const i = participantId - 1;
    const huidig = teller[i];
    if (huidig !== undefined) teller[i] = huidig + 1;
  };

  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      if (event.type !== "CHAMPION_KILL") continue;
      tel(kills, event.killerId);
      tel(deaths, event.victimId);
      for (const id of event.assistingParticipantIds ?? []) tel(assists, id);
    }
    for (let stoel = 0; stoel < aantalStoelen; stoel++) {
      const kolom = spelers[stoel]!;
      const pf = frame.participantFrames[String(stoel + 1)];
      kolom.cs.push(pf ? pf.minionsKilled + pf.jungleMinionsKilled : null);
      kolom.level.push(pf ? pf.level : null);
      // The counters are not conditional on a frame being present: they are
      // derived from events, which exist whether or not that seat was listed.
      kolom.kills.push(kills[stoel]!);
      kolom.deaths.push(deaths[stoel]!);
      kolom.assists.push(assists[stoel]!);
    }
  }

  return {
    interval: INTERVAL_SECONDEN,
    tijden,
    // Verloop.goud has room for exactly one seat's gold in hand, because the
    // running game only ever reveals it for the player at the keyboard. Match
    // history is not so shy -- it gives currentGold for all ten -- but widening
    // this field would change the shape every line already in buildorders.jsonl
    // is written in. So this stays your seat only, the other nine travel in
    // HistorieTijdlijn.goudPerStoel, and neither source has to lie.
    goud:
      jouwStoel === null
        ? leegOf(frames.length, null)
        : frames.map((f) => f.participantFrames[String(jouwStoel + 1)]?.currentGold ?? null),
    spelers,
  };
}

/**
 * Total gold earned per seat per minute -- the one series this source has and
 * the recording does not.
 *
 * Kept apart from Verloop rather than added to VerloopKolommen. Adding a column
 * there would put a gold axis on the timeline screen that is permanently empty
 * for every live recording ever made, which trades a gap in one place for a gap
 * in a worse one.
 *
 * `totalGold` and not `currentGold`: earned, not in hand. It only goes up, so it
 * is a score, and a dip in the slope is the thing somebody looking for the
 * minute it went wrong is actually looking for.
 */
export function goudPerStoel(
  timeline: GameTimeline,
  aantalStoelen: number,
): Array<Array<number | null>> {
  const kolommen: Array<Array<number | null>> = [];
  for (let stoel = 0; stoel < aantalStoelen; stoel++) {
    kolommen.push(
      timeline.frames.map((f) => f.participantFrames[String(stoel + 1)]?.totalGold ?? null),
    );
  }
  return kolommen;
}

/**
 * The three kinds of event the frames carry, in the shape the screens use.
 *
 * Measured over four full games: BUILDING_KILL arrives with buildingType
 * TOWER_BUILDING or INHIBITOR_BUILDING, ELITE_MONSTER_KILL with monsterType
 * DRAGON or BARON_NASHOR. Nothing else appears.
 *
 * Two fields are honestly unfillable and are reported as such rather than
 * quietly defaulted:
 *
 *   soort "firstblood"  never emitted. The first champion kill of a game is
 *                       first blood by definition, but an execution is not, and
 *                       the timeline does not say which the first one was. A
 *                       plain "kill" is never wrong; a wrong "firstblood" is.
 *   gestolen            always false, because the timeline has no field for it
 *                       and no way to derive one. HistorieTijdlijn.gemeten says
 *                       so out loud, so nobody reads that false as a measurement.
 *
 * `detail` carries what the wire actually said: the tower ring, or the lane for
 * an inhibitor. Dragons come back with monsterSubType "UNKNOWN" on this map, so
 * the element is null rather than invented.
 *
 * On a BUILDING_KILL, `teamId` is the team that OWNED the building, not the team
 * that took it -- a tower with teamId 100 killed by participant 6. So `aan` is
 * left null: the victim of a building kill is a building, and this field is for
 * seats.
 */
export function gebeurtenissenUitTimeline(timeline: GameTimeline): SpelGebeurtenis[] {
  const stoel = (participantId: number): number | null =>
    participantId >= 1 && participantId <= 10 ? participantId - 1 : null;

  const uit: SpelGebeurtenis[] = [];
  for (const frame of timeline.frames) {
    for (const e of frame.events ?? []) {
      const basis = {
        at: Math.round(e.timestamp / 1000),
        door: stoel(e.killerId),
        assists: (e.assistingParticipantIds ?? [])
          .map(stoel)
          .filter((s): s is number => s !== null),
        gestolen: false,
      };
      if (e.type === "CHAMPION_KILL") {
        uit.push({ ...basis, soort: "kill", aan: stoel(e.victimId), detail: null });
      } else if (e.type === "BUILDING_KILL") {
        uit.push({
          ...basis,
          soort: e.buildingType === "INHIBITOR_BUILDING" ? "inhibitor" : "turret",
          aan: null,
          detail: e.towerType || e.laneType || null,
        });
      } else if (e.type === "ELITE_MONSTER_KILL") {
        uit.push({
          ...basis,
          soort: e.monsterType === "BARON_NASHOR" ? "baron" : "dragon",
          aan: null,
          detail: e.monsterSubType && e.monsterSubType !== "UNKNOWN" ? e.monsterSubType : null,
        });
      }
    }
  }
  return uit.sort((a, b) => a.at - b.at);
}

/** Everything above, assembled for one game. */
export function historieUitTimeline(
  gameId: number,
  timeline: GameTimeline,
  aantalStoelen: number,
  jouwStoel: number | null,
): HistorieTijdlijn {
  return {
    gameId,
    opgehaaldOp: Date.now(),
    verloop: verloopUitTimeline(timeline, aantalStoelen, jouwStoel),
    goudPerStoel: goudPerStoel(timeline, aantalStoelen),
    gebeurtenissen: gebeurtenissenUitTimeline(timeline),
    // Read here because this is the last place the coordinates exist. They are
    // the bulk of an 80 KB response, they answer one question -- which lane --
    // and the frames are dropped on the next line. Anything wanting this later
    // would have to fetch the whole timeline again for two numbers a seat.
    laanmetingen: laanmetingenUit(timeline.frames, aantalStoelen),
    jouwStoel,
    gemeten: {
      cs: true, level: true, kills: true, deaths: true, assists: true,
      wards: false, gestolen: false, aankopen: false, skills: false,
    },
  };
}

/* ────────────────────────────── the store itself ──────────────────────────── */

interface Verzoek {
  gameId: number;
  aantalStoelen: number;
  jouwStoel: number | null;
  /**
   * The stored creep score of each seat, in seat order, so a fetched timeline
   * can be checked against the record before anybody draws it. See stemtOvereen.
   */
  csPerStoel: number[];
}

/**
 * Does this timeline describe the seats we think it does?
 *
 * Seat i is participantId i+1. That holds today and it was measured rather than
 * hoped for: across 220 seats in 22 games the final frame agreed with the stored
 * record exactly -- not approximately -- on kills, deaths, assists, creeps, gold
 * and level, with zero mismatches on any of the six, and a second run over 100
 * seats in ten other games agreed on creeps just as exactly.
 *
 * None of which is a guarantee, because StoredPlayer carries no participantId,
 * so nothing in this app would notice the day the client starts ordering
 * `participants` differently. The failure mode is the quiet one: every player
 * gets somebody else's curve and the screen stays entirely believable. The check
 * costs one comparison per seat and was exact on every seat ever measured, so
 * there is no reason to run without it.
 *
 * It rejects and never repairs. Re-deriving the seat order from the numbers
 * cannot work: in game 7955631201 three of the ten seats finished on identical
 * gold and identical creeps (1048 and 0), so a best-numeric-match matcher
 * collapses all three onto one participantId while the plain index mapping is
 * exact. A wrong curve drawn confidently is worse than no curve at all.
 */
export function stemtOvereen(timeline: GameTimeline, csPerStoel: number[]): boolean {
  const laatste = timeline.frames[timeline.frames.length - 1]?.participantFrames;
  if (!laatste) return false;
  return csPerStoel.every((cs, stoel) => {
    const pf = laatste[String(stoel + 1)];
    // A seat the last frame never listed is a gap rather than a contradiction:
    // the columns carry null there and the chart says so.
    return pf === undefined || pf.minionsKilled + pf.jungleMinionsKilled === cs;
  });
}

/**
 * The timelines we have already paid for, and the queue for the ones we have not.
 *
 * ── Why one JSONL and not one file per game ──────────────────────────────────
 *
 * A file per game means a directory that grows one entry per row anybody has
 * ever opened, and on NTFS a 6 KB payload occupies a 4 KB-cluster file plus an
 * MFT record, so the small ones round up badly. One append-only JSONL is also
 * what matches.jsonl and buildorders.jsonl already are, which means it inherits
 * the guard those two live by -- see sluitAfgebrokenRegel -- instead of needing
 * a new one.
 *
 * Size, at the measured mean of 14.9 KB a game: 100 games opened is 1.5 MB, and
 * it takes opening about 670 distinct games to reach 10 MB. This only ever grows
 * by rows a person actually clicked -- never by crawling, never in the
 * background -- so that is the ceiling in practice, and the whole file is read
 * once and kept in memory. Fetching all 130,086 up front would be 1.9 GB and,
 * at the measured mean round trip of 116 ms plus the pause below, about six and
 * a half hours of requests through somebody's game client. That is the other
 * half of why this is on demand.
 *
 * If it ever does become a file worth streaming, the change is an offset index
 * rather than a new format: the lines are already independent.
 *
 * ── What is not cached ───────────────────────────────────────────────────────
 *
 * A game with no timeline is remembered in memory only, not written down. That
 * keeps a session of clicking from re-asking, and it lets the next run check
 * again -- because a 404 is a statement about what the client can reach today,
 * and this app spends its life waiting for a client that comes and goes.
 */
export class HistorieTijdlijnStore {
  private inhoud: Map<number, HistorieTijdlijn> | null = null;
  /** gameIds that came back 404 this run. Never written to disk; see above. */
  private readonly zonderTijdlijn = new Set<number>();
  /**
   * Failures waiting to be reported, by gameId.
   *
   * Held only until somebody asks, then dropped. A failure that stuck would
   * leave the panel apologising for a client that came back five minutes ago;
   * one that vanished silently would leave it saying "busy" forever. Reporting
   * once and then forgetting is the only version where reopening the row is a
   * real retry.
   */
  private readonly mislukt = new Map<number, string>();
  private readonly bezig = new Set<number>();
  private wachtrij: Verzoek[] = [];
  private lopend = 0;

  /**
   * @param pad         where the cache lives.
   * @param clientVan   the connected client, or null. Asked per request rather
   *                    than held, because the client disappears and comes back
   *                    with a different port and a stale reference would be a
   *                    request into nothing.
   * @param opGeland    called after a fetch settles, so whoever is looking at
   *                    that game can ask again. Never called for a cache hit --
   *                    that answer was already handed over synchronously.
   */
  constructor(
    private readonly pad: string,
    private readonly clientVan: () => LcuClient | null,
    private readonly opGeland: (gameId: number) => void,
  ) {}

  private laad(): Map<number, HistorieTijdlijn> {
    if (this.inhoud) return this.inhoud;
    const kaart = new Map<number, HistorieTijdlijn>();
    try {
      statSync(this.pad);
      for (const regel of readFileSync(this.pad, "utf8").split("\n")) {
        const tekst = regel.trim();
        if (!tekst) continue;
        try {
          const ontleed = JSON.parse(tekst) as HistorieTijdlijn;
          // Last line wins, so a game fetched twice reads back as the newer one.
          if (typeof ontleed?.gameId === "number") kaart.set(ontleed.gameId, ontleed);
        } catch {
          // A half-written line costs one game, not the file. Same rule the
          // match store and the recordings live by.
        }
      }
    } catch {
      // No file yet is the normal state until the first game is opened.
    }
    this.inhoud = kaart;
    return kaart;
  }

  /**
   * What we can say about one game right now, without waiting for anything.
   *
   * Synchronous on purpose: gameDetail is synchronous, and the point of this
   * whole file is that opening a game draws immediately. When the answer is
   * "bezig" a fetch has just been scheduled and opGeland will fire; when it is
   * "geen-client" nothing was scheduled and nothing will happen until League is
   * running, which is a fact about the world and not a fault.
   */
  uitslagVoor(
    gameId: number,
    aantalStoelen: number,
    jouwStoel: number | null,
    csPerStoel: number[],
  ): HistorieUitslag {
    const gevonden = this.laad().get(gameId);
    // A cached line only answers the question that was asked if it was built for
    // the same seat. `verloop.goud` holds gold in hand for one seat and one seat
    // only, chosen at fetch time -- so a game first opened during the window
    // after the client connects but before the summoner lands cached a column of
    // nulls for your own wallet, and without this it would keep serving them
    // back forever. Only the null-to-known direction refetches; a seat we
    // already know never turns into a different one.
    if (gevonden && !(gevonden.jouwStoel === null && jouwStoel !== null)) {
      return { staat: "gevonden", tijdlijn: gevonden };
    }
    if (this.zonderTijdlijn.has(gameId)) return { staat: "geen-tijdlijn" };
    const fout = this.mislukt.get(gameId);
    if (fout !== undefined) {
      this.mislukt.delete(gameId);
      return { staat: "mislukt", reden: fout };
    }
    if (!this.clientVan()) return { staat: "geen-client" };
    this.plan({ gameId, aantalStoelen, jouwStoel, csPerStoel });
    return { staat: "bezig" };
  }

  /** Queue one fetch, deduplicating and dropping the stalest if we are behind. */
  private plan(verzoek: Verzoek): void {
    if (this.bezig.has(verzoek.gameId)) return;
    if (this.wachtrij.some((w) => w.gameId === verzoek.gameId)) return;
    this.bezig.add(verzoek.gameId);
    this.wachtrij.push(verzoek);
    while (this.wachtrij.length > WACHTRIJ_MAX) {
      // Oldest out. Nobody is looking at that row any more, and a dropped
      // request costs nothing: opening it again asks again.
      const weg = this.wachtrij.shift();
      if (!weg) break;
      this.bezig.delete(weg.gameId);
      // Being dropped still counts as settled, and saying so is not optional.
      // uitslagVoor already answered "bezig" for this game, which is a promise
      // that something will happen; going quiet here would leave a screen
      // spinning on a request that no longer exists. Announcing it makes the
      // screen ask again, and an asker who is still on that game re-queues it as
      // the newest entry -- which is the one that gets served next. An asker who
      // has moved on never asks, and the request stays dropped. Either way it
      // terminates.
      this.opGeland(weg.gameId);
    }
    this.werkAf();
  }

  private werkAf(): void {
    if (this.lopend >= GELIJKTIJDIG) return;
    // Newest first. Somebody who clicked five rows in four seconds is looking at
    // the fifth, so that is the one worth a round trip; the four behind it are
    // served afterwards if they survive the queue at all.
    const volgende = this.wachtrij.pop();
    if (!volgende) return;
    this.lopend++;
    void this.haal(volgende).finally(() => {
      this.lopend--;
      this.bezig.delete(volgende.gameId);
      this.opGeland(volgende.gameId);
      if (this.wachtrij.length > 0) setTimeout(() => this.werkAf(), PAUZE_MS);
    });
  }

  private async haal(verzoek: Verzoek): Promise<void> {
    const client = this.clientVan();
    if (!client) return;
    try {
      const timeline = await this.metTijdslimiet(fetchGameTimeline(client, verzoek.gameId));
      if (!timeline) {
        // 404, or frames the client answered with but did not fill. Either way
        // there is nothing to draw and nothing to keep.
        this.zonderTijdlijn.add(verzoek.gameId);
        return;
      }
      // Checked before it is kept, so a scrambled curve is never cached and
      // never drawn. Reported as a failure rather than as "no timeline", because
      // a timeline that contradicts the record is a fault worth seeing and not
      // an absence to shrug at.
      if (!stemtOvereen(timeline, verzoek.csPerStoel)) {
        this.mislukt.set(
          verzoek.gameId,
          "the timeline's seats do not line up with the stored match, so no curve is drawn",
        );
        console.warn(
          `[allmid] tijdlijn ${verzoek.gameId}: participantId 1..10 does not match the stored` +
            ` scoreline; refusing to draw it rather than guessing at the order`,
        );
        return;
      }
      const historie = historieUitTimeline(
        verzoek.gameId, timeline, verzoek.aantalStoelen, verzoek.jouwStoel,
      );
      this.laad().set(verzoek.gameId, historie);
      this.schrijf(historie);
    } catch (err) {
      // A failure is not an absence, so it is never written down as one. It is
      // held just long enough to be told to the screen once, and reopening the
      // row after that is a real retry.
      const reden = (err as Error)?.message ?? String(err);
      this.mislukt.set(verzoek.gameId, reden);
      console.warn(`[allmid] tijdlijn ${verzoek.gameId} mislukt: ${reden}`);
    }
  }

  /** See WACHT_MAX_MS: this frees the queue, it does not cancel the request. */
  private metTijdslimiet<T>(belofte: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const klok = setTimeout(
        () => reject(new Error(`geen antwoord binnen ${WACHT_MAX_MS} ms`)),
        WACHT_MAX_MS,
      );
      belofte.then(resolve, reject).finally(() => clearTimeout(klok));
    });
  }

  private schrijf(historie: HistorieTijdlijn): void {
    try {
      sluitAfgebrokenRegel(this.pad);
      appendFileSync(this.pad, JSON.stringify(historie) + "\n", "utf8");
    } catch (err) {
      // Losing the cache costs a second request next time and nothing else, so
      // it must never cost the curve that is already in memory.
      console.warn(
        `[allmid] tijdlijn ${historie.gameId} niet bewaard: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}
