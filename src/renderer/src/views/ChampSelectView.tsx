/**
 * The champion select scout.
 *
 * Shown in the Live tab and, more importantly, in the popup window that appears
 * on its own the moment champion select starts.
 *
 * Two things are worth knowing about the data. Riot hides enemy names during
 * ranked, so their cards show the pick but no profile. And Riot only assigns a
 * position to your own team, so enemy lanes are inferred from where each player
 * usually plays according to our own match database -- if we cannot tell, the
 * lane stays empty instead of guessing.
 */
import { useEffect, useState } from "react";
import type {
  AppSnapshot, ChampionPlan, ChampionSummary, LaneAnalysis, ScoutEntry,
} from "../../../shared/types";
import type { ModeId } from "../../../core/modes/types";
import { rangVoor, samenvatting } from "../modus";
import {
  asset, catalogusIndex, ChampionIcon, FormDots, Panel, PositionIcon, POSITION_LABELS, RankPill,
  SplashBackdrop, Streak, Winrate,
} from "../ui";

/**
 * Ticks the champion select clock down between client events.
 *
 * The LCU sends a new session only when something happens, so the number it
 * gives is a reading from a moment ago rather than a live value. Subtracting the
 * time since that reading is what makes the seconds actually move; without it
 * the timer sits on whatever it said at the last pick.
 */
function useAftellen(timeLeftMs: number, timerAt: number): number {
  const bereken = (): number => Math.max(0, Math.round((timeLeftMs - (Date.now() - timerAt)) / 1000));
  const [seconden, setSeconden] = useState(bereken);

  useEffect(() => {
    setSeconden(bereken());
    // Four times a second rather than once: at exactly one second the displayed
    // value would lag by up to a full second after every client event.
    const t = setInterval(() => setSeconden(bereken()), 250);
    return () => clearInterval(t);
  }, [timeLeftMs, timerAt]);

  return seconden;
}

