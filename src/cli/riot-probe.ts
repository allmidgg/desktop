/**
 * jade.gg riot-probe -- zoekt uit of de publieke Riot API wél vertelt met welke
 * runes en masteries er in een Classic-game gespeeld is.
 *
 * De lokale client doet dat niet: `perk0` t/m `perk5` zijn daar altijd 0. Als de
 * publieke API het wel meestuurt, kunnen we eigen rune-statistiek opbouwen. Zo
 * niet, dan weten we dat het langs deze weg simpelweg niet kan.
 *
 *   RIOT_API_KEY=RGAPI-... npm run riot-probe
 */
import { LcuClient, LcuNotRunningError } from "../core/lcu/connector";
import { RiotApiClient, RiotApiError } from "../core/riot/api";
import { fetchCurrentSummoner, fetchJadeGames } from "../core/services/player";
import { JADE_QUEUES } from "../core/jade/ids";

const c = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };

/** Zoekt in een willekeurig genest object naar sleutels die op runes wijzen. */
function findRuneLikeKeys(value: unknown, path = "", found: string[] = [], depth = 0): string[] {
  if (depth > 6 || found.length > 40 || value === null || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (/perk|rune|mastery|talent|loadout/i.test(key)) {
      const preview = JSON.stringify(child);
      found.push(`${here} = ${preview.length > 120 ? preview.slice(0, 120) + "..." : preview}`);
    }
    if (Array.isArray(child)) {
      if (child.length > 0) findRuneLikeKeys(child[0], `${here}[0]`, found, depth + 1);
    } else {
      findRuneLikeKeys(child, here, found, depth + 1);
    }
  }
  return found;
}

