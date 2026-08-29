/**
 * Your game against the champion's normal game in that lane.
 *
 * The scoreboard above this block compares the ten players in one match to each
 * other, and it closes by saying so. That comparison has a ceiling: if everyone
 * played badly you are still the best of a bad game. This is the other half --
 * your line against what the champion normally does in that lane, over every
 * recorded game of the pick.
 *
 * It is also the one part of the post-game that works on the whole database as
 * it stands. Nothing here reads damage, damage taken, vision, wards or level: CS
 * per minute, gold per minute and KDA come out of cs, gold, kills, deaths,
 * assists and the match duration, every one of which is mandatory and present on
 * all 130,086 stored games. The averages were already sitting in the published
 * aggregate -- fields 5, 6 and 7 of every champion row -- and were being read
 * straight past.
 *
 * A number on its own settles nothing. 6.2 CS per minute is a strong game on a
 * support and a poor one on a mid laner, and the only thing that decides which
 * is the same figure over every other game of that pick. So every row here is
 * two values and the distance between them, and never a grade.
 */
import type {
  BaselineNumber, ChampionSummary, PerformanceBaseline,
} from "../../../shared/types";
import type { Oordeel, Uitspraak } from "../../../shared/oordeel";
import { ChampionIcon, POSITION_LABELS, PositionIcon } from "../ui";

/**
 * How far apart two numbers have to be before the difference is drawn as one.
 *
 * Under this the row goes grey. Your side of every row is a single game, and a
 * single game wobbles by more than five percent for reasons that have nothing to
 * do with how you played -- a lane that ended early, a fight that ran long. A
 * colour on that difference would be reading tea leaves in the app's own voice.
 */
const IJK_RUIS = 0.05;

/**
 * The rows, and which way is up in each.
 *
 * Deaths is the reason this table carries a direction at all: fewer than average
 * is the better game, and a block that painted everything above the average
 * green would congratulate you for dying more than everybody else.
 */
const IJK_RIJEN: Array<{
  label: string;
  sleutel: "csPerMin" | "goldPerMin" | "kda" | "kills" | "deaths" | "assists";
  hogerIsBeter: boolean;
  decimalen: number;
  uitleg: string;
}> = [
  {
    label: "CS / min",
    sleutel: "csPerMin",
    hogerIsBeter: true,
    decimalen: 1,
    uitleg: "Creep score divided by the length of the game.",
  },
  {
    label: "Gold / min",
    sleutel: "goldPerMin",
    hogerIsBeter: true,
    decimalen: 0,
    uitleg: "Gold earned divided by the length of the game.",
  },
  {
    label: "KDA",
    sleutel: "kda",
    hogerIsBeter: true,
    decimalen: 2,
    uitleg: "(kills + assists) / deaths. With no deaths it is kills + assists.",
  },
  {
    label: "Kills",
    sleutel: "kills",
    hogerIsBeter: true,
    decimalen: 1,
    uitleg: "Kills in this game.",
  },
  {
    label: "Deaths",
    sleutel: "deaths",
    hogerIsBeter: false,
    decimalen: 1,
    uitleg:
      "Deaths in this game. Fewer than average is the better game, so this row reads the other way.",
  },
  {
    label: "Assists",
    sleutel: "assists",
    hogerIsBeter: true,
    decimalen: 1,
    uitleg: "Assists in this game.",
  },
];

const ijkGetal = (n: number, decimalen: number): string =>
  n.toLocaleString("en-GB", { minimumFractionDigits: decimalen, maximumFractionDigits: decimalen });

/** True when this row went the way you would want it to, beyond the noise. */
function ijkBeter(paar: BaselineNumber, hogerIsBeter: boolean): boolean | null {
  if (paar.average <= 0) return null;
  const verschil = (paar.you - paar.average) / paar.average;
  if (Math.abs(verschil) < IJK_RUIS) return null;
  return hogerIsBeter ? verschil > 0 : verschil < 0;
}

