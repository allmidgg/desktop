/**
 * De instellingen van de host: waar hij luistert, waar hij schrijft, en wie er
 * binnen mag.
 *
 * Alles op dit scherm raakt de hele app in plaats van één service, dus alles
 * heeft hier een bevestiging of een zichtbaar gevolg. Een API-sleutel is de
 * uitzondering die de meeste zorg vraagt: het geheim bestaat maar één moment --
 * daarna kent de manager alleen nog de hash -- dus hij komt precies één keer in
 * beeld, met een kopieerknop en de waarschuwing erbij.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ManagerSnapshot } from "../../../../shared/types";

export interface ManagerSettings {
  port: number;
  /** Bovenliggende map; elke service krijgt daaronder zijn eigen map. */
  dataRoot: string;
  /** Start de host meteen als de app opengaat, in plaats van na een klik. */
  autoStart: boolean;
}

export interface ApiKeyInfo {
  id: string;
  label: string;
  /** De eerste tekens van de sleutel, genoeg om hem te herkennen in een lijst. */
  prefix: string;
  createdAt: number;
  /** Null zolang er nooit een verzoek mee is gedaan. */
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** Het geheim komt alleen hieruit; opvragen kan later niet meer. */
export interface CreatedApiKey {
  key: ApiKeyInfo;
  secret: string;
}

export interface StorageUsage {
  serviceId: string;
  name: string;
  /** Volledig pad naar het databestand van de service. */
  path: string;
  bytes: number;
  records: number;
}

export interface SettingsMutationResult {
  ok: boolean;
  /** Engelse UI-tekst, wordt letterlijk getoond. */
  message: string;
}

/** De functies die deze view van window.manager gebruikt. */
interface SettingsBridge {
  getSnapshot(): Promise<ManagerSnapshot>;
  onSnapshot(handler: (snapshot: ManagerSnapshot) => void): () => void;
  setPort(port: number): Promise<ManagerSnapshot>;
  openDataFolder(serviceId: string | null): Promise<void>;

  getSettings(): Promise<ManagerSettings>;
  setAutoStart(enabled: boolean): Promise<ManagerSettings>;
  setDataRoot(path: string): Promise<ManagerSettings>;
  /** Opent de mapkiezer in het main-proces; null als de gebruiker afbreekt. */
  chooseDataRoot(): Promise<string | null>;

  listApiKeys(): Promise<ApiKeyInfo[]>;
  createApiKey(label: string): Promise<CreatedApiKey>;
  revokeApiKey(id: string): Promise<SettingsMutationResult>;

  storageUsage(): Promise<StorageUsage[]>;
}

/**
 * De brug per aanroep opzoeken in plaats van één keer bij het laden: zo levert
 * een functie die de preload (nog) niet aanbiedt een leesbare melding op de plek
 * van de klik op, in plaats van een leeg scherm.
 */
function endpoint<K extends keyof SettingsBridge>(name: K): SettingsBridge[K] {
  const bridge = (window as unknown as { manager?: Partial<SettingsBridge> }).manager;
  const fn = bridge?.[name];
  if (typeof fn !== "function") throw new Error(`This build of the manager does not provide "${name}".`);
  return fn as SettingsBridge[K];
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const pad = (value: number): string => String(value).padStart(2, "0");

function formatDateTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "Last used" is vooral een vraag naar "recent of niet"; het exacte tijdstip staat in de titel. */
function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let step = 0;
  while (value >= 1024 && step < units.length - 1) {
    value /= 1024;
    step += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[step] ?? "B"}`;
}

const formatCount = (value: number): string => value.toLocaleString("en-US");

type Tone = "ok" | "error";

interface Notice {
  tone: Tone;
  text: string;
}

const inputClass =
  "rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-white/90 outline-none placeholder:text-white/25 focus:border-emerald-400/40";

const buttonClass =
  "rounded-lg border border-white/10 px-3 py-1.5 text-[12px] font-medium text-white/70 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

const primaryClass =
  "rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-[12px] font-medium text-emerald-200 transition-colors hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40";

const dangerClass =
  "rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[12px] font-medium text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40";

export function SettingsView({ snapshot }: { snapshot?: ManagerSnapshot | null }): JSX.Element {
  /** Zonder snapshot van de ouder haalt de view hem zelf op; met is hij de enige waarheid. */
  const owned = snapshot === undefined;
  const [fetched, setFetched] = useState<ManagerSnapshot | null>(null);
  const live = snapshot ?? fetched;

  const [settings, setSettings] = useState<ManagerSettings | null>(null);
  const [portInput, setPortInput] = useState("");
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [usage, setUsage] = useState<StorageUsage[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (!owned) return;
    try {
      void endpoint("getSnapshot")().then(setFetched);
      return endpoint("onSnapshot")(setFetched);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
      return;
    }
  }, [owned]);

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const result = await endpoint("getSettings")();
      setSettings(result);
      setPortInput(String(result.port));
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    }
  }, []);

  const loadKeys = useCallback(async (): Promise<void> => {
    try {
      setKeys(await endpoint("listApiKeys")());
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    }
  }, []);

  const loadUsage = useCallback(async (): Promise<void> => {
    try {
      setUsage(await endpoint("storageUsage")());
    } catch {
      // Zonder cijfers valt de rest van dit scherm nog prima te gebruiken.
      setUsage([]);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadKeys();
    void loadUsage();
  }, [loadSettings, loadKeys, loadUsage]);

  const parsedPort = Number(portInput);
  const portValid = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const portChanged = settings !== null && parsedPort !== settings.port;

  const applyPort = async (): Promise<void> => {
    if (!portValid) return;
    setBusy(true);
    try {
      const result = await endpoint("setPort")(parsedPort);
      if (owned) setFetched(result);
      setSettings((current) => (current ? { ...current, port: result.host.port } : current));
      setNotice(
        result.host.listening
          ? { tone: "ok", text: `The host is listening on port ${result.host.port}.` }
          : { tone: "error", text: result.host.error ?? "The host is not listening." },
      );
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoStart = async (): Promise<void> => {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(await endpoint("setAutoStart")(!settings.autoStart));
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const changeDataRoot = async (): Promise<void> => {
    setBusy(true);
    try {
      const chosen = await endpoint("chooseDataRoot")();
      if (chosen === null) return;
      setSettings(await endpoint("setDataRoot")(chosen));
      await loadUsage();
      setNotice({ tone: "ok", text: "The data folder has been changed." });
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const createKey = async (): Promise<void> => {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true);
    try {
      const result = await endpoint("createApiKey")(label);
      setCreated(result);
      setCopied(false);
      setNewLabel("");
      await loadKeys();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const revokeKey = async (): Promise<void> => {
    if (!revoking) return;
    setBusy(true);
    try {
      const result = await endpoint("revokeApiKey")(revoking.id);
      setNotice({ tone: result.ok ? "ok" : "error", text: result.message });
      setRevoking(null);
      await loadKeys();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
      setRevoking(null);
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async (secret: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setNotice({ tone: "error", text: "Copying failed. Select the key and copy it by hand." });
    }
  };

  const dataRoot = settings?.dataRoot ?? live?.dataRoot ?? "";
  const totalBytes = usage.reduce((sum, entry) => sum + entry.bytes, 0);

  return (
    <div className="animate-rise mx-auto max-w-3xl space-y-4 pb-8">
      {notice ? (
        <div
          className={`flex items-start justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-[12px] ${
            notice.tone === "ok"
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 opacity-60 hover:opacity-100">
            Dismiss
          </button>
        </div>
      ) : null}