async function main(): Promise<void> {
  const apiKey = process.env.RIOT_API_KEY ?? process.argv[2];
  if (!apiKey) {
    console.error(
      `\n${c.red}Geen API-sleutel.${c.reset}\n` +
        `Haal een gratis ontwikkelaarssleutel op developer.riotgames.com en draai:\n` +
        `  RIOT_API_KEY=RGAPI-... npm run riot-probe\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Werkt met of zonder draaiende client: zonder client zoeken we het account op
  // via de publieke API, met een Riot-ID als tweede argument.
  let lcu: LcuClient | null = null;
  let me: { puuid: string; gameName: string; tagLine: string } | null = null;
  try {
    lcu = await LcuClient.connect();
    me = await fetchCurrentSummoner(lcu);
  } catch {
    const riotId = process.env.RIOT_ID ?? process.argv[3];
    if (!riotId?.includes("#")) {
      console.error(
        `
${c.red}League-client staat uit.${c.reset} Geef dan je Riot-ID mee:
` +
          `  npm run riot-probe -- RGAPI-... naam#EUW
`,
      );
      process.exitCode = 1;
      return;
    }
    const [gameName, tagLine] = riotId.split("#");
    const probe = new RiotApiClient(apiKey, `${tagLine!.toUpperCase()}1`);
    me = await probe.accountByRiotId(gameName!, tagLine!);
  }

  const platform = me.tagLine?.toUpperCase() === "EUW" ? "EUW1" : `${me.tagLine}1`;
  const riot = new RiotApiClient(apiKey, platform);

  // De client en de publieke API gebruiken verschillende identiteiten voor
  // hetzelfde account: de LCU geeft een UUID, de API een versleutelde string.
  // Voor match-v5 hebben we die tweede nodig.
  const account = await riot.accountByRiotId(me.gameName, me.tagLine);
  const lcuPuuid = me.puuid;
  const apiPuuid = account.puuid;
  if (apiPuuid !== lcuPuuid) {
    console.log(
      `${c.dim}client-puuid en API-puuid verschillen; elk endpoint krijgt de zijne${c.reset}`,
    );
  }

  console.log(`\n${c.bold}jade.gg riot-probe${c.reset}`);
  console.log(`${c.dim}account ${me.gameName}#${me.tagLine} | platform ${platform} | regio ${riot.region}${c.reset}\n`);

  // 1. Kent de publieke API onze Classic-queue?
  console.log(`${c.bold}1. Match-ID's via de publieke API${c.reset}`);
  let ids: string[] = [];
  try {
    ids = await riot.matchIds(apiPuuid, { count: 10 });
    console.log(`   zonder filter: ${ids.length} matches -> ${ids.slice(0, 3).join(", ")}`);
  } catch (err) {
    console.log(`   ${c.red}${err instanceof RiotApiError ? err.message : String(err)}${c.reset}`);
    if (err instanceof RiotApiError && err.status === 403) {
      console.log(`   ${c.yellow}403 betekent meestal: sleutel verlopen (dev-keys leven 24 uur).${c.reset}`);
      process.exitCode = 1;
      return;
    }
  }
  try {
    const ranked = await riot.matchIds(apiPuuid, { count: 10, queue: JADE_QUEUES.RANKED_SOLO });
    console.log(
      `   queue=${JADE_QUEUES.RANKED_SOLO} (Classic ranked): ${ranked.length} matches` +
        (ranked.length ? ` -> ${ranked.slice(0, 3).join(", ")}` : ` ${c.yellow}(queue-filter kent Classic niet)${c.reset}`),
    );
    if (ranked.length > 0) ids = ranked;
  } catch (err) {
    console.log(`   queue-filter: ${c.yellow}${err instanceof RiotApiError ? err.status : "fout"}${c.reset}`);
  }

  // 2. Een Classic-game die we zeker gespeeld hebben, opgebouwd uit het lokale ID.
  const [localGame] = lcu ? await fetchJadeGames(lcu, lcuPuuid, 1) : [];
  const candidates = [...ids];
  if (localGame) {
    const constructed = riot.matchIdFromGameId(localGame.gameId);
    if (!candidates.includes(constructed)) candidates.unshift(constructed);
    console.log(`\n${c.bold}2. Bekende Classic-game${c.reset}`);
    console.log(`   lokaal gameId ${localGame.gameId} -> ${constructed}`);
  }

  // 3. Het rapport ophalen en kijken wat erin zit.
  console.log(`\n${c.bold}3. Inhoud van het matchrapport${c.reset}`);
  for (const matchId of candidates.slice(0, 4)) {
    try {
      const match = await riot.match(matchId);
      const info = (match.info ?? {}) as Record<string, unknown>;
      const participants = (info.participants ?? []) as Array<Record<string, unknown>>;
      const first = participants[0] ?? {};
      console.log(
        `\n   ${c.green}${matchId}${c.reset} | mode=${String(info.gameMode)} map=${String(info.mapId)} ` +
          `queue=${String(info.queueId)} | ${participants.length} spelers`,
      );

      const hits = findRuneLikeKeys(first);
      if (hits.length === 0) {
        console.log(`      ${c.yellow}geen rune-/mastery-velden gevonden${c.reset}`);
      } else {
        for (const hit of hits.slice(0, 12)) console.log(`      ${hit}`);
      }
      // Is er iets dat níet nul is?
      const meaningful = hits.filter((h) => !/= (0|\[\]|\{\}|null)$/.test(h) && !/:0[,}]/.test(h));
      console.log(
        meaningful.length > 0
          ? `      ${c.green}>> er zit echte data in -- rune-statistiek is mogelijk${c.reset}`
          : `      ${c.yellow}>> alles leeg of nul, net als in de client${c.reset}`,
      );
    } catch (err) {
      console.log(`   ${matchId}: ${c.red}${err instanceof RiotApiError ? err.status : String(err)}${c.reset}`);
    }
  }
  console.log();
}

main().catch((err) => {
  if (err instanceof LcuNotRunningError) console.error(`\n${c.red}${err.message}${c.reset}`);
  else console.error(err);
  process.exitCode = 1;
});