export function IjkBlok({
  baseline,
  champion,
  oordeel,
}: {
  baseline: PerformanceBaseline;
  champion: ChampionSummary | undefined;
  /**
   * The same six rows said out loud, plus the three areas that have no row.
   *
   * Inside this block rather than beside it, because it is the same comparison:
   * the header above already says which champion, which lane and how many games
   * the averages stand on, and a second box repeating that header would be the
   * app making one claim twice. Null only if the caller has nothing to say.
   */
  oordeel: Oordeel | null;
}): JSX.Element {
  const beter = IJK_RIJEN.filter(
    (rij) => ijkBeter(baseline[rij.sleutel], rij.hogerIsBeter) === true,
  ).length;
  const naam = champion?.name ?? String(baseline.championId);
  const lane = POSITION_LABELS[baseline.position] ?? baseline.position;
  // Het lidwoord hoort in de variant, niet ervoor: "the your own crawled
  // database" is geen zin, en de local-tak is gewoon bereikbaar -- rebuildStats
  // valt in de constructor terug op de lokale store zolang loadCommunityStats
  // nog loopt, en permanent zonder netwerk of cache.
  const bron = baseline.source === "community" ? "the shared" : "your own crawled";

  return (
    <section className="ijk">
      <header className="ijk-kop">
        <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={26} />
        <div className="min-w-0">
          <p className="ijk-titel">
            <PositionIcon position={baseline.position} size={13} />
            <span className="truncate">
              {naam} {lane}
            </span>
            <span className="ijk-titel-bij">this game vs. normal</span>
          </p>
          <p className="num ijk-sample">
            measured against {baseline.games.toLocaleString("en-GB")} recorded games of this pick
          </p>
        </div>
        {/* Not a score. It counts the rows below, and the rows below are all on
            screen, so nothing here is hiding a formula. */}
        <span
          className={`ijk-telling ${beter > IJK_RIJEN.length / 2 ? "ijk-telling-goed" : ""}`}
          title="Rows where you are more than 5% on the better side of the average. Deaths counts as better when it is lower."
        >
          better on {beter} of {IJK_RIJEN.length}
        </span>
      </header>

      <div className="ijk-rijen">
        {IJK_RIJEN.map((rij) => (
          <IjkRij key={rij.sleutel} rij={rij} paar={baseline[rij.sleutel]} />
        ))}
      </div>

      {oordeel ? <OordeelLijst oordeel={oordeel} /> : null}

      {/* The rule, in view. Every figure above is reproducible from this
          paragraph and the raw match, which is the only reason any of it is
          allowed on screen at all. */}
      <p className="ijk-regel">
        Averages cover every recorded game of {naam} in {lane} in the {bron} database (
        {baseline.games.toLocaleString("en-GB")} games) and are counted as totals: all CS divided by
        all game time, not the average of each game&rsquo;s own rate. KDA is (kills + assists)
        &divide; deaths over those same totals, so a game without deaths counts kills + assists on
        both sides. The tick on each bar is the average and the bar runs out at twice it. A gap
        under 5% is drawn grey, because on one game it is not a gap. This game ran{" "}
        <span className="num">{baseline.yourMinutes.toFixed(1)}</span> min against an average of{" "}
        <span className="num">{baseline.averageMinutes.toFixed(1)}</span> min.
      </p>
    </section>
  );
}

/** One metric: your value, the distance to the average, the average. */
function IjkRij({
  rij,
  paar,
}: {
  rij: (typeof IJK_RIJEN)[number];
  paar: BaselineNumber;
}): JSX.Element {
  const { you, average } = paar;
  // The average sits at the halfway mark, so the fill is the ratio halved and a
  // full track means twice the average. Anything past that is clamped and says
  // so with the marker, because a clamped bar that merely looked full would
  // report a 3x game and a 2x game as the same thing.
  const deel = average > 0 ? Math.min(1, (you / average) * 0.5) : 0;
  const voorbij = average > 0 && you > average * 2;
  const verschil = average > 0 ? (you - average) / average : 0;
  const beter = ijkBeter(paar, rij.hogerIsBeter);
  const toon = beter === null ? "ijk-neutraal" : beter ? "ijk-goed" : "ijk-slecht";

  return (
    <div className="ijk-rij" title={rij.uitleg}>
      <span className="ijk-label">{rij.label}</span>
      <span className={`num ijk-jij ${toon}`}>{ijkGetal(you, rij.decimalen)}</span>

      <span className={`ijk-baan ${toon}`}>
        <span className="ijk-tik" />
        <span
          className={`ijk-vulling ${voorbij ? "ijk-voorbij" : ""}`}
          style={{ width: `${deel * 100}%` }}
        />
      </span>

      <span className="num ijk-gemiddeld" title="The average">
        {ijkGetal(average, rij.decimalen)}
      </span>
      <span className={`num ijk-verschil ${toon}`}>
        {/* Teken en cijfers uit hetzelfde afgeronde getal, anders krijgt elk
            verschil tussen -0,5% en 0% een minteken voor een nul -- 5.797 van
            1.030.020 gerenderde rijen, ruwweg 1 op de 30 schermen. */}
        {average > 0
          ? (() => {
              const heel = Math.round(verschil * 100);
              return `${heel > 0 ? "+" : heel < 0 ? "−" : ""}${Math.abs(heel)}%`;
            })()
          : "—"}
      </span>
    </div>
  );
}

