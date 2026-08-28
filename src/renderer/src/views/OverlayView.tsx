/**
 * The panel that sits on top of the game.
 *
 * Deliberately small, and deliberately limited to things both teams can already
 * see. Riot's overlay guidance forbids "tracking of enemy ability cooldowns, or
 * facilitating players tracking these with timers" and says outright that
 * "ultimate timers is strictly forbidden". Objectives are the opposite case: a
 * dragon falling puts a banner on all ten screens, so a countdown from that is
 * arithmetic on something everyone watched.
 *
 * It draws nothing while no Classic game is running, and nothing at all that the
 * game has not already announced.
 */
import { useEffect, useState } from "react";
import type { AppSnapshot } from "../../../shared/types";

const klok = (s: number): string =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

const NAAM: Record<string, string> = { dragon: "Drake", baron: "Baron", inhibitor: "Inhib" };

export function OverlayView({ snapshot }: { snapshot: AppSnapshot | null }): JSX.Element | null {
  // Locked is the normal state and the one that has to be invisible to the mouse.
  // Unlocked gets a visible frame and a drag region, because you are moving it
  // and need to see what you are grabbing.
  const [vergrendeld, setVergrendeld] = useState(true);
  useEffect(() => window.jade.onOverlayLocked(setVergrendeld), []);

  const live = snapshot?.liveGame;
  if (!live || !live.isClassic) return null;

  const jij = live.players.find((p) => p.isYou) ?? null;
  const objectieven = live.inzichten?.objectieven ?? [];
  const verschil = live.inzichten?.itemVerschil ?? 0;
  const iets = objectieven.length > 0 || jij?.trinketLeeg || live.skillOrder.length > 0;
  if (!iets) return null;

  return (
    <div className="flex h-full w-full items-start justify-end p-2">
      {/* A drag region only while unlocked. Leaving it on permanently is what
          turns the cursor into a caret over a panel you are supposed to be able
          to look straight past. */}
      <div
        style={vergrendeld ? undefined : ({ WebkitAppRegion: "drag" } as React.CSSProperties)}
        className={`w-[230px] rounded-xl p-2.5 text-ink-100 backdrop-blur-[3px] transition-colors ${
          vergrendeld
            ? "border border-white/[0.07] bg-void/60 shadow-[0_8px_28px_-14px_rgba(0,0,0,0.9)]"
            : "cursor-move border-2 border-dashed border-gold-400/70 bg-void/92"
        }`}
      >
        {!vergrendeld ? (
          <p className="mb-1.5 text-center text-[9px] tracking-[0.14em] text-gold-300 uppercase">
            Drag me
          </p>
        ) : null}
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[9px] tracking-[0.16em] text-gold-400 uppercase">AllMid</span>
          <span className="num text-[10px] text-ink-600">{klok(live.gameTimeSeconds)}</span>
        </div>

        {objectieven.length > 0 ? (
          <div className="mb-1.5 grid gap-1">
            {objectieven.slice(0, 4).map((o, i) => {
              const terug = o.overSeconden <= 0;
              return (
                <div
                  key={`${o.soort}-${o.detail ?? i}`}
                  className="num flex items-center justify-between rounded-md bg-white/[0.05] px-1.5 py-1 text-[11px]"
                >
                  <span className="text-ink-400">
                    {NAAM[o.soort] ?? o.soort}
                    {o.soort === "dragon" && o.detail ? (
                      <span className="ml-1 text-ink-600">{o.detail}</span>
                    ) : null}
                  </span>
                  <span className={terug ? "font-semibold text-jade-300" : "text-ink-200"}>
                    {terug ? "up" : klok(o.overSeconden)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {live.inzichten ? (
          <div className="num mb-1.5 flex items-center justify-between rounded-md bg-white/[0.03] px-1.5 py-1 text-[10px]">
            <span className="text-ink-600">Item gold</span>
            <span className={verschil >= 0 ? "text-sky-400" : "text-loss-400"}>
              {verschil === 0 ? "even" : `${verschil > 0 ? "+" : ""}${(verschil / 1000).toFixed(1)}k`}
            </span>
          </div>
        ) : null}

        {live.skillOrder.length > 0 ? (
          <div className="num mb-1.5 flex items-center justify-between rounded-md bg-white/[0.03] px-1.5 py-1 text-[10px]">
            <span className="text-ink-600">Skills</span>
            <span className="text-ink-300">{live.skillOrder.slice(-6).join(" ")}</span>
          </div>
        ) : null}

        {jij?.trinketLeeg ? (
          <div className="rounded-md border border-gold-400/40 bg-gold-400/10 px-1.5 py-1 text-[10px] text-gold-300">
            Trinket slot empty
          </div>
        ) : null}
      </div>
    </div>
  );
}
