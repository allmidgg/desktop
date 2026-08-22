/**
 * De schil van de Server Manager: titelbalk, statusbalk, navigatie en de plek
 * waar een scherm getekend wordt.
 *
 * De schermen zelf staan in ./views en worden hier niet met de hand
 * geïmporteerd. Reden: ze worden apart gebouwd en de app moet altijd opengaan --
 * ook als er eentje nog niet af is. Wat er wél is wordt gevonden, de rest krijgt
 * een nette lege plek in plaats van een wit venster.
 */
import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { ManagerSnapshot } from "../../../shared/types";
import {
  Badge,
  Button,
  CopyButton,
  Divider,
  EmptyState,
  Mono,
  Spinner,
  formatCount,
  formatUptime,
} from "./ui";

declare global {
  interface ImportMeta {
    /** Vite's glob-import. Zelf getypeerd omdat we vite/client hier niet meenemen. */
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

/** Wat elk scherm binnenkrijgt. Meer heeft geen scherm nodig: de rest zit in window.manager. */
export interface ViewProps {
  snapshot: ManagerSnapshot;
}

type ViewComponent = ComponentType<ViewProps>;

type TabId = "services" | "data" | "logs" | "settings";

interface TabDef {
  id: TabId;
  label: string;
  /** 24x24 SVG-pad. */
  icon: string;
  /** Bestandsnamen in ./views waar dit scherm in kan staan, meest waarschijnlijke eerst. */
  files: string[];
}

const TABS: TabDef[] = [
  {
    id: "services",
    label: "Services",
    icon: "M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01",
    files: ["ServicesView", "Services"],
  },
  {
    id: "data",
    label: "Data",
    icon: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    files: ["DataView", "Data"],
  },
  {
    id: "logs",
    label: "Logs",
    icon: "M5 4h14v16H5zM8.5 9h7M8.5 12.5h7M8.5 16h4",
    files: ["LogsView", "Logs"],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
    files: ["SettingsView", "Settings"],
  },
];

const VIEW_MODULES = import.meta.glob<Record<string, unknown>>("./views/*.tsx", { eager: true });

/**
 * Zoekt de component die bij een tabblad hoort. Een scherm mag zichzelf onder
 * zijn eigen naam exporteren of als default -- allebei komt in deze codebase voor.
 */
function resolveView(files: string[]): ViewComponent | null {
  for (const file of files) {
    const module = VIEW_MODULES[`./views/${file}.tsx`];
    if (!module) continue;
    for (const candidate of [module[file], module.default, ...Object.values(module)]) {
      if (typeof candidate === "function") return candidate as ViewComponent;
    }
  }
  return null;
}

const VIEWS: Record<TabId, ViewComponent | null> = {
  services: resolveView(TABS[0]?.files ?? []),
  data: resolveView(TABS[1]?.files ?? []),
  logs: resolveView(TABS[2]?.files ?? []),
  settings: resolveView(TABS[3]?.files ?? []),
};

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<ManagerSnapshot | null>(null);
  const [tab, setTab] = useState<TabId>("services");

  useEffect(() => {
    void window.manager.getSnapshot().then(setSnapshot);
    return window.manager.onSnapshot(setSnapshot);
  }, []);

  // Ctrl+1 tot Ctrl+4: wie de hele dag in dit venster zit wil niet klikken.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      const index = Number.parseInt(event.key, 10) - 1;
      const target = TABS[index];
      if (!target) return;
      event.preventDefault();
      setTab(target.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const View = VIEWS[tab];
  const label = TABS.find((entry) => entry.id === tab)?.label ?? "";

  return (
    <div className="app-backdrop relative flex h-full flex-col">
      <TitleBar />
      <StatusBar snapshot={snapshot} />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar tab={tab} snapshot={snapshot} onSelect={setTab} />
        <main key={tab} className="animate-rise min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {!snapshot ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Reading the host..." />
            </div>
          ) : View ? (
            <View snapshot={snapshot} />
          ) : (
            <EmptyState
              title={`${label} is not part of this build`}
              hint="This screen is missing from the bundle. The rest of the manager keeps working."
            />
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * De eigen titelbalk. De hele balk is sleepgebied -- ook de lege ruimte tussen de
 * naam en de knoppen -- zodat het venster zich gedraagt als elk ander venster.
 */
function TitleBar(): JSX.Element {
  return (
    <header className="drag relative z-20 flex h-11 shrink-0 items-center justify-between border-b border-white/6 pr-1 pl-4">
      <div className="flex items-center gap-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 5h16v5H4zM4 14h16v5H4z" className="text-jade-400" />
          <path d="M7.5 7.5h.01M7.5 16.5h.01" className="text-jade-400" strokeLinecap="round" />
        </svg>
        <span className="text-[14px] font-semibold tracking-tight">
          server<span className="text-jade-400">.manager</span>
        </span>
        <span className="text-[10px] tracking-[0.16em] text-ink-700 uppercase">Game Host</span>
      </div>
      <div className="no-drag flex items-center">
        <WindowButton onClick={() => window.manager.minimize()} path="M4 9h10" title="Minimise" />
        <WindowButton
          onClick={() => window.manager.maximize()}
          path="M4.5 4.5h9v9h-9z"
          title="Maximise"
        />
        <WindowButton
          onClick={() => window.manager.close()}
          path="M4.5 4.5l9 9m0-9l-9 9"
          title="Close"
          danger
        />
      </div>
    </header>
  );
}

function WindowButton({
  onClick,
  path,
  title,
  danger = false,
}: {
  onClick: () => void;
  path: string;
  title: string;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
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

/**
 * De statusbalk: waar luistert de host, hoeveel services draaien er, hoeveel
 * verzoeken zijn er binnengekomen. Dit zijn de drie dingen die je wilt weten
 * zonder ergens heen te klikken, dus staan ze boven élk scherm.
 */
function StatusBar({ snapshot }: { snapshot: ManagerSnapshot | null }): JSX.Element {
  const host = snapshot?.host;
  const services = snapshot?.services ?? [];
  const running = services.filter((service) => service.status === "running").length;
  const failed = services.filter((service) => service.status === "error").length;
  const listening = host?.listening ?? false;
  const baseUrl = `http://localhost:${host?.port ?? 0}`;

  return (
    <div className="relative z-10 flex h-9 shrink-0 items-center gap-3 border-b border-white/6 bg-white/[0.015] px-4 text-[11px]">
      <span className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            listening ? "animate-pulse-ring bg-jade-500" : host?.error ? "bg-loss-500" : "bg-ink-700"
          }`}
        />
        <span className={listening ? "text-ink-100" : "text-ink-500"}>
          {listening ? (
            <>
              Listening on port <span className="num font-mono text-jade-300">{host?.port}</span>
            </>
          ) : (
            (host?.error ?? "Host stopped")
          )}
        </span>
      </span>

      <Divider />
      <span className="num text-ink-500">
        Uptime <span className="text-ink-300">{formatUptime(host?.uptimeSeconds ?? 0)}</span>
      </span>

      <Divider />
      <span className="num text-ink-500">
        Services{" "}
        <span className={running > 0 ? "text-jade-300" : "text-ink-300"}>
          {running}/{services.length}
        </span>
      </span>
      {failed > 0 ? <Badge tone="bad">{failed} failed</Badge> : null}

      <Divider />
      <span className="num text-ink-500">
        Requests <span className="text-ink-300">{formatCount(host?.totalRequests ?? 0)}</span>
      </span>

      <div className="flex-1" />

      <Mono className="text-ink-500">{baseUrl}</Mono>
      <CopyButton value={baseUrl} title="Copy base URL" />
      <Button
        variant={listening ? "default" : "primary"}
        onClick={() => void (listening ? window.manager.stopHost() : window.manager.startHost())}
        title={listening ? "Stop accepting requests" : "Start listening"}
      >
        {listening ? "Stop host" : "Start host"}
      </Button>
    </div>
  );
}

function Sidebar({
  tab,
  snapshot,
  onSelect,
}: {
  tab: TabId;
  snapshot: ManagerSnapshot | null;
  onSelect: (tab: TabId) => void;
}): JSX.Element {
  const counts: Record<TabId, number | null> = {
    services: snapshot?.services.length ?? null,
    data: snapshot?.services.reduce((total, service) => total + (service.summary?.records ?? 0), 0) ?? null,
    logs: snapshot?.logs.length ?? null,
    settings: null,
  };

  return (
    <nav className="relative z-10 flex w-[184px] shrink-0 flex-col border-r border-white/6 p-2">
      {TABS.map((entry) => {
        const active = tab === entry.id;
        const count = counts[entry.id];
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelect(entry.id)}
            className={`group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors ${
              active ? "bg-white/[0.06] text-jade-300" : "text-ink-500 hover:bg-white/[0.03] hover:text-ink-300"
            }`}
          >
            {active ? (
              <span className="absolute top-1/2 -left-2 h-4 w-[2px] -translate-y-1/2 rounded-r bg-jade-400" />
            ) : null}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={entry.icon} />
            </svg>
            <span className="flex-1 text-[12px] font-medium">{entry.label}</span>
            {count === null ? null : (
              <span className="num text-[10px] text-ink-700">{formatCount(count)}</span>
            )}
          </button>
        );
      })}

      <div className="flex-1" />

      <button
        type="button"
        title={snapshot?.dataRoot}
        onClick={() => void window.manager.openDataFolder(null)}
        className="flex h-7 items-center gap-2 rounded-md px-2.5 text-[11px] text-ink-700 transition-colors hover:bg-white/[0.03] hover:text-ink-300"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 7h6l2 2h10v10H3z" strokeLinejoin="round" />
        </svg>
        Data folder
      </button>
    </nav>
  );
}