/**
 * The rows above, said as sentences, and the three areas that have no row.
 *
 * Three groups on purpose, and the reader is told which is which before reading
 * any of them. The first group is measured against the whole database and is
 * allowed to be a verdict. The second is measured against the nine other players
 * in this one game, because no average for those fields exists anywhere, and is
 * therefore drawn without a colour and without a claim. The third is the list of
 * questions this game cannot answer at all -- printed rather than omitted,
 * because a missing row and a row that was never possible look identical from
 * the outside, and only one of them is worth being annoyed about.
 */
function OordeelLijst({ oordeel }: { oordeel: Oordeel }): JSX.Element | null {
  const { tegenDatabase, binnenDezeGame, gewoon, zwijgt } = oordeel;
  if (tegenDatabase.length === 0 && binnenDezeGame.length === 0 && zwijgt.length === 0) return null;

  return (
    <div className="oordeel">
      <p className="oordeel-kop">What stood out, against every recorded game of this pick</p>
      {tegenDatabase.length > 0 ? (
        tegenDatabase.map((u) => <OordeelRegel key={u.sleutel} uitspraak={u} />)
      ) : (
        <p className="oordeel-leeg">
          Nothing. Every figure above sits closer to normal than half of all recorded games of any
          pick do, which is its own answer: this was an ordinary game on this champion.
        </p>
      )}

      {gewoon.length > 0 ? (
        <p className="oordeel-gewoon">
          Normal for this pick, so not listed above: {gewoon.join(", ")}.
        </p>
      ) : null}

      {binnenDezeGame.length > 0 ? (
        <>
          <p className="oordeel-kop oordeel-kop-tweede">
            Figures with no average behind them &mdash; these compare you to the nine other players
            in this game, and to nothing else
          </p>
          {binnenDezeGame.map((u) => (
            <OordeelRegel key={u.sleutel} uitspraak={u} />
          ))}
        </>
      ) : null}

      {zwijgt.length > 0 ? (
        <div className="oordeel-zwijgt">
          <p className="oordeel-kop oordeel-kop-tweede">What this game cannot be asked</p>
          {zwijgt.map((z) => (
            <p key={z.onderwerp} className="oordeel-stil">
              <span className="oordeel-stil-kop">{z.onderwerp}.</span> {z.reden}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One statement, its figures, and the threshold that let it through.
 *
 * The band is on the row and not in a tooltip. This block is the only place in
 * the app that turns a comparison into a sentence, and a sentence carries more
 * authority than a bar does -- so the reader gets the cut point that produced it
 * in the same glance, and can disagree with the app's idea of "unusual" without
 * having to go looking for it.
 */
function OordeelRegel({ uitspraak: u }: { uitspraak: Uitspraak }): JSX.Element {
  const toon = u.toon === "goed" ? "ijk-goed" : u.toon === "slecht" ? "ijk-slecht" : "ijk-neutraal";

  return (
    <div className={`oordeel-regel ${u.tier === "ver" ? "oordeel-ver" : ""}`}>
      <span className="oordeel-gebied">{u.gebied}</span>
      <p className={`oordeel-zin ${toon}`}>{u.zin}</p>
      <p className="num oordeel-cijfers">{u.cijfers}</p>
      {u.band && u.gat !== null ? <p className="oordeel-band">{bandTekst(u)}</p> : null}
      <p className="oordeel-grond">{u.grond}</p>
    </div>
  );
}

/**
 * The threshold, in the same unit as the gap it let through.
 *
 * Both cut points are printed, not just the one that was crossed, because "past
 * the halfway mark" only means something beside the mark it did not reach.
 */
function bandTekst(u: Uitspraak): string {
  const band = u.band;
  if (!band || u.gat === null) return "";
  const toon = band.ratio
    ? (n: number) => `${(n * 100).toFixed(1)}%`
    : (n: number) => Math.round(n).toLocaleString("en-GB");
  const sample = band.slots.toLocaleString("en-GB");
  // Three cases and not two. A row can now reach this list while sitting inside
  // its band -- shared/tijdvak.ts sends one that describes the shape of a
  // collapse rather than judging it, and "not concentrated" is that row's answer
  // rather than its absence. Calling that "further out than half of them" would
  // be the caption contradicting the sentence above it.
  const waar =
    u.tier === "ver"
      ? `further out than nine in ten of them`
      : u.tier === "buiten"
        ? `further out than half of them`
        : `closer in than half of them`;

  // The sample is named rather than assumed to be "recorded player slots". This
  // block now mixes rows whose cut points rest on a million slots off the local
  // store with rows whose cut points rest on a couple of hundred observations
  // pulled from the client, and a reader who cannot see which is which will
  // reasonably give both the same weight.
  return `Gap of ${toon(u.gat)} on ${band.maat} — ${waar}. Over ${sample} ${band.herkomst}, half sit within ${toon(band.helft)} and one in ten passes ${toon(band.staart)}.`;
}
