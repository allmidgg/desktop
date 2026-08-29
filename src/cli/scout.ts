/**
 * AllMid scout -- terminalversie van de champ select-scout.
 *
 * Zonder argumenten: analyseert de tien spelers uit je laatste game, in de modus
 * van die game. Met een Riot-ID (`npm run scout -- Faker#KR1`): analyseert die
 * ene speler, met een blok per modus waarin hij games heeft.
 *
 * Dit is bewust een CLI: het bewijst dat de complete datalaag klopt voordat er
 * ook maar een pixel UI bestaat.
 */
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { GameCatalog, type CatalogView } from "../core/jade/catalog";
import type { Game } from "../core/lcu/types";
import { COLLECTED_MODES, modeCollects, modeLabel, type CollectedMode } from "../core/modes/registry";
import {
  buildPlayerProfile,
  fetchCurrentSummoner,
  fetchRecentGames,
  fetchSummonerByRiotId,
  modeOfGame,
  participantOf,
  type PlayerProfile,
} from "../core/services/player";

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

async function main(): Promise<void> {
  const client = await LcuClient.connect();
  const catalogus = await GameCatalog.load(client);
  for (const warning of catalogus.warnings) console.warn(`${c.yellow}! ${warning}${c.reset}`);
  const arg = process.argv.slice(2).join(" ").trim();
  // The whole catalogue rather than one mode's view of it: which names to print
  // follows from the game being scouted, and that is not known yet here.
  if (arg) return scoutSinglePlayer(client, catalogus, arg);
  return scoutLastGame(client, catalogus);
}

async function scoutSinglePlayer(client: LcuClient, catalogus: GameCatalog, riotId: string): Promise<void> {
  const [gameName, tagLine] = riotId.split("#");
  if (!gameName || !tagLine) {
    console.error("Geef een volledig Riot-ID op, bijvoorbeeld: npm run scout -- Faker#KR1");
    process.exitCode = 1;
    return;
  }
  const summoner = await fetchSummonerByRiotId(client, gameName, tagLine);
  if (!summoner) {
    console.error(`Speler ${riotId} niet gevonden.`);
    process.exitCode = 1;
    return;
  }
  const profile = await buildPlayerProfile(client, summoner.puuid, 30);
  console.log();
  // One block per mode this player has games in, never one block averaging
  // them: without a lobby to scout there is no single mode to pick, and the
  // honest answer to "how does he play" is then two answers.
  const gespeeld = COLLECTED_MODES.filter((mode) => profile.perModus[mode]);
  if (gespeeld.length === 0) {
    console.log(`  ${c.dim}geen games in een modus die we volgen${c.reset}`);
    return;
  }
  for (const mode of gespeeld) {
    console.log(`${c.dim}${modeLabel(mode)}${c.reset}`);
    printProfile(profile, catalogus.for(mode), mode, null);
  }
}

