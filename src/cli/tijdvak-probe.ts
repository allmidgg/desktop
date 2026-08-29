/**
 * Runs the timeline verdicts over real games, against the running client, and
 * prints what the screen would say.
 *
 *   npm run tijdvak-probe                 twelve random games from the store
 *   npm run tijdvak-probe -- 30           thirty of them
 *   npm run tijdvak-probe -- 8 mine       eight of this account's own games
 *
 * The sibling of oordeel-probe.ts and deliberately not a copy of it. That one
 * reads matches off disk with League closed, which is the right test for rules
 * built on end-of-game totals. Every rule in shared/tijdvak.ts needs a per-minute
 * timeline, and the only place a timeline exists is the client's own match
 * history endpoint -- so this probe cannot run without League, and says so
 * rather than printing a page of silences that look like bugs.
 *
 * Every seat is treated as "you" in turn, exactly as oordeel-probe does, because
 * the store is almost entirely other people's games: isYou is false on all ten
 * in 130,067 of the 130,086 records. Pretending a seat is the local player is
 * what gives this anything to say, and it walks the same code path the screen
 * does.
 *
 * One request per game, with a pause between them. This talks to a real person's
 * League client, so a probe that hammers it is a probe that should not exist.
 */
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { fetchGameTimeline } from "../core/lcu/timeline";
import { historieUitTimeline } from "../core/services/historieTijdlijn";
import { MatchStore, defaultStorePath, type StoredMatch } from "../core/services/matchStore";
import { leesTijdvak } from "../shared/tijdvak";
import type { GameDetail } from "../shared/types";

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m",
};

/** Milliseconds between requests. Somebody is using this client. */
const PAUZE_MS = 150;

/**
 * A GameDetail with everything the timeline rules read and nothing else.
 *
 * The fields left null are the ones only the main process can fill -- baselines
 * need the tallies, `tijdlijn` needs a recording. shared/tijdvak.ts touches
 * neither, which is itself worth checking: if this probe ever stops compiling
 * because a rule reached for a baseline, that rule has quietly become unable to
 * answer for a crawled game.
 */
function detailVan(match: StoredMatch, stoel: number): GameDetail {
  return {
    gameId: match.gameId,
    createdAt: match.createdAt,
    durationSeconds: match.duration,
    queueId: match.queueId,
    patch: match.patch,
    surrendered: match.surrendered,
    baseline: null,
    tijdlijn: null,
    historie: { staat: "geen-client" },
    players: match.players.map((p, i) => ({
      championId: p.championId,
      team: p.teamId,
      position: p.position,
      win: p.win,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      cs: p.cs,
      gold: p.gold,
      items: p.items,
      spells: p.spells,
      damage: p.damage,
      damageTaken: p.damageTaken,
      vision: p.vision,
      wards: p.wards,
      level: p.level,
      ijklijn: null,
      isYou: i === stoel,
    })),
  };
}

