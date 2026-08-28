/** Small building blocks shared by every view. */
import { Fragment, type ReactNode } from "react";
import type { RankedSummary } from "../../core/services/player";
import { MerkWapen } from "./merk";

/** Client assets are proxied through the jade:// protocol in the main process. */
export const asset = (path: string): string => (path ? `jade://asset${path}` : "");

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={`panel ${className}`}>{children}</div>;
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }): JSX.Element {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-[13px] font-semibold tracking-[0.14em] text-ink-500 uppercase">{children}</h2>
      {hint ? <span className="text-xs text-ink-500">{hint}</span> : null}
    </div>
  );
}

export function ChampionIcon({
  iconPath,
  name,
  size = 40,
  dim = false,
  fill = false,
  className = "",
}: {
  iconPath?: string;
  name?: string;
  size?: number;
  dim?: boolean;
  /** Stretch to the parent instead of carrying a size, radius and hairline. */
  fill?: boolean;
  className?: string;
}): JSX.Element {
  // A portrait that has to fill a card cannot also own its shape. The inline
  // width would beat whatever the card asked for, and the icon's own 12px radius
  // inside the card's 8px one reads as a rounded rectangle in a rounded
  // rectangle. So `fill` hands all three back to the parent rather than fighting
  // it -- the fallback and the client asset path stay exactly as they were.
  const style = fill ? undefined : { width: size, height: size };
  if (!iconPath) {
    return (
      <div
        style={style}
        className={`flex items-center justify-center text-[10px] text-ink-700 ${
          fill ? "h-full w-full bg-white/[0.03]" : "shrink-0 rounded-xl border border-white/10 bg-white/[0.03]"
        } ${className}`}
      >
        ?
      </div>
    );
  }
  return (
    <img
      src={asset(iconPath)}
      alt={name ?? ""}
      title={name}
      style={style}
      className={`object-cover ${fill ? "h-full w-full" : "shrink-0 rounded-xl border border-white/10"} ${
        dim ? "opacity-40 grayscale" : ""
      } ${className}`}
    />
  );
}

/** Item row from a finished game; empty slots render as a faint placeholder. */
export function ItemRow({
  items,
  lookup,
  size = 24,
}: {
  items: number[];
  lookup: Map<number, { name: string; iconPath: string }>;
  size?: number;
}): JSX.Element {
  return (
    <div className="flex gap-1">
      {items.map((id, index) => {
        const item = id ? lookup.get(id) : undefined;
        return item ? (
          <img
            key={index}
            src={asset(item.iconPath)}
            alt={item.name}
            title={item.name}
            style={{ width: size, height: size }}
            className="rounded-md border border-white/8"
          />
        ) : (
          <div
            key={index}
            style={{ width: size, height: size }}
            className="rounded-md border border-line bg-white/[0.02]"
          />
        );
      })}
    </div>
  );
}

export function SpellPair({
  spells,
  lookup,
  size = 18,
}: {
  spells: number[];
  lookup: Map<number, { name: string; iconPath: string }>;
  size?: number;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-[3px]">
      {spells.map((id, index) => {
        const spell = lookup.get(id);
        return spell ? (
          <img
            key={index}
            src={asset(spell.iconPath)}
            alt={spell.name}
            title={spell.name}
            style={{ width: size, height: size }}
            className="rounded border border-white/8"
          />
        ) : (
          <div
            key={index}
            style={{ width: size, height: size }}
            className="rounded border border-line bg-white/[0.02]"
          />
        );
      })}
    </div>
  );
}

/**
 * Classic has its own ladder (Wood, Salt, ...) instead of Iron→Challenger, so we
 * colour by the tier name the client reports rather than by a fixed order we
 * cannot know yet.
 */
const TIER_COLORS: Record<string, string> = {
  wood: "text-[#b08968] border-[#b08968]/30 bg-[#b08968]/10",
  salt: "text-[#cfd6dd] border-[#cfd6dd]/25 bg-[#cfd6dd]/10",
  bronze: "text-[#cd7f32] border-[#cd7f32]/30 bg-[#cd7f32]/10",
  silver: "text-[#c0c8d0] border-[#c0c8d0]/25 bg-[#c0c8d0]/10",
  // Letterlijke hex, niet het merktoken: de rangkleuren moeten exact blijven
  // staan ook nu goud van tint verandert.
  gold: "text-[#e6c88a] border-[#e6c88a]/30 bg-[#e6c88a]/10",
  platinum: "text-[#5fd6c8] border-[#5fd6c8]/30 bg-[#5fd6c8]/10",
  diamond: "text-[#7aa8ff] border-[#7aa8ff]/30 bg-[#7aa8ff]/10",
};

