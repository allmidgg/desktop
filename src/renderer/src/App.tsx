import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppSnapshot, Settings, UploadStatus } from "../../shared/types";
import { MerkGeslepen } from "./merk";
import { LiveView } from "./views/LiveView";
import { ProfileView } from "./views/ProfileView";
import { RunesView } from "./views/RunesView";
import { MasteriesView } from "./views/MasteriesView";
import { MetaView } from "./views/MetaView";
import { OverlayView } from "./views/OverlayView";
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
const venster = window.location.hash.replace("#", "");
const isChampSelectWindow = venster === "champselect";
const isOverlayWindow = venster === "overlay";

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);

  useEffect(() => {
    void window.jade.getSnapshot().then(setSnapshot);
    return window.jade.onSnapshot(setSnapshot);
  }, []);

  if (isOverlayWindow) return <OverlayView snapshot={snapshot} />;
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
          {/* De key is het hele punt: wisselt hij, dan hangt React de oude
              boom af en zet een nieuwe neer, en dan speelt de animatie opnieuw
              af. Zonder key blijft het dezelfde node en gebeurt er niets. */}
          <div key={tab} className="tabwissel">
          {!snapshot ? null : tab === "live" ? (
            <LiveView snapshot={snapshot} onNavigate={setTab} />
          ) : tab === "meta" ? (
            <MetaView snapshot={snapshot} />
          ) : tab === "profile" ? (
            <ProfileView snapshot={snapshot} />
          ) : tab === "runes" ? (
            <RunesView snapshot={snapshot} />
          ) : (
            <MasteriesView snapshot={snapshot} />
          )}
          </div>
        </main>
      </div>
    </div>
  );
}

