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
}: {
  baseline: PerformanceBaseline;
  champion: ChampionSummary | undefined;
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
