/**
 * jade.gg scout -- terminalversie van de champ select-scout.
 *
 * Zonder argumenten: analyseert de tien spelers uit je laatste League Classic-game.
 * Met een Riot-ID (`npm run scout -- Faker#KR1`): analyseert die ene speler.
 *
 * Dit is bewust een CLI: het bewijst dat de complete datalaag klopt voordat er
 * ook maar een pixel UI bestaat.
 */
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { JadeCatalog } from "../core/jade/catalog";
import type { Game } from "../core/lcu/types";
import {
  buildPlayerProfile,
  fetchCurrentSummoner,
  fetchJadeGames,
  fetchSummonerByRiotId,
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
  const catalog = await JadeCatalog.load(client);
  for (const warning of catalog.warnings) console.warn(`${c.yellow}! ${warning}${c.reset}`);

  const arg = process.argv.slice(2).join(" ").trim();
  if (arg) return scoutSinglePlayer(client, catalog, arg);
  return scoutLastGame(client, catalog);
}

async function scoutSinglePlayer(client: LcuClient, catalog: JadeCatalog, riotId: string): Promise<void> {
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
  printProfile(profile, catalog, null);
}

async function scoutLastGame(client: LcuClient, catalog: JadeCatalog): Promise<void> {
  const me = await fetchCurrentSummoner(client);
  console.log(`\n${c.bold}jade.gg${c.reset} ${c.dim}// ingelogd als ${me.gameName}#${me.tagLine}${c.reset}`);

  const [recent] = await fetchJadeGames(client, me.puuid, 1);
  if (!recent) {
    console.log("Geen League Classic-games gevonden in je matchhistorie.");
    return;
  }
  const detail = await client.get<Game>(`/lol-match-history/v1/games/${recent.gameId}`);
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
      printProfile(profile, catalog, participant.championId, identity.player.puuid === me.puuid);
    }
    console.log();
  }
}

function printProfile(
  profile: PlayerProfile,
  catalog: JadeCatalog,
  playedChampionId: number | null,
  isMe = false,
): void {
  const { jade } = profile;
  const name = (isMe ? `${c.cyan}${profile.riotId}${c.reset}` : profile.riotId).padEnd(isMe ? 34 : 25);
  const champ = playedChampionId ? catalog.championName(playedChampionId).padEnd(14) : "".padEnd(14);
  const rank = (profile.rank?.label ?? "Unranked").padEnd(18);

  const wr = Math.round(jade.winrate * 100);
  const wrColor = jade.games === 0 ? c.dim : wr >= 55 ? c.green : wr <= 45 ? c.red : c.yellow;
  const wrText = jade.games === 0 ? "geen data" : `${wr}% (${jade.wins}/${jade.games - jade.wins})`;

  const streak =
    jade.streak >= 3
      ? `${c.green} ${jade.streak}W streak${c.reset}`
      : jade.streak <= -3
        ? `${c.red} ${Math.abs(jade.streak)}L streak${c.reset}`
        : "";

  console.log(
    `  ${name} ${c.magenta}${champ}${c.reset} ${rank} ` +
      `${wrColor}${wrText.padEnd(16)}${c.reset} ` +
      `${c.dim}KDA ${jade.kda.toFixed(2)}${c.reset}` +
      streak,
  );

  const mains = jade.topChampions
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
