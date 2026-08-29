/**
 * Saying which mode a screen means, in one place.
 *
 * Two jobs that are one job seen from either end: reading a player's profile for
 * ONE mode without ever borrowing the other's, and telling the reader which mode
 * they are looking at. Every screen that used to read the one summary there was
 * has to name the mode it means now, and the rule belongs here rather than being
 * re-derived at each of the places a winrate is drawn.
 */
import {
  COLLECTED_MODES, describeMode, modeCollects, modeCrawls, modeLabel,
} from "../../core/modes/registry";
import type { CollectedMode } from "../../core/modes/registry";
import type { ModeId } from "../../core/modes/types";
import type { ModusSamenvatting, PlayerProfile, RankedSummary } from "../../core/services/player";
import type { AppSnapshot, DatabaseStatus } from "../../shared/types";
import { EmptyState } from "./ui";

/**
 * A player's numbers for one mode, or null when there are none.
 *
 * Note what this deliberately does NOT do: it never hands the Classic summary to
 * a caller asking for the modern game. That fallback would be the forbidden
 * merge produced by the safety net rather than by anyone's code -- a screen
 * headed "League of Legends" showing Classic averages, with nothing on it to
 * give the lie away. So the net has a hole in it on purpose, and a mode without
 * data reads as no data.
 */
export const samenvatting = (
  profile: PlayerProfile | null | undefined,
  mode: ModeId,
): ModusSamenvatting | null =>
  // modeCollects is the type guard as well as the question: a mode with no
  // bucket to be counted in has no summary to look up either.
  (modeCollects(mode) ? profile?.perModus[mode] : undefined) ?? null;

/**
 * A player's rank in one mode: the ladder, `null` for unranked on it, and
 * `undefined` where this app reads no ladder at all.
 *
 * Three answers rather than two, because "unranked" and "we do not know" are
 * different claims and the pill states the first one in words. Classic ranked
 * and modern solo queue are separate ladders that share only their tier names,
 * so a Classic Gold shown beside a heading naming the other game is not a
 * rounding error -- it is a wrong fact carrying a full emblem. Modern therefore
 * answers `undefined` and the pill is left out, until something actually reads
 * that ladder.
 */
export const rangVoor = (
  profile: PlayerProfile | null | undefined,
  mode: ModeId,
): RankedSummary | null | undefined => (mode === "lol:jade" ? (profile?.rank ?? null) : undefined);

/**
 * The mode the client is in right now, or null when it is in none.
 *
 * A running game outranks a champion select because the two overlap: the client
 * still reports the select it came out of for a moment after the game starts,
 * and the game is the later fact. Both are read off the thing itself -- the live
 * endpoint's own mode, the lobby's own queue -- and never off whatever the
 * window happens to be browsing.
 */
function draaiendeModus(snapshot: AppSnapshot | null): { mode: ModeId; waar: string } | null {
  if (snapshot?.liveGame) return { mode: snapshot.liveGame.mode, waar: "In game" };
  if (snapshot?.champSelect?.mode) {
    return { mode: snapshot.champSelect.mode, waar: "Champion select" };
  }
  return null;
}

/**
 * The mode marker: the one thing in the chrome that says you are in Classic.
 *
 * Deliberately asymmetric -- it appears for Classic and never for the modern
 * game. Modern is the default and a default needs no label; Classic is the
 * exception, and announcing the exception is the whole job. That asymmetry is
 * also what keeps the mode out of the wordmark: the title bar was cut from nine
 * things to seven to lose the two that never stopped changing, and a subline
 * that swapped width every time a game started would put that mistake back into
 * the brand itself. A marker that is simply absent most of the time does not.
 *
 * It is a `badge`, the utility already in styles.css, and not a shape of its own.
 * There was a `.modusmerk` rule here that restated that utility nearly value for
 * value: the same --radius-xs, a gold edge, a ten-percent gold wash. Where the
 * two differed they differed by amounts nobody had written a reason for -- the
 * edge at 35% of gold-500 against the badge's solid gold-500, a wash mixed from
 * gold-500 against the badge's from gold-400, 11px/500/0.08em uppercase against
 * 0.66rem/700/0.02em. A second definition of a shape that already exists is a
 * shape that drifts: the tier chips on the champion panel are `badge` too, and
 * the day somebody adjusts the badge they would have adjusted one of these two
 * and not the other. The one thing the old rule bought was a 22px height
 * matching the sharing pill; the pill sits in the top-aligned cluster on the far
 * right of the bar and this stands beside the lockup in a flex row that centres
 * its children, so the two were never on a shared edge and nothing moves by
 * giving that up -- the badge is 19.7px and centres in the same place.
 *
 * Square-cornered rather than the sharing pill's 999px -- which the badge gives
 * for free -- so it does not read as a second switch beside it, and it carries
 * its situation so the screen tells the two Classic moments apart.
 */