async function main(): Promise<void> {
  const hoeveel = Number(process.argv[2] ?? 12) || 12;
  const alleenEigen = process.argv[3] === "mine";

  let client: LcuClient;
  try {
    client = await LcuClient.connect();
  } catch (err) {
    if (err instanceof LcuNotRunningError) {
      console.error(
        "League is not running. Every rule in shared/tijdvak.ts reads a per-minute\n" +
        "timeline, and the only place one exists is the client's own match-history\n" +
        "endpoint. There is nothing to probe with the client closed -- which is the\n" +
        "same thing the screen tells the user, for the same reason.",
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const store = new MatchStore(defaultStorePath(process.cwd()));
  await store.load();
  const alle = store.all();

  const eigen = new Set<number>();
  if (alleenEigen) {
    const mij = await client.get<{ puuid: string }>("/lol-summoner/v1/current-summoner");
    for (const m of alle) if (m.players.some((p) => p.puuid === mij.puuid)) eigen.add(m.gameId);
    console.log(`${c.dim}${eigen.size} of ${alle.length.toLocaleString("en-GB")} stored games are this account's own${c.reset}`);
  }
  const vijver = alleenEigen ? alle.filter((m) => eigen.has(m.gameId)) : alle;
  console.log(`${c.dim}${vijver.length.toLocaleString("en-GB")} games to draw from, ${hoeveel} sampled, one request each${c.reset}\n`);

  const uitspraken = new Map<string, number>();
  const stiltes = new Map<string, number>();
  let gedaan = 0;
  let geenTijdlijn = 0;

  for (let poging = 0; poging < hoeveel * 4 && gedaan < hoeveel; poging++) {
    const match = vijver[Math.floor(Math.random() * vijver.length)];
    if (!match) continue;

    const timeline = await fetchGameTimeline(client, match.gameId);
    await new Promise((r) => setTimeout(r, PAUZE_MS));
    if (!timeline) {
      geenTijdlijn++;
      continue;
    }

    const stoel = Math.floor(Math.random() * match.players.length);
    const detail = detailVan(match, stoel);
    const historie = historieUitTimeline(match.gameId, timeline, match.players.length, stoel);

    // The one check that proves the seat order before a word is printed. Every
    // curve below is indexed by participantId minus one, and the final frame's
    // totalGold is the same number match history reports as gold earned -- so if
    // those ten agree, the mapping held for this game. Measured over 99 games it
    // held on 990 of 990 seats; it is checked anyway, because the failure mode
    // is ten confident curves belonging to the wrong people.
    const laatste = historie.verloop.tijden.length - 1;
    const mis = match.players.filter(
      (p, i) => (historie.goudPerStoel[i]?.[laatste] ?? -1) !== p.gold,
    ).length;

    const jij = match.players[stoel];
    if (!jij) continue;
    gedaan++;
    console.log(
      `${c.bold}game ${match.gameId}${c.reset} ${c.dim}seat ${stoel + 1}, champion ${jij.championId} ` +
      `(stored ${jij.position}), ${jij.kills}/${jij.deaths}/${jij.assists}, ` +
      `${(match.duration / 60).toFixed(1)} min, ${historie.verloop.tijden.length} frames${c.reset}` +
      (mis > 0 ? ` ${c.red}SEAT ORDER MISMATCH on ${mis} of 10${c.reset}` : ` ${c.dim}seat order verified on 10/10${c.reset}`),
    );

    const uit = leesTijdvak(historie, detail, () => null);
    // Both lists, because the screen shows both: `altijd` holds the rows a band
    // may not filter out. Printing only `uitspraken` here would make the probe
    // quieter than the app, which is the wrong way round for a check.
    for (const u of [...uit.uitspraken, ...uit.altijd]) {
      const kleur = u.toon === "goed" ? c.green : u.toon === "slecht" ? c.red : c.cyan;
      const ster = u.tier === "ver" ? `${c.yellow}*${c.reset}` : " ";
      console.log(`  ${ster}${kleur}${u.gebied}:${c.reset} ${u.zin}`);
      console.log(`    ${c.dim}${u.cijfers}${c.reset}`);
      if (u.band && u.gat !== null) {
        const toon = u.band.ratio
          ? (n: number) => `${(n * 100).toFixed(1)}%`
          : (n: number) => Math.round(n).toLocaleString("en-GB");
        console.log(
          `    ${c.dim}gap ${toon(u.gat)} on ${u.band.maat}; half sit within ${toon(u.band.helft)}, ` +
          `one in ten passes ${toon(u.band.staart)} — over ${u.band.slots} ${u.band.herkomst}${c.reset}`,
        );
      }
      uitspraken.set(u.sleutel, (uitspraken.get(u.sleutel) ?? 0) + 1);
    }
    for (const z of uit.zwijgt) {
      console.log(`  ${c.dim}silent on ${z.onderwerp}: ${z.reden}${c.reset}`);
      stiltes.set(z.onderwerp, (stiltes.get(z.onderwerp) ?? 0) + 1);
    }
    console.log();
  }

  console.log(`${c.bold}Statements fired, over ${gedaan} seats${c.reset}`);
  for (const [sleutel, n] of [...uitspraken].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sleutel.padEnd(14)} ${n}`);
  }
  console.log(`${c.bold}Silences${c.reset}`);
  for (const [onderwerp, n] of [...stiltes].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${onderwerp.padEnd(32)} ${n}`);
  }
  if (geenTijdlijn > 0) console.log(`${c.dim}${geenTijdlijn} games answered 404: no timeline${c.reset}`);
}

void main();
