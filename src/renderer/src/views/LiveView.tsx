/**
 * The screen that follows whatever you are doing in the client.
 *
 * During champion select it hands over to the scout; the rest of the time it
 * shows your recent Classic games.
 */
import { bouwPad } from "../../../shared/build";
import type {
  AppSnapshot, BuildStep, ChampionDetail, ChampionSummary, GameDetail, GameDetailPlayer,
  ItemSummary, LiveGamePlayer, LiveGameSnapshot, LiveInzichtenUit, RecentGameSummary,
  TeamTotaalUit, TierEntry,
} from "../../../shared/types";
import { ChampSelectView } from "./ChampSelectView";
import { MerkGeslepen } from "../merk";
import { Fragment, useEffect, useState } from "react";
import {
  asset, ChampionIcon, EmptyState, FormDots, ItemRow, Panel, RankPill, SectionTitle, SkillGrid,
  SpellPair, Spinner, SplashBackdrop, Winrate, WinrateRing,
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

/**
 * Where this screen can send you.
 *
 * Deliberately narrower than App's own Tab union: the live screen is where you
 * already are, so "live" is never a destination it should be able to offer.
 */
export type SnelnavDoel = "meta" | "profile" | "runes" | "masteries";

export function LiveView({
  snapshot,
  onNavigate,
}: {
  snapshot: AppSnapshot;
  /** The tab strip lives in the shell, so the view cannot switch it itself. */
  onNavigate: (tab: SnelnavDoel) => void;
}): JSX.Element {
  if (snapshot.connection !== "connected") return <GeenGame snapshot={snapshot} />;
  if (snapshot.champSelect) return <ChampSelectView snapshot={snapshot} />;
  return <LiveInhoud snapshot={snapshot} onNavigate={onNavigate} />;
}

/**
 * De games die AllMid volgt.
 *
 * Een lijst en geen vaste tekst, omdat er een tweede bij komt. Wat er niet in
 * staat zijn games die we nog niet doen -- een rij grijze logo's is een belofte,
 * en die maken we hier niet.
 */
const GEVOLGDE_GAMES = [{ naam: "League of Legends", modus: "Classic", actief: true }];

/**
 * Wat je ziet als er niets draait.
 *
 * Vroeger stond hier een spinner met "Connecting to the League client...", en
 * dat leest als een app die vastloopt. Er is niets aan de hand: er is gewoon
 * geen game bezig, en dat is de normale toestand van een companion. Dus zegt hij
 * dat, vertelt wat er gebeurt zodra je begint, en laat zien welke games hij in
 * de gaten houdt.
 */
function GeenGame({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const clientAan = snapshot.connection === "connected";

  return (
    <div className="animate-rise flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-lg text-center">
        {/* Het merk, rustig: de M met de duikende middenstok. */}
        <MerkGeslepen size={58} className="mx-auto mb-5 opacity-80" />

        <h2 className="mb-2 text-lg font-semibold text-ink-100">No game running</h2>
        <p className="mx-auto mb-7 max-w-sm text-sm leading-relaxed text-ink-500">
          AllMid sits here until one starts. Open champion select and it comes to the front on its
          own, with your masteries, your matchups and what wins on your pick.
        </p>

        <div className="mb-6 space-y-1.5">
          {GEVOLGDE_GAMES.map((g) => (
            <div
              key={g.naam}
              className="flex items-center justify-between rounded-lg border border-line bg-white/[0.02] px-3.5 py-2.5 text-left"
            >
              <span className="flex items-center gap-2.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    clientAan ? "animate-pulse-ring bg-jade-500" : "bg-ink-700"
                  }`}
                />
                <span className="text-[13px] font-medium text-ink-200">{g.naam}</span>
                <span className="text-[11px] tracking-[0.1em] text-ink-600 uppercase">{g.modus}</span>
              </span>
              <span className="num text-[11px] text-ink-600">
                {clientAan ? "watching" : "client closed"}
              </span>
            </div>
          ))}
        </div>

        {/* De client-stand als bijzaak, want daar hoef je niets mee zolang je
            niet speelt. Alleen als hij dicht is is het het vermelden waard. */}
        {!clientAan ? (
          <p className="text-xs text-ink-600">
            {snapshot.error ?? "Start the League client — AllMid picks up the connection on its own."}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LiveInhoud({
  snapshot,
  onNavigate,
}: {
  snapshot: AppSnapshot;
  onNavigate: (tab: SnelnavDoel) => void;
}): JSX.Element {
  const [geopend, setGeopend] = useState<number | null>(null);
  const [gekozen, setGekozen] = useState<number | null>(null);

  return (
    <div className="animate-rise">
      {snapshot.liveGame ? (
        <div className="mb-5">
          <LiveGamePanel live={snapshot.liveGame} snapshot={snapshot} />
        </div>
      ) : null}

      {/* Twee kolommen: wat je deed links, wat je moet weten rechts. De
          matchlijst is het lange verhaal en krijgt de ruimte; de rechterkolom
          is de context ernaast en blijft smal. */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <StatusBalk snapshot={snapshot} />

          <div>
            <SectionTitle hint={`${snapshot.recentGames.length} games`}>
              Recent Classic games
            </SectionTitle>
            {snapshot.recentGames.length === 0 ? (
              <Panel className="p-6">
                <EmptyState
                  title="No Classic games yet"
                  hint="Games appear here after you play one. AllMid reads them from your own client."
                />
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

          <Snelnav onNavigate={onNavigate} />
        </div>

        <div className="space-y-5">
          <TierKolom
            snapshot={snapshot}
            gekozen={gekozen}
            onKies={setGekozen}
            onNavigate={onNavigate}
          />
          <ChampionKolom snapshot={snapshot} championId={gekozen} />
          <JouwStats snapshot={snapshot} />
        </div>
      </div>
    </div>
  );
}

/**
 * De vier uitgangen van het live-scherm.
 *
 * Three of them go exactly where the left rail goes, which looks like a
 * duplicate and is not one. The rail is permanent chrome and permanent chrome
 * goes unread; this bar is the last thing under the match list, so it is in
 * front of you at the moment you have finished reading and are looking for what
 * is next. A destination you can reach two ways beats one you can only reach
 * through a strip your eye has learned to skip.
 *
 * Champions is the odd one: it has no tab of its own. Meta is where it belongs
 * anyway -- that screen is a per-lane list of every champion in the database,
 * with a build and a matchup behind each portrait, which is what "browse all
 * champs" means. The cost is that the rail lights up "Meta" after you clicked
 * "Champions"; renaming that one tab would close the gap, but the mock-up still
 * calls it Meta, so it keeps the name it has.
 *
 * The icons are drawn rather than shipped, the way PositionIcon is: four line
 * glyphs at 22px in a 24 grid, so they stay crisp at any scale and cost nothing
 * to load.
 */
const SNELNAV: Array<{ doel: SnelnavDoel; titel: string; onder: string; pad: string[] }> = [
  {
    doel: "profile",
    titel: "Profile",
    onder: "Overview & Stats",
    pad: ["M12 12.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Z", "M4.4 20.4a7.6 7.6 0 0 1 15.2 0"],
  },
  {
    doel: "runes",
    titel: "Runes",
    onder: "Build your runes",
    pad: [
      "M12 7.6 16.4 12 12 16.4 7.6 12Z",
      "M12 2.4 13.8 4.2 12 6 10.2 4.2Z",
      "M21.6 12 19.8 13.8 18 12 19.8 10.2Z",
      "M12 21.6 10.2 19.8 12 18 13.8 19.8Z",
      "M2.4 12 4.2 10.2 6 12 4.2 13.8Z",
    ],
  },
  {
    doel: "masteries",
    titel: "Masteries",
    onder: "Mastery pages",
    pad: [
      "M12 3 14.4 6 12 9 9.6 6Z",
      "M12 9v3",
      "M6.6 15v-3h10.8v3",
      "M6.6 15 9 18 6.6 21 4.2 18Z",
      "M17.4 15 19.8 18 17.4 21 15 18Z",
    ],
  },
  {
    doel: "meta",
    titel: "Champions",
    onder: "Browse all champs",
    pad: [
      "M5.2 10.2a6.8 6.8 0 0 1 13.6 0v7.3a2.3 2.3 0 0 1-2.3 2.3H7.5a2.3 2.3 0 0 1-2.3-2.3Z",
      "M5.2 13.8h13.6",
      "M12 13.8v6",
    ],
  },
];

function Snelnav({ onNavigate }: { onNavigate: (tab: SnelnavDoel) => void }): JSX.Element {
  return (
    <Panel className="snelnav">
      {SNELNAV.map((entry) => (
        <button
          key={entry.doel}
          type="button"
          onClick={() => onNavigate(entry.doel)}
          className="snelnav-item"
        >
          <svg
            className="snelnav-icoon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {entry.pad.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </svg>
          <span className="min-w-0">
            <span className="snelnav-titel truncate">{entry.titel}</span>
            <span className="snelnav-onder truncate">{entry.onder}</span>
          </span>
        </button>
      ))}
    </Panel>
  );
}

/** De statusbalk: waar je nu bent, en je rang ernaast. */
function StatusBalk({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  return (
    <Panel className="flex items-center justify-between gap-6 p-5">
      <div>
        {/* Sizes and padding here were already right once the mock-up was pinned
            to the correct scale: the phase line measures 101 CSS wide at a 17px
            cap, which is exactly this text-lg, and the text starts 20.5 px
            inside the panel, which is exactly this p-5. What was wrong was the
            air between the lines and the brightness of the sentence. */}
        <p className="sectiekop">Status</p>
        <p className="mt-2 text-lg font-semibold text-ink-100">
          {PHASE_LABELS[snapshot.phase] ?? snapshot.phase}
        </p>
        <p className="mt-1.5 text-xs text-ink-300">
          The scout opens by itself as soon as champion select begins.
        </p>
      </div>
      {snapshot.profile ? (
        <div className="status-rang flex flex-col items-end gap-2">
          <RankPill rank={snapshot.profile.rank} />
          <div className="flex items-center gap-3">
            <Winrate winrate={snapshot.profile.jade.winrate} games={snapshot.profile.jade.games} />
            <FormDots results={snapshot.profile.jade.recentResults} />
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * De letters bij een winrate.
 *
 * Dit is een oordeel van ons, geen meting: de data kent geen tiers. De regel
 * staat hier zodat hij na te lezen is -- winrate bepaalt de letter, en niets
 * anders. Wie het niet met de grenzen eens is kan ze hier zien staan in plaats
 * van te moeten raden waar ze vandaan komen.
 */
/**
 * `winrate` is een fractie (0.553), zoals overal in deze codebase.
 *
 * Two shapes come out of one rule, because the letter shows up twice on this
 * screen and the mock-up draws it differently each time. `klasse` is the filled
 * seal on a tier tile; `tekst` is only a colour, for the outlined chip in the
 * champion panel, which takes its border and fill from currentColor. One
 * function so a champion can never be an S in one panel and something else in
 * the other.
 */
function tierLetter(winrate: number): { letter: string; klasse: string; tekst: string } {
  // Only S is inverted -- solid gold with a dark letter -- because it is the one
  // that has to be findable in a row of six at a glance; the rest stay dark
  // plates so they read as a scale below it rather than five more things
  // shouting.
  if (winrate >= 0.55)
    return { letter: "S", klasse: "border-gold-400 bg-gold-400 text-void", tekst: "text-gold-300" };
  if (winrate >= 0.52)
    return { letter: "A", klasse: "border-jade-500/60 bg-jade-500/25 text-jade-300", tekst: "text-jade-300" };
  if (winrate >= 0.49)
    return { letter: "B", klasse: "border-line-lit bg-void/85 text-ink-100", tekst: "text-ink-100" };
  if (winrate >= 0.46)
    return { letter: "C", klasse: "border-line bg-void/85 text-ink-300", tekst: "text-ink-300" };
  return { letter: "D", klasse: "border-loss-500/50 bg-void/85 text-loss-400", tekst: "text-loss-400" };
}

/**
 * De grenzen, op de tooltip van de letter zelf.
 *
 * Ze stonden als vijfde tekstregel onder het raster. Dat is veel ruimte voor een
 * regel die je één keer leest, en het is precies de ruimte die de uitgang uit dit
 * paneel nodig had. Aan de letter hangen zet de uitleg waar de vraag ontstaat.
 */
const TIER_REGEL = "S 55%+ · A 52%+ · B 49%+ · C 46%+ · D below";

/**
 * De tier list voor jouw lane, met de portretten erbij.
 *
 * Six cards on one row. The card is a portrait and not a square because both the
 * face and the winrate have to be readable and at 50px across only one of them
 * fits; the number therefore gets a band of its own under the art instead of
 * lying over it. The letter hangs on the corner so it covers nothing, and the
 * grid keeps 4px of headroom for that overhang.
 */
function TierKolom({
  snapshot,
  gekozen,
  onKies,
  onNavigate,
}: {
  snapshot: AppSnapshot;
  gekozen: number | null;
  onKies: (id: number) => void;
  onNavigate: (tab: SnelnavDoel) => void;
}): JSX.Element {
  const [rijen, setRijen] = useState<TierEntry[] | null>(null);
  const champions = new Map(snapshot.champions.map((c) => [c.jadeId, c]));

  useEffect(() => {
    void window.jade.getTierList("MIDDLE", 25).then(setRijen);
  }, [snapshot.database.matches, snapshot.database.community?.games]);

  return (
    <Panel className="p-4">
      <div className="mb-4 flex items-baseline justify-between">
        <p className="sectiekop">Mid tier list</p>
        <span className="text-[11px] text-ink-300">at least 25 games</span>
      </div>

      {!rijen ? (
        // The skeleton is the same card, so the panel keeps its height and
        // nothing below it jumps when the list arrives.
        <div className="grid grid-cols-6 gap-1.5 pt-1">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="tier-tegel" />
          ))}
        </div>
      ) : rijen.length === 0 ? (
        <EmptyState title="Not enough games yet" hint="The database grows while you play." />
      ) : (
        <>
          <div className="grid grid-cols-6 gap-1.5 pt-1">
            {rijen.slice(0, 6).map((rij) => {
              const champ = champions.get(rij.championId);
              const tier = tierLetter(rij.winrate);
              const aan = gekozen === rij.championId;
              return (
                <button
                  key={rij.championId}
                  onClick={() => onKies(rij.championId)}
                  title={`${champ?.name ?? ""} — ${(rij.winrate * 100).toFixed(1)}% over ${rij.games} games`}
                  className={`tier-tegel ${aan ? "tier-tegel-aan" : ""}`}
                >
                  <span className="tier-art">
                    <ChampionIcon iconPath={champ?.iconPath} name={champ?.name} fill />
                  </span>
                  <span className="num tier-wr">{(rij.winrate * 100).toFixed(1)}%</span>
                  <span className={`tier-badge ${tier.klasse}`} title={TIER_REGEL}>
                    {tier.letter}
                  </span>
                  {aan ? <span className="tier-punt" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>

          {/* The way out of the six. The legend it replaces moved onto the
              letter's own tooltip, which is where the question gets asked. */}
          <button type="button" onClick={() => onNavigate("meta")} className="tier-meer">
            View full tier list
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 12h14" />
              <path d="m13 6 6 6-6 6" />
            </svg>
          </button>
        </>
      )}
    </Panel>
  );
}

/**
 * Seven item slots, because that is what the mock-up lays out and what fits on
 * one line beside the marker bar and the arrow: 3 + 16 + 7*30 + 6*6 + 32 comes
 * to 291 of the 328 px the panel has inside its padding.
 */
const CHAMPION_ITEMS = 7;

/** Wat er bekend is over de champion die je aanklikte. */
function ChampionKolom({
  snapshot,
  championId,
}: {
  snapshot: AppSnapshot;
  championId: number | null;
}): JSX.Element {
  const [detail, setDetail] = useState<ChampionDetail | null>(null);
  const [alles, setAlles] = useState(false);
  const champions = new Map(snapshot.champions.map((c) => [c.jadeId, c]));
  const items = new Map(snapshot.items.map((i) => [i.jadeId, i]));

  useEffect(() => {
    // An expanded build row belongs to the champion it was opened on, so it
    // collapses again the moment a different one is picked.
    setAlles(false);
    if (championId === null) {
      setDetail(null);
      return;
    }
    setDetail(null);
    void window.jade.getChampionDetail(championId, "MIDDLE").then(setDetail);
  }, [championId]);

  const champ = championId === null ? null : champions.get(championId);

  const tier = detail?.stat ? tierLetter(detail.stat.winrate) : null;

  return (
    <Panel className="paneel-champion p-4">
      <p className="sectiekop mb-3">Champion</p>
      {!champ ? (
        <div className="champion-leeg">
          <EmptyState
            title="Pick a champion"
            hint="Builds and matchups appear here."
            actie={<span className="champion-scheiding" aria-hidden="true" />}
          />
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-5">
            <ChampionIcon
              iconPath={champ.iconPath}
              name={champ.name}
              size={76}
              className="champion-portret"
            />
            <div className="min-w-0">
              <p className="truncate text-[18px] leading-[22px] font-semibold text-ink-100">
                {champ.name}
              </p>
              {/* The client ships each champion's classes and we show the first
                  one. It stays absent rather than guessed when the catalogue has
                  none, which happens for anything the client added since the
                  summary file was last read. */}
              {champ.roles[0] ? (
                <p className="truncate text-[12px] leading-4 text-ink-300 capitalize">
                  {champ.roles[0]}
                </p>
              ) : null}
              {detail?.stat && tier ? (
                <div className="mt-1.5 flex items-center gap-3">
                  {/* Same letter and the same hue as the tier list two panels up,
                      so one champion never reads as an S there and as something
                      else here. The sample size moved onto the winrate's title:
                      it is what you check, not what you scan. */}
                  <span className={`badge ${tier.tekst}`}>{tier.letter} Tier</span>
                  <span
                    className={`badge ${detail.stat.winrate >= 0.5 ? "badge-goed" : "badge-slecht"}`}
                    title={`${(detail.stat.winrate * 100).toFixed(1)}% won over ${detail.stat.games} games`}
                  >
                    {(detail.stat.winrate * 100).toFixed(1)}% WR
                  </span>
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-ink-500">Loading…</p>
              )}
            </div>
          </div>

          {detail && detail.items.length > 0 ? (
            <div className="champion-items">
              <span className="champion-items-baken" aria-hidden="true" />
              {(alles ? detail.items : detail.items.slice(0, CHAMPION_ITEMS)).map((entry) => {
                const item = items.get(entry.itemId);
                return (
                  <img
                    key={entry.itemId}
                    src={asset(item?.iconPath ?? "")}
                    alt={item?.name ?? ""}
                    title={`${item?.name ?? ""} — ${(entry.winrate * 100).toFixed(1)}% over ${entry.games} games`}
                    width={30}
                    height={30}
                  />
                );
              })}
              {/* The mock-up ends the row with an arrow, so it has to lead
                  somewhere real: it opens the builds that did not fit on the
                  line. Disabled rather than dropped when there is nothing more,
                  because a row that loses its last element on some champions and
                  not on others reads as a bug. */}
              <button
                type="button"
                className="champion-items-meer"
                onClick={() => setAlles(!alles)}
                disabled={detail.items.length <= CHAMPION_ITEMS}
                aria-expanded={alles}
                title={alles ? "Show fewer items" : "Show every item built"}
                aria-label={alles ? "Show fewer items" : "Show every item built"}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/**
 * Jouw eigen cijfers, met de twee waarvoor je kwam in goud.
 *
 * One headline statistic instead of five figures shouting equally loudly is
 * still the point, but the mock-up makes the case differently: winrate, KDA and
 * games share one frame, and colour rather than size decides what carries. Gold
 * goes on the two numbers you would look up anyway; every label around them
 * stays grey, so the row has one voice instead of five.
 *
 * The averages at the bottom are the three numbers the KDA is made of, and they
 * are worth showing precisely because the ratio hides them: 2.33 is the same
 * whether you die twice a game or six times.
 *
 * Note the labels were not too faint before, they were too loud: `text-ink-600`
 * is not a token in @theme, so Tailwind never generated the class and every one
 * of these labels inherited ink-100 and came out near white.
 */
function JouwStats({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const jade = snapshot.profile?.jade;
  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="sectiekop">Your stats (Classic)</p>
        {/* The window is not a guess: src/main/service.ts asks
            buildPlayerProfile for thirty games. Saying which thirty beats
            leaving the reader to work out what "your stats" averages over. */}
        <span className="text-[10px] text-ink-300">Last 30 games</span>
      </div>
      {!jade || jade.games === 0 ? (
        <EmptyState title="No games recorded" hint="Your own numbers appear once you have played." />
      ) : (
        <>
          <div className="stats-kader">
            <div className="stats-ring">
              <WinrateRing winrate={jade.winrate} games={jade.games} />
            </div>
            <div className="stats-cel">
              <p className="num text-[24px] leading-none font-bold text-gold-400">
                {jade.kda.toFixed(2)}
              </p>
              <p className="mt-1.5 text-[10px] tracking-[0.1em] text-ink-300 uppercase">KDA</p>
            </div>
            <div className="stats-cel">
              <p className="num text-[24px] leading-none font-bold text-gold-400">{jade.games}</p>
              <p className="mt-1.5 text-[10px] tracking-[0.1em] text-ink-300 uppercase">Games</p>
            </div>
          </div>

          {/* No rule of its own: the bottom edge of the frame above is already
              the line the mock-up separates these two rows with. */}
          <div className="mt-3.5 flex items-center justify-between gap-3">
            {jade.recentResults.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-ink-300">Recent form</span>
                <FormDots results={jade.recentResults} />
              </div>
            ) : (
              <div />
            )}
            <div className="text-right">
              <p className="num text-[14px] text-ink-100">
                {jade.avgKills.toFixed(1)} / {jade.avgDeaths.toFixed(1)} /{" "}
                {jade.avgAssists.toFixed(1)}
              </p>
              <p className="text-[11px] text-ink-300">avg KDA</p>
            </div>
          </div>
        </>
      )}
    </Panel>
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
        <Panel className="paneel-goud p-3 text-xs text-ink-400">{live.note}</Panel>
      ) : null}

      {live.inzichten ? <Inzichtenbalk inzichten={live.inzichten} /> : null}

      <OverlayKnoppen aan={snapshot.settings.overlay} beeldmodus={snapshot.beeldmodus} />

      {jij?.trinketLeeg ? (
        <Panel className="rim paneel-goud bg-gold-400/[0.06] p-3 text-xs text-gold-300">
          Your trinket slot is empty.
        </Panel>
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
            <LivePlayerRow key={`rest-${j}`} p={p} items={items} champions={champions} index={j} />
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

/**
 * Team totals and objective timers.
 *
 * The item difference stands in for a gold lead, which the running game does not
 * report for anyone but you. It is not the same number -- gold still in a pocket
 * counts towards a real lead and not towards this one -- so it is labelled for
 * what it is rather than dressed up as gold.
 */
function Inzichtenbalk({ inzichten }: { inzichten: LiveInzichtenUit }): JSX.Element {
  const { order, chaos, itemVerschil, objectieven } = inzichten;
  const blauwVoor = itemVerschil >= 0;
  const NAAM: Record<string, string> = { dragon: "Dragon", baron: "Baron", inhibitor: "Inhibitor" };

  return (
    <Panel className="grid gap-3 p-3.5">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <TeamKant totaal={order} blauw />
        <div className="text-center">
          <p className="text-[9px] tracking-[0.14em] text-ink-700 uppercase">Item gold</p>
          <p className={`num text-lg font-semibold ${blauwVoor ? "text-sky-400" : "text-loss-400"}`}>
            {itemVerschil === 0 ? "even" : `${blauwVoor ? "+" : ""}${(itemVerschil / 1000).toFixed(1)}k`}
          </p>
        </div>
        <TeamKant totaal={chaos} blauw={false} />
      </div>

      {objectieven.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
          {objectieven.map((o, i) => {
            const terug = o.overSeconden <= 0;
            return (
              <span
                key={`${o.soort}-${o.detail ?? i}`}
                title={`Fell at ${klok(o.gevallenOp)}, back at ${klok(o.terugOp)}`}
                className={`num flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] ${
                  terug
                    ? "border-jade-500/40 bg-jade-500/10 text-jade-300"
                    : "border-line-lit bg-white/[0.03] text-ink-300"
                }`}
              >
                <span className="text-ink-500">{NAAM[o.soort] ?? o.soort}</span>
                {o.detail && o.soort === "dragon" ? <span className="text-ink-600">{o.detail}</span> : null}
                <span>{terug ? "up" : klok(o.overSeconden)}</span>
              </span>
            );
          })}
        </div>
      ) : null}
    </Panel>
  );
}

function TeamKant({ totaal, blauw }: { totaal: TeamTotaalUit; blauw: boolean }): JSX.Element {
  return (
    <div className={blauw ? "" : "text-right"}>
      <p className={`num text-sm font-semibold ${blauw ? "text-sky-400" : "text-loss-400"}`}>
        {totaal.kills} <span className="text-[11px] font-normal text-ink-600">kills</span>
      </p>
      <p className="num mt-0.5 text-[10px] text-ink-600">
        {totaal.cs.toLocaleString("en-US")} cs · {totaal.wards} wards · {(totaal.itemWaarde / 1000).toFixed(1)}k in items
      </p>
    </div>
  );
}

/**
 * Turning the on-top panel on, and moving it.
 *
 * It is click-through by default, which is what makes it usable in a fight and
 * also what makes it impossible to drag. Unlocking hands the mouse back for as
 * long as it takes to put it somewhere; where it ends up is remembered.
 */
function OverlayKnoppen({
  aan,
  beeldmodus,
}: {
  aan: boolean;
  beeldmodus: AppSnapshot["beeldmodus"];
}): JSX.Element {
  const [ontgrendeld, setOntgrendeld] = useState(false);
  // Only worth saying when we actually read the setting and it is the one that
  // makes the panel impossible to see.
  const geblokkeerd = aan && beeldmodus === "fullscreen";
  return (
    <Panel className="flex flex-wrap items-center gap-2 p-2.5 text-[11px]">
      <button
        onClick={() => {
          void window.jade.updateSettings({ overlay: !aan });
          if (aan) setOntgrendeld(false);
        }}
        className={`rounded-lg border px-2.5 py-1 font-medium transition-colors ${
          aan
            ? "border-gold-400/40 bg-gold-400/10 text-gold-300"
            : "border-line text-ink-400 hover:border-line-lit"
        }`}
      >
        {aan ? "Overlay on" : "Overlay off"}
      </button>

      {aan ? (
        <button
          onClick={() => {
            const nieuw = !ontgrendeld;
            setOntgrendeld(nieuw);
            void window.jade.lockOverlay(!nieuw);
          }}
          className="rounded-lg border border-line px-2.5 py-1 text-ink-400 transition-colors hover:border-line-lit"
        >
          {ontgrendeld ? "Lock in place" : "Move it"}
        </button>
      ) : null}

      <span className="text-ink-700">
        {aan
          ? ontgrendeld
            ? "Drag it where you want it, then lock it again."
            : "Shown over the game while League runs borderless or windowed."
          : "A small panel on top of the game: objective timers, item gold, your skill order."}
      </span>

      {geblokkeerd ? (
        <div className="w-full rounded-lg border border-gold-400/30 bg-gold-400/[0.06] p-2.5">
          <p className="text-[12px] font-medium text-gold-300">
            League is set to Full Screen, so the overlay can&apos;t be drawn over it.
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
            In that mode Windows hands the whole display to the game and no other app can put
            anything on top — not us, and not Discord either. In League:{" "}
            <span className="text-ink-200">Settings → Video → Window Mode → Borderless</span>.
            Borderless still fills the screen at the same resolution, and alt-tab gets faster.
          </p>
        </div>
      ) : null}
    </Panel>
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
        <div className="text-ink-700" title="Share of the team's kills · wards placed · gold in items">
          {Math.round(p.killDeelname * 100)}% kp · {p.wards}w · {(p.itemWaarde / 1000).toFixed(1)}k
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
    <Panel className={`overflow-hidden transition-colors ${open ? "paneel-goud" : ""}`}>
    <button
      type="button"
      onClick={onToggle}
      className={`group relative flex w-full items-center gap-3 py-2.5 pr-4 pl-4 text-left transition-colors hover:bg-white/[0.03] ${
        game.win ? "wedstrijdrij-winst" : "wedstrijdrij-verlies"
      }`}
    >
      {/* The stripe is the one place the outcome is stated at full strength, so
          it takes the bright semantic colours rather than the muted edge tones:
          the mock-up reads (10,228,164) and (223,62,56) on this very pixel.
          Everything else in the row stays neutral, which is what lets a column
          of seven results be scanned down the left edge alone. */}
      <span
        className={`absolute top-0 bottom-0 left-0 w-[3px] ${game.win ? "bg-jade-400" : "bg-loss-400"}`}
      />

      <div className="flex shrink-0 items-center gap-1.5">
        <ChampionIcon
          iconPath={champion?.iconPath}
          name={champion?.name}
          size={36}
          className="rij-portret"
        />
        {/* 16 + 3 + 16 is 35, so the two spells end level with the 36px portrait
            instead of setting the height of the row themselves. */}
        <span className="rij-spells">
          <SpellPair spells={[game.spell1Id, game.spell2Id]} lookup={spells} size={16} />
        </span>
      </div>

      <div className="w-[108px] shrink-0">
        <p className="truncate text-sm font-semibold text-ink-100">
          {champion?.name ?? game.championId}
        </p>
        <p
          className={`truncate text-[11px] font-semibold ${game.win ? "text-jade-400" : "text-loss-400"}`}
        >
          {game.win ? "Victory" : "Defeat"}
          <span className="ml-1.5 font-normal text-ink-500">
            {QUEUE_LABELS[game.queueId] ?? "Classic"}
          </span>
        </p>
      </div>

      <div className="w-[92px] shrink-0">
        <p className="num text-sm text-ink-100">
          {game.kills} <span className="text-ink-700">/</span>{" "}
          <span className="text-loss-400">{game.deaths}</span> <span className="text-ink-700">/</span>{" "}
          {game.assists}
        </p>
        <p className="num text-[11px] text-ink-500">{kda.toFixed(2)} KDA</p>
      </div>

      <div className="w-[64px] shrink-0">
        <p className="num text-sm text-ink-100">{game.cs}</p>
        <p className="num text-[11px] text-ink-500">{csPerMin.toFixed(1)} CS/min</p>
      </div>

      <div className="w-[48px] shrink-0">
        <p className="num text-sm text-ink-100">{(game.gold / 1000).toFixed(1)}k</p>
        <p className="num text-[11px] text-ink-500">gold</p>
      </div>

      {/* An item icon that has been squeezed is no longer the item: the artwork
          is square and reads by silhouette. So this block never shrinks, and the
          slack in the row comes out of the text columns beside it instead. */}
      <span className="rij-items shrink-0">
        <ItemRow items={game.items} lookup={items} size={22} />
      </span>

      <div className="ml-auto shrink-0 text-right">
        <p className="num text-[11px] text-ink-300">{Math.floor(minutes)} min</p>
        <p className="num text-[11px] text-ink-500">{relativeDate(game.createdAt)}</p>
      </div>

      {/* A drawn chevron rather than a typographic angle quote, because the
          glyph's size and baseline move with whichever font actually loads, and
          at this size it landed as a comma. */}
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`shrink-0 text-ink-500 transition-transform ${open ? "rotate-90" : ""}`}
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
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
