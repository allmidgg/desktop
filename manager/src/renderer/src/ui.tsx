/**
 * De bouwstenen van de Server Manager.
 *
 * Alles wat in meer dan één scherm voorkomt staat hier, zodat een tabel in Data
 * er hetzelfde uitziet als een tabel in Services en niemand zijn eigen knopje
 * hoeft te verzinnen. De maatvoering is bewust krap: rijen van 32 pixels, tekst
 * van 11 tot 13 pixels, hairlines in plaats van randen. Op een beheerscherm wil
 * je in één blik twintig regels kunnen overzien.
 */
import type { ReactNode } from "react";
import type { LogLevel, ServiceStatus } from "../../../shared/types";

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={`panel ${className}`}>{children}</div>;
}

export function SectionTitle({
  children,
  hint,
  actions,
}: {
  children: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-3 flex items-center justify-between gap-4">
      <div className="flex items-baseline gap-3">
        <h2 className="label">{children}</h2>
        {hint ? <span className="text-[11px] text-ink-500">{hint}</span> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Balk met bediening boven een lijst of tabel. */
export function Toolbar({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function Divider(): JSX.Element {
  return <span className="h-3.5 w-px bg-white/10" />;
}

type ButtonVariant = "primary" | "default" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-jade-500/40 bg-jade-500/15 text-jade-300 hover:bg-jade-500/25",
  default: "border-white/10 bg-white/[0.04] text-ink-100 hover:bg-white/[0.08]",
  ghost: "border-transparent text-ink-300 hover:bg-white/[0.06] hover:text-ink-100",
  danger: "border-loss-500/35 bg-loss-500/10 text-loss-400 hover:bg-loss-500/20 hover:text-white",
};

export function Button({
  children,
  onClick,
  variant = "default",
  disabled = false,
  title,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  className?: string;
}): JSX.Element {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/** Vierkant knopje voor een enkel pictogram; `path` is een 24x24 SVG-pad. */
export function IconButton({
  path,
  onClick,
  title,
  disabled = false,
  danger = false,
}: {
  path: string;
  onClick?: () => void;
  title: string;
  disabled?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-7 w-7 place-items-center rounded-md border border-white/10 bg-white/[0.03] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "text-ink-500 hover:border-loss-500/40 hover:bg-loss-500/15 hover:text-loss-400"
          : "text-ink-500 hover:bg-white/[0.08] hover:text-ink-100"
      }`}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={path} />
      </svg>
    </button>
  );
}

type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

const TONES: Record<Tone, string> = {
  neutral: "border-white/10 bg-white/[0.04] text-ink-300",
  good: "border-jade-500/30 bg-jade-500/12 text-jade-300",
  warn: "border-gold-500/30 bg-gold-500/12 text-gold-300",
  bad: "border-loss-500/30 bg-loss-500/12 text-loss-400",
  accent: "border-jade-500/25 bg-jade-500/8 text-jade-400",
};

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}): JSX.Element {
  return (
    <span
      title={title}
      className={`num inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * De statussen uit het contract, met de kleur die ze in de hele app hebben.
 * 'starting' en 'stopping' delen het goud: het gaat ergens heen, maar het is er
 * nog niet. 'paused' krijgt datzelfde goud maar dan stil -- de service is er nog
 * en houdt zijn data vast, dus grijs (dat hier "er is niets" betekent) zou liegen.
 */
const STATUS_TONE: Record<ServiceStatus, Tone> = {
  running: "good",
  starting: "warn",
  stopping: "warn",
  paused: "warn",
  stopped: "neutral",
  error: "bad",
};

const STATUS_LABEL: Record<ServiceStatus, string> = {
  running: "Running",
  starting: "Starting",
  stopping: "Stopping",
  paused: "Paused",
  stopped: "Stopped",
  error: "Error",
};

export function statusLabel(status: ServiceStatus): string {
  return STATUS_LABEL[status];
}

const STATUS_DOT: Record<ServiceStatus, string> = {
  running: "bg-jade-500 animate-pulse-ring",
  starting: "bg-gold-400 animate-breathe",
  stopping: "bg-gold-400 animate-breathe",
  // Stil, met ring: een pauze verandert vanzelf niets, daar moet jij iets voor doen.
  paused: "bg-gold-400 ring-2 ring-gold-400/25",
  stopped: "bg-ink-700",
  error: "bg-loss-500",
};

export function StatusDot({ status }: { status: ServiceStatus }): JSX.Element {
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />;
}

export function StatusPill({ status }: { status: ServiceStatus }): JSX.Element {
  return (
    <Badge tone={STATUS_TONE[status]}>
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Eén cijfer met zijn onderschrift; de bouwsteen van elke kop met kerngetallen. */
export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}): JSX.Element {
  const color =
    tone === "good"
      ? "text-jade-300"
      : tone === "warn"
        ? "text-gold-300"
        : tone === "bad"
          ? "text-loss-400"
          : "text-ink-100";
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={`num mt-1 truncate text-[19px] leading-none font-semibold ${color}`}>
        {value}
      </div>
      {hint ? <div className="mt-1 truncate text-[11px] text-ink-500">{hint}</div> : null}
    </div>
  );
}

/** Label-waardepaar voor detailblokken; smaller dan Stat en bedoeld voor tekst. */
export function KeyValue({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="shrink-0 text-[11px] text-ink-500">{label}</span>
      <span className="num selectable truncate text-[12px] text-ink-100">{children}</span>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-ink-500">{hint}</span> : null}
    </label>
  );
}

const INPUT_CLASS =
  "h-7 w-full rounded-md border border-white/10 bg-void/50 px-2 text-[12px] text-ink-100 outline-none transition-colors focus:border-jade-500/50";

export function TextInput({
  value,
  onChange,
  placeholder,
  mono = false,
  disabled = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <input
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`${INPUT_CLASS} ${mono ? "font-mono" : ""} ${className}`}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  className = "",
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  className?: string;
}): JSX.Element {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(event) => {
        const parsed = Number.parseInt(event.target.value, 10);
        // Een leeg veld tussendoor mag geen NaN naar de host sturen.
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      className={`${INPUT_CLASS} num font-mono ${className}`}
    />
  );
}

export function Select({
  value,
  options,
  onChange,
  className = "",
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  className?: string;
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`${INPUT_CLASS} appearance-none pr-6 ${className}`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-surface-2">
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 disabled:opacity-40"
    >
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors ${
          checked ? "border-jade-500/50 bg-jade-500/30" : "border-white/10 bg-white/[0.05]"
        }`}
      >
        <span
          className={`absolute top-[2px] h-[10px] w-[10px] rounded-full transition-all ${
            checked ? "left-[14px] bg-jade-400" : "left-[2px] bg-ink-500"
          }`}
        />
      </span>
      {label ? <span className="text-[12px] text-ink-300">{label}</span> : null}
    </button>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  /** CSS-breedte; laat leeg voor een kolom die de rest opvult. */
  width?: string;
  align?: "left" | "right";
  render(row: T): ReactNode;
}

/**
 * De tabel van de app.
 *
 * De kop blijft staan bij het scrollen, want zonder kolomnamen is een tabel met
 * duizend regels onleesbaar zodra je één scherm verder bent.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  empty?: ReactNode;
}): JSX.Element {
  if (rows.length === 0) {
    return <div className="panel-inset">{empty ?? <EmptyState title="Nothing here yet" />}</div>;
  }
  return (
    <div className="panel-inset overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={column.width ? { width: column.width } : undefined}
                className={`label row px-3 py-2 font-medium ${
                  column.align === "right" ? "text-right" : "text-left"
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const selected = selectedKey === key;
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`row transition-colors ${onRowClick ? "cursor-pointer" : ""} ${
                  selected ? "bg-jade-500/8" : "hover:bg-white/[0.03]"
                }`}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`num h-8 px-3 align-middle text-ink-300 ${
                      column.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onSelect: (id: T) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1 rounded-md border border-white/8 bg-white/[0.02] p-0.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onSelect(tab.id)}
          className={`flex h-6 items-center gap-1.5 rounded px-2 text-[11px] font-medium transition-colors ${
            active === tab.id
              ? "bg-white/[0.08] text-ink-100"
              : "text-ink-500 hover:text-ink-300"
          }`}
        >
          {tab.label}
          {tab.count === undefined ? null : (
            <span className="num text-[10px] text-ink-700">{formatCount(tab.count)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: "text-ink-500",
  warn: "text-gold-400",
  error: "text-loss-400",
};

/** Het niveau van een logregel als drie letters, zodat de kolom uitlijnt. */
export function LevelTag({ level }: { level: LogLevel }): JSX.Element {
  return (
    <span className={`font-mono text-[10px] tracking-wider uppercase ${LEVEL_COLOR[level]}`}>
      {level === "info" ? "inf" : level === "warn" ? "wrn" : "err"}
    </span>
  );
}

/** Tekst die je wilt kunnen kopiëren: id's, paden, sleutels. */
export function Mono({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span className={`selectable font-mono text-[11px] text-ink-300 ${className}`}>{children}</span>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <p className="text-[13px] text-ink-300">{title}</p>
      {hint ? <p className="max-w-md text-[11px] text-ink-500">{hint}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink-500">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/15 border-t-jade-500" />
      {label}
    </div>
  );
}

/**
 * Venster voor alles wat bevestiging vraagt of even alle aandacht nodig heeft --
 * een sleutel die je maar één keer te zien krijgt, records die je weggooit.
 */
export function Modal({
  title,
  children,
  footer,
  onClose,
  width = 440,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        style={{ width }}
        onClick={(event) => event.stopPropagation()}
        className="panel animate-rise max-h-full overflow-y-auto bg-surface p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-ink-100">{title}</h3>
          <IconButton path="M6 6l12 12M18 6l-12 12" title="Close" onClick={onClose} />
        </div>
        {children}
        {footer ? <div className="mt-4 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

export function CopyButton({ value, title = "Copy" }: { value: string; title?: string }): JSX.Element {
  return (
    <IconButton
      path="M9 9h9v12H9zM6 15H4V3h12v2"
      title={title}
      onClick={() => void navigator.clipboard.writeText(value)}
    />
  );
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Looptijd als 3d 04h 12m / 12m 04s: kort genoeg voor de statusbalk. */
export function formatUptime(seconds: number): string {
  if (seconds <= 0) return "0s";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(rest)}s`;
  return `${rest}s`;
}

/** Klokje bij een logregel; de datum laten we weg, die staat in de kop. */
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatDateTime(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(at)}`;
}

export function formatAgo(at: number | null): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
