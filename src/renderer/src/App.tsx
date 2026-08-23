import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppSnapshot, UploadStatus } from "../../shared/types";
import { LiveView } from "./views/LiveView";
import { ProfileView } from "./views/ProfileView";
import { RunesView } from "./views/RunesView";
import { MasteriesView } from "./views/MasteriesView";
import { MetaView } from "./views/MetaView";
import { ChampSelectView } from "./views/ChampSelectView";
import { Spinner } from "./ui";

type Tab = "live" | "meta" | "profile" | "runes" | "masteries";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "live", label: "Live", icon: "M12 2 3 7v10l9 5 9-5V7z" },
  { id: "meta", label: "Meta", icon: "M4 20V10m5 10V4m5 16v-7m5 7V7" },
  { id: "profile", label: "Profile", icon: "M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm-9 9a9 9 0 0 1 18 0Z" },
  { id: "runes", label: "Runes", icon: "M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1z" },
  { id: "masteries", label: "Masteries", icon: "M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z" },
];

/** Both windows load the same bundle; the hash decides which one this is. */
const isChampSelectWindow = window.location.hash.replace("#", "") === "champselect";

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);

  useEffect(() => {
    void window.jade.getSnapshot().then(setSnapshot);
    return window.jade.onSnapshot(setSnapshot);
  }, []);

  if (isChampSelectWindow) return <ChampSelectWindow snapshot={snapshot} />;
  return <MainWindow snapshot={snapshot} />;
}

/**
 * The popup: nothing but the scout, floating above the client.
 *
 * The title bar spans the full width of the window and is the drag handle, so
 * you can grab it anywhere along the top edge the way any other window works.
 */
function ChampSelectWindow({ snapshot }: { snapshot: AppSnapshot | null }): JSX.Element {
  const database = snapshot?.database;
  return (
    <div className="app-backdrop relative flex h-full flex-col">
      <header className="drag flex h-10 shrink-0 items-center justify-between border-b border-line pr-1 pl-4">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold tracking-tight">
            All<span className="text-gold-400">Mid</span>
          </span>
          <span className="text-[10px] tracking-[0.16em] text-ink-700 uppercase">
            Champion Select
          </span>
          {database?.community || (database && database.matches > 0) ? (
            <span className="num text-[10px] text-ink-700">
              {(database.community?.games ?? database.matches).toLocaleString("en-US")} games
              {database.crawling ? " · syncing" : ""}
            </span>
          ) : null}
        </div>
        <div className="no-drag flex items-center">
          <button
            onClick={() => window.jade.minimize()}
            className="grid h-10 w-11 place-items-center text-ink-500 transition-colors hover:bg-white/8 hover:text-ink-100"
            title="Minimise"
          >
            <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M4 9h10" />
            </svg>
          </button>
          <button
            onClick={() => window.jade.close()}
            className="grid h-10 w-11 place-items-center text-ink-500 transition-colors hover:bg-loss-500 hover:text-white"
            title="Hide"
          >
            <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M4.5 4.5l9 9m0-9l-9 9" />
            </svg>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {snapshot?.champSelect ? (
          <ChampSelectView snapshot={snapshot} compact />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner label="Waiting for champion select..." />
          </div>
        )}
      </div>
    </div>
  );
}

function MainWindow({ snapshot }: { snapshot: AppSnapshot | null }): JSX.Element {
  const [tab, setTab] = useState<Tab>("live");
  const inChampSelect = Boolean(snapshot?.champSelect);

  // Champion select is almost always what you want to look at.
  useEffect(() => {
    if (inChampSelect) setTab("live");
  }, [inChampSelect]);

  return (
    <div className="app-backdrop relative flex h-full flex-col">
      <TitleBar snapshot={snapshot} />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar tab={tab} onSelect={setTab} hasChampSelect={inChampSelect} />
        <main className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          {!snapshot ? null : tab === "live" ? (
            <LiveView snapshot={snapshot} />
          ) : tab === "meta" ? (
            <MetaView snapshot={snapshot} />
          ) : tab === "profile" ? (
            <ProfileView snapshot={snapshot} />
          ) : tab === "runes" ? (
            <RunesView snapshot={snapshot} />
          ) : (
            <MasteriesView snapshot={snapshot} />
          )}
        </main>
      </div>
    </div>
  );
}