export function ModusMerk({
  snapshot,
  className = "",
}: {
  snapshot: AppSnapshot | null;
  /** Spacing from whatever it stands next to; the two bars space differently. */
  className?: string;
}): JSX.Element | null {
  const draait = draaiendeModus(snapshot);
  if (draait?.mode !== "lol:jade") return null;
  return (
    <span
      className={`badge badge-goud ${className}`}
      title="This is League Classic. Its numbers are kept apart from the modern game's."
    >
      {describeMode(draait.mode)?.shortLabel ?? modeLabel(draait.mode)}
      {/* Quieter than the mode itself: champion select and in game are the two
          moments this app exists for and the screen has to tell them apart, but
          the mode is the news and the moment is the footnote. gold-500 is the
          muted step of the same accent the badge is already drawn in, so this is
          one colour class rather than a rule of its own -- the same thing the
          tier chip on the champion panel does. */}
      <span className="text-gold-500">{draait.waar}</span>
    </span>
  );
}

/**
 * Which mode the window opens on, the first time it is drawn.
 *
 * Modern is the default, because that is what the app is primarily about now.
 * But a principled default that opens on an empty tier list is a worse first
 * screen than an honest one, and today modern holds nothing while Classic holds
 * everything this machine ever crawled. So: modern, unless modern is empty and
 * Classic is not. The switch is on screen either way, which is what keeps this a
 * starting point rather than a silent redirection.
 */
export function kiesStartModus(database: DatabaseStatus): CollectedMode {
  const modern = database.perModus["lol:sr"]?.matches ?? 0;
  const classic = database.perModus["lol:jade"]?.matches ?? 0;
  return modern === 0 && classic > 0 ? "lol:jade" : "lol:sr";
}

/**
 * The browse switch, and the offer that deliberately does not touch it.
 *
 * The switch is a choice the reader made and it may not move on its own. If it
 * flipped when a queue popped, the numbers under someone reading a modern tier
 * list would change while they were reading them, with nothing on screen to say
 * why. So the running mode gets a sentence beside the switch instead: click it
 * or ignore it. The live panel and champion select take the running mode
 * unconditionally, because there is nothing to choose there.
 *
 * Same shape as the lane buttons it sits beside, on purpose. This is a second
 * row of a control that already exists, not a new kind of thing.
 */
export function ModusKeuze({
  modus,
  onKies,
  snapshot,
}: {
  modus: CollectedMode;
  onKies: (mode: CollectedMode) => void;
  snapshot: AppSnapshot;
}): JSX.Element {
  const draait = draaiendeModus(snapshot);
  const aanbod = draait && modeCollects(draait.mode) && draait.mode !== modus ? draait.mode : null;
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1.5">
        {COLLECTED_MODES.map((entry) => (
          <button
            key={entry}
            onClick={() => onKies(entry)}
            className={`rounded-xl border px-3.5 py-2 text-[12px] font-medium transition-colors ${
              modus === entry
                ? "border-gold-400/40 bg-gold-400/12 text-gold-300"
                : "border-white/8 text-ink-500 hover:border-line-lit hover:text-ink-300"
            }`}
          >
            {modeLabel(entry)}
          </button>
        ))}
      </div>
      {aanbod ? (
        <button
          onClick={() => onKies(aanbod)}
          className="text-[11px] text-ink-500 transition-colors hover:text-ink-300"
        >
          You are in {modeLabel(aanbod)}. Show its stats?
        </button>
      ) : null}
    </div>
  );
}

/**
 * What a mode with nothing in it looks like.
 *
 * Three different absences where there used to be one sentence, and that one
 * sentence -- "The database keeps growing in the background while you play" --
 * is true of exactly one of them. "No games in this mode" is not "this lane is
 * below the floor", and neither of those is "we do not gather this mode at all".
 * The third is the honest state of the modern game today: its shared numbers
 * would have to come from Riot's documented match API rather than from walking
 * strangers' histories in the client, so telling somebody to come back tomorrow
 * is telling them to come back forever.
 */
export function ModusLeeg({
  modus,
  ander,
  onKies,
}: {
  modus: CollectedMode;
  /**
   * The other mode, when it has something to show, and the way to get there.
   *
   * Both optional because not every empty panel is somewhere you can switch
   * from: the tier column on the Live screen has no mode switch of its own, and
   * offering a button there that changes what the rest of the window is showing
   * would move the reader's choice from under them. Where there is no switch,
   * the sentence still has to be the right sentence.
   */
  ander?: CollectedMode | null;
  onKies?: (mode: CollectedMode) => void;
}): JSX.Element {
  const verzamelt = modeCrawls(modus);
  return (
    <EmptyState
      title={
        verzamelt
          ? `No ${modeLabel(modus)} games collected yet`
          : `AllMid does not collect ${modeLabel(modus)} games yet`
      }
      hint={
        verzamelt
          ? "Nothing is wrong: there is simply nothing to average yet, and these numbers are never borrowed from the other mode."
          : "They would have to come from Riot's own match API rather than from the client, so there is nothing here until that exists. Your own games in this mode still appear on Live and Profile."
      }
      actie={
        ander && onKies ? (
          <button type="button" className="knop knop-secundair" onClick={() => onKies(ander)}>
            Show {modeLabel(ander)} instead
          </button>
        ) : undefined
      }
    />
  );
}