async function scoutLastGame(client: LcuClient, catalogus: GameCatalog): Promise<void> {
  const me = await fetchCurrentSummoner(client);
  console.log(`\n${c.bold}AllMid${c.reset} ${c.dim}// ingelogd als ${me.gameName}#${me.tagLine}${c.reset}`);

  const [recent] = await fetchRecentGames(client, me.puuid, 1);
  if (!recent) {
    console.log("Geen games gevonden in je matchhistorie.");
    return;
  }
  const detail = await client.get<Game>(`/lol-match-history/v1/games/${recent.gameId}`);
  // The names come from the mode of the game in front of us. Printing the
  // Classic catalogue over a modern game would not fail; it would print the
  // wrong champions, which is worse.
  const modus = modeOfGame(detail);
  if (!modeCollects(modus)) {
    console.log(`Je laatste game (${modeLabel(modus)}) hoort in geen enkele bak, dus scouten we hem niet.`);
    return;
  }
  const catalog = catalogus.for(modus);
  const mine = participantOf(detail, me.puuid);
  const date = new Date(detail.gameCreation).toLocaleString("nl-NL");
  const minutes = Math.floor(detail.gameDuration / 60);

  console.log(
    `${c.dim}Laatste game: ${date} - ${minutes} min - queue ${detail.queueId} - ` +
      `patch ${detail.gameVersion.split(".").slice(0, 2).join(".")}${c.reset}\n`,
  );

  // Alle tien spelers parallel opvragen; de client houdt dit prima bij.
  const profiles = await Promise.all(
    detail.participantIdentities.map(async (identity) => ({
      identity,
      profile: await buildPlayerProfile(client, identity.player.puuid, 20),
    })),
  );

  for (const teamId of [100, 200]) {
    const isMyTeam = mine?.participant.teamId === teamId;
    const won = detail.teams.find((t) => t.teamId === teamId)?.win;
    const outcome = won === "Win" || won === true ? `${c.green}gewonnen${c.reset}` : `${c.red}verloren${c.reset}`;
    console.log(
      `${c.bold}${teamId === 100 ? "Blauw" : "Rood"}${c.reset} ${outcome}` +
        (isMyTeam ? ` ${c.dim}(jouw team)${c.reset}` : ""),
    );
    console.log(c.dim + "-".repeat(96) + c.reset);

    for (const { identity, profile } of profiles) {
      const participant = detail.participants.find((p) => p.participantId === identity.participantId);
      if (!participant || participant.teamId !== teamId) continue;
      printProfile(profile, catalog, modus, participant.championId, identity.player.puuid === me.puuid);
    }
    console.log();
  }
}

function printProfile(
  profile: PlayerProfile,
  catalog: CatalogView,
  mode: CollectedMode,
  playedChampionId: number | null,
  isMe = false,
): void {
  // The named mode's numbers or none at all. Nothing here borrows the other
  // mode's summary to fill a gap.
  const stats = profile.perModus[mode] ?? null;
  const name = (isMe ? `${c.cyan}${profile.riotId}${c.reset}` : profile.riotId).padEnd(isMe ? 34 : 25);
  const champ = playedChampionId ? catalog.championName(playedChampionId).padEnd(14) : "".padEnd(14);
  // The rank column is the Classic ladder. Modern solo queue is a different
  // ladder that this app does not read, so it stays blank rather than repeating
  // a tier earned somewhere else.
  const rank = (mode === "lol:jade" ? (profile.rank?.label ?? "Unranked") : "").padEnd(18);

  const wr = stats ? Math.round(stats.winrate * 100) : 0;
  const wrColor = !stats || stats.games === 0 ? c.dim : wr >= 55 ? c.green : wr <= 45 ? c.red : c.yellow;
  const wrText = !stats || stats.games === 0 ? "geen data" : `${wr}% (${stats.wins}/${stats.games - stats.wins})`;

  const streak =
    !stats || Math.abs(stats.streak) < 3
      ? ""
      : stats.streak > 0
        ? `${c.green} ${stats.streak}W streak${c.reset}`
        : `${c.red} ${Math.abs(stats.streak)}L streak${c.reset}`;

  console.log(
    `  ${name} ${c.magenta}${champ}${c.reset} ${rank} ` +
      `${wrColor}${wrText.padEnd(16)}${c.reset} ` +
      `${c.dim}KDA ${stats ? stats.kda.toFixed(2) : "-"}${c.reset}` +
      streak,
  );

  const mains = (stats?.topChampions ?? [])
    .slice(0, 3)
    .map((rec) => {
      const pct = Math.round((rec.wins / rec.games) * 100);
      return `${catalog.championName(rec.championId)} ${rec.games}g ${pct}%`;
    })
    .join(c.dim + " | " + c.reset);
  if (mains) console.log(`  ${c.dim}    mains: ${mains}${c.reset}`);
}

main().catch((err) => {
  if (err instanceof LcuNotRunningError) {
    console.error(`\n${c.red}${err.message}${c.reset}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
