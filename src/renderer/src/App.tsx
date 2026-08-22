import { useEffect, useState } from "react";
import type { AppSnapshot } from "../../shared/types";
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
      <header className="drag flex h-10 shrink-0 items-center justify-between border-b border-white/6 pr-1 pl-4">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold tracking-tight">
            All<span className="text-jade-400">Mid</span>
          </span>
          <span className="text-[10px] tracking-[0.16em] text-ink-700 uppercase">
            Champion Select
          </span>
          {database && database.matches > 0 ? (
            <span className="num text-[10px] text-ink-700">
              {database.matches.toLocaleString("en-US")} games
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
    <header className="drag relative z-10 flex h-11 shrink-0 items-center justify-between border-b border-white/6 pr-1 pl-5">
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-semibold tracking-tight">
          All<span className="text-jade-400">Mid</span>
        </span>
        <span className="text-[11px] tracking-[0.16em] text-ink-700 uppercase">League Classic</span>
      </div>

      <div className="flex items-center gap-4">
        {database && database.matches > 0 ? (
          <span className="num text-[11px] text-ink-700" title="Games in your local Classic database">
            {database.matches.toLocaleString("en-US")} games{database.crawling ? " · syncing" : ""}
          </span>
        ) : null}
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
    <nav className="relative z-10 flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-white/6 py-5">
      {TABS.map((entry) => {
        const active = tab === entry.id;
        return (
          <button
            key={entry.id}
            onClick={() => onSelect(entry.id)}
            className={`group relative flex w-full flex-col items-center gap-1.5 py-3 transition-colors ${
              active ? "text-jade-300" : "text-ink-500 hover:text-ink-300"
            }`}
          >
            {active ? (
              <span className="absolute top-1/2 left-0 h-7 w-[2px] -translate-y-1/2 rounded-r bg-jade-400" />
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
              <span className="absolute top-2.5 right-4 h-1.5 w-1.5 rounded-full bg-jade-400" />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