      <Section
        title="Host"
        hint={
          live
            ? live.host.listening
              ? `Listening on port ${live.host.port}`
              : (live.host.error ?? "Not listening")
            : undefined
        }
      >
        <Row
          label="Port"
          description="Every service is reachable on this one port, each under its own path. Changing it restarts the listener; running services stay up."
        >
          <input
            value={portInput}
            onChange={(event) => setPortInput(event.target.value)}
            inputMode="numeric"
            className={`${inputClass} w-24 tabular-nums`}
            aria-label="Host port"
          />
          <button onClick={() => void applyPort()} disabled={!portValid || !portChanged || busy} className={primaryClass}>
            Apply
          </button>
          {!portValid && portInput !== "" ? (
            <span className="text-[11px] text-rose-300/80">Use a number between 1 and 65535.</span>
          ) : null}
        </Row>

        <Row label="Start automatically" description="Bring the host and its services up as soon as the manager opens.">
          <Toggle
            checked={settings?.autoStart ?? false}
            disabled={!settings || busy}
            label="Start automatically"
            onChange={() => void toggleAutoStart()}
          />
        </Row>
      </Section>

      <Section title="Data" hint={usage.length > 0 ? `${formatBytes(totalBytes)} on disk` : undefined}>
        <Row label="Folder" description="Each service keeps its own folder underneath this one.">
          <input value={dataRoot} readOnly className={`${inputClass} min-w-0 flex-1 font-mono text-[11px]`} title={dataRoot} />
          <button onClick={() => void changeDataRoot()} disabled={busy} className={buttonClass}>
            Change…
          </button>
          <button
            onClick={() => {
              try {
                void endpoint("openDataFolder")(null);
              } catch (error) {
                setNotice({ tone: "error", text: errorText(error) });
              }
            }}
            className={buttonClass}
          >
            Open folder
          </button>
        </Row>

