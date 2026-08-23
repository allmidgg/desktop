/**
 * The screen that follows whatever you are doing in the client.
 *
 * During champion select it hands over to the scout; the rest of the time it
 * shows your recent Classic games.
 */
import { bouwPad } from "../../../shared/build";
import type {
  AppSnapshot, BuildStep, ChampionSummary, GameDetail, GameDetailPlayer, ItemSummary,
  LiveGamePlayer, LiveGameSnapshot, RecentGameSummary,
} from "../../../shared/types";
import { ChampSelectView } from "./ChampSelectView";
import { Fragment, useEffect, useState } from "react";
import {
  asset, ChampionIcon, EmptyState, FormDots, ItemRow, Panel, RankPill, SectionTitle, SkillGrid,
  SpellPair, Spinner, SplashBackdrop, Winrate,
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
  return <LiveInhoud snapshot={snapshot} />;
}

function LiveInhoud({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [geopend, setGeopend] = useState<number | null>(null);

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
              <GameRow
                key={game.gameId}
                game={game}
                snapshot={snapshot}
                open={geopend === game.gameId}
                onToggle={() => setGeopend(geopend === game.gameId ? null : game.gameId)}
              />
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
        {([
          ["Blue side", orde, "from-sky-500/12"],
          ["Red side", chaos, "from-loss-500/12"],
        ] as const).map(([naam, team, kleur], i) => (
          <Panel key={i} className={`relative overflow-hidden divide-y divide-line/50 bg-gradient-to-b ${kleur} to-transparent`}>
            <p className="px-3 pt-2.5 pb-1.5 text-[10px] tracking-[0.16em] text-ink-500 uppercase">{naam}</p>
            {team.length === 0 ? (
              <div className="p-4">
                <EmptyState title="Nobody here yet" hint="Players appear as the game loads them in." />
              </div>
            ) : (
              team.map((p, j) => (
                <LivePlayerRow
                  key={`${p.championName}-${j}`}
                  p={p}
                  items={items}
                  champions={champions}
                  index={j}
                />
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

      {jij ? (
        <JouwGame
          live={live}
          jij={jij}
          items={items}
          champion={jij.championId === null ? undefined : champions.get(jij.championId)}
        />
      ) : null}
    </div>
  );
}

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
  champion,
}: {
  live: LiveGameSnapshot;
  jij: LiveGamePlayer;
  items: Map<number, ItemSummary>;
  champion?: ChampionSummary;
}): JSX.Element {
  // Reading the flat purchase list as a build needs the catalogue: only it knows
  // that a Long Sword and a Vampiric Scepter became a Bilgewater Cutlass.
  const groepen = bouwPad(jij.build, (id) => items.get(id)?.buildsFrom ?? []);
  return (
    <div className="space-y-3">
      <SectionTitle hint={<span className="num text-gold-400">{jij.championName}</span>}>Your game</SectionTitle>

      <Panel className="relative overflow-hidden p-4">
        <SplashBackdrop champion={champion} strip />
        <div className="relative">
        <p className="text-[10px] tracking-[0.14em] text-ink-500 uppercase">Skill order</p>
        {live.skillOrder.length === 0 ? (
          <p className="mt-2 text-xs text-ink-600">Nothing levelled yet.</p>
        ) : (
          <div className="mt-3">
            <SkillGrid order={live.skillOrder} />
          </div>
        )}
        <p className="mt-3 text-[11px] text-ink-600">
          Yours only &mdash; the client does not reveal anyone else&rsquo;s abilities.
        </p>
        </div>
      </Panel>

      <Panel className="p-4">
        <p className="text-[10px] tracking-[0.14em] text-ink-500 uppercase">Purchase order</p>
        {groepen.length === 0 ? (
          <p className="mt-2 text-xs text-ink-600">Nothing bought yet.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {groepen.map((groep, i) => (
              <div
                key={`${groep.af.itemId}-${i}`}
                className="flex flex-wrap items-center gap-1.5 rounded-md bg-ink-900/40 px-2 py-1.5"
              >
                {groep.weg.map((stap, j) => (
                  <Fragment key={`w-${j}`}>
                    <ItemStap stap={stap} items={items} klein />
                    <span className="text-ink-700">&rsaquo;</span>
                  </Fragment>
                ))}
                <ItemStap stap={groep.af} items={items} />
              </div>
            ))}
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

/** One purchase: icon, name, and the minute it happened. */
function ItemStap({
  stap,
  items,
  klein = false,
}: {
  stap: BuildStep;
  items: Map<number, ItemSummary>;
  klein?: boolean;
}): JSX.Element {
  const item = items.get(stap.itemId);
  const maat = klein ? "h-7 w-7" : "h-9 w-9";
  return (
    <span className="flex items-center gap-1.5" title={`${item?.name ?? "Unknown item"} — ${klok(stap.at)}`}>
      {item ? (
        <img
          src={asset(item.iconPath)}
          alt={item.name}
          className={`${maat} rounded border ${klein ? "border-ink-800" : "border-gold-500/40"}`}
        />
      ) : (
        <span className={`${maat} rounded border border-ink-800 bg-ink-900`} />
      )}
      <span className="flex flex-col leading-tight">
        <span className={`${klein ? "text-[10px] text-ink-500" : "text-xs text-ink-300"}`}>{item?.name ?? "?"}</span>
        <span className="num text-[9px] text-ink-700">{klok(stap.at)}</span>
      </span>
    </span>
  );
}

function LivePlayerRow({
  p,
  items,
  champions,
  index,
}: {
  p: LiveGamePlayer;
  items: Map<number, ItemSummary>;
  champions: Map<number, ChampionSummary>;
  index: number;
}): JSX.Element {
  const champion = p.championId === null ? undefined : champions.get(p.championId);
  return (
    <div
      className={`stagger flex items-center gap-3 p-2.5 ${p.isYou ? "bg-gold-500/[0.09] shadow-[inset_2px_0_0_var(--color-gold-400)]" : ""}`}
      style={{ "--vertraging": `${index * 45}ms` } as React.CSSProperties}
    >
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

/**
 * One finished game, everyone in it.
 *
 * Only what was really recorded. There is no timeline in this data -- no gold
 * over time, no first blood, no objectives -- so the honest thing to draw is how
 * the ten players compare to each other, which the numbers do support.
 */
function GameDetailPaneel({
  gameId,
  snapshot,
}: {
  gameId: number;
  snapshot: AppSnapshot;
}): JSX.Element {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [bezig, setBezig] = useState(true);

  useEffect(() => {
    let levend = true;
    setBezig(true);
    void window.jade
      .gameDetail(gameId)
      .then((d) => {
        if (levend) {
          setDetail(d);
          setBezig(false);
        }
      })
      .catch(() => levend && setBezig(false));
    return () => {
      levend = false;
    };
  }, [gameId]);

  if (bezig) return <div className="px-4 py-6"><Spinner label="Opening the game..." /></div>;
  if (!detail) {
    return (
      <div className="px-4 py-5">
        <EmptyState
          title="This game is not in your database"
          hint="Only games the crawler has picked up can be opened. It fills in over time."
        />
      </div>
    );
  }

  const champions = new Map(snapshot.champions.map((c) => [c.jadeId, c]));
  const items = new Map(snapshot.items.map((i) => [i.jadeId, i]));
  const minuten = detail.durationSeconds / 60;
  const teams = [100, 200].map((id) => detail.players.filter((p) => p.team === id));
  const maxGold = Math.max(1, ...detail.players.map((p) => p.gold));
  const maxCs = Math.max(1, ...detail.players.map((p) => p.cs));
  const totaal = (spelers: GameDetailPlayer[], veld: "kills" | "gold") =>
    spelers.reduce((a, p) => a + p[veld], 0);

  return (
    <div className="space-y-4 border-t border-line px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] text-ink-500">
        <span className="num">{klok(detail.durationSeconds)} long</span>
        <span className="num">patch {detail.patch}</span>
        <span className="num">
          {totaal(teams[0]!, "kills")} &ndash; {totaal(teams[1]!, "kills")} kills
        </span>
        <span className="num">
          {Math.round(totaal(teams[0]!, "gold") / 1000)}k &ndash; {Math.round(totaal(teams[1]!, "gold") / 1000)}k gold
        </span>
      </div>

      {teams.map((team, i) => (
        <div key={i}>
          <p className={`mb-1.5 text-[10px] tracking-[0.16em] uppercase ${i === 0 ? "text-sky-400/70" : "text-loss-400/70"}`}>
            {i === 0 ? "Blue side" : "Red side"}
            <span className="ml-2 text-ink-700">{team[0]?.win ? "won" : "lost"}</span>
          </p>
          <div className="space-y-1">
            {team.map((p, j) => (
              <DetailSpeler
                key={j}
                p={p}
                champions={champions}
                items={items}
                minuten={minuten}
                maxGold={maxGold}
                maxCs={maxCs}
                blauw={i === 0}
              />
            ))}
          </div>
        </div>
      ))}

      <p className="text-[11px] text-ink-600">
        Bars compare the ten players in this game, nothing more. Classic match history carries no
        timeline, so there is no gold curve to draw and no first blood to report &mdash; only what each
        player finished with.
      </p>
    </div>
  );
}

function DetailSpeler({
  p,
  champions,
  items,
  minuten,
  maxGold,
  maxCs,
  blauw,
}: {
  p: GameDetailPlayer;
  champions: Map<number, ChampionSummary>;
  items: Map<number, ItemSummary>;
  minuten: number;
  maxGold: number;
  maxCs: number;
  blauw: boolean;
}): JSX.Element {
  const champion = champions.get(p.championId);
  const kda = p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;
  const kleur = blauw ? "bg-sky-500/70" : "bg-loss-500/70";
  return (
    <div className={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${p.isYou ? "bg-gold-500/[0.09]" : "bg-white/[0.02]"}`}>
      <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={28} />
      <span className="w-24 shrink-0 truncate text-[11px]">{champion?.name ?? p.championId}</span>
      <span className="num w-16 shrink-0 text-[11px] text-ink-300">
        {p.kills}/{p.deaths}/{p.assists}
      </span>
      <span className="num w-10 shrink-0 text-[10px] text-ink-600">{kda.toFixed(1)}</span>

      <span className="flex w-28 shrink-0 items-center gap-1.5" title={`${p.cs} CS`}>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line/50">
          <span className={`block h-full ${kleur}`} style={{ width: `${(p.cs / maxCs) * 100}%` }} />
        </span>
        <span className="num w-12 text-right text-[10px] text-ink-500">
          {minuten > 0 ? (p.cs / minuten).toFixed(1) : "0"}/m
        </span>
      </span>

      <span className="flex w-28 shrink-0 items-center gap-1.5" title={`${p.gold} gold`}>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line/50">
          <span className="block h-full bg-gold-400/70" style={{ width: `${(p.gold / maxGold) * 100}%` }} />
        </span>
        <span className="num w-10 text-right text-[10px] text-ink-500">{(p.gold / 1000).toFixed(1)}k</span>
      </span>

      <span className="ml-auto">
        <ItemRow items={p.items} lookup={items} size={20} />
      </span>
    </div>
  );
}

function GameRow({
  game,
  snapshot,
  open,
  onToggle,
}: {
  game: RecentGameSummary;
  snapshot: AppSnapshot;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const champion = snapshot.champions.find((c) => c.jadeId === game.championId);
  const items = new Map(snapshot.items.map((i) => [i.jadeId, i]));
  const spells = new Map(snapshot.spells.map((s) => [s.jadeId, s]));

  const minutes = game.durationSeconds / 60;
  const kda = game.deaths === 0 ? game.kills + game.assists : (game.kills + game.assists) / game.deaths;
  const csPerMin = minutes > 0 ? game.cs / minutes : 0;

  return (
    <Panel className={`overflow-hidden transition-colors ${open ? "border-gold-400/40" : ""}`}>
    <button
      type="button"
      onClick={onToggle}
      className={`group relative flex w-full items-center gap-4 py-3 pr-5 pl-4 text-left transition-colors hover:bg-white/[0.03] ${
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
      <span className={`ml-1 text-ink-600 transition-transform ${open ? "rotate-90" : ""}`}>&rsaquo;</span>
    </button>
    {open ? <GameDetailPaneel gameId={game.gameId} snapshot={snapshot} /> : null}
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
