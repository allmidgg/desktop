/**
 * Het logvenster: alles wat de host en zijn services zeggen, op volgorde.
 *
 * Omdat elk verzoek door dezelfde host loopt, is dit de enige plek waar je de
 * volgorde van gebeurtenissen over services heen echt kunt zien -- daarom filtert
 * dit scherm wel, maar hervormt het niets: één regel per melding, zoals hij binnenkwam.
 *
 * Meescrollen staat aan tot je zelf omhoog scrolt of op pauze drukt. Wie terugleest
 * wil niet dat de tekst onder zijn ogen wegschuift, en wie kijkt wil niet klikken.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, LogLevel, ManagerApi, ManagerSnapshot } from "../../../../shared/types";

/** Dezelfde declaratie als in main.tsx; identiek herhalen mag en houdt deze view op zichzelf leesbaar. */
declare global {
  interface Window {
    manager: ManagerApi;
  }
}

const LEVELS: LogLevel[] = ["info", "warn", "error"];

/** Sentinel voor LogEntry.serviceId === null, zodat de filterknoppen één type hebben. */
const HOST = "host";

/**
 * Meer regels dan dit tegelijk in de DOM maakt scrollen merkbaar traag, terwijl
 * niemand verder dan een paar schermen terugleest. De host bewaart de historie.
 */
const MAX_ROWS = 500;

const LEVEL_LOOK: Record<LogLevel, { row: string; tag: string; text: string }> = {
  info: { row: "border-transparent", tag: "text-ink-700", text: "text-ink-300" },
  warn: { row: "border-gold-500/60 bg-gold-500/[0.05]", tag: "text-gold-400", text: "text-ink-300" },
  error: { row: "border-loss-500 bg-loss-500/[0.07]", tag: "text-loss-400", text: "text-ink-100" },
};