        <div className="px-4 py-3">
          {usage.length === 0 ? (
            <p className="text-[12px] text-white/35">No service has written anything yet.</p>
          ) : (
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="text-[10px] tracking-[0.12em] text-white/35 uppercase">
                  <th className="pb-1.5 font-medium">Service</th>
                  <th className="pb-1.5 font-medium">File</th>
                  <th className="pb-1.5 text-right font-medium">Records</th>
                  <th className="pb-1.5 text-right font-medium">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {usage.map((entry) => (
                  <tr key={entry.serviceId} className="border-t border-white/6">
                    <td className="py-1.5 pr-3 text-white/80">{entry.name}</td>
                    <td className="max-w-[280px] truncate py-1.5 pr-3 font-mono text-[11px] text-white/40" title={entry.path}>
                      {entry.path}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-white/60">{formatCount(entry.records)}</td>
                    <td className="py-1.5 text-right tabular-nums text-white/60">{formatBytes(entry.bytes)}</td>
                    <td className="py-1.5 pl-3 text-right">
                      <button
                        onClick={() => {
                          try {
                            void endpoint("openDataFolder")(entry.serviceId);
                          } catch (error) {
                            setNotice({ tone: "error", text: errorText(error) });
                          }
                        }}
                        className="text-[11px] text-white/40 transition-colors hover:text-white"
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      <Section title="API keys" hint={`${formatCount(keys.filter((key) => key.revokedAt === null).length)} active`}>
        <Row label="New key" description="The label is only there to tell your keys apart later.">
          <input
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createKey();
            }}
            placeholder="Home PC"
            className={`${inputClass} w-56`}
            aria-label="Label for the new key"
          />
          <button onClick={() => void createKey()} disabled={!newLabel.trim() || busy} className={primaryClass}>
            Create key
          </button>
        </Row>

        {created ? (
          <div className="mx-4 mb-3 rounded-xl border border-amber-400/40 bg-amber-400/[0.07] p-3.5">
            <p className="text-[12px] font-medium text-amber-200">
              Copy “{created.key.label}” now — this is the only time the key is shown.
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 font-mono text-[12px] text-white/90 select-all">
                {created.secret}
              </code>
              <button onClick={() => void copySecret(created.secret)} className={primaryClass}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button onClick={() => setCreated(null)} className={buttonClass}>
                I saved it
              </button>
            </div>
            <p className="mt-2 text-[11px] text-amber-200/60">
              The manager only stores a hash. Lose the key and the only way back is a new one.
            </p>
          </div>
        ) : null}

        <div className="px-4 pb-3">
          {keys.length === 0 ? (
            <p className="text-[12px] text-white/35">No keys yet. Clients need one to upload matches.</p>
          ) : (
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="text-[10px] tracking-[0.12em] text-white/35 uppercase">
                  <th className="pb-1.5 font-medium">Label</th>
                  <th className="pb-1.5 font-medium">Key</th>
                  <th className="pb-1.5 font-medium">Created</th>
                  <th className="pb-1.5 font-medium">Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const revoked = key.revokedAt !== null;
                  return (
                    <tr key={key.id} className={`border-t border-white/6 ${revoked ? "opacity-45" : ""}`}>
                      <td className="py-1.5 pr-3 text-white/80">{key.label}</td>
                      <td className="py-1.5 pr-3 font-mono text-[11px] text-white/40">{key.prefix}…</td>
                      <td className="py-1.5 pr-3 tabular-nums text-white/50">{formatDateTime(key.createdAt)}</td>
                      <td
                        className="py-1.5 pr-3 text-white/50"
                        title={key.lastUsedAt === null ? "Never used" : formatDateTime(key.lastUsedAt)}
                      >
                        {key.lastUsedAt === null ? "Never" : formatAge(key.lastUsedAt)}
                      </td>
                      <td className="py-1.5 text-right">
                        {revoked ? (
                          <span className="text-[11px] text-white/35">Revoked</span>
                        ) : (
                          <button
                            onClick={() => setRevoking(key)}
                            className="text-[11px] text-rose-300/80 transition-colors hover:text-rose-300"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      {revoking ? (
        <ConfirmDialog
          title="Revoke API key"
          confirmLabel="Revoke key"
          busy={busy}
          onCancel={() => setRevoking(null)}
          onConfirm={() => void revokeKey()}
        >
          <p>
            “{revoking.label}” stops working the moment you confirm. Anything using it starts getting 401 responses, and
            the key cannot be brought back — you would have to create a new one and update the client.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

export default SettingsView;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02]">
      <header className="flex items-baseline justify-between border-b border-white/8 px-4 py-2.5">
        <h2 className="text-[11px] font-semibold tracking-[0.14em] text-white/45 uppercase">{title}</h2>
        {hint ? <span className="text-[11px] text-white/30">{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-white/6 px-4 py-3 last:border-b-0">
      <div className="w-40 shrink-0">
        <div className="text-[12px] font-medium text-white/80">{label}</div>
        {description ? <p className="mt-0.5 text-[11px] leading-relaxed text-white/35">{description}</p> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-5 w-9 rounded-full border transition-colors disabled:opacity-40 ${
        checked ? "border-emerald-400/50 bg-emerald-400/25" : "border-white/12 bg-white/5"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
          checked ? "left-4.5 bg-emerald-300" : "left-0.5 bg-white/40"
        }`}
      />
    </button>
  );
}

/**
 * Bevestiging voor wat niet terug te draaien is.
 *
 * Annuleren heeft de focus zodat een enter-toets nooit per ongeluk intrekt;
 * Escape doet hetzelfde.
 */
function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  busy: boolean;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-white/12 bg-[#0d0f13] p-5 shadow-2xl">
        <h3 className="text-[14px] font-semibold text-white/90">{title}</h3>
        <div className="mt-3 space-y-2.5 text-[12px] leading-relaxed text-white/60">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} autoFocus className={buttonClass}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy} className={dangerClass}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
