/**
 * Tier lists, matchups and item builds for one mode at a time.
 *
 * Every number is shown with the games behind it. A 70% winrate over 9 games and
 * a 54% over 400 look nothing alike once you can see the sample -- and a number
 * from the wrong mode looks exactly like a right one, which is why the mode is
 * named on the switch above the list and passed on every call below it.
 */
import { useEffect, useState } from "react";
import type {
  AppSnapshot, ChampionDetail, ChampionSummary, ItemEntry, Position, SpellEntry, TierEntry,
} from "../../../shared/types";
import type { CollectedMode } from "../../../core/modes/registry";
import { COLLECTED_MODES, modeCrawls, modeLabel } from "../../../core/modes/registry";
import { ModusKeuze, ModusLeeg } from "../modus";
import {
  asset, catalogusIndex, ChampionIcon, EmptyState, Panel, PositionIcon, POSITION_LABELS,
  SectionTitle, Spinner,
} from "../ui";

const POSITIONS: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];

/** Below this many games a champion is not listed: the number would be noise. */
const MIN_GAMES = 25;

function winrateTone(winrate: number): string {
  return winrate >= 0.55 ? "text-jade-400" : winrate <= 0.45 ? "text-loss-400" : "text-ink-300";
}

export function MetaView({
  snapshot,
  modus,
  onKiesModus,
}: {
  snapshot: AppSnapshot;
  /** The browse mode: a choice the reader made, held by the window. */
  modus: CollectedMode;
  onKiesModus: (mode: CollectedMode) => void;
}): JSX.Element {
  const [position, setPosition] = useState<Position>("MIDDLE");
  const [tier, setTier] = useState<TierEntry[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<ChampionDetail | null>(null);

  const champions = catalogusIndex(snapshot.champions, modus);
  const items = catalogusIndex(snapshot.items, modus);
  const spells = catalogusIndex(snapshot.spells, modus);

  // This mode's figures, not the app's totals: the sentence under the switch
  // reports the pool the list beside it was actually computed from.
  const cijfers = snapshot.database.perModus[modus];
  const spelen = cijfers ? (cijfers.community?.games ?? cijfers.matches) : 0;

  // The other mode, offered only when it has something to offer. Pointing at a
  // second empty screen is worse than saying nothing.
  const ander =
    COLLECTED_MODES.find((entry) => {
      const anderCijfers = snapshot.database.perModus[entry];
      return entry !== modus && (anderCijfers?.community?.games ?? anderCijfers?.matches ?? 0) > 0;
    }) ?? null;

  // Deliberately not gated on the client being connected. The tier list is
  // computed from the local database -- community data plus whatever has been
  // crawled -- and needs no client at all. Waiting for a connection left this
  // panel spinning forever for anyone who opened the app before League.
  useEffect(() => {
    setTier(null);
    setSelected(null);
    setDetail(null);
    void window.jade.getTierList(modus, position, MIN_GAMES).then(setTier);
  }, [modus, position, spelen]);

  useEffect(() => {
    if (selected === null) return;
    setDetail(null);
    void window.jade.getChampionDetail(modus, selected, position).then(setDetail);
  }, [modus, selected, position]);

  return (
    <div className="animate-rise space-y-5">
      <ModusKeuze modus={modus} onKies={onKiesModus} snapshot={snapshot} />

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
        {/* Named, because the number and the mode have to travel together. A
            count on its own beside a tier list is read as the app's size, and
            the app's size is not what these bands were computed from. */}
        <span className="num text-[11px] text-ink-700">
          from {spelen.toLocaleString("en-US")}{" "}
          {cijfers?.community ? "shared" : "collected"} {modeLabel(modus)} games
          {/* Why the total is smaller than the file it was read from, on the one
              run in a thousand where the app had to leave records out. Absent
              otherwise. It belongs in this sentence and nowhere else: this is
              the only place the number itself is printed, and a count that
              quietly dropped is indistinguishable from a database that grew
              slowly. Plain text in the span that is already here -- nothing new
              to look at, just the rest of the sentence. */}
          {cijfers?.probleem ? ` · ${cijfers.probleem}` : ""}
          {/* Only where the crawler is actually working. It runs in one mode, so
              "syncing" beside the other mode's total says something is filling
              up that is not. */}
          {snapshot.database.crawling && modeCrawls(modus) ? " · syncing" : ""}
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
              {/* Two different emptinesses, and they used to share one sentence.
                  A mode with games but a thin lane really does fill in while you
                  play; a mode with no games at all may never, and saying the
                  first about the second is a promise nobody can keep. */}
              {spelen === 0 ? (
                <ModusLeeg modus={modus} ander={ander} onKies={onKiesModus} />
              ) : (
                <EmptyState
                  title={`Not enough ${modeLabel(modus)} games for this lane yet`}
                  hint="Other lanes may already have enough. This one keeps filling in while you play."
                />
              )}
            </Panel>
          ) : (
            <TierBanden
              tier={tier}
              champions={champions}
              selected={selected}
              onSelect={setSelected}
            />
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

/**
 * De tier-banden.
 *
 * Hiervoor stond hier een tabel: eenenzestig rijen met vier getallen elk. Dat
 * is compleet en het is onleesbaar -- je ziet pas wie sterk is nadat je hebt
 * gelezen. Een band per tier laat dat in één blik zien, en de portretten doen
 * het werk dat de namen deden.
 *
 * De grenzen staan hieronder en worden ook getoond. Ze zijn van ons, niet van
 * de data: champions.json kent geen tiers. Wie het er niet mee eens is hoort te
 * kunnen zien waar ze liggen in plaats van een letter te moeten geloven.
 */
const BANDEN: Array<{ letter: string; vanaf: number; kleur: string; rand: string }> = [
  { letter: "S", vanaf: 0.545, kleur: "text-gold-300", rand: "border-gold-500" },
  { letter: "A", vanaf: 0.52, kleur: "text-jade-300", rand: "border-jade-500/45" },
  { letter: "B", vanaf: 0.49, kleur: "text-ink-100", rand: "border-line-lit" },
  { letter: "C", vanaf: 0.46, kleur: "text-ink-300", rand: "border-line" },
  { letter: "D", vanaf: -1, kleur: "text-loss-400", rand: "border-loss-500/40" },
];

function TierBanden({
  tier,
  champions,
  selected,
  onSelect,
}: {
  tier: TierEntry[];
  champions: Map<number, ChampionSummary>;
  selected: number | null;
  onSelect: (id: number) => void;
}): JSX.Element {
  // Eén doorloop: elke champion in de eerste band waar hij boven de grens valt.
  const perBand = BANDEN.map((band) => ({
    band,
    rijen: tier.filter((e) => {
      const hoger = BANDEN.find((b) => b.vanaf > band.vanaf && e.winrate >= b.vanaf);
      return e.winrate >= band.vanaf && !hoger;
    }),
  })).filter((g) => g.rijen.length > 0);

  return (
    <div className="space-y-2">
      {perBand.map(({ band, rijen }) => (
        <div key={band.letter} className="panel flex items-start gap-3 p-3">
          {/* De letter draagt de band en staat daarom apart, niet als kolom. */}
          <div
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-md border text-lg font-bold ${band.rand} ${band.kleur}`}
            style={{ background: "rgba(255,255,255,0.02)" }}
          >
            {band.letter}
          </div>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {rijen.map((entry) => {
              const champion = champions.get(entry.championId);
              const aan = selected === entry.championId;
              return (
                <button
                  key={entry.championId}
                  onClick={() => onSelect(entry.championId)}
                  title={`${champion?.name ?? entry.championId} — ${(entry.winrate * 100).toFixed(1)}% over ${entry.games} games, ${entry.kda.toFixed(2)} KDA`}
                  className={`relative overflow-hidden rounded-md border transition-colors ${
                    aan ? "border-gold-400" : "border-line hover:border-gold-500/60"
                  }`}
                >
                  <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={44} />
                  {/* De winrate onderaan het portret: het getal hoort bij het
                      gezicht en niet in een kolom drie plekken verderop. */}
                  <span className="num absolute inset-x-0 bottom-0 bg-void/85 py-px text-center text-[9px] font-semibold text-ink-100">
                    {(entry.winrate * 100).toFixed(0)}%
                  </span>
                </button>
              );
            })}
          </div>
          <span className="num shrink-0 pt-1 text-[10px] text-ink-700">{rijen.length}</span>
        </div>
      ))}
      <p className="px-1 pt-1 text-[10px] text-ink-700">
        Bands are ours, not Riot&rsquo;s: S from 54.5% win rate, A from 52%, B from 49%, C from 46%.
        Every champion here already clears the {MIN_GAMES}-game floor.
      </p>
    </div>
  );
}