function TitleBar({ snapshot }: { snapshot: AppSnapshot | null }): JSX.Element {
  const connected = snapshot?.connection === "connected";
  const database = snapshot?.database;
  return (
    <header className="drag relative z-10 flex h-11 shrink-0 items-center justify-between border-b border-line pr-1 pl-5">
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-semibold tracking-tight">
          All<span className="text-gold-400">Mid</span>
        </span>
        <span className="text-[11px] tracking-[0.16em] text-ink-700 uppercase">League Classic</span>
      </div>

      <div className="flex items-center gap-4">
        {database?.community || (database && database.matches > 0) ? (
          <span
            className="num text-[11px] text-ink-700"
            title={
              database.community
                ? `${database.community.games.toLocaleString("en-US")} shared games from ${database.community.players.toLocaleString("en-US")} players, collected up to ${new Date(database.community.newestGame).toLocaleString()}. You have crawled ${database.matches.toLocaleString("en-US")} yourself; those are already included.`
                : "Games in your local Classic database"
            }
          >
            {(database.community?.games ?? database.matches).toLocaleString("en-US")} games
            {database.community ? " shared" : ""}
            {database.crawling ? " · syncing" : ""}
          </span>
        ) : null}
        {snapshot ? <SharingBadge upload={snapshot.upload} /> : null}
        <div className="flex items-center gap-2 text-[11px] text-ink-500">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected ? "animate-pulse-ring bg-jade-500" : "bg-ink-700"
            }`}
          />
          {connected ? (snapshot?.summoner?.riotId ?? "connected") : (snapshot?.error ?? "connecting...")}
        </div>
        <div className="no-drag flex items-center">
          <WindowButton onClick={() => window.jade.minimize()} path="M4 9h10" />
          <WindowButton onClick={() => window.jade.maximize()} path="M4.5 4.5h9v9h-9z" />
          <WindowButton onClick={() => window.jade.close()} path="M4.5 4.5l9 9m0-9l-9 9" danger />
        </div>
      </div>
    </header>
  );
}

/**
 * The sharing indicator, and the switch behind it.
 *
 * It sits in the title bar of every screen on purpose. The app sends match data
 * to a shared server, and the one thing people rightly hate about software like
 * this is that it does so quietly. So the state is always on screen — on or off,
 * how much has gone out, when it last ran, and what went wrong if anything did.
 *
 * The details, including the off switch, are one click away rather than always
 * expanded: permanently visible, never in the way.
 */
function SharingBadge({ upload }: { upload: UploadStatus }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Clicking anywhere else closes it, the way a menu is expected to behave.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function toggle(): Promise<void> {
    setBusy(true);
    await window.jade.updateSettings({ shareMatches: !upload.enabled });
    setBusy(false);
  }

  async function shareNow(): Promise<void> {
    setBusy(true);
    await window.jade.uploadNow();
    setBusy(false);
  }

  const failing = Boolean(upload.error) && upload.enabled;
  const dot = !upload.enabled
    ? "bg-ink-700"
    : upload.busy
      ? "animate-pulse-ring bg-gold-400"
      : failing
        ? "bg-loss-500"
        : "bg-jade-500";

  return (
    <div className="no-drag relative" ref={box}>
      <button
        onClick={() => setOpen(!open)}
        title="Match data sharing"
        className={`flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] transition-colors ${
          open ? "bg-white/8 text-ink-100" : "text-ink-500 hover:bg-white/5 hover:text-ink-300"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span>
          {!upload.enabled
            ? "not sharing"
            : upload.busy
              ? "sharing..."
              : failing
                ? "sharing paused"
                : "sharing"}
        </span>
        {upload.enabled && upload.shared > 0 ? (
          <span className="num text-ink-700">{upload.shared.toLocaleString("en-US")}</span>
        ) : null}
      </button>

      {open ? (
        <div className="panel absolute top-[calc(100%+8px)] right-0 z-30 w-[340px] p-4 text-left">
          <label
            className={`flex cursor-pointer items-start gap-2.5 ${busy ? "opacity-60" : ""}`}
          >
            <input
              type="checkbox"
              checked={upload.enabled}
              onChange={() => void toggle()}
              disabled={busy}
              className="mt-0.5 h-3.5 w-3.5 accent-gold-400"
            />
            <span>
              <span className="text-[12px] font-medium text-ink-100">Share collected matches</span>
              <span className="mt-1 block text-[11px] leading-relaxed text-ink-500">
                Games the crawler finds are sent to the shared pool, so everyone&rsquo;s stats get
                better. Only match results — the same ones all ten players see after the game.
              </span>
            </span>
          </label>

          <dl className="mt-3.5 space-y-1.5 border-t border-line pt-3 text-[11px]">
            <Row label="Shared so far">
              <span className="num">{upload.shared.toLocaleString("en-US")} games</span>
            </Row>
            <Row label="Waiting to go out">
              <span className="num">{upload.pending.toLocaleString("en-US")} games</span>
            </Row>
            <Row label="Last run">
              {upload.busy ? (
                <span className="text-gold-300">right now</span>
              ) : (
                <span>{relativeTime(upload.lastRunAt)}</span>
              )}
            </Row>
            {upload.lastUploaded > 0 ? (
              <Row label="Added last run">
                <span className="num text-jade-400">
                  +{upload.lastUploaded.toLocaleString("en-US")}
                </span>
              </Row>
            ) : null}
            {upload.serverTotal !== null ? (
              <Row label="Pool size">
                <span className="num">{upload.serverTotal.toLocaleString("en-US")} games</span>
              </Row>
            ) : null}
            <Row label="Server">
              <span className="truncate text-ink-300" title={upload.server || "not set"}>
                {upload.server || "not set"}
              </span>
            </Row>
          </dl>

          {/* A server that is down is not an error the user has to act on: nothing
              is lost, it simply goes out later. So it reads as a note, not an alarm. */}
          {upload.error && upload.enabled ? (
            <p className="mt-3 rounded-lg border border-loss-500/30 bg-loss-500/8 px-2.5 py-2 text-[11px] leading-relaxed text-loss-400">
              {upload.error} Nothing is lost — it will be offered again automatically.
            </p>
          ) : null}

          {upload.enabled ? (
            <button
              onClick={() => void shareNow()}
              disabled={busy || upload.busy}
              className="mt-3 w-full rounded-lg border border-white/10 py-1.5 text-[11px] font-medium text-ink-300 transition-colors hover:border-white/20 hover:text-ink-100 disabled:opacity-50"
            >
              {upload.busy ? "Sharing..." : "Share now"}
            </button>
          ) : (
            <p className="mt-3 text-[11px] leading-relaxed text-ink-700">
              Off — nothing leaves your machine. The stats you see stay whatever your own crawler
              collected.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-700">{label}</dt>
      <dd className="min-w-0 text-right text-ink-300">{children}</dd>
    </div>
  );
}

/** Short, human times: "4 min ago" says more here than a timestamp. */
function relativeTime(at: number | null): string {
  if (at === null) return "not yet";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function WindowButton({
  onClick,
  path,
  danger = false,
}: {
  onClick: () => void;
  path: string;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`grid h-11 w-12 place-items-center text-ink-500 transition-colors ${
        danger ? "hover:bg-loss-500 hover:text-white" : "hover:bg-white/8 hover:text-ink-100"
      }`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.2">
        <path d={path} />
      </svg>
    </button>
  );
}

function Sidebar({
  tab,
  onSelect,
  hasChampSelect,
}: {
  tab: Tab;
  onSelect: (tab: Tab) => void;
  hasChampSelect: boolean;
}): JSX.Element {
  return (
    <nav className="relative z-10 flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line py-5">
      {TABS.map((entry) => {
        const active = tab === entry.id;
        return (
          <button
            key={entry.id}
            onClick={() => onSelect(entry.id)}
            className={`group relative flex w-full flex-col items-center gap-1.5 py-3 transition-colors ${
              active ? "text-gold-300" : "text-ink-500 hover:text-ink-300"
            }`}
          >
            {active ? (
              <span className="absolute top-1/2 left-0 h-7 w-[2px] -translate-y-1/2 rounded-r bg-gold-400" />
            ) : null}
            <svg
              width="21"
              height="21"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            >
              <path d={entry.icon} />
            </svg>
            <span className="text-[10px] font-medium tracking-wide">{entry.label}</span>
            {entry.id === "live" && hasChampSelect && !active ? (
              <span className="absolute top-2.5 right-4 h-1.5 w-1.5 rounded-full bg-gold-400" />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
