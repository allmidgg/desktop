/**
 * The screen that follows whatever you are doing in the client.
 *
 * During champion select it hands over to the scout; the rest of the time it
 * shows your recent Classic games.
 */
import type { AppSnapshot, RecentGameSummary } from "../../../shared/types";
import { ChampSelectView } from "./ChampSelectView";
import {
  ChampionIcon, EmptyState, FormDots, ItemRow, Panel, RankPill, SectionTitle, SpellPair, Spinner,
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

function GameRow({ game, snapshot }: { game: RecentGameSummary; snapshot: AppSnapshot }): JSX.Element {
  const champion = snapshot.champions.find((c) => c.jadeId === game.championId);
  const items = new Map(snapshot.items.map((i) => [i.jadeId, i]));
  const spells = new Map(snapshot.spells.map((s) => [s.jadeId, s]));

  const minutes = game.durationSeconds / 60;
  const kda = game.deaths === 0 ? game.kills + game.assists : (game.kills + game.assists) / game.deaths;
  const csPerMin = minutes > 0 ? game.cs / minutes : 0;

  return (
    <Panel
      className={`group relative flex items-center gap-4 overflow-hidden py-3 pr-5 pl-4 transition-colors hover:border-white/14 ${
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
