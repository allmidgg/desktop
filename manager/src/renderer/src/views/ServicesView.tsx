/**
 * Het beheerscherm: de host bovenaan, daaronder een kaart per game-service.
 *
 * De hele opzet draait om één poort, dus dat is ook wat het scherm als eerste
 * vertelt: één adres, en het pad erachter bepaalt wie antwoordt. Zonder dat in
 * beeld lijkt "service gestopt" op "server plat", terwijl de host gewoon door
 * blijft luisteren en op dat pad een 503 teruggeeft.
 *
 * Om dezelfde reden staat pauze hier niet als een grijze uit-stand in beeld: een
 * gepauzeerde service is geladen en wel, hij laat alleen even niemand binnen.
 *
 * De view houdt zelf geen staat over services bij: alles komt uit de snapshot,
 * behalve wat er nu op een knop geklikt is. Zo staat er nooit een halve waarheid
 * in beeld.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  HostInfo, ManagerApi, ManagerSnapshot, ServiceActionResult, ServiceInfo, ServiceStatus,
} from "../../../../shared/types";

/**
 * Dezelfde declaratie als in main.tsx. Identiek herhalen mag van TypeScript en
 * maakt deze view los te compileren en te lezen: hier staat precies wat het
 * scherm van de buitenwereld nodig heeft.
 */
declare global {
  interface Window {
    manager: ManagerApi;
  }
}

type ServiceAction = "start" | "pause" | "resume" | "stop" | "restart";

const ACTIONS: Record<ServiceAction, (id: string) => Promise<ServiceActionResult>> = {
  start: (id) => window.manager.startService(id),
  pause: (id) => window.manager.pauseService(id),
  resume: (id) => window.manager.resumeService(id),
  stop: (id) => window.manager.stopService(id),
  restart: (id) => window.manager.restartService(id),
};

/**
 * Pauze moet op het eerste gezicht iets anders zijn dan offline.
 *
 * Grijs betekent hier "er is niets", en dat is precies wat een pauze níet is: de
 * service draait, houdt zijn data vast en komt terug. Daarom goud, net als bij
 * starting en stopping -- maar dan stil in plaats van kloppend, met een ring
 * eromheen. Kloppend goud zegt "even wachten, het gebeurt vanzelf"; stil goud met
 * ring zegt "dit blijft zo tot jij iets doet".
 */
const STATUS_LOOK: Record<ServiceStatus, { label: string; dot: string; pill: string }> = {
  running: { label: "Online", dot: "animate-pulse-ring bg-jade-500", pill: "border-jade-500/40 bg-jade-500/12 text-jade-300" },
  starting: { label: "Starting", dot: "animate-pulse bg-gold-400", pill: "border-gold-400/35 bg-gold-400/10 text-gold-300" },
  stopping: { label: "Stopping", dot: "animate-pulse bg-gold-400", pill: "border-gold-400/35 bg-gold-400/10 text-gold-300" },
  paused: {
    label: "Paused",
    dot: "bg-gold-400 ring-2 ring-gold-400/25",
    pill: "border-gold-400/60 bg-gold-400/18 text-gold-300",
  },
  stopped: { label: "Offline", dot: "bg-ink-700", pill: "border-white/10 bg-white/[0.04] text-ink-500" },
  error: { label: "Error", dot: "bg-loss-500", pill: "border-loss-500/45 bg-loss-500/12 text-loss-400" },
};