export function ChampSelectView({
  snapshot,
  compact = false,
}: {
  snapshot: AppSnapshot;
  compact?: boolean;
}): JSX.Element | null {
  const select = snapshot.champSelect;
  if (!select) return null;

  // The mode the lobby is queueing for, off the snapshot -- never the browse
  // mode, which is a different fact about a different thing: what you last
  // looked at in the tier list has no bearing on the game you are about to
  // start. Null means nothing has said yet, and an index over no mode is empty
  // rather than Classic: at that point nobody has picked anything either, so
  // there is nothing it could have drawn.
  const modus = select.mode ?? "unknown";
  const champions = catalogusIndex(snapshot.champions, modus);
  const seconds = useAftellen(select.timeLeftMs, select.timerAt);
  const assignedCells = new Set(
    select.lanes.flatMap((lane) => [lane.allyChampionId, lane.enemyChampionId]).filter(Boolean),
  );
  const unassigned = [...select.myTeam, ...select.theirTeam].filter(
    (entry) => !assignedCells.has(entry.championId || entry.championPickIntent),
  );
  const myLane = select.lanes.find((lane) => lane.isLocalPlayerLane);

  const mijnChampion = select.localChampionId ? champions.get(select.localChampionId) : undefined;

  return (
    <div className={`animate-rise relative ${compact ? "space-y-3" : "space-y-5"}`}>
      {/* The champion you are about to play, behind everything. Nothing else on
          this screen carries any weight until a pick lands, and an empty grid of
          placeholders is exactly what makes it feel like nothing is happening. */}
      <SplashBackdrop champion={mijnChampion} className="-inset-x-6 -top-6 bottom-auto h-[340px]" />

      <div className="relative flex items-start justify-between gap-4">
        <AutoMasteries
          enabled={snapshot.settings.autoMasteries}
          status={snapshot.autoMasteryStatus}
          championId={select.localChampionId}
        />
        <div className="flex items-center gap-3">
          <BanStrip
            label="Your bans"
            bans={select.bans.myTeamBans}
            champions={champions}
            align="right"
          />
          {/* Under ten seconds it should start pressing. */}
          <div
            className={`num rounded-xl border px-4 py-1.5 text-xl font-semibold transition-colors ${
              seconds <= 10
                ? "urgent border-loss-500/50 bg-loss-500/10 text-loss-400"
                : "border-white/8 bg-white/[0.03]"
            }`}
          >
            {seconds}
            <span className="ml-1 text-[11px] font-normal text-ink-500">s</span>
          </div>
          <BanStrip label="Enemy bans" bans={select.bans.theirTeamBans} champions={champions} />
        </div>
      </div>

      <div className="relative space-y-2">
        <div className="grid grid-cols-[1fr_auto_1fr] gap-3 px-1 text-[10px] tracking-[0.16em] text-ink-700 uppercase">
          <span className="text-sky-400/70">Your team</span>
          <span className="text-center">Lane</span>
          <span className="text-right text-loss-400/70">Enemy team</span>
        </div>
        {select.lanes.map((lane, i) => (
          <div key={lane.position} className="stagger" style={{ "--vertraging": `${i * 55}ms` } as React.CSSProperties}>
            <LaneRow
              lane={lane}
              entries={[...select.myTeam, ...select.theirTeam]}
              champions={champions}
              modus={modus}
            />
          </div>
        ))}
      </div>

      {select.localPlan ? (
        <BuildPanel
          plan={select.localPlan}
          champions={champions}
          items={catalogusIndex(snapshot.items, modus)}
          spells={catalogusIndex(snapshot.spells, modus)}
        />
      ) : null}

      {myLane && myLane.enemyChampionId ? (
        <CounterPanel lane={myLane} champions={champions} />
      ) : (
        <Panel className="p-3">
          <p className="text-[11px] text-ink-500">
            Counter suggestions appear once we know who you are up against.
          </p>
        </Panel>
      )}

      {unassigned.length > 0 ? (
        <Panel className="p-3">
          <p className="mb-2 text-[10px] tracking-[0.16em] text-ink-700 uppercase">Lane unknown</p>
          <div className="flex flex-wrap gap-2">
            {unassigned.map((entry) => (
              <MiniPlayer key={entry.cellId} entry={entry} champions={champions} modus={modus} />
            ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function LaneRow({
  lane,
  entries,
  champions,
  modus,
}: {
  lane: LaneAnalysis;
  entries: ScoutEntry[];
  champions: Map<number, ChampionSummary>;
  /** The lobby's mode, carried down so a card reads the right half of a profile. */
  modus: ModeId;
}): JSX.Element {
  const findEntry = (championId: number | null): ScoutEntry | undefined =>
    championId ? entries.find((e) => (e.championId || e.championPickIntent) === championId) : undefined;

  const ally = findEntry(lane.allyChampionId);
  const enemy = findEntry(lane.enemyChampionId);

  return (
    <div
      className={`grid grid-cols-[1fr_150px_1fr] items-stretch gap-3 ${
        lane.isLocalPlayerLane ? "" : "opacity-95"
      }`}
    >
      <PlayerCard
        entry={ally}
        champions={champions}
        modus={modus}
        side="ally"
        highlight={lane.isLocalPlayerLane}
      />

      <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-line bg-white/[0.015] px-2 py-2">
        <div className="flex items-center gap-1.5 text-ink-500">
          <PositionIcon position={lane.position} />
          <span className="text-[11px] font-medium tracking-wide">
            {POSITION_LABELS[lane.position] ?? lane.position}
          </span>
        </div>
        <MatchupVerdict lane={lane} />
      </div>

      <PlayerCard entry={enemy} champions={champions} modus={modus} side="enemy" highlight={false} />
    </div>
  );
}

function MatchupVerdict({ lane }: { lane: LaneAnalysis }): JSX.Element {
  if (!lane.allyChampionId || !lane.enemyChampionId) {
    return <span className="text-[10px] text-ink-700">waiting for picks</span>;
  }
  if (!lane.matchup) {
    return <span className="text-[10px] text-ink-700">too few games to call it</span>;
  }
  const pct = Math.round(lane.matchup.winrate * 100);
  const tone = pct >= 55 ? "text-jade-400" : pct <= 45 ? "text-loss-400" : "text-ink-300";
  // A bar as well as a number: at a glance you want to see which way it leans
  // before you have read anything. Measured from 50, because that is the only
  // place a matchup means nothing -- a bar from zero would make 47% and 53%
  // look like the same comfortable majority.
  const kant = Math.min(100, Math.abs(pct - 50) * 6);
  return (
    <div className="text-center">
      <p className={`num text-sm font-semibold ${tone}`}>{pct}%</p>
      <div className="mx-auto mt-0.5 flex h-[3px] w-16 overflow-hidden rounded-full bg-line/50">
        <span className="flex-1" />
        {pct < 50 ? (
          <span className="bg-loss-500/80" style={{ width: `${kant / 2}%`, marginLeft: `-${kant / 2}%` }} />
        ) : (
          <span className="bg-jade-500/80" style={{ width: `${kant / 2}%` }} />
        )}
        <span className="flex-1" />
      </div>
      <p className="num mt-0.5 text-[9px] text-ink-700">{lane.matchup.games} games</p>
    </div>
  );
}

function PlayerCard({
  entry,
  champions,
  modus,
  side,
  highlight,
}: {
  entry: ScoutEntry | undefined;
  champions: Map<number, ChampionSummary>;
  modus: ModeId;
  side: "ally" | "enemy";
  highlight: boolean;
}): JSX.Element {
  if (!entry) {
    return (
      <div
        className={`flex items-center gap-2.5 rounded-xl border border-dashed border-line/70 px-3 py-2 ${
          side === "enemy" ? "flex-row-reverse" : ""
        }`}
      >
        <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-line/30">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              side === "enemy" ? "bg-loss-500/60" : "bg-sky-500/60"
            } animate-pulse`}
          />
        </span>
        <span className="text-[11px] text-ink-700">waiting to pick</span>
      </div>
    );
  }

  const championId = entry.championId || entry.championPickIntent;
  const champion = championId ? champions.get(championId) : undefined;
  const hovering = !entry.championId && Boolean(entry.championPickIntent);
  const profile = entry.profile;
  const stats = samenvatting(profile, modus);
  const rang = rangVoor(profile, modus);
  const record = entry.championRecord;
  const alignRight = side === "enemy";

  return (
    <Panel
      className={`flex items-center gap-3 px-3 py-2 ${alignRight ? "flex-row-reverse text-right" : ""} ${
        highlight ? "paneel-goud" : ""
      }`}
    >
      <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={42} dim={hovering} />

      <div className={`min-w-0 flex-1 ${alignRight ? "items-end" : ""}`}>
        <div className={`flex items-center gap-2 ${alignRight ? "justify-end" : ""}`}>
          <span
            className={`truncate text-[13px] font-medium ${
              entry.isLocalPlayer ? "text-gold-300" : "text-ink-100"
            }`}
          >
            {entry.toonNaam ?? champion?.name ?? "Hidden player"}
          </span>
          {entry.isLocalPlayer ? (
            <span className="rounded bg-gold-400/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-gold-300 uppercase">
              you
            </span>
          ) : null}
          {hovering ? (
            <span className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] tracking-wide text-ink-500 uppercase">
              hovering
            </span>
          ) : null}
        </div>

        <div className={`mt-1 flex items-center gap-2 ${alignRight ? "justify-end" : ""}`}>
          <span className="text-[11px] text-ink-300">{champion?.name ?? "no pick"}</span>
          {record ? (
            <span
              className="num rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-ink-300"
              title="This player's record on this champion"
            >
              {record.wins}/{record.games - record.wins} on champ
            </span>
          ) : null}
          {entry.likelyPosition && entry.positionShare > 0 ? (
            <span
              className="flex items-center gap-1 text-[10px] text-ink-500"
              title={`Where this player usually goes: ${POSITION_LABELS[entry.likelyPosition]} in ${Math.round(entry.positionShare * 100)}% of the games we have of them. It says nothing about the champion.`}
            >
              <PositionIcon position={entry.likelyPosition} size={11} />
              <span className="text-ink-600">usually</span>
              <span className="num text-ink-300">{POSITION_LABELS[entry.likelyPosition]}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* The half of the profile that belongs to the mode this lobby is for. A
          player's Classic form says nothing about the game about to start when
          that game is the other one, and a card showing it would be indistinguishable
          from one that had measured it. */}
      {profile ? (
        <div className={`shrink-0 ${alignRight ? "text-left" : "text-right"}`}>
          {rang === undefined ? null : <RankPill rank={rang} compact />}
          {stats ? (
            <>
              <div className={`mt-1 flex items-center gap-2 ${alignRight ? "" : "justify-end"}`}>
                <Winrate winrate={stats.winrate} games={stats.games} />
              </div>
              <div className={`mt-1 flex items-center gap-2 ${alignRight ? "" : "justify-end"}`}>
                <Streak streak={stats.streak} />
                <FormDots results={stats.recentResults} />
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <span className="shrink-0 text-[10px] text-ink-700">name hidden</span>
      )}
    </Panel>
  );
}

function CounterPanel({
  lane,
  champions,
}: {
  lane: LaneAnalysis;
  champions: Map<number, ChampionSummary>;
}): JSX.Element {
  const enemy = lane.enemyChampionId ? champions.get(lane.enemyChampionId) : undefined;
  return (
    <Panel className="p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[10px] tracking-[0.16em] text-ink-700 uppercase">
          Best picks against {enemy?.name ?? "the enemy laner"}
        </p>
        <span className="text-[10px] text-ink-700">{POSITION_LABELS[lane.position]}</span>
      </div>
      {lane.counters.length === 0 ? (
        <p className="text-[11px] text-ink-500">
          No champion has a winning record against {enemy?.name ?? "this champion"} yet with enough
          games behind it. The database keeps filling up while you play.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {lane.counters.map((counter) => {
            const champion = champions.get(counter.championId);
            const pct = Math.round(counter.winrate * 100);
            return (
              <div
                key={counter.championId}
                className="flex items-center gap-2 rounded-xl bg-white/[0.04] py-1.5 pr-3 pl-1.5"
              >
                <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={26} />
                <div>
                  <p className="text-[12px] leading-tight">{champion?.name ?? counter.championId}</p>
                  <p className="num text-[10px] leading-tight text-ink-500">
                    <span className={pct >= 55 ? "text-jade-400" : "text-ink-300"}>{pct}%</span> ·{" "}
                    {counter.games} games
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function MiniPlayer({
  entry,
  champions,
  modus,
}: {
  entry: ScoutEntry;
  champions: Map<number, ChampionSummary>;
  modus: ModeId;
}): JSX.Element {
  const championId = entry.championId || entry.championPickIntent;
  const champion = championId ? champions.get(championId) : undefined;
  const rang = rangVoor(entry.profile, modus);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-white/[0.04] py-1 pr-2.5 pl-1">
      <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={22} />
      <span className="text-[11px] text-ink-300">
        {entry.toonNaam ?? champion?.name ?? "Hidden player"}
      </span>
      {rang === undefined ? null : <RankPill rank={rang} compact />}
    </div>
  );
}

/**
 * Een vinkje in plaats van een knop: staat het aan, dan houdt de app je
 * mastery-pagina vanzelf gelijk aan de champion die je gepickt hebt. Ook als je
 * halverwege van champion wisselt.
 */
function AutoMasteries({
  enabled,
  status,
  championId,
}: {
  enabled: boolean;
  status: string | null;
  championId: number | null;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    setBusy(true);
    await window.jade.updateSettings({ autoMasteries: !enabled });
    setBusy(false);
  }

  return (
    <div className="no-drag">
      <label
        className={`flex w-fit cursor-pointer items-center gap-2.5 rounded-xl border px-4 py-2 transition-colors ${
          enabled
            ? "border-gold-400/40 bg-gold-400/12 text-gold-300"
            : "border-white/10 text-ink-300 hover:border-white/20"
        } ${busy ? "opacity-60" : ""}`}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => void toggle()}
          disabled={busy}
          className="h-3.5 w-3.5 accent-gold-400"
        />
        <span className="text-[12px] font-medium">Auto Set Best Masteries</span>
      </label>
      <p className="mt-1.5 max-w-[520px] text-[11px] text-ink-700">
        {!enabled
          ? "Off — your mastery pages stay untouched."
          : status
            ? status
            : championId
              ? "Watching your pick..."
              : "On — applies as soon as you pick a champion."}
      </p>
    </div>
  );
}

function BanStrip({
  label,
  bans,
  champions,
  align = "left",
}: {
  label: string;
  bans: number[];
  champions: Map<number, ChampionSummary>;
  align?: "left" | "right";
}): JSX.Element {
  return (
    <div className={align === "right" ? "text-right" : ""}>
      <p className="mb-1 text-[9px] tracking-[0.16em] text-ink-700 uppercase">{label}</p>
      <div className={`flex gap-1 ${align === "right" ? "justify-end" : ""}`}>
        {bans.length === 0 ? (
          <span className="text-[10px] text-ink-700">none</span>
        ) : (
          bans.map((championId, index) => {
            const champion = champions.get(championId);
            return (
              <div key={`${championId}-${index}`} className="relative">
                <ChampionIcon
                  iconPath={champion?.iconPath}
                  name={champion?.name}
                  size={26}
                  className="opacity-55 grayscale"
                />
                <span className="pointer-events-none absolute inset-0 grid place-items-center text-loss-400">
                  <svg width="24" height="24" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6">
                    <path d="M5 19 19 5" />
                  </svg>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Wat de verzamelde games zeggen over de champion die je net gepickt hebt:
 * welke items er gebouwd worden, welke spells, en tegen wie het lastig wordt.
 */
function BuildPanel({
  plan,
  champions,
  items,
  spells,
}: {
  plan: ChampionPlan;
  champions: Map<number, ChampionSummary>;
  items: Map<number, { name: string; iconPath: string }>;
  spells: Map<number, { name: string; iconPath: string }>;
}): JSX.Element {
  const champion = champions.get(plan.championId);
  const pct = (value: number): string => `${Math.round(value * 100)}%`;

  return (
    <Panel className="p-3">
      <div className="mb-2.5 flex items-baseline justify-between">
        <p className="text-[10px] tracking-[0.16em] text-ink-700 uppercase">
          What wins on {champion?.name ?? "your pick"}
        </p>
        <span className="num text-[10px] text-ink-700">
          {POSITION_LABELS[plan.position]}
          {plan.games > 0 ? ` · ${plan.winrate !== null ? pct(plan.winrate) : "-"} over ${plan.games} games` : ""}
        </span>
      </div>

      {plan.games === 0 ? (
        <p className="text-[11px] text-ink-500">
          Not enough games on this champion yet. The database is still filling up.
        </p>
      ) : (
        <div className="grid grid-cols-[1fr_auto] gap-4">
          <div>
            <div className="flex flex-wrap gap-1.5">
              {[...plan.items, ...plan.boots].map((entry) => {
                const item = items.get(entry.itemId);
                return (
                  <div
                    key={entry.itemId}
                    title={`${item?.name ?? entry.itemId} · built in ${pct(entry.pickRate)} of games · ${pct(entry.winrate)} winrate`}
                    className="flex items-center gap-1.5 rounded-lg bg-white/[0.04] py-1 pr-2 pl-1"
                  >
                    {item?.iconPath ? (
                      <img src={asset(item.iconPath)} alt="" className="h-6 w-6 rounded border border-white/8" />
                    ) : null}
                    <span className="num text-[10px] text-ink-500">{pct(entry.pickRate)}</span>
                    <span
                      className={`num text-[10px] font-medium ${
                        entry.winrate >= 0.54 ? "text-jade-400" : "text-ink-300"
                      }`}
                    >
                      {pct(entry.winrate)}
                    </span>
                  </div>
                );
              })}
            </div>

            {plan.weakAgainst.length > 0 ? (
              <div className="mt-3">
                <p className="text-[10px] tracking-[0.13em] text-loss-400 uppercase">Careful against</p>
                {/* Faces, like the items above. A row of names is something you
                    have to read; a row of portraits is something you recognise
                    the moment the enemy locks one in. */}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {plan.weakAgainst.map((m) => {
                    const champion = champions.get(m.championId);
                    return (
                      <span
                        key={m.championId}
                        className="flex items-center gap-1.5 rounded-lg border border-loss-500/25 bg-loss-500/[0.07] py-1 pr-2 pl-1"
                        title={`${champion?.name ?? m.championId} beats this pick in ${pct(m.winrate)} of ${m.games} games`}
                      >
                        <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={22} />
                        <span className="num text-[10px] font-semibold text-loss-400">{pct(m.winrate)}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5 border-l border-line pl-4">
            {plan.spells.map((entry) => (
              <div key={entry.spells.join("-")} className="flex items-center gap-1.5">
                {entry.spells.map((id) => {
                  const spell = spells.get(id);
                  return spell?.iconPath ? (
                    <img
                      key={id}
                      src={asset(spell.iconPath)}
                      alt={spell.name}
                      title={spell.name}
                      className="h-6 w-6 rounded border border-white/8"
                    />
                  ) : null;
                })}
                <span className="num text-[10px] text-ink-500">{pct(entry.pickRate)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
