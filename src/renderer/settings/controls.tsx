import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import type { DeepPartial, Config } from '@shared/config';
import { invoke } from '../lib/bridge';

/** Errors from saving settings are shown by the settings shell, not swallowed. */
export const ReportContext = createContext<(message: string) => void>(() => undefined);

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSave(): (patch: DeepPartial<Config>) => void {
  const report = useContext(ReportContext);
  return useCallback(
    (patch: DeepPartial<Config>) => {
      invoke('config:update', patch).catch((error: unknown) => report(errorText(error)));
    },
    [report]
  );
}

export function useSecretSave(): (key: 'tunnelApiKey' | 'automationApiKey', value: string | null) => Promise<void> {
  const report = useContext(ReportContext);
  return useCallback(
    async (key, value) => {
      try {
        await invoke('secrets:set', key, value);
      } catch (error) {
        report(errorText(error));
      }
    },
    [report]
  );
}

/** Relative age for status cards: "12s ago", "4m ago", "never". */
export function ago(at: number | null, now = Date.now()): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Re-renders once a second so relative times stay honest while a panel is open. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------- layout

export function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="st-group">
      <header className="st-group-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className="st-card">{children}</div>
    </section>
  );
}

export function Row({
  label,
  hint,
  children,
  stacked
}: {
  label: string;
  hint?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}): JSX.Element {
  return (
    <div className={stacked ? 'st-row is-stacked' : 'st-row'}>
      <div className="st-row-text">
        <div className="st-row-label">{label}</div>
        {hint && <div className="st-row-hint">{hint}</div>}
      </div>
      {children && <div className="st-row-control">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- controls

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange(value: boolean): void; disabled?: boolean; label: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="st-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="st-switch-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  label: string;
}): JSX.Element {
  return (
    <div className="st-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'is-on' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SelectField<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  label: string;
}): JSX.Element {
  return (
    <select className="st-input" aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Text that commits on blur or Enter, so a half-typed value never reaches the config. */
export function TextField({
  value,
  onCommit,
  label,
  placeholder,
  mono,
  list,
  type = 'text'
}: {
  value: string;
  onCommit(value: string): void;
  label: string;
  placeholder?: string;
  mono?: boolean;
  list?: string;
  type?: 'text' | 'password';
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      className={mono ? 'st-input is-mono' : 'st-input'}
      aria-label={label}
      type={type}
      value={draft}
      placeholder={placeholder}
      list={list}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(value);
      }}
    />
  );
}

export function TextArea({
  value,
  onCommit,
  label,
  rows = 4,
  mono,
  placeholder
}: {
  value: string;
  onCommit(value: string): void;
  label: string;
  rows?: number;
  mono?: boolean;
  placeholder?: string;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className={mono ? 'st-input st-textarea is-mono' : 'st-input st-textarea'}
      aria-label={label}
      rows={rows}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

/** Integer field; the value is clamped on commit and an invalid entry reverts. */
export function NumberField({
  value,
  min,
  max,
  onCommit,
  label,
  suffix
}: {
  value: number;
  min: number;
  max: number;
  onCommit(value: number): void;
  label: string;
  suffix?: string;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <span className="st-number">
      <input
        className="st-input is-number"
        aria-label={label}
        inputMode="numeric"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      {suffix && <span className="st-suffix">{suffix}</span>}
    </span>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onCommit,
  label,
  format
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit(value: number): void;
  label: string;
  format(value: number): string;
}): JSX.Element {
  // Dragging previews locally; the config is written once the user lets go.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <span className="st-slider">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="st-suffix">{format(draft)}</span>
    </span>
  );
}

export function Pill({ tone = 'muted', children }: { tone?: 'ok' | 'warn' | 'bad' | 'accent' | 'muted'; children: ReactNode }): JSX.Element {
  return <span className={`st-pill is-${tone}`}>{children}</span>;
}

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'default' | 'ghost' | 'danger' }): JSX.Element {
  return <button type="button" {...props} className={`st-btn is-${variant}${className ? ` ${className}` : ''}`} />;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="st-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="st-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="st-dialog-head">
          <h3>{title}</h3>
          <Button variant="ghost" aria-label="Close" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="st-dialog-body">{children}</div>
      </div>
    </div>
  );
}

/** Runs an action from a button; failures are reported to the settings banner instead of thrown. */
export function useRun(): (task: () => Promise<unknown>) => Promise<void> {
  const report = useContext(ReportContext);
  return useCallback(
    async (task) => {
      try {
        await task();
      } catch (error) {
        report(errorText(error));
      }
    },
    [report]
  );
}

export function ConnectionPill({ state }: { state: string }): JSX.Element {
  const tone = state === 'connected' ? 'ok' : state === 'starting' || state === 'connecting' ? 'accent' : state === 'disconnected' ? 'muted' : 'bad';
  return <Pill tone={tone}>{state.replace('-', ' ')}</Pill>;
}
