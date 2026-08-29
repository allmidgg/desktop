/**
 * The screen after a game.
 *
 * What used to sit under a match row was a scoreboard: champion, KDA, CS, gold,
 * items, and an apology at the bottom that there was nothing else. There was
 * something else -- the client had been sending damage, damage taken, vision,
 * wards and champion level all along and the store threw them away. Now it keeps
 * them, and this is the screen that spends them: who actually carried, who
 * absorbed the game, who saw it coming, and how each of the ten compares to the
 * other nine.
 *
 * Two things it deliberately does not do. It never fills a missing figure with a
 * zero -- a match saved before the store kept damage has no damage, so those
 * columns disappear and the screen says why. And its one derived judgement, the
 * score, prints its own rule on demand rather than asking to be trusted.
 */
import { useEffect, useMemo, useState } from "react";
import { Tijdlijnpaneel } from "./Tijdlijn";
import { OmslagPaneel } from "./Omslag";
import { IjkBlok } from "./IjkBlok";
import { MINIMALE_GAMEDUUR_SECONDEN } from "../../../shared/types";
import type {
  AppSnapshot, ChampionSummary, GameDetail, ItemSummary, RecentGameSummary, SpellSummary,
} from "../../../shared/types";
import type { Naspel, NaspelDeel, NaspelLane, NaspelSpeler, NaspelTeam } from "../../../shared/naspel";
import { leesNaspel, NASPEL_FACTOREN } from "../../../shared/naspel";
import { leesOordeel } from "../../../shared/oordeel";
import { leesOmslag } from "../../../shared/omslag";
import {
  ChampionIcon, GeenDetail, ItemRow, POSITION_LABELS, PositionIcon, SpellPair, Spinner,
  type GeenDetailReden,
} from "../ui";

/** mm:ss, because a game is a length and not a decimal. */
const duurTekst = (seconden: number): string =>
  `${Math.floor(seconden / 60)}:${String(Math.floor(seconden % 60)).padStart(2, "0")}`;

/** Thousands only above a thousand: "840" is a number, "0.8k" is a rounding. */
const kort = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/**
 * Which of the three absences this is.
 *
 * Read off fields the row already holds, so deciding costs no second round trip.
 * The duration decides "never", and it is the store's own floor rather than a
 * number picked here. The other threshold is honest about being slack: the game
 * ends at roughly createdAt + duration, and ten minutes past that is longer than
 * any client has been seen to take to publish a match. Nothing is drawn from it
 * beyond the choice of sentence.
 */
function geenDetailReden(game: RecentGameSummary): GeenDetailReden {
  if (game.durationSeconds < MINIMALE_GAMEDUUR_SECONDEN) return "te-kort";
  if (Date.now() - game.createdAt < (game.durationSeconds + 600) * 1000) return "nog-niet";
  return "niet-gecrawld";
}

