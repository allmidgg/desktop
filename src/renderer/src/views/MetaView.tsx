/**
 * Tier lists, matchups and item builds — all computed from the games we collect
 * ourselves, because no public source has this mode.
 *
 * Every number is shown with the games behind it. A 70% winrate over 9 games and
 * a 54% over 400 look nothing alike once you can see the sample.
 */
import { useEffect, useState } from "react";
import type {
  AppSnapshot, ChampionDetail, ItemEntry, Position, SpellEntry, TierEntry,
} from "../../../shared/types";
import {
  asset, ChampionIcon, EmptyState, Panel, PositionIcon, POSITION_LABELS, SectionTitle, Spinner,
} from "../ui";

const POSITIONS: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];

/** Below this many games a champion is not listed: the number would be noise. */
const MIN_GAMES = 25;

function winrateTone(winrate: number): string {
  return winrate >= 0.55 ? "text-jade-400" : winrate <= 0.45 ? "text-loss-400" : "text-ink-300";
}

export function MetaView({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [position, setPosition] = useState<Position>("MIDDLE");
  const [tier, setTier] = useState<TierEntry[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<ChampionDetail | null>(null);

  const champions = new Map(snapshot.champions.map((c) => [c.jadeId, c]));
  const items = new Map(snapshot.items.map((i) => [i.jadeId, i]));
  const spells = new Map(snapshot.spells.map((s) => [s.jadeId, s]));

  useEffect(() => {
    if (snapshot.connection !== "connected") return;
    setTier(null);
    setSelected(null);
    setDetail(null);
    void window.jade.getTierList(position, MIN_GAMES).then(setTier);
  }, [position, snapshot.connection, snapshot.database.matches]);

  useEffect(() => {
    if (selected === null) return;
    setDetail(null);
    void window.jade.getChampionDetail(selected, position).then(setDetail);
  }, [selected, position]);

  return (
    <div className="animate-rise space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {POSITIONS.map((entry) => (
            <button
              key={entry}
              onClick={() => setPosition(entry)}
              className={`flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-[12px] font-medium transition-colors ${
                position === entry
                  ? "border-gold-400/40 bg-gold-400/12 text-gold-300"
                  : "border-white/8 text-ink-500 hover:border-line-lit hover:text-ink-300"
              }`}
            >
              <PositionIcon position={entry} size={14} />
              {POSITION_LABELS[entry]}
            </button>
          ))}
        </div>
        <span className="num text-[11px] text-ink-700">
          from{" "}
          {(snapshot.database.community?.games ?? snapshot.database.matches).toLocaleString("en-US")}{" "}
          {snapshot.database.community ? "shared games" : "collected games"}
          {snapshot.database.crawling ? " · syncing" : ""}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_380px] gap-5">
        <div>
          <SectionTitle hint={`at least ${MIN_GAMES} games`}>
            {POSITION_LABELS[position]} tier list
          </SectionTitle>

          {!tier ? (
            <Panel className="p-6">
              <Spinner label="Crunching the numbers..." />
            </Panel>
          ) : tier.length === 0 ? (
            <Panel className="p-6">
              <EmptyState
                title="Not enough games for this lane yet"
                hint="The database keeps growing in the background while you play."
              />
            </Panel>
          ) : (
            <div className="space-y-1">
              {tier.map((entry, index) => {
                const champion = champions.get(entry.championId);
                const active = selected === entry.championId;
                return (
                  <button
                    key={entry.championId}
                    onClick={() => setSelected(entry.championId)}
                    className={`panel flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                      active ? "border-gold-400/45" : "hover:border-line-lit"
                    }`}
                  >
                    <span className="num w-6 text-center text-[12px] text-ink-700">{index + 1}</span>
                    <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={34} />
                    <span className="flex-1 truncate text-[13px] font-medium">
                      {champion?.name ?? entry.championId}
                    </span>
                    <span
                      className={`num w-14 text-right text-[13px] font-semibold ${winrateTone(entry.winrate)}`}
                    >
                      {(entry.winrate * 100).toFixed(0)}%
                    </span>
                    <span className="num w-16 text-right text-[11px] text-ink-500">{entry.games}g</span>
                    <span className="num w-16 text-right text-[11px] text-ink-500">
                      {(entry.pickRate * 100).toFixed(1)}%
                    </span>
                    <span className="num w-14 text-right text-[11px] text-ink-500">
                      {entry.kda.toFixed(2)}
                    </span>
                  </button>
                );
              })}
              <div className="flex gap-3 px-3 pt-1 text-[10px] tracking-wide text-ink-700 uppercase">
                <span className="ml-auto w-14 text-right">winrate</span>
                <span className="w-16 text-right">games</span>
                <span className="w-16 text-right">pick</span>
                <span className="w-14 text-right">kda</span>
              </div>
            </div>
          )}
        </div>

        <div>
          <SectionTitle>Champion</SectionTitle>
          {selected === null ? (
            <Panel className="p-6">
              <EmptyState title="Pick a champion" hint="Builds and matchups appear here." />
            </Panel>
          ) : !detail ? (
            <Panel className="p-6">
              <Spinner label="Loading..." />
            </Panel>
          ) : (
            <ChampionPanel
              detail={detail}
              champions={champions}
              items={items}
              spells={spells}
              name={champions.get(detail.championId)?.name ?? String(detail.championId)}
              iconPath={champions.get(detail.championId)?.iconPath}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ChampionPanel({
  detail,
  champions,
  items,
  spells,
  name,
  iconPath,
}: {
  detail: ChampionDetail;
  champions: Map<number, { name: string; iconPath: string }>;
  items: Map<number, { name: string; iconPath: string }>;
  spells: Map<number, { name: string; iconPath: string }>;
  name: string;
  iconPath?: string;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <Panel className="p-4">
        <div className="flex items-center gap-3">
          <ChampionIcon iconPath={iconPath} name={name} size={48} />
          <div className="flex-1">
            <p className="text-base font-medium">{name}</p>
            {detail.stat ? (
              <p className="num text-[11px] text-ink-500">
                <span className={winrateTone(detail.stat.winrate)}>
                  {(detail.stat.winrate * 100).toFixed(0)}%
                </span>{" "}
                over {detail.stat.games} games · KDA {detail.stat.kda.toFixed(2)}
              </p>
            ) : null}
          </div>
        </div>

        {detail.positions.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
            {detail.positions.map((entry) => (
              <span
                key={entry.position}
                className={`num flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] ${
                  entry.position === detail.position
                    ? "bg-gold-400/12 text-gold-300"
                    : "bg-white/[0.04] text-ink-500"
                }`}
              >
                <PositionIcon position={entry.position} size={11} />
                {POSITION_LABELS[entry.position]} {(entry.share * 100).toFixed(0)}%
              </span>
            ))}
          </div>
        ) : null}
      </Panel>

      <SpellBlock entries={detail.spells} spells={spells} />
      <ItemBlock title="Most built items" entries={detail.items} items={items} />
      <ItemBlock title="Boots" entries={detail.boots} items={items} />

      <MatchupBlock
        title="Wins against"
        entries={detail.strongAgainst}
        champions={champions}
        tone="text-jade-400"
      />
      <MatchupBlock
        title="Struggles against"
        entries={detail.weakAgainst}
        champions={champions}
        tone="text-loss-400"
      />
    </div>
  );
}

function ItemBlock({
  title,
  entries,
  items,
}: {
  title: string;
  entries: ItemEntry[];
  items: Map<number, { name: string; iconPath: string }>;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <Panel className="p-4">
      <p className="mb-2.5 text-[10px] tracking-[0.16em] text-ink-700 uppercase">{title}</p>
      <div className="space-y-1.5">
        {entries.map((entry) => {
          const item = items.get(entry.itemId);
          return (
            <div key={entry.itemId} className="flex items-center gap-2.5">
              {item?.iconPath ? (
                <img
                  src={asset(item.iconPath)}
                  alt={item.name}
                  className="h-7 w-7 rounded-md border border-white/8"
                />
              ) : (
                <div className="h-7 w-7 rounded-md border border-white/8 bg-white/[0.02]" />
              )}
              <span className="flex-1 truncate text-[12px]">{item?.name ?? entry.itemId}</span>
              <span className="num text-[11px] text-ink-500">{(entry.pickRate * 100).toFixed(0)}%</span>
              <span className={`num w-10 text-right text-[11px] ${winrateTone(entry.winrate)}`}>
                {(entry.winrate * 100).toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-ink-700">
        share of games the item was in the final build · winrate with it
      </p>
    </Panel>
  );
}

function MatchupBlock({
  title,
  entries,
  champions,
  tone,
}: {
  title: string;
  entries: Array<{ championId: number; winrate: number; games: number }>;
  champions: Map<number, { name: string; iconPath: string }>;
  tone: string;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <Panel className="p-4">
      <p className="mb-2.5 text-[10px] tracking-[0.16em] text-ink-700 uppercase">{title}</p>
      <div className="space-y-1.5">
        {entries.map((entry) => {
          const champion = champions.get(entry.championId);
          return (
            <div key={entry.championId} className="flex items-center gap-2.5">
              <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={26} />
              <span className="flex-1 truncate text-[12px]">{champion?.name ?? entry.championId}</span>
              <span className={`num text-[12px] font-medium ${tone}`}>
                {(entry.winrate * 100).toFixed(0)}%
              </span>
              <span className="num w-10 text-right text-[10px] text-ink-700">{entry.games}g</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function SpellBlock({
  entries,
  spells,
}: {
  entries: SpellEntry[];
  spells: Map<number, { name: string; iconPath: string }>;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <Panel className="p-4">
      <p className="mb-2.5 text-[10px] tracking-[0.16em] text-ink-700 uppercase">Summoner spells</p>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.spells.join("-")} className="flex items-center gap-2.5">
            <div className="flex gap-1">
              {entry.spells.map((id) => {
                const spell = spells.get(id);
                return spell?.iconPath ? (
                  <img
                    key={id}
                    src={asset(spell.iconPath)}
                    alt={spell.name}
                    title={spell.name}
                    className="h-7 w-7 rounded-md border border-white/8"
                  />
                ) : (
                  <div key={id} className="h-7 w-7 rounded-md border border-white/8 bg-white/[0.02]" />
                );
              })}
            </div>
            <span className="flex-1 truncate text-[12px]">
              {entry.spells.map((id) => spells.get(id)?.name ?? id).join(" + ")}
            </span>
            <span className="num text-[11px] text-ink-500">{(entry.pickRate * 100).toFixed(0)}%</span>
            <span className={`num w-10 text-right text-[11px] ${winrateTone(entry.winrate)}`}>
              {(entry.winrate * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
