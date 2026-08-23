/**
 * The screen that follows whatever you are doing in the client.
 *
 * During champion select it hands over to the scout; the rest of the time it
 * shows your recent Classic games.
 */
import type { AppSnapshot, LiveGamePlayer, LiveGameSnapshot, RecentGameSummary } from "../../../shared/types";
import { ChampSelectView } from "./ChampSelectView";
import { Fragment } from "react";
import {
  asset, ChampionIcon, EmptyState, FormDots, ItemRow, Panel, RankPill, SectionTitle, SpellPair, Spinner,
  Winrate,
} from "../ui";

const PHASE_LABELS: Record<string, string> = {
  None: "Not in a lobby",
  Lobby: "In the lobby",
  Matchmaking: "In queue",
  ReadyCheck: "Match found",
  ChampSelect: "Champion select",
  GameStart: "Game starting",
  InProgress: "Game in progress",
  WaitingForStats: "Waiting for stats",
  PreEndOfGame: "Game over",
  EndOfGame: "Game over",
  Reconnect: "Reconnecting",
};

const QUEUE_LABELS: Record<number, string> = {
  3260: "Normal",
  3262: "Normal",
  4310: "Ranked Solo",
  4320: "Co-op vs AI",
};

export function LiveView({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  if (snapshot.connection !== "connected") {
    return (
      <Panel className="p-8">
        <Spinner label={snapshot.error ?? "Connecting to the League client..."} />
        <p className="mt-3 text-xs text-ink-500">
          Start the League client — AllMid picks up the connection on its own.
        </p>
      </Panel>
    );
  }

  if (snapshot.champSelect) return <ChampSelectView snapshot={snapshot} />;

  return (
    <div className="animate-rise space-y-6">
      {snapshot.liveGame ? <LiveGamePanel live={snapshot.liveGame} snapshot={snapshot} /> : null}
      <Panel className="flex items-center justify-between p-6">
        <div>
          <p className="text-xs tracking-[0.14em] text-ink-500 uppercase">Status</p>
          <p className="mt-1 text-lg font-medium">{PHASE_LABELS[snapshot.phase] ?? snapshot.phase}</p>
          <p className="mt-1 text-xs text-ink-500">
            The scout opens by itself as soon as champion select begins.
          </p>
        </div>
        {snapshot.profile ? (
          <div className="text-right">
            <RankPill rank={snapshot.profile.rank} />
            <div className="mt-2 flex items-center justify-end gap-2">
              <Winrate winrate={snapshot.profile.jade.winrate} games={snapshot.profile.jade.games} />
              <FormDots results={snapshot.profile.jade.recentResults} />
            </div>
          </div>
        ) : null}
      </Panel>

      <div>
        <SectionTitle hint={`${snapshot.recentGames.length} games`}>Recent Classic games</SectionTitle>
        {snapshot.recentGames.length === 0 ? (
          <Panel className="p-6">
            <EmptyState title="No Classic games found yet" />
          </Panel>
        ) : (
          <div className="space-y-2">
            {snapshot.recentGames.map((game) => (
              <GameRow key={game.gameId} game={game} snapshot={snapshot} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const klok = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * The game as it stands right now, read from the client on port 2999.
 *
 * Everything here is live rather than remembered, so there is nothing to keep in
 * sync: what the client says is what is shown.
 */
function LiveGamePanel({ live, snapshot }: { live: LiveGameSnapshot; snapshot: AppSnapshot }): JSX.Element {
  const items = new Map(snapshot.items.map((i) => [i.jadeId, i]));
  const champions = new Map(snapshot.champions.map((c) => [c.jadeId, c]));
  const jij = live.players.find((p) => p.isYou) ?? null;
  const orde = live.players.filter((p) => p.team === "ORDER");
  const chaos = live.players.filter((p) => p.team === "CHAOS");
  const rest = live.players.filter((p) => p.team === "UNKNOWN");

  return (
    <div className="space-y-3">
      <SectionTitle
        hint={
          <span className="num">
            {klok(live.gameTimeSeconds)}
            {live.isClassic ? "" : ` · ${live.mode}`}
          </span>
        }
      >
        In game
      </SectionTitle>

      {live.note ? (
        <Panel className="border-gold-500/30 p-3 text-xs text-ink-400">{live.note}</Panel>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        {[orde, chaos].map((team, i) => (
          <Panel key={i} className="divide-y divide-ink-900/60">
            {team.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No players on this side yet" />
              </div>
            ) : (
              team.map((p, j) => (
                <LivePlayerRow key={`${p.championName}-${j}`} p={p} items={items} champions={champions} />
              ))
            )}
          </Panel>
        ))}
      </div>

      {rest.length ? (
        <Panel className="divide-y divide-ink-900/60">
          {rest.map((p, j) => (
            <LivePlayerRow key={`rest-${j}`} p={p} items={items} champions={champions} />
          ))}
        </Panel>
      ) : null}

      {jij ? <JouwGame live={live} jij={jij} items={items} /> : null}
    </div>
  );
}

const SKILLS = ["Q", "W", "E", "R"] as const;
const LEVELS = Array.from({ length: 18 }, (_, i) => i + 1);

/**
 * The two things a finished match can never tell you, side by side.
 *
 * Skill order is yours alone: the client keeps everyone else's abilities to
 * itself. The build order is collected for all ten, but yours is the one you can
 * still act on while the game is running.
 */
function JouwGame({
  live,
  jij,
  items,
}: {
  live: LiveGameSnapshot;
  jij: LiveGamePlayer;
  items: Map<number, { name: string; iconPath: string }>;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <SectionTitle hint={<span className="num">{jij.championName}</span>}>Your game</SectionTitle>

      <Panel className="p-4">
        <p className="text-[10px] tracking-[0.14em] text-ink-500 uppercase">Skill order</p>
        {live.skillOrder.length === 0 ? (
          <p className="mt-2 text-xs text-ink-600">Nothing levelled yet.</p>
        ) : (
          <SkillRaster order={live.skillOrder} />
        )}
        <p className="mt-3 text-[11px] text-ink-600">
          Yours only &mdash; the client does not reveal anyone else&rsquo;s abilities.
        </p>
      </Panel>

      <Panel className="p-4">
        <p className="text-[10px] tracking-[0.14em] text-ink-500 uppercase">Purchase order</p>
        {jij.build.length === 0 ? (
          <p className="mt-2 text-xs text-ink-600">Nothing bought yet.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-x-1.5 gap-y-3">
            {jij.build.map((stap, i) => {
              const item = items.get(stap.itemId);
              return (
                <div key={`${stap.itemId}-${i}`} className="flex flex-col items-center gap-1" title={item?.name}>
                  {item ? (
                    <img src={asset(item.iconPath)} alt={item.name} className="h-8 w-8 rounded border border-ink-800" />
                  ) : (
                    <div className="h-8 w-8 rounded border border-ink-800 bg-ink-900" />
                  )}
                  <span className="num text-[9px] text-ink-600">{klok(stap.at)}</span>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-[11px] text-ink-600">
          Components count: a Long Sword that later becomes something else was still bought. Recorded for
          all ten players, which is how Classic gets a build order at all &mdash; a finished match reports
          the six slots someone ended on and nothing about the road there.
        </p>
      </Panel>
    </div>
  );
}

/**
 * The grid every build guide uses: one row per ability, one column per level.
 *
 * The recorded order is the whole story -- entry n was the point spent at level
 * n -- so the grid needs nothing beyond it.
 */
function SkillRaster({ order }: { order: string[] }): JSX.Element {
  return (
    <div className="mt-2 overflow-x-auto">
      <div className="inline-grid gap-[3px]" style={{ gridTemplateColumns: "18px repeat(18, 18px)" }}>
        <span />
        {LEVELS.map((n) => (
          <span key={n} className="num text-center text-[9px] leading-4 text-ink-600">
            {n}
          </span>
        ))}
        {SKILLS.map((skill) => (
          <Fragment key={skill}>
            <span className="num text-center text-[10px] leading-[18px] font-semibold text-ink-400">{skill}</span>
            {LEVELS.map((n) => {
              const gezet = order[n - 1] === skill;
              return (
                <span
                  key={n}
                  className={`h-[18px] rounded-[3px] ${
                    gezet ? (skill === "R" ? "bg-gold-400" : "bg-gold-500/70") : "bg-ink-900/70"
                  }`}
                  title={gezet ? `Level ${n}: ${skill}` : undefined}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function LivePlayerRow({
  p,
  items,
  champions,
}: {
  p: LiveGamePlayer;
  items: Map<number, { name: string; iconPath: string }>;
  champions: Map<number, { name: string; iconPath: string }>;
}): JSX.Element {
  const champion = p.championId === null ? undefined : champions.get(p.championId);
  return (
    <div className={`flex items-center gap-3 p-2.5 ${p.isYou ? "bg-gold-500/[0.07]" : ""}`}>
      <ChampionIcon iconPath={champion?.iconPath} name={p.championName} size={34} dim={p.isDead} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">
          {p.championName}
          {p.position ? <span className="ml-1.5 text-[10px] text-ink-600">{p.position}</span> : null}
        </p>
        <p className="truncate text-[11px] text-ink-600">{p.riotId ?? "—"}</p>
      </div>
      <div className="num text-right text-[11px] whitespace-nowrap text-ink-400">
        <div>
          {p.kills}/{p.deaths}/{p.assists}
        </div>
        <div className="text-ink-600">
          {p.cs} cs · lv {p.level}
          {p.isDead && p.respawnIn > 0 ? <span className="text-red-400"> · {p.respawnIn}s</span> : null}
        </div>
      </div>
      <ItemRow items={p.items} lookup={items} size={22} />
    </div>
  );
}

function GameRow({ game, snapshot }: { game: RecentGameSummary; snapshot: AppSnapshot }): JSX.Element {
  const champion = snapshot.champions.find((c) => c.jadeId === game.championId);
  const items = new Map(snapshot.items.map((i) => [i.jadeId, i]));
  const spells = new Map(snapshot.spells.map((s) => [s.jadeId, s]));

  const minutes = game.durationSeconds / 60;
  const kda = game.deaths === 0 ? game.kills + game.assists : (game.kills + game.assists) / game.deaths;
  const csPerMin = minutes > 0 ? game.cs / minutes : 0;

  return (
    <Panel
      className={`group relative flex items-center gap-4 overflow-hidden py-3 pr-5 pl-4 transition-colors hover:border-line-lit ${
        game.win ? "bg-jade-500/[0.035]" : "bg-loss-500/[0.03]"
      }`}
    >
      <span
        className={`absolute top-0 bottom-0 left-0 w-[3px] ${game.win ? "bg-jade-500" : "bg-loss-500/80"}`}
      />

      <div className="flex items-center gap-2">
        <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={46} />
        <SpellPair spells={[game.spell1Id, game.spell2Id]} lookup={spells} size={21} />
      </div>

      <div className="w-[130px]">
        <p className="truncate text-sm font-medium">{champion?.name ?? game.championId}</p>
        <p className={`text-[11px] font-medium ${game.win ? "text-jade-400" : "text-loss-400"}`}>
          {game.win ? "Victory" : "Defeat"}
          <span className="ml-1.5 font-normal text-ink-700">
            {QUEUE_LABELS[game.queueId] ?? "Classic"}
          </span>
        </p>
      </div>

      <div className="w-[104px]">
        <p className="num text-sm">
          {game.kills} <span className="text-ink-700">/</span>{" "}
          <span className="text-loss-400">{game.deaths}</span> <span className="text-ink-700">/</span>{" "}
          {game.assists}
        </p>
        <p className="num text-[11px] text-ink-500">{kda.toFixed(2)} KDA</p>
      </div>

      <div className="w-[86px]">
        <p className="num text-sm">{game.cs}</p>
        <p className="num text-[11px] text-ink-500">{csPerMin.toFixed(1)} cs/min</p>
      </div>

      <div className="w-[80px]">
        <p className="num text-sm">{(game.gold / 1000).toFixed(1)}k</p>
        <p className="num text-[11px] text-ink-500">gold</p>
      </div>

      <ItemRow items={game.items} lookup={items} size={26} />

      <div className="ml-auto text-right">
        <p className="num text-[12px] text-ink-300">{Math.floor(minutes)} min</p>
        <p className="num text-[11px] text-ink-700">{relativeDate(game.createdAt)}</p>
      </div>
    </Panel>
  );
}

/** Short, human dates: today and yesterday read faster than a number. */
function relativeDate(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