export function RankPill({ rank, compact = false }: { rank: RankedSummary | null; compact?: boolean }): JSX.Element {
  if (!rank) {
    return (
      <span className="rang-pil rounded-md border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[11px] text-ink-500">
        Unranked
      </span>
    );
  }
  const tone = TIER_COLORS[rank.tier.toLowerCase()] ?? "text-ink-300 border-white/10 bg-white/[0.04]";
  const label = compact ? `${rank.tier} ${rank.division}`.trim() : rank.label;
  return <span className={`rang-pil num rounded-md border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>;
}

export function Winrate({ winrate, games }: { winrate: number; games: number }): JSX.Element {
  if (games === 0) return <span className="text-[11px] text-ink-700">no games yet</span>;
  const pct = Math.round(winrate * 100);
  const sterk = pct >= 55;
  const zwak = pct <= 45;
  const tone = sterk ? "text-jade-300" : zwak ? "text-loss-400" : "text-ink-100";
  const veld = sterk
    ? "border-jade-500/30 bg-jade-500/10"
    : zwak
      ? "border-loss-500/30 bg-loss-500/10"
      : "border-line bg-white/[0.03]";
  return (
    <span
      className={`winrate-badge inline-flex items-baseline gap-1 rounded-lg border px-2 py-0.5 ${veld}`}
      title={`${pct}% won over ${games} games`}
    >
      <span className={`num text-[13px] leading-none font-semibold ${tone}`}>{pct}%</span>
      <span className="num text-[9px] text-ink-500">{games}g</span>
    </span>
  );
}

/** Recent results as dots, newest first. */
export function FormDots({ results }: { results: boolean[] }): JSX.Element {
  return (
    // Bigger and brighter, in both places the mock-up draws them: the dots sit
    // on an 11px pitch at about 7 across, where the app had 6 on 9. The colours
    // moved up a step too -- the mock-up green reads (12,204,129) and the red
    // (237,58,65), while jade-500 tops out at a green channel of 163 and
    // loss-500 at a red of 184, so neither could ever get there. These are the
    // palette's own Green and Red, and a result you won or lost deserves to be
    // legible at seven pixels across.
    <div className="flex gap-1">
      {results.slice(0, 10).map((won, i) => (
        <span
          key={i}
          title={won ? "Win" : "Loss"}
          className={`h-[7px] w-[7px] rounded-full ${won ? "bg-jade-400" : "bg-loss-400"}`}
        />
      ))}
    </div>
  );
}

export function Streak({ streak }: { streak: number }): JSX.Element | null {
  if (Math.abs(streak) < 3) return null;
  const won = streak > 0;
  return (
    <span
      className={`num rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
        won ? "bg-jade-500/15 text-jade-300" : "bg-loss-500/15 text-loss-400"
      }`}
    >
      {Math.abs(streak)} {won ? "win" : "loss"} streak
    </span>
  );
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-500">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-lit border-t-gold-400" />
      {label}
    </div>
  );
}

/**
 * Splash art behind a screen that is about one champion.
 *
 * The lesson the website learned the hard way: a portrait you dim turns to mud.
 * You brighten it and shape the darkness on top, with the gradient sitting
 * exactly where the text does. So the image gets brightness above 1 and the veil
 * closes fully at the bottom -- there is never a strip with art and no veil.
 *
 * Assets come through the client, so this quietly shows nothing when League is
 * closed. That is the right failure: a missing backdrop is not worth an error.
 */
export function SplashBackdrop({
  champion,
  strip = false,
  className = "",
}: {
  champion?: { splashPath: string; tilePath: string; name: string };
  strip?: boolean;
  className?: string;
}): JSX.Element | null {
  if (!champion) return null;
  const pad = strip ? champion.tilePath : champion.splashPath;
  if (!pad) return null;
  return (
    <div className={`splash ${strip ? "splash-strip" : ""} ${className}`} aria-hidden="true">
      <img key={pad} src={asset(pad)} alt="" />
    </div>
  );
}

/**
 * The grid every build guide uses: one row per ability, one column per level.
 *
 * The recorded order is the whole story, since entry n is the point spent at
 * level n, so this needs nothing beyond it. Levels 6, 11 and 16 are marked
 * because that is where the ultimate becomes available and it makes the row
 * readable without counting columns.
 */
export function SkillGrid({ order, compact = false }: { order: string[]; compact?: boolean }): JSX.Element {
  const skills = ["Q", "W", "E", "R"] as const;
  const levels = Array.from({ length: 18 }, (_, i) => i + 1);
  const cel = compact ? 16 : 22;

  return (
    <div className="overflow-x-auto">
      <div
        className="inline-grid gap-[3px]"
        style={{ gridTemplateColumns: `${cel + 4}px repeat(18, ${cel}px)` }}
      >
        <span />
        {levels.map((n) => (
          <span
            key={n}
            className={`num text-center text-[9px] leading-4 ${
              n === 6 || n === 11 || n === 16 ? "text-gold-500" : "text-ink-700"
            }`}
          >
            {n}
          </span>
        ))}
        {skills.map((skill) => {
          const isUlt = skill === "R";
          return (
            <Fragment key={skill}>
              <span
                className={`num flex items-center justify-center rounded-[4px] text-[10px] font-bold ${
                  isUlt ? "bg-gold-500/25 text-gold-300" : "bg-line/60 text-ink-300"
                }`}
                style={{ height: cel }}
              >
                {skill}
              </span>
              {levels.map((n) => {
                const gezet = order[n - 1] === skill;
                return (
                  <span
                    key={n}
                    title={gezet ? `Level ${n}: ${skill}` : undefined}
                    className={`rounded-[4px] transition-colors duration-300 ${
                      gezet
                        ? isUlt
                          ? "bg-gold-300 shadow-[0_0_10px_-1px_var(--color-gold-400)]"
                          : "bg-gold-400/85"
                        : "bg-line/35"
                    }`}
                    style={{ height: cel }}
                  />
                );
              })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Een leeg scherm, met opzet ontworpen.
 *
 * Hiervoor stonden hier twee regels grijze tekst in een grote doos, en dat
 * leest als "er ontbreekt iets" in plaats van "hier komt iets". Het merk erbij
 * maakt er een plek van die klopt: rustig genoeg om niet als fout te lezen,
 * aanwezig genoeg om te laten zien dat het scherm het doet.
 *
 * `actie` is er voor de gevallen waarin de gebruiker het leeg-zijn kan
 * oplossen -- dan hoort de weg eruit ernaast te staan en niet ergens anders.
 */
export function EmptyState({
  title,
  hint,
  actie,
}: {
  title: string;
  hint?: string;
  actie?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <MerkWapen size={84} />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-ink-100">{title}</p>
        {hint ? <p className="mx-auto max-w-sm text-xs leading-relaxed text-ink-500">{hint}</p> : null}
      </div>
      {actie ? <div className="mt-1">{actie}</div> : null}
    </div>
  );
}

export const POSITION_LABELS: Record<string, string> = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "Bot",
  SUPPORT: "Support",
  UNKNOWN: "Unknown",
};

/** Tiny lane glyphs, drawn rather than shipped as images. */
export function PositionIcon({ position, size = 15 }: { position: string; size?: number }): JSX.Element {
  const paths: Record<string, string> = {
    TOP: "M4 20V4h16",
    JUNGLE: "M12 21c0-6 3-10 8-12-6 0-8 3-8 3s-2-3-8-3c5 2 8 6 8 12Z",
    MIDDLE: "M4 20 20 4",
    BOTTOM: "M4 4v16h16",
    SUPPORT: "M12 21s-8-4.7-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 11c0 5.3-8 10-8 10Z",
    UNKNOWN: "M12 17h.01M9.5 9a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label={POSITION_LABELS[position] ?? position}
    >
      <path d={paths[position] ?? paths.UNKNOWN!} />
    </svg>
  );
}
