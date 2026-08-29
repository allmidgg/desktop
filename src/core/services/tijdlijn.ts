/**
 * Reads back the games this app watched, and works out which stored match each
 * one was.
 *
 * ── The thing this file exists to work around ────────────────────────────────
 *
 * This file used to open by stating that Classic match history has no timeline.
 * That was wrong, and it was wrong for as long as anyone had bothered to check:
 * `/lol-match-history/v1/game-timelines/{gameId}` answers 200 with one frame a
 * minute, for games this account never played. See core/lcu/timeline.ts, which
 * has the measurements. The claim traced back to `Participant.timeline` being
 * typed as `{ lane, role }` -- true, and about lane assignment rather than
 * frames -- and nobody had ever asked for a timeline as a resource of its own.
 *
 * That does not make this file redundant, because the two sources hold
 * different things. The match-history timeline carries gold, xp, levels, creeps
 * and positions per minute, and exactly three kinds of event: champion kills,
 * buildings, and elite monsters. It carries no item purchases and no skill
 * levels at all. So the recording this file reads is still the only source for
 * when an item was bought, and it is still the only one that samples finer than
 * a minute. They complement each other; neither replaces the other.
 *
 * What this file reads is the game itself. While it runs, the Live Client Data
 * API on port 2999 reports every inventory second by second and hands over its
 * whole event feed with timestamps, and the watcher writes it down.
 *
 * ── Why joining is not just a lookup ─────────────────────────────────────────
 *
 * A recording has no game id, because the Live Client Data API does not have
 * one to give -- the watcher says so itself, and it is why a new game is
 * detected on the clock running backwards. So the recording and the match are
 * matched on what they both describe, and the reasoning is handed to the screen
 * rather than swallowed, because a join you cannot inspect is a guess.
 */
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { GameTijdlijn, OpnameRecord, OpnameSpeler, TijdlijnKoppeling } from "../../shared/types";
import type { StoredMatch } from "./matchStore";

/**
 * How long after a game ends the recording may still be written.
 *
 * The harvest fires when the server on 2999 stops answering, which is seconds
 * after the game ends -- but a client that hangs on the end-of-game screen, or a
 * machine that went to sleep mid-poll, can stretch it. Half an hour is loose
 * enough to survive that and still far tighter than the gap between two games.
 */
const NA_EINDE_MAX_MS = 30 * 60_000;
/** A recording written before its own game started is not that game. */
const VOOR_EINDE_MARGE_MS = 120_000;

/**
 * The old per-player line shape, kept only so the file stays readable.
 *
 * These were written one per player with the game's fields repeated on each, and
 * they carry no side and no events, because at the time nothing recorded either.
 * Nothing fills that in afterwards.
 */
interface OudeRegel {
  recordedAt: number;
  gameMode?: string;
  mapNumber?: number;
  gameLengthSeconds?: number;
  championId?: number | null;
  championName?: string;
  position?: OpnameSpeler["position"];
  level?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  cs?: number;
  build?: OpnameSpeler["build"];
  skillOrder?: string[];
}

const isNieuweRegel = (regel: unknown): regel is OpnameRecord =>
  typeof regel === "object" && regel !== null && Array.isArray((regel as OpnameRecord).spelers);

/**
 * Folds the old per-player lines back into games.
 *
 * They were written in one pass with one Date.now(), so every line from the same
 * game carries the identical millisecond. That is not a heuristic -- it is the
 * grouping the writer used and never wrote down.
 */
function bundelOudeRegels(regels: OudeRegel[]): OpnameRecord[] {
  const per = new Map<number, OudeRegel[]>();
  for (const r of regels) {
    const lijst = per.get(r.recordedAt);
    if (lijst) lijst.push(r);
    else per.set(r.recordedAt, [r]);
  }

  return [...per.entries()].map(([recordedAt, lijst]) => ({
    recordedAt,
    gameMode: lijst[0]?.gameMode ?? "",
    mapNumber: lijst[0]?.mapNumber ?? 0,
    gameLengthSeconds: lijst[0]?.gameLengthSeconds ?? 0,
    spelers: lijst.map((r) => ({
      championId: r.championId ?? null,
      championName: r.championName ?? "",
      // Nothing recorded the side back then. Left honest rather than guessed at
      // from array order, which the client never promised; the join fills it in
      // from match history when it can, and says that it did.
      team: "UNKNOWN" as const,
      position: r.position ?? null,
      level: r.level ?? 0,
      kills: r.kills ?? 0,
      deaths: r.deaths ?? 0,
      assists: r.assists ?? 0,
      cs: r.cs ?? 0,
      build: r.build ?? [],
      ...(r.skillOrder ? { skillOrder: r.skillOrder } : {}),
    })),
    gebeurtenissen: [],
  }));
}