function TitleBar({ snapshot }: { snapshot: AppSnapshot | null }): JSX.Element {
  const connected = snapshot?.connection === "connected";
  return (
    <header className="drag titelbalk relative z-10 flex shrink-0 items-center pr-2">
      {/* The emblem stands over the rail instead of inside it. In the mock-up
          the rail runs to x=721 and its centre is x=689, and the mark's ink is
          centred on x=689.0 -- so the left edge of the window reads as one
          column rather than two blocks stacked on each other. Same SVG as the
          tray, the splash and the empty screens; only the place changed. */}
      <div className="grid shrink-0 place-items-center" style={{ width: "var(--rail-breedte)" }}>
        <MerkGeslepen size={46} />
      </div>

      {/* The lockup: name above, mode below, both gold. Colouring only MID made
          the eye split one name into two words, and the design wants a single
          object sitting on the rail. */}
      <div className="flex flex-col justify-center pl-1">
        <span className="woordmerk">ALLMID</span>
        <span className="woordmerk-sub">League Classic</span>
      </div>

      {/* Pinned to the top of the bar rather than centred in it. The bar grew
          to hold the emblem, but the drawing keeps this cluster where a window's
          controls belong -- its glyph centres sit 28px down a 72px bar, which is
          the top-aligned 44px button row and not the middle of the header. */}
      <div className="ml-auto flex items-center gap-4 self-start pt-1.5">
        {snapshot ? <UpdateBadge update={snapshot.update} /> : null}
        {snapshot ? <SharingBadge upload={snapshot.upload} /> : null}
        {snapshot ? <AppMenu settings={snapshot.settings} /> : null}

        {/* Once the Riot ID is on screen you are connected, so a lamp beside it
            says the same thing twice and the mock-up leaves it out. It comes
            back only when there is no client, which is the one moment the lamp
            carries news. The games counter left the bar entirely: it was the
            only thing here that changed by itself, and the number already lives
            in the sharing popover under "Shared so far". */}
        <div className="flex items-center gap-2 text-[12px]">
          {connected ? null : <span className="h-1.5 w-1.5 rounded-full bg-ink-700" />}
          <span className={connected ? "text-ink-100" : "text-ink-500"}>
            {connected ? (snapshot?.summoner?.riotId ?? "connected") : (snapshot?.error ?? "connecting...")}
          </span>
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
 * De update-melding. Alleen zichtbaar als er iets te melden valt.
 *
 * Downloaden gebeurt vanzelf, installeren nooit. Dit is een app die in de tray
 * leeft en dus zelden afgesloten wordt -- de standaard "installeer bij het
 * afsluiten" zou betekenen dat de update maanden blijft liggen. Dus staat hier
 * een knop, en jij kiest het moment.
 */
function UpdateBadge({ update }: { update: AppSnapshot["update"] }): JSX.Element | null {
  const [bezig, setBezig] = useState(false);

  // Niets aan de hand is niets te zeggen. Een groen vinkje "je bent up to date"
  // is ruis in een titelbalk die al vol staat.
  if (update.fase === "uit" || update.fase === "actueel" || update.fase === "kijken") return null;

  if (update.fase === "downloaden") {
    return (
      <span className="num flex items-center gap-2 text-[11px] text-ink-600" title={`Downloading ${update.versie ?? "update"}`}>
        <span className="h-1.5 w-1.5 animate-pulse-ring rounded-full bg-gold-400" />
        Updating {update.voortgang}%
      </span>
    );
  }

  if (update.fase === "fout") {
    return (
      <span className="text-[11px] text-ink-600" title={update.fout ?? "Update failed"}>
        Update failed
      </span>
    );
  }

  // klaar
  return (
    <button
      onClick={() => {
        setBezig(true);
        void window.jade.installUpdate();
      }}
      disabled={bezig}
      title={`Version ${update.versie ?? ""} is downloaded. Installing restarts AllMid.`}
      className="no-drag flex items-center gap-1.5 rounded-lg border border-gold-400/40 bg-gold-400/10 px-2 py-1 text-[11px] font-medium text-gold-300 transition-colors hover:bg-gold-400/20 disabled:opacity-50"
    >
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2v8" /><path d="m4.5 7 3.5 3.5L11.5 7" /><path d="M3 13.5h10" />
      </svg>
      {bezig ? "Restarting..." : `Update to ${update.versie ?? "new version"}`}
    </button>
  );
}

/**
 * The app-level switches: how AllMid behaves when you are not looking at it.
 *
 * These live in the title bar rather than on a page because they are not about
 * League -- they are about the program. Three of them, and the third only means
 * anything with the second on, so it is indented under it and disabled without.
 */
function AppMenu({ settings }: { settings: Settings }): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const zet = (patch: Partial<Settings>): void => {
    void window.jade.updateSettings(patch);
  };

  return (
    <div className="no-drag relative" ref={box}>
      {/* Gold and box-free at rest. In the mock-up this icon measures 15 CSS px
          across and samples at (194,154,89), which is gold-500 to the digit --
          it is one of the three warm marks that carry the brand across the bar,
          not a grey utility button parked next to them. */}
      <button
        onClick={() => setOpen(!open)}
        title="Settings"
        aria-label="Settings"
        className={`flex items-center rounded-lg p-1 transition-colors ${
          open ? "bg-white/8 text-gold-300" : "text-gold-500 hover:bg-white/5 hover:text-gold-300"
        }`}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
        </svg>
      </button>

      {open ? (
        <div className="absolute top-full right-0 z-50 mt-1.5 w-72 rounded-xl border border-line bg-surface p-3 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.9)]">
          <p className="mb-2.5 text-[10px] tracking-[0.14em] text-ink-600 uppercase">Behaviour</p>

          <Schakelaar
            aan={settings.sluitNaarTray}
            onClick={() => zet({ sluitNaarTray: !settings.sluitNaarTray })}
            titel="Close to tray"
            uitleg="The X hides AllMid instead of quitting, so it can still catch your next champion select. Quit from the tray icon."
          />

          <Schakelaar
            aan={settings.startMetWindows}
            onClick={() => zet({ startMetWindows: !settings.startMetWindows })}
            titel="Start with Windows"
            uitleg="Launches on sign-in so it is already there when you open League."
          />

          <div className={settings.startMetWindows ? "pl-5" : "pl-5 opacity-40"}>
            <Schakelaar
              aan={settings.startVerborgen}
              onClick={() => settings.startMetWindows && zet({ startVerborgen: !settings.startVerborgen })}
              titel="Start hidden"
              uitleg="Come up as a tray icon only, with no window."
              uit={!settings.startMetWindows}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Eén rij in het menu: schakelaar, titel, en waarom je hem zou willen. */
function Schakelaar({
  aan,
  onClick,
  titel,
  uitleg,
  uit,
}: {
  aan: boolean;
  onClick: () => void;
  titel: string;
  uitleg: string;
  uit?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={uit}
      className="mb-2 flex w-full gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-white/[0.04] disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          aan ? "bg-gold-400/80" : "bg-ink-800"
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full bg-surface transition-transform ${aan ? "translate-x-3" : ""}`}
        />
      </span>
      <span>
        <span className="block text-[12px] font-medium text-ink-200">{titel}</span>
        <span className="block text-[11px] leading-snug text-ink-600">{uitleg}</span>
      </span>
    </button>
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

  // The pill keeps its shape through every state and only changes temperature,
  // so the bad news lands where the good news does and nothing in the bar moves
  // sideways when an upload fails.
  const pil = !upload.enabled ? "deelpil-uit" : failing ? "deelpil-fout" : "";

  // The lamp is an outline rather than a disc: the mock-up ring measures 10 CSS
  // px across with a dark centre, and an outline reads as a status light where a
  // filled dot reads as a bullet.
  const stip = !upload.enabled
    ? "text-ink-700"
    : upload.busy
      ? "animate-pulse-ring text-gold-400"
      : failing
        ? "text-loss-400"
        : "text-jade-400";

  return (
    <div className="no-drag relative" ref={box}>
      <button
        onClick={() => setOpen(!open)}
        title="Match data sharing"
        className={`deelpil ${pil} ${open ? "ring-1 ring-white/15" : ""}`}
      >
        <span className={`deel-stip ${stip}`} />
        <span>
          {!upload.enabled
            ? "Not sharing"
            : upload.busy
              ? "Sharing..."
              : failing
                ? "Sharing paused"
                : "Sharing"}
        </span>
      </button>

      {open ? (
        <div className="panel panel-zwevend absolute top-[calc(100%+8px)] right-0 z-30 w-[340px] p-4 text-left">
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
      className={`grid h-11 w-12 place-items-center text-ink-300 transition-colors ${
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
    <nav
      className="rail relative z-10 flex shrink-0 flex-col items-center overflow-hidden pt-2"
      style={{ width: "var(--rail-breedte)" }}
    >
      {/* Dezelfde toren als op het installatiescherm: wie de app installeert
          ziet hem daar, en herkent hem hier terug. */}
      <img src="/merk/rail-toren.png" alt="" aria-hidden="true" className="rail-toren" />

      {/* The mark used to sit here and now stands in the title bar, on this
          rail's own centre line, so that emblem and wordmark form one lockup
          instead of the mark hanging under its own name. */}
      {TABS.map((entry) => {
        const active = tab === entry.id;
        return (
          <button
            key={entry.id}
            onClick={() => onSelect(entry.id)}
            className={`rail-item group relative z-10 flex w-full flex-col items-center justify-center gap-1.5 transition-colors ${
              active ? "rail-item-aan text-gold-300" : "rail-item-uit"
            }`}
          >
            {/* Three marks, one state. The bar owns the left edge, the two
                lozenges pin the item to the rail's divider, and together they
                say "this tab is the surface you are standing on" -- which a
                colour change on its own never managed. */}
            {active ? (
              <>
                <span className="rail-aan" />
                <span className="rail-ruit rail-ruit-boven" />
                <span className="rail-ruit rail-ruit-onder" />
              </>
            ) : null}
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinejoin="round"
              className={active ? "rail-icoon-aan" : undefined}
            >
              <path d={entry.icon} />
            </svg>
            <span className="text-[12px] font-medium">{entry.label}</span>
            {entry.id === "live" && hasChampSelect && !active ? (
              <span className="absolute top-3 right-3.5 h-1.5 w-1.5 rounded-full bg-gold-400" />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