export function NaspelPaneel({
  game,
  snapshot,
}: {
  /**
   * The whole row rather than just its id.
   *
   * The panel has to be able to say why a game is missing, and the two facts
   * that decide the answer -- how long it ran and when it ended -- are on the
   * row and nowhere else once the fetch has come back empty.
   */
  game: RecentGameSummary;
  snapshot: AppSnapshot;
}): JSX.Element {
  const gameId = game.gameId;
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [bezig, setBezig] = useState(true);
  /**
   * Bumped by "Look again".
   *
   * The game you just finished is not missing, it is in transit: the client
   * publishes the match a little after the end screen, and refreshOwnProfile
   * only writes it to the database on a phase change. With no way to ask a
   * second time this panel would keep insisting the game does not exist until
   * you had played another one.
   */
  const [poging, setPoging] = useState(0);

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
  }, [gameId, poging]);

  // The catalogues are three Maps built from arrays of several hundred entries,
  // and this panel re-renders every time the snapshot ticks. Keying them to the
  // arrays themselves rebuilds them when the client actually delivers new
  // assets and never merely because a timer moved.
  const champions = useMemo(
    () => new Map(snapshot.champions.map((c) => [c.jadeId, c])),
    [snapshot.champions],
  );
  const items = useMemo(() => new Map(snapshot.items.map((i) => [i.jadeId, i])), [snapshot.items]);
  const spells = useMemo(() => new Map(snapshot.spells.map((s) => [s.jadeId, s])), [snapshot.spells]);

  const naspel = useMemo(() => (detail ? leesNaspel(detail) : null), [detail]);

  // Built here rather than in the main process because it is arithmetic on data
  // that already crossed IPC, and because it needs both halves of the screen:
  // the baseline that only exists for you, and the scored lobby that knows your
  // share of the team's kills and damage. Null whenever the baseline is, which
  // is the same condition IjkBlok itself is drawn under -- four of its five
  // verdicts have nothing to stand on without it, and a verdict list made of the
  // leftovers would be a different rule wearing the same clothes.
  const oordeel = useMemo(() => {
    if (!detail || !naspel || !detail.baseline) return null;
    const champion = champions.get(detail.baseline.championId);
    return leesOordeel(
      detail,
      naspel,
      detail.baseline,
      champion?.name ?? String(detail.baseline.championId),
      POSITION_LABELS[detail.baseline.position] ?? detail.baseline.position,
    );
  }, [detail, naspel, champions]);

  /**
   * Which stretch of this game went worst, worked out exactly once.
   *
   * Three things on this screen want that answer: the sentence naming it, the
   * band on the chart, and the band on the lane strip inside the chart. They
   * have to be the same stretch. Each of them finding its own would mean the
   * app answers the one question it was built to answer three times over, in
   * three different places, with three different minutes -- and a reader who is
   * told 22:00 in a sentence and shown a band over 14:00 has not learned when
   * the game turned, he has learned the app is guessing.
   *
   * Null is the ordinary answer and stays ordinary: no recording, no readings,
   * no seat marked as yours, or no norm for the champion yet. Everything
   * downstream draws itself without a stretch rather than inventing a flat one.
   */
  const omslag = useMemo(() => {
    const opname = detail?.tijdlijn?.opname;
    if (!detail || !opname) return null;

    // The norm for the seat that was at the keyboard. Taken off the player row
    // rather than recomputed, because that row is what the badge above is
    // scored against, and reading the same figure from two places is how two
    // numbers start disagreeing.
    const jij = opname.spelers.findIndex((s) => (s.skillOrder?.length ?? 0) > 0);
    const mijnChampion = jij < 0 ? null : (opname.spelers[jij]?.championId ?? null);
    const rij =
      detail.players.find((p) => p.isYou) ??
      (mijnChampion === null ? undefined : detail.players.find((p) => p.championId === mijnChampion));

    return leesOmslag(
      opname,
      rij?.ijklijn ?? null,
      (id) => items.get(id)?.price ?? 0,
      (id) => items.get(id)?.buildsFrom ?? [],
    ).omslag;
  }, [detail, items]);

  if (bezig) {
    return (
      <div className="px-4 py-6">
        <Spinner label="Opening the game..." />
      </div>
    );
  }
  if (!detail || !naspel) {
    return (
      <div className="px-4 py-5">
        <GeenDetail
          reden={geenDetailReden(game)}
          minimumSeconden={MINIMALE_GAMEDUUR_SECONDEN}
          onOpnieuw={() => setPoging((n) => n + 1)}
        />
      </div>
    );
  }

  // Two of the nine columns exist only when the record does. Driving the grid
  // from a variable rather than from two hard-coded templates means the header
  // row and the ten player rows can never disagree about which columns are up.
  const kolommen = [
    "56px",
    "minmax(88px, 1fr)",
    "46px",
    "78px",
    "54px",
    "50px",
    naspel.maxDamage !== null || naspel.maxDamageTaken !== null ? "124px" : null,
    naspel.visieBron ? "46px" : null,
    "176px",
  ]
    .filter((k): k is string => k !== null)
    .join(" ");

  const minuten = detail.durationSeconds / 60;

  return (
    <div className="naspel space-y-4 px-4 py-4" style={{ ["--naspel-kolommen" as string]: kolommen }}>
      <NaspelKop detail={detail} naspel={naspel} />

      {/* Absent whenever the average is absent. The block is the comparison; a
          version of it with nothing to compare against would be the scoreboard
          again in a box. */}
      {detail.baseline ? (
        <IjkBlok
          baseline={detail.baseline}
          champion={champions.get(detail.baseline.championId)}
          oordeel={oordeel}
        />
      ) : null}

      <div className="naspel-schuif">
        <div className="naspel-raster space-y-3">
          {naspel.teams.map((team) => (
            <TeamBlok
              key={team.teamId}
              team={team}
              naspel={naspel}
              champions={champions}
              items={items}
              spells={spells}
              minuten={minuten}
            />
          ))}
        </div>
      </div>

      {naspel.lanes.length > 0 ? <LaneDuels lanes={naspel.lanes} champions={champions} /> : null}

      <ScoreRegel naspel={naspel} />

      {/* The answer before the picture. Somebody who has just finished a game
          wants to know which minute it went wrong, not to go hunting for it in a
          chart, so the finding sits above the thing it was found in -- and the
          chart is then the place to go and check it. Draws nothing at all unless
          this machine watched the game and the readings can carry a finding. */}
      <OmslagPaneel
        omslag={omslag}
        opname={detail.tijdlijn?.opname ?? null}
        champions={champions}
      />

      {/* The one game in a hundred thousand this machine was actually running
          during. The match-history timeline does exist -- see core/lcu/timeline.ts
          -- but it carries no purchases and samples once a minute, so what is
          drawn here is still the recording this app made itself. It gets handed
          the same stretch the sentence above names, rather than looking for one,
          so the band and the sentence cannot disagree. */}
      <Tijdlijnpaneel
        tijdlijn={detail.tijdlijn}
        items={items}
        champions={champions}
        venster={omslag?.ergste ?? null}
      />

      <p className="text-[11px] leading-relaxed text-ink-600">
        Everything above the timeline is measured against the ten players in this game and nothing
        else.{" "}
        {detail.tijdlijn ? (
          <>
            The timeline below was recorded by this app while the game was running, which is why it
            can say what was bought and when, and why it reads the scoreline every few seconds
            rather than once a minute.
          </>
        ) : (
          <>
            This app was not running while this game was played, so nothing here is a reading taken
            during it &mdash; only what each player finished with. Match history does keep a
            per-minute timeline for Classic games, which nothing in this app fetches yet; it holds
            gold, creeps and levels but no purchases, so it could show how the game went and never
            what was built.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The game in one strip: how long, which patch, and the two team totals against
 * each other.
 *
 * The bars are split by share rather than drawn to a maximum, because that is
 * the question a total answers -- not "how much gold", but "how much more than
 * them". Queue and date are missing on purpose: the row this panel opens under
 * prints both, two lines above.
 */
function NaspelKop({ detail, naspel }: { detail: GameDetail; naspel: Naspel }): JSX.Element {
  const blauw = naspel.teams.find((t) => t.teamId === 100) ?? naspel.teams[0];
  const rood = naspel.teams.find((t) => t.teamId !== 100) ?? naspel.teams[1];

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-ink-500">
        <span className="num">{duurTekst(detail.durationSeconds)} long</span>
        <span className="num">patch {detail.patch}</span>
        {detail.surrendered === true ? (
          <span className="naspel-opgegeven num">ended in surrender</span>
        ) : null}
      </div>

      {blauw && rood ? (
        <div className="space-y-1.5">
          <Vergelijking label="Kills" links={blauw.kills} rechts={rood.kills} toon={(n) => String(n)} />
          <Vergelijking label="Gold" links={blauw.gold} rechts={rood.gold} toon={kort} />
          {blauw.damage !== null && rood.damage !== null ? (
            <Vergelijking label="Damage" links={blauw.damage} rechts={rood.damage} toon={kort} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One total, split blue against red, with the numbers on the outside. */
function Vergelijking({
  label,
  links,
  rechts,
  toon,
}: {
  label: string;
  links: number;
  rechts: number;
  toon: (n: number) => string;
}): JSX.Element {
  const totaal = links + rechts;
  // A nil-nil game is a real state -- an early surrender has no kills at all --
  // and it deserves an even bar rather than a divide by zero.
  const deel = totaal > 0 ? (links / totaal) * 100 : 50;
  return (
    <div className="flex items-center gap-2.5">
      <span className="num w-12 shrink-0 text-right text-[11px] text-ink-100">{toon(links)}</span>
      <span className="naspel-vergelijking">
        <span className="naspel-vergelijking-links" style={{ width: `${deel}%` }} />
      </span>
      <span className="num w-12 shrink-0 text-[11px] text-ink-100">{toon(rechts)}</span>
      <span className="w-14 shrink-0 text-[10px] tracking-[0.12em] text-ink-600 uppercase">{label}</span>
    </div>
  );
}

function TeamBlok({
  team,
  naspel,
  champions,
  items,
  spells,
  minuten,
}: {
  team: NaspelTeam;
  naspel: Naspel;
  champions: Map<number, ChampionSummary>;
  items: Map<number, ItemSummary>;
  spells: Map<number, SpellSummary>;
  minuten: number;
}): JSX.Element {
  const blauw = team.teamId === 100;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <p className={`text-[10px] tracking-[0.16em] uppercase ${blauw ? "text-info-400/70" : "text-loss-400/70"}`}>
          {blauw ? "Blue side" : "Red side"}
        </p>
        <p className={`text-[11px] font-semibold ${team.win ? "text-jade-400" : "text-loss-400"}`}>
          {team.win ? "Victory" : "Defeat"}
        </p>
        <p className="num ml-auto text-[11px] text-ink-500">
          {team.kills} / {team.deaths} / {team.assists}
          <span className="ml-3">{kort(team.gold)} gold</span>
          {team.damage !== null ? <span className="ml-3">{kort(team.damage)} damage</span> : null}
        </p>
      </div>

      <div className="naspel-kolomkop">
        <span />
        <span>Champion</span>
        <span className="text-center">Score</span>
        <span>K / D / A</span>
        <span>CS</span>
        <span>Gold</span>
        {naspel.maxDamage !== null || naspel.maxDamageTaken !== null ? <span>Dealt / taken</span> : null}
        {naspel.visieBron ? <span>{naspel.visieBron === "vision" ? "Vision" : "Wards"}</span> : null}
        <span>Items</span>
      </div>

      <div className="space-y-1">
        {team.spelers.map((gescoord, i) => (
          <SpelerRij
            key={i}
            gescoord={gescoord}
            naspel={naspel}
            champions={champions}
            items={items}
            spells={spells}
            minuten={minuten}
          />
        ))}
      </div>
    </div>
  );
}

function SpelerRij({
  gescoord,
  naspel,
  champions,
  items,
  spells,
  minuten,
}: {
  gescoord: NaspelSpeler;
  naspel: Naspel;
  champions: Map<number, ChampionSummary>;
  items: Map<number, ItemSummary>;
  spells: Map<number, SpellSummary>;
  minuten: number;
}): JSX.Element {
  const p = gescoord.speler;
  const champion = champions.get(p.championId);
  const kda = p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;
  const visie = naspel.visieBron === "vision" ? p.vision : naspel.visieBron === "wards" ? p.wards : undefined;
  const toontSchade = naspel.maxDamage !== null || naspel.maxDamageTaken !== null;

  return (
    <div className={`naspel-rij ${p.isYou ? "naspel-rij-jij" : ""}`}>
      <span className="flex items-center gap-1.5">
        <span className="naspel-portret">
          <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={34} />
          {/* Champion level only when the record has it: a badge reading 0 on an
              older game would look like a bug rather than like an absence. */}
          {p.level !== undefined ? <span className="naspel-level num">{p.level}</span> : null}
        </span>
        <span className="naspel-spells">
          <SpellPair spells={p.spells} lookup={spells} size={15} />
        </span>
      </span>

      <span className="min-w-0">
        <span className="block truncate text-[12px] text-ink-100">{champion?.name ?? p.championId}</span>
        {p.position !== "UNKNOWN" ? (
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-600">
            <PositionIcon position={p.position} size={11} />
            {POSITION_LABELS[p.position] ?? p.position}
          </span>
        ) : null}
      </span>

      <ScoreChip gescoord={gescoord} />

      <span>
        <span className="num block text-[12px] text-ink-100">
          {p.kills} <span className="text-ink-700">/</span>{" "}
          <span className="text-loss-400">{p.deaths}</span> <span className="text-ink-700">/</span>{" "}
          {p.assists}
        </span>
        <span className="num block text-[10px] text-ink-600" title={`${kda.toFixed(2)} KDA`}>
          {Math.round(gescoord.killDeelname * 100)}% KP
        </span>
      </span>

      {/* De twee balken die het op elke game doen. maxCs en maxGold worden voor
          precies dit uitgerekend en werden nergens getekend, dus op een
          database zonder schadecijfers verloor de rij al zijn twintig balken en
          werd het een tabel met kale getallen. */}
      <span>
        <span className="num block text-[12px] text-ink-100">{p.cs}</span>
        <span className="num block text-[10px] text-ink-600">
          {minuten > 0 ? (p.cs / minuten).toFixed(1) : "0"}/m
        </span>
        <span className="naspel-balk mt-1 block" title={`${p.cs} CS`}>
          <span
            className="naspel-balk-opgevangen"
            style={{ width: `${naspel.maxCs > 0 ? Math.min(100, (p.cs / naspel.maxCs) * 100) : 0}%` }}
          />
        </span>
      </span>

      <span>
        <span className="num block text-[12px] text-ink-100">{kort(p.gold)}</span>
        <span className="num block text-[10px] text-ink-600">
          {minuten > 0 ? Math.round(p.gold / minuten) : 0}/m
        </span>
        <span className="naspel-balk mt-1 block" title={`${p.gold.toLocaleString("en-GB")} gold`}>
          <span
            className="naspel-balk-schade"
            style={{ width: `${naspel.maxGold > 0 ? Math.min(100, (p.gold / naspel.maxGold) * 100) : 0}%` }}
          />
        </span>
      </span>

      {toontSchade ? (
        <span className="naspel-schade">
          <Balk
            waarde={p.damage}
            max={naspel.maxDamage}
            klasse="naspel-balk-schade"
            bijschrift={
              gescoord.damageAandeel !== null ? `${Math.round(gescoord.damageAandeel * 100)}%` : null
            }
            titel={
              p.damage !== undefined
                ? `${p.damage.toLocaleString("en-GB")} damage to champions`
                : "Damage was not recorded for this game"
            }
          />
          <Balk
            waarde={p.damageTaken}
            max={naspel.maxDamageTaken}
            klasse="naspel-balk-opgevangen"
            bijschrift={null}
            titel={
              p.damageTaken !== undefined
                ? `${p.damageTaken.toLocaleString("en-GB")} damage taken`
                : "Damage taken was not recorded for this game"
            }
          />
        </span>
      ) : null}

      {naspel.visieBron ? (
        <span>
          <span className="num block text-[12px] text-ink-100">{visie ?? "--"}</span>
          {/* Wards are printed under the vision score only when they are a
              second, different figure -- otherwise the cell says the same thing
              twice. */}
          <span className="num block text-[10px] text-ink-600">
            {naspel.visieBron === "vision" && p.wards !== undefined ? `${p.wards}w` : "\u00a0"}
          </span>
        </span>
      ) : null}

      <span className="flex items-center gap-1.5">
        <span className="naspel-items">
          <ItemRow items={p.items.slice(0, 6)} lookup={items} size={22} />
        </span>
        {/* De scheiding komt uit de gap-1.5 van de ouder (6px tegen de 3px
            binnen een ItemRow); een eigen klasse bestond nooit in styles.css en
            past ook niet -- de kolom is 176px en de inhoud meet er 175. */}
        <span className="naspel-items">
          <ItemRow items={p.items.slice(6, 7)} lookup={items} size={22} />
        </span>
      </span>
    </div>
  );
}

/**
 * The score, and the two badges that come off it.
 *
 * MVP is the best score on the winning side and ACE the best on the losing side,
 * which is the client's own convention and the reason the rule needs no bonus
 * for having won: the two are never in the same contest.
 *
 * The full breakdown hangs on the element's title, so the number can always be
 * taken apart on the spot without opening anything.
 */
function deelRegel(deel: NaspelDeel): string {
  const punten = `${(deel.aandeel * deel.gewicht * 100).toFixed(1)} of ${(deel.gewicht * 100).toFixed(1)} points`;
  if (deel.normaal === null) {
    return `${deel.factor.naam}: ${Math.round(deel.waarde * 100)}% of your own team's kills, ${punten}`;
  }
  const cijfer = (n: number): string => (n >= 100 ? String(Math.round(n)) : n.toFixed(2));
  return `${deel.factor.naam}: ${cijfer(deel.waarde)} against ${cijfer(deel.normaal)} normal, ${punten}`;
}

function ScoreChip({ gescoord }: { gescoord: NaspelSpeler }): JSX.Element {
  const uitsplitsing = gescoord.delen.map(deelRegel).join("\n");

  const soort = gescoord.isMvp ? "mvp" : gescoord.isAce ? "ace" : "gewoon";
  return (
    <span
      className={`naspel-score naspel-score-${soort}`}
      title={`${gescoord.score.toFixed(1)} out of 100 — 50 is a completely normal game for this champion in this lane.\n\n${uitsplitsing}`}
    >
      <span className="num naspel-score-getal">{Math.round(gescoord.score)}</span>
      {soort !== "gewoon" ? <span className="naspel-score-merk">{soort.toUpperCase()}</span> : null}
    </span>
  );
}

/** A bar against the highest in the game, or a dash when nothing was recorded. */
function Balk({
  waarde,
  max,
  klasse,
  bijschrift,
  titel,
}: {
  waarde: number | undefined;
  max: number | null;
  klasse: string;
  bijschrift: string | null;
  titel: string;
}): JSX.Element {
  if (waarde === undefined || max === null || max <= 0) {
    return <span className="num block text-[10px] text-ink-700">--</span>;
  }
  return (
    <span className="flex items-center gap-1.5" title={titel}>
      <span className="naspel-balk">
        <span className={klasse} style={{ width: `${Math.min(100, (waarde / max) * 100)}%` }} />
      </span>
      <span className="num w-11 shrink-0 text-right text-[10px] text-ink-500">{kort(waarde)}</span>
      {bijschrift ? (
        <span className="num w-7 shrink-0 text-right text-[10px] text-ink-700">{bijschrift}</span>
      ) : null}
    </span>
  );
}

/**
 * The five lanes, side against side.
 *
 * Only lanes where exactly one player per team claimed the position are here --
 * see leesLanes. In a blind-pick lobby that can be none of them, and then the
 * section does not exist at all rather than inventing a matchup.
 */
function LaneDuels({
  lanes,
  champions,
}: {
  lanes: NaspelLane[];
  champions: Map<number, ChampionSummary>;
}): JSX.Element {
  return (
    <div>
      <p className="sectiekop mb-2">Lane by lane</p>
      <div className="space-y-1">
        {lanes.map((lane) => (
          <div key={lane.position} className="naspel-lane">
            <span className="flex items-center gap-2">
              <ChampionIcon
                iconPath={champions.get(lane.blauw.speler.championId)?.iconPath}
                name={champions.get(lane.blauw.speler.championId)?.name}
                size={22}
              />
              <span className="num text-[11px] text-ink-300">{Math.round(lane.blauw.score)}</span>
            </span>

            <span className="flex items-center justify-center gap-1.5 text-[10px] tracking-[0.12em] text-ink-600 uppercase">
              <PositionIcon position={lane.position} size={12} />
              {POSITION_LABELS[lane.position] ?? lane.position}
            </span>

            <span className="flex items-center justify-end gap-2">
              <span className="num text-[11px] text-ink-300">{Math.round(lane.rood.score)}</span>
              <ChampionIcon
                iconPath={champions.get(lane.rood.speler.championId)?.iconPath}
                name={champions.get(lane.rood.speler.championId)?.name}
                size={22}
              />
            </span>

            <span className="naspel-lane-cijfers">
              <Verschil label="gold" waarde={lane.goudVerschil} toon={kort} />
              <Verschil label="cs" waarde={lane.csVerschil} toon={(n) => String(n)} />
              {lane.damageVerschil !== null ? (
                <Verschil label="dmg" waarde={lane.damageVerschil} toon={kort} />
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One gap, signed towards whoever is ahead.
 *
 * The colour follows the side and not the outcome: blue ahead is blue, red ahead
 * is red. Green and red are spoken for in this app -- they mean won and lost --
 * and a green lead in a game you lost would say the wrong thing twice over.
 */
function Verschil({
  label,
  waarde,
  toon,
}: {
  label: string;
  waarde: number;
  toon: (n: number) => string;
}): JSX.Element {
  const kleur = waarde > 0 ? "text-info-400" : waarde < 0 ? "text-loss-400" : "text-ink-600";
  return (
    <span className="num text-[10px] text-ink-700">
      <span className={kleur}>
        {waarde > 0 ? "+" : waarde < 0 ? "-" : ""}
        {toon(Math.abs(waarde))}
      </span>{" "}
      {label}
    </span>
  );
}

/**
 * The rule behind the score, on request.
 *
 * It renders NASPEL_FACTOREN itself rather than a written-out copy of it, so the
 * weights on screen are by construction the weights that were applied. A factor
 * this game could not supply is listed struck through with the reason, which is
 * also the only honest way to present a score that was computed from fewer parts
 * than usual.
 */
function ScoreRegel({ naspel }: { naspel: Naspel }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button type="button" className="naspel-regel-knop" onClick={() => setOpen(!open)}>
        <svg
          viewBox="0 0 24 24"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        How the score is made
      </button>

      {/* Stated where the score is, rather than only inside the panel that
          explains it.

          The old caveat here counted factors, because a game stored before the
          store kept damage was scored on four of seven and the reader had to be
          told. That is gone: every game is now scored on the same five figures,
          all of which are on every record, so scores are comparable between
          games and there is nothing left to warn about on that front. What is
          left to warn about is which yardstick was available, and that is a
          property of the database rather than of the game. */}
      {naspel.ijk === "champion" ? (
        <p className="naspel-beperkt">
          This game came back without lanes, so everyone was measured against their champion across
          every lane instead of in one. That is a coarser comparison &mdash; a champion is played in
          its usual lane about seven games in ten &mdash; but it is still each player against their
          own champion, and not against whoever farmed most in the lobby.
        </p>
      ) : null}
      {naspel.ijk === "lobby" ? (
        <p className="naspel-beperkt">
          There are not enough recorded games yet to say what these champions normally do, so this
          score compares the ten players in this game with each other instead. That is the older and
          worse yardstick: it flatters whoever farmed most and it is unkind to supports. It corrects
          itself as the database fills.
        </p>
      ) : null}

      {open ? (
        <div className="naspel-regel">
          <p className="mb-2.5 text-[11px] leading-relaxed text-ink-300">
            Every player is measured against what their own champion normally does in their own
            lane, so a support&rsquo;s 11 CS is held against other supports and not against the top
            laner&rsquo;s 236. Exactly normal scores 50, twice normal 74, half normal 26 &mdash; so
            50 is an average game and not a bad one. Kill participation is the one figure that is
            already a share of your own team, so it is taken as it stands. MVP is the best score on
            the winning side, ACE the best on the losing side, so nothing here has to reward having
            won.
          </p>
          <ul className="space-y-1">
            {NASPEL_FACTOREN.map((factor) => (
              <li key={factor.sleutel} className="naspel-regel-item">
                <span className="num w-10 shrink-0 text-right text-[11px] text-gold-300">
                  {/* One decimal, because rounding 22.5 to 23 twice makes the
                      five weights on screen add up to 101 and a rule that does
                      not add up is a rule nobody will trust. */}
                  {+(factor.gewicht * 100).toFixed(1)}%
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] text-ink-100">{factor.naam}</span>
                  <span className="block text-[10px] leading-relaxed text-ink-500">{factor.uitleg}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-[10px] leading-relaxed text-ink-600">
            {naspel.ijkGames !== null ? (
              <>
                The thinnest average behind this game stands on {naspel.ijkGames.toLocaleString()} recorded{" "}
                {naspel.ijkGames === 1 ? "game" : "games"}.{" "}
              </>
            ) : null}
            Damage, damage taken and vision are shown above but deliberately not scored: no stored
            game carries them and there is no backfill, so scoring on them would mean two different
            rules on one screen. When enough games have them, they become factors here too.
          </p>
        </div>
      ) : null}
    </div>
  );
}