/**
 * Closes a line a previous write did not finish, before anything is appended.
 *
 * The match store already lives by this rule and its own header says why: a
 * write that breaks halfway leaves a record with no newline after it, and
 * whoever appends behind that glues his first record onto the broken half, so
 * one interruption costs two games instead of one -- and the second one
 * silently, because the append reported success.
 *
 * buildorders.jsonl never had the guard and needs it more than it used to. The
 * line was around 7,500 bytes when it held ten scorelines and their purchases;
 * with a score curve on it, it is several times that. A bigger write is a wider
 * window to be interrupted in, and the thing now at risk is the only copy of
 * how a game went.
 *
 * The already-broken line is still lost. That one cannot be recovered by
 * anybody; what this prevents is it taking the next game down with it.
 */
export function sluitAfgebrokenRegel(pad: string): void {
  let grootte = 0;
  try {
    grootte = statSync(pad).size;
  } catch {
    // No file yet: the first append creates it, and it will end in a newline.
    return;
  }
  if (grootte === 0) return;

  let fd: number | null = null;
  try {
    fd = openSync(pad, "r");
    const laatste = Buffer.allocUnsafe(1);
    readSync(fd, laatste, 0, 1, grootte - 1);
    if (laatste[0] !== 0x0a) appendFileSync(pad, "\n", "utf8");
  } catch {
    // Failing to tidy up is not a reason to lose the game we came here to write.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Reads one JSONL file into recordings, tolerating both line shapes. */
export function leesOpnames(inhoud: string): OpnameRecord[] {
  const nieuw: OpnameRecord[] = [];
  const oud: OudeRegel[] = [];

  for (const regel of inhoud.split("\n")) {
    const tekst = regel.trim();
    if (!tekst) continue;
    let ontleed: unknown;
    try {
      ontleed = JSON.parse(tekst);
    } catch {
      // A half-written last line costs one game, not the file. Same rule the
      // match store lives by.
      continue;
    }
    if (isNieuweRegel(ontleed)) nieuw.push(ontleed);
    else if (typeof (ontleed as OudeRegel)?.recordedAt === "number") oud.push(ontleed as OudeRegel);
  }

  return [...nieuw, ...bundelOudeRegels(oud)].sort((a, b) => b.recordedAt - a.recordedAt);
}

/** A sorted multiset key, so ten champions compare as a set and not as an order. */
const championSleutel = (ids: Array<number | null>): string =>
  ids.filter((id): id is number => id !== null).sort((a, b) => a - b).join(",");

/**
 * Decides whether a recording is this match, and shows its work.
 *
 * Two hard requirements. The ten champions have to be the same ten -- that alone
 * is a strong fingerprint, since it is one specific line-up -- and the recording
 * has to have been written in the window right after the game ended. Everything
 * else is reported rather than required: scorelines can differ by a kill because
 * the last poll before the game ended is a second or two before the last kill,
 * and the live clock runs from a different zero than Riot's duration does. Those
 * are measurements of how good the match is, and they go on screen.
 */
export function koppel(opname: OpnameRecord, match: StoredMatch): TijdlijnKoppeling | null {
  if (opname.spelers.length !== match.players.length) return null;
  if (championSleutel(opname.spelers.map((s) => s.championId)) !==
      championSleutel(match.players.map((p) => p.championId))) {
    return null;
  }

  const einde = match.createdAt + match.duration * 1000;
  const na = opname.recordedAt - einde;
  if (na < -VOOR_EINDE_MARGE_MS || na > NA_EINDE_MAX_MS) return null;

  // Champion plus the four counters, consumed one by one, so two seats on the
  // same champion cannot both claim the same scoreline.
  const rest = match.players.map((p) => `${p.championId}|${p.kills}|${p.deaths}|${p.assists}|${p.cs}`);
  let gelijkeScores = 0;
  for (const s of opname.spelers) {
    const sleutel = `${s.championId}|${s.kills}|${s.deaths}|${s.assists}|${s.cs}`;
    const i = rest.indexOf(sleutel);
    if (i !== -1) {
      rest.splice(i, 1);
      gelijkeScores++;
    }
  }

  return {
    gameId: match.gameId,
    gelijkeScores,
    spelers: opname.spelers.length,
    naEindeSeconden: Math.round(na / 1000),
    duurVerschilSeconden: opname.gameLengthSeconds - match.duration,
    teamsUitMatch: opname.spelers.every((s) => s.team === "UNKNOWN"),
  };
}

/**
 * Fills in the side from match history for recordings that never stored one.
 *
 * Only ever from the match, never from the order the client happened to list
 * players in -- that order is not promised anywhere. A champion picked on both
 * sides in the same game is left alone rather than assigned to whichever team
 * came first.
 */
function vulTeamsAan(opname: OpnameRecord, match: StoredMatch): OpnameRecord {
  const perChampion = new Map<number, number[]>();
  for (const p of match.players) {
    const lijst = perChampion.get(p.championId);
    if (lijst) lijst.push(p.teamId);
    else perChampion.set(p.championId, [p.teamId]);
  }

  return {
    ...opname,
    spelers: opname.spelers.map((s) => {
      if (s.team !== "UNKNOWN" || s.championId === null) return s;
      const kanten = perChampion.get(s.championId) ?? [];
      const uniek = [...new Set(kanten)];
      if (uniek.length !== 1) return s;
      return { ...s, team: uniek[0] === 100 ? ("ORDER" as const) : ("CHAOS" as const) };
    }),
  };
}

/**
 * The recordings on disk, read once and kept until the file changes.
 *
 * Synchronous because gameDetail is, and because this is one small file that is
 * appended to once per game you play. Re-read on mtime so a game that just ended
 * shows up without a restart.
 */
export class TijdlijnStore {
  private opnames: OpnameRecord[] | null = null;
  private gelezenOp = 0;

  constructor(private readonly pad: string) {}

  /** Drop the cache. Called right after a game is written down. */
  vergeet(): void {
    this.opnames = null;
  }

  private laad(): OpnameRecord[] {
    let mtime = 0;
    try {
      mtime = statSync(this.pad).mtimeMs;
    } catch {
      // No file yet is the normal state until the first game is played.
      this.opnames = [];
      return this.opnames;
    }
    if (this.opnames && mtime === this.gelezenOp) return this.opnames;
    try {
      this.opnames = leesOpnames(readFileSync(this.pad, "utf8"));
      this.gelezenOp = mtime;
    } catch {
      this.opnames = [];
    }
    return this.opnames;
  }

  /** Every recording, newest first. */
  alle(): OpnameRecord[] {
    return this.laad();
  }

  /**
   * The timeline for one stored match, if this machine happened to watch it.
   *
   * Null is the ordinary answer: the crawler collects other people's games by
   * the tens of thousands and nobody was watching any of them.
   */
  voor(match: StoredMatch): GameTijdlijn | null {
    let beste: GameTijdlijn | null = null;
    for (const opname of this.laad()) {
      const koppeling = koppel(opname, match);
      if (!koppeling) continue;
      // More agreeing scorelines wins; on a tie, the recording written closest
      // to the end of the game.
      const beter =
        !beste ||
        koppeling.gelijkeScores > beste.koppeling.gelijkeScores ||
        (koppeling.gelijkeScores === beste.koppeling.gelijkeScores &&
          Math.abs(koppeling.naEindeSeconden) < Math.abs(beste.koppeling.naEindeSeconden));
      if (beter) beste = { opname: vulTeamsAan(opname, match), koppeling };
    }
    return beste;
  }
}