export function ServicesView({ snapshot }: { snapshot: ManagerSnapshot }): JSX.Element {
  const [pending, setPending] = useState<Record<string, ServiceAction>>({});
  const [results, setResults] = useState<Record<string, ServiceActionResult>>({});
  const now = useNow();

  const origin = `http://localhost:${snapshot.host.port}`;

  const run = useCallback(async (id: string, action: ServiceAction): Promise<void> => {
    // Per service bijgehouden, want start/stop/restart van A mag de knoppen van B niet blokkeren.
    setPending((current) => ({ ...current, [id]: action }));
    try {
      const result = await ACTIONS[action](id);
      setResults((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setResults((current) => ({ ...current, [id]: { ok: false, message: describe(error), service: null } }));
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  }, []);

  /**
   * De voorkeur zelf staat in de manager, niet hier: die start de services al bij
   * het openen. De schakelaar zet hem alleen om en wacht op de volgende snapshot,
   * zodat er nooit een stand in beeld staat die het main-proces niet kent.
   */
  const setAuto = useCallback((id: string, on: boolean): void => {
    void window.manager.setAutoStart(id, on);
  }, []);

  return (
    <div className="animate-rise space-y-6">
      <HostPanel host={snapshot.host} services={snapshot.services} dataRoot={snapshot.dataRoot} origin={origin} />

      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold tracking-[0.14em] text-ink-500 uppercase">Game services</h2>
          <span className="text-xs text-ink-500">
            {snapshot.services.length === 0
              ? "none registered"
              : `${snapshot.services.length} mounted on port ${snapshot.host.port}`}
          </span>
        </div>

        {snapshot.services.length === 0 ? (
          <NoServices />
        ) : (
          <div className="space-y-3">
            {snapshot.services.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                origin={origin}
                now={now}
                busy={pending[service.id]}
                result={results[service.id]}
                onAutoStart={setAuto}
                onAction={run}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * De host zelf: het adres, of hij luistert, en de knoppen die daarover gaan.
 *
 * ManagerApi kent alleen setPort(), geen los start/stop van de luisteraar.
 * Opnieuw binden op dezelfde poort is daarom "start listening"; kan het
 * main-proces wél stoppen, dan biedt het dat als extra functie aan en tasten we
 * dat hieronder af in plaats van het te eisen.
 */
type HostControls = { startHost?: () => Promise<unknown>; stopHost?: () => Promise<unknown> };

function HostPanel({
  host,
  services,
  dataRoot,
  origin,
}: {
  host: HostInfo;
  services: ServiceInfo[];
  dataRoot: string;
  origin: string;
}): JSX.Element {
  const [draft, setDraft] = useState<string>(String(host.port));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // De poort kan ook van buitenaf veranderen; het invoerveld volgt dan mee.
  useEffect(() => setDraft(String(host.port)), [host.port]);

  const port = Number.parseInt(draft, 10);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  const controls = window.manager as ManagerApi & HostControls;
  const canStopHost = typeof controls.stopHost === "function";

  const call = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage(label);
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const applyPort = (): void => {
    if (!validPort || port === host.port) return;
    void call(`Now listening on port ${port}.`, () => window.manager.setPort(port));
  };

  const startHost = (): void => {
    const starter = controls.startHost;
    // Zonder eigen start-functie is opnieuw binden op dezelfde poort hetzelfde resultaat.
    void call("Listener started.", starter ? () => starter() : () => window.manager.setPort(host.port));
  };

  const stopHost = (): void => {
    const stopper = controls.stopHost;
    if (!stopper) return;
    void call("Listener stopped. Services keep running.", () => stopper());
  };

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-6 p-5">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[0.16em] text-ink-700 uppercase">HTTP host</p>
          <div className="mt-1.5 flex items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${host.listening ? "animate-pulse-ring bg-jade-500" : "bg-ink-700"}`} />
            <span className="num text-lg font-medium">{origin}</span>
            <span
              className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                host.listening
                  ? "border-jade-500/40 bg-jade-500/12 text-jade-300"
                  : "border-white/10 bg-white/[0.04] text-ink-500"
              }`}
            >
              {host.listening ? "Listening" : "Not listening"}
            </span>
          </div>
          <p className="mt-2 max-w-xl text-[12px] leading-relaxed text-ink-500">
            Every service shares this one port. The path after it decides who answers, so opening a single
            port is enough — even when more games are added later.
          </p>
        </div>

        <div className="flex flex-col items-end gap-2.5">
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-ink-500" htmlFor="host-port">
              Port
            </label>
            <input
              id="host-port"
              value={draft}
              inputMode="numeric"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyPort();
              }}
              className={`num w-[86px] rounded-lg border bg-white/[0.03] px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-jade-500/40 ${
                validPort ? "border-white/10" : "border-loss-500/50 text-loss-400"
              }`}
            />
            <PillButton onClick={applyPort} disabled={busy || !validPort || port === host.port} tone="neutral">
              Apply
            </PillButton>
          </div>

          <div className="flex items-center gap-1.5">
            <PillButton onClick={startHost} disabled={busy || host.listening} tone="go">
              Start host
            </PillButton>
            <PillButton
              onClick={stopHost}
              disabled={busy || !host.listening || !canStopHost}
              tone="stop"
              title={
                canStopHost
                  ? "Stop listening; running services stay loaded"
                  : "This build cannot stop the listener separately — change the port to rebind"
              }
            >
              Stop host
            </PillButton>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-white/6 border-t border-white/6">
        <Stat label="Uptime" value={host.listening ? formatDuration(host.uptimeSeconds) : "—"} />
        <Stat label="Requests" value={host.totalRequests.toLocaleString("en-US")} hint="all paths, including 404 and 503" />
        <Stat label="Services" value={String(services.length)} hint={serviceHint(services)} />
      </div>

      {host.error ? (
        <div className="border-t border-loss-500/25 bg-loss-500/[0.07] px-5 py-3">
          <p className="text-[10px] tracking-[0.16em] text-loss-400 uppercase">Host error</p>
          <p className="num mt-1 text-[12px] leading-relaxed break-words whitespace-pre-wrap text-loss-400">
            {host.error}
          </p>
        </div>
      ) : null}

      {message ? <p className="border-t border-white/6 px-5 py-2.5 text-[12px] text-ink-300">{message}</p> : null}

      <RouteMap services={services} origin={origin} />

      <div className="flex items-center justify-between gap-4 border-t border-white/6 px-5 py-3">
        <p className="num truncate text-[11px] text-ink-700" title={dataRoot}>
          {dataRoot}
        </p>
        <PillButton onClick={() => void window.manager.openDataFolder(null)} tone="neutral">
          Open data folder
        </PillButton>
      </div>
    </div>
  );
}

/**
 * Gepauzeerde services apart noemen, want ze tellen niet als online en ze zijn ook
 * niet uit; wie alleen "2 online" van vier ziet gaat de andere twee zoeken.
 */
function serviceHint(services: ServiceInfo[]): string {
  const online = services.filter((service) => service.status === "running").length;
  const paused = services.filter((service) => service.status === "paused").length;
  return paused === 0 ? `${online} online` : `${online} online, ${paused} paused`;
}

/** Welk pad bij welke service hoort -- op één plek, zodat je het kunt voorlezen aan wie het moet instellen. */
function RouteMap({ services, origin }: { services: ServiceInfo[]; origin: string }): JSX.Element | null {
  const [copied, setCopied] = useState<string | null>(null);
  if (services.length === 0) return null;

  const copy = (url: string): void => {
    void navigator.clipboard.writeText(url).then(
      () => {
        setCopied(url);
        window.setTimeout(() => setCopied((current) => (current === url ? null : current)), 1400);
      },
      () => setCopied(null),
    );
  };

  return (
    <div className="border-t border-white/6 px-5 py-4">
      <p className="mb-2.5 text-[10px] tracking-[0.16em] text-ink-700 uppercase">Path routing</p>
      <div className="space-y-1">
        {services.map((service) => {
          const url = `${origin}${service.basePath}`;
          const look = STATUS_LOOK[service.status];
          return (
            <button
              key={service.id}
              onClick={() => copy(url)}
              title="Copy this address"
              className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${look.dot}`} />
              <span className="num shrink-0 text-[12px] text-ink-300">{service.basePath}/…</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-500">{service.name}</span>
              <span
                className={`shrink-0 text-[11px] ${service.status === "paused" ? "text-gold-300/70" : "text-ink-700"}`}
              >
                {copied === url
                  ? "copied"
                  : service.status === "running"
                    ? "serving"
                    : service.status === "paused"
                      ? "503 while paused"
                      : "503 while offline"}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2.5 text-[11px] text-ink-700">
        Clients outside this machine use the same paths with your LAN address or domain instead of localhost.
      </p>
    </div>
  );
}

function ServiceCard({
  service,
  origin,
  now,
  busy,
  result,
  onAutoStart,
  onAction,
}: {
  service: ServiceInfo;
  origin: string;
  now: number;
  busy: ServiceAction | undefined;
  result: ServiceActionResult | undefined;
  onAutoStart: (id: string, on: boolean) => void;
  onAction: (id: string, action: ServiceAction) => Promise<void>;
}): JSX.Element {
  const look = STATUS_LOOK[service.status];
  const chips = Object.entries(service.summary?.detail ?? {});
  const paused = service.status === "paused";
  // Tijdens een pauze blijft de service gestart, dus zijn looptijd loopt door.
  const loaded = service.status === "running" || paused;
  const uptime =
    loaded && service.startedAt !== null
      ? formatDuration(Math.max(0, Math.round((now - service.startedAt) / 1000)))
      : "—";

  /**
   * Dezelfde afweging als bij "Stop host" hierboven: de brug groeit mee met het
   * main-proces, en een build zonder pauze moet niet stukgaan op de eerste klik.
   * Zonder deze functies blijven de twee knoppen uit, met uitleg in de tooltip.
   */
  const canPauseHere =
    typeof window.manager.pauseService === "function" && typeof window.manager.resumeService === "function";

  return (
    <article
      className={`panel overflow-hidden transition-colors ${
        service.status === "error" ? "border-loss-500/30" : paused ? "border-gold-400/30" : ""
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-5 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${look.dot}`} />
            <h3 className="truncate text-[15px] font-medium">{service.name}</h3>
            <span className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${look.pill}`}>{look.label}</span>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">{service.description}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="num rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1 text-[11px] text-ink-300">
              {origin}
              <span className="text-jade-400">{service.basePath}</span>
            </span>
            <button
              onClick={() => void window.manager.openDataFolder(service.id)}
              className="text-[11px] text-ink-700 underline-offset-2 transition-colors hover:text-ink-300 hover:underline"
            >
              Data folder
            </button>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2.5">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <PillButton
              onClick={() => void onAction(service.id, "start")}
              disabled={busy !== undefined || !canStart(service.status)}
              tone="go"
              title={paused ? "Paused services resume; they do not start again" : "Load this service and serve its paths"}
            >
              {busy === "start" ? "Starting…" : "Start"}
            </PillButton>
            <PillButton
              onClick={() => void onAction(service.id, "pause")}
              disabled={busy !== undefined || !canPauseHere || !canPause(service.status)}
              tone="hold"
              title={
                canPauseHere
                  ? "Hold traffic; the service stays loaded and its paths answer 503"
                  : "This build cannot pause services yet"
              }
            >
              {busy === "pause" ? "Pausing…" : "Pause"}
            </PillButton>
            <PillButton
              onClick={() => void onAction(service.id, "resume")}
              disabled={busy !== undefined || !canPauseHere || !canResume(service.status)}
              tone="go"
              title={
                canPauseHere
                  ? "Serve this path again; nothing has to be loaded twice"
                  : "This build cannot pause services yet"
              }
            >
              {busy === "resume" ? "Resuming…" : "Resume"}
            </PillButton>
            <PillButton
              onClick={() => void onAction(service.id, "stop")}
              disabled={busy !== undefined || !canStop(service.status)}
              tone="stop"
              title="Unload this service; it releases everything it holds"
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </PillButton>
            <PillButton
              onClick={() => void onAction(service.id, "restart")}
              disabled={busy !== undefined || !canRestart(service.status)}
              tone="neutral"
              title={paused ? "Reload from scratch; the service comes back online, not paused" : "Stop and start again"}
            >
              {busy === "restart" ? "Restarting…" : "Restart"}
            </PillButton>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={service.autoStart}
            onClick={() => onAutoStart(service.id, !service.autoStart)}
            className="flex items-center gap-2 text-[11px] text-ink-500 transition-colors hover:text-ink-300"
            title="Start this service by itself as soon as the host is listening"
          >
            <span
              className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                service.autoStart ? "border-jade-500/50 bg-jade-500/25" : "border-white/10 bg-white/[0.04]"
              }`}
            >
              <span
                className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all ${
                  service.autoStart ? "left-[18px] bg-jade-400" : "left-[3px] bg-ink-500"
                }`}
              />
            </span>
            Start with host
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-white/6 border-t border-white/6">
        <Stat
          label="Records"
          value={service.summary ? service.summary.records.toLocaleString("en-US") : "—"}
          hint={service.summary ? undefined : "no figures yet"}
        />
        <Stat
          label="Requests"
          value={format(service.requests)}
          hint="delivered on this path"
        />
        <Stat
          label="Uptime"
          value={uptime}
          hint={paused ? "still loaded, paused" : service.status === "running" ? "since last start" : undefined}
        />
      </div>

      {paused ? (
        <div className="border-t border-gold-400/25 bg-gold-400/[0.07] px-5 py-3">
          <p className="text-[10px] tracking-[0.16em] text-gold-300 uppercase">Paused</p>
          <p className="mt-1 text-[12px] leading-relaxed text-gold-300/85">
            The service is still loaded and keeps its data in memory. This path answers 503 with{" "}
            <span className="num">service_paused</span> until you resume, so clients know to come back instead of
            giving up.
          </p>
        </div>
      ) : null}

      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-white/6 px-5 py-3">
          {chips.map(([key, value]) => (
            <span key={key} className="num rounded-lg bg-white/[0.04] px-2 py-1 text-[11px] text-ink-500">
              {key} <span className="text-ink-300">{format(value)}</span>
            </span>
          ))}
        </div>
      ) : null}

      {service.error ? (
        <div className="border-t border-loss-500/25 bg-loss-500/[0.07] px-5 py-3">
          <p className="text-[10px] tracking-[0.16em] text-loss-400 uppercase">
            {service.status === "error" ? "Error" : "Last error"}
          </p>
          <p className="num mt-1 text-[12px] leading-relaxed break-words whitespace-pre-wrap text-loss-400">
            {service.error}
          </p>
          <p className="mt-1.5 text-[11px] text-loss-400/70">
            The host kept running; this path answers 503 until the service starts.
          </p>
        </div>
      ) : null}

      {result ? (
        <p
          className={`border-t border-white/6 px-5 py-2.5 text-[12px] ${result.ok ? "text-jade-300" : "text-loss-400"}`}
        >
          {result.message}
        </p>
      ) : null}
    </article>
  );
}

/** Wat er staat als er nog geen enkele service geregistreerd is: hoe je er een toevoegt. */
function NoServices(): JSX.Element {
  const steps: Array<{ title: string; body: string }> = [
    {
      title: "Write the service",
      body: "Add manager/src/main/services/<your-game>/ and export an object that implements GameService: id, name, description, basePath, start, stop, routes and summary.",
    },
    {
      title: "Pick a unique base path",
      body: "Something like /your-game. It is the only part of the layout a client ever sees, and it keeps every service on this one port.",
    },
    {
      title: "Never listen yourself",
      body: "No createServer, no listen. Return routes() and the host mounts them; a stopped service answers 503 on its own paths.",
    },
    {
      title: "Register and restart",
      body: "Add the service to the host's list and restart the manager. Its card shows up here with its own start, pause, resume, stop and restart.",
    },
  ];

  return (
    <div className="panel p-6">
      <p className="text-sm text-ink-300">No game services registered yet</p>
      <p className="mt-1 max-w-xl text-xs text-ink-500">
        The host is ready and will keep listening on its own. A service is a small module it mounts on a path.
      </p>
      <ol className="mt-5 space-y-3">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="num mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border border-white/8 bg-white/[0.03] text-[11px] text-ink-500">
              {index + 1}
            </span>
            <div>
              <p className="text-[12px] font-medium text-ink-300">{step.title}</p>
              <p className="num mt-0.5 max-w-2xl text-[11px] leading-relaxed text-ink-500">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="px-5 py-3.5">
      <p className="text-[10px] tracking-[0.16em] text-ink-700 uppercase">{label}</p>
      <p className="num mt-1 text-[17px] font-medium">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-[10px] text-ink-700">{hint}</p> : null}
    </div>
  );
}

type PillTone = "go" | "hold" | "stop" | "neutral";

function PillButton({
  children,
  onClick,
  disabled = false,
  tone,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone: PillTone;
  title?: string;
}): JSX.Element {
  const tones: Record<PillTone, string> = {
    go: "border-jade-500/35 bg-jade-500/10 text-jade-300 hover:border-jade-500/60 hover:bg-jade-500/18",
    // 'hold' hoort bij het goud van de gepauzeerde kaart en niet bij het rood van
    // stoppen: pauzeren is omkeerbaar en gooit niets weg.
    hold: "border-gold-400/35 bg-gold-400/10 text-gold-300 hover:border-gold-400/60 hover:bg-gold-400/18",
    stop: "border-white/8 text-ink-300 hover:border-loss-500/50 hover:bg-loss-500/12 hover:text-loss-400",
    neutral: "border-white/8 text-ink-300 hover:border-white/16 hover:bg-white/[0.05]",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-xl border px-3 py-1.5 text-[12px] font-medium transition-colors ${
        disabled ? "cursor-not-allowed border-white/6 text-ink-700" : tones[tone]
      }`}
    >
      {children}
    </button>
  );
}

/**
 * De registry verbiedt deze opdrachten buiten deze statussen; de knoppen tonen dat
 * vooraf. Deze vier functies zijn dus een kopie van de precondities in
 * manager/src/main/registry.ts en horen daarmee gelijk te blijven -- een knop die
 * aanstaat terwijl de registry weigert levert een melding op die niemand vroeg.
 */
function canStart(status: ServiceStatus): boolean {
  // Bewust niet vanuit 'paused': daar hoort Resume, en start() zou de opslag
  // opnieuw laten inlezen.
  return status === "stopped" || status === "error";
}

function canPause(status: ServiceStatus): boolean {
  return status === "running";
}

function canResume(status: ServiceStatus): boolean {
  return status === "paused";
}

function canStop(status: ServiceStatus): boolean {
  // Een gepauzeerde service is nog gestart, dus die valt wel degelijk te stoppen.
  return status === "running" || status === "paused" || status === "error";
}

function canRestart(status: ServiceStatus): boolean {
  return status !== "starting" && status !== "stopping";
}

const format = (value: string | number): string =>
  typeof value === "number" ? value.toLocaleString("en-US") : value;

/** Grof genoeg om in één oogopslag te lezen: seconden boeien niet meer na een uur. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Looptijd rekenen we lokaal uit startedAt: dan loopt de teller ook tussen twee snapshots door. */
function useNow(): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