export function LogsView({ snapshot }: { snapshot: ManagerSnapshot }): JSX.Element {
  const [source, setSource] = useState<string>("all");
  const [levels, setLevels] = useState<Record<LogLevel, boolean>>({ info: true, warn: true, error: true });
  const [following, setFollowing] = useState(true);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const names = new Map(snapshot.services.map((service) => [service.id, service.name]));

  // Tellers gaan over de gekozen bron, niet over het gekozen niveau: anders zou een
  // uitgezet niveau zijn eigen aantal op nul zetten en kun je nooit meer zien dat er iets is.
  const counts = useMemo(() => {
    const total: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
    for (const entry of snapshot.logs) {
      if (source !== "all" && (entry.serviceId ?? HOST) !== source) continue;
      total[entry.level] += 1;
    }
    return total;
  }, [snapshot.logs, source]);

  const { rows, hidden } = useMemo(() => {
    const matched = snapshot.logs.filter(
      (entry) => levels[entry.level] && (source === "all" || (entry.serviceId ?? HOST) === source),
    );
    return {
      rows: matched.length > MAX_ROWS ? matched.slice(-MAX_ROWS) : matched,
      hidden: Math.max(0, matched.length - MAX_ROWS),
    };
  }, [snapshot.logs, levels, source]);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element || !following) return;
    element.scrollTop = element.scrollHeight;
  }, [rows.length, following]);

  const pause = (): void => {
    // Vastleggen waar we stonden, zodat "N new" klopt met wat er ondertussen binnenkwam.
    setPausedAt(rows.at(-1)?.at ?? Date.now());
    setFollowing(false);
  };

  const resume = (): void => {
    setPausedAt(null);
    setFollowing(true);
  };

  const onScroll = (): void => {
    const element = listRef.current;
    if (!element || !following) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    // Zelf omhoog scrollen betekent lezen; dan houdt het meescrollen vanzelf op.
    if (!atBottom) pause();
  };

  const missed = pausedAt === null ? 0 : rows.filter((entry) => entry.at > pausedAt).length;

  return (
    <div className="animate-rise flex h-full min-h-[520px] flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-[0.14em] text-ink-500 uppercase">Live log</h2>
        <button
          onClick={following ? pause : resume}
          title={following ? "Stop scrolling along so you can read back" : "Jump to the newest line and follow again"}
          className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[12px] font-medium transition-colors ${
            following
              ? "border-jade-500/40 bg-jade-500/12 text-jade-300"
              : "border-white/8 text-ink-300 hover:border-white/16 hover:bg-white/[0.05]"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${following ? "animate-pulse-ring bg-jade-500" : "bg-ink-700"}`} />
          {following ? "Following" : missed > 0 ? `Paused · ${missed} new` : "Paused"}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-4">
        <div className="flex flex-wrap gap-1.5">
          <FilterPill active={source === "all"} onClick={() => setSource("all")}>
            All sources
          </FilterPill>
          <FilterPill active={source === HOST} onClick={() => setSource(HOST)}>
            Host
          </FilterPill>
          {snapshot.services.map((service) => (
            <FilterPill key={service.id} active={source === service.id} onClick={() => setSource(service.id)}>
              {service.name}
            </FilterPill>
          ))}
        </div>

        <div className="flex gap-1.5">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => setLevels((current) => ({ ...current, [level]: !current[level] }))}
              className={`num rounded-xl border px-3 py-2 text-[12px] font-medium transition-colors ${
                levels[level]
                  ? level === "error"
                    ? "border-loss-500/45 bg-loss-500/12 text-loss-400"
                    : level === "warn"
                      ? "border-gold-400/35 bg-gold-400/10 text-gold-300"
                      : "border-white/14 bg-white/[0.05] text-ink-300"
                  : "border-white/8 text-ink-700 hover:border-white/14 hover:text-ink-500"
              }`}
            >
              {level} <span className="opacity-60">{counts[level]}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="panel min-h-0 flex-1 overflow-y-auto py-2"
      >
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center">
            <p className="text-sm text-ink-300">
              {snapshot.logs.length === 0 ? "Nothing logged yet" : "No lines match these filters"}
            </p>
            <p className="max-w-sm text-xs text-ink-500">
              {snapshot.logs.length === 0
                ? "Every request the host handles and everything a service reports shows up here."
                : "Turn a level back on or pick another source."}
            </p>
          </div>
        ) : (
          <>
            {hidden > 0 ? (
              <p className="px-4 py-1.5 text-[11px] text-ink-700">
                {hidden.toLocaleString("en-US")} older lines hidden — showing the newest {MAX_ROWS}
              </p>
            ) : null}
            {rows.map((entry, index) => (
              <Row key={`${entry.at}-${index}`} entry={entry} names={names} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ entry, names }: { entry: LogEntry; names: Map<string, string> }): JSX.Element {
  const look = LEVEL_LOOK[entry.level];
  const source = entry.serviceId ?? HOST;
  return (
    <div className={`flex gap-3 border-l-2 px-4 py-1 ${look.row}`}>
      <span className="num shrink-0 text-[11px] text-ink-700">{clock(entry.at)}</span>
      <span
        className="w-[104px] shrink-0 truncate text-[11px] text-ink-500"
        title={entry.serviceId === null ? "The host itself" : (names.get(source) ?? source)}
      >
        {source}
      </span>
      <span className={`w-9 shrink-0 text-[10px] tracking-wide uppercase ${look.tag}`}>{entry.level}</span>
      <span className={`min-w-0 flex-1 text-[12px] leading-relaxed break-words whitespace-pre-wrap ${look.text}`}>
        {entry.message}
      </span>
    </div>
  );
}

function FilterPill({
  children,
  active,
  onClick,
}: {
  children: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border px-3.5 py-2 text-[12px] font-medium transition-colors ${
        active
          ? "border-jade-500/40 bg-jade-500/12 text-jade-300"
          : "border-white/8 text-ink-500 hover:border-white/14 hover:text-ink-300"
      }`}
    >
      {children}
    </button>
  );
}

/** 24-uurs klok zonder datum: een logvenster gaat over de laatste minuten, niet over vorige week. */
const clock = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour12: false });
