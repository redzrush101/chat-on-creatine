import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Plus, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke, subscribe } from '../lib/bridge';
import { Empty, errorText, Notice } from './common';

// Output can arrive before a pane has its terminal id, so unclaimed output waits here.
const dataListeners = new Map<string, (data: string) => void>();
const exitListeners = new Map<string, (code: number | null) => void>();
const earlyData = new Map<string, string[]>();

subscribe('terminal:data', ({ terminalId, data }) => {
  const listener = dataListeners.get(terminalId);
  if (listener) listener(data);
  else earlyData.set(terminalId, [...(earlyData.get(terminalId) ?? []), data]);
});

subscribe('terminal:exit', ({ terminalId, code }) => {
  exitListeners.get(terminalId)?.(code);
});

interface TerminalSlot {
  key: number;
}

export function TerminalTab({ rootDir }: { rootDir: string | null }): JSX.Element {
  const nextKey = useRef(1);
  const [slots, setSlots] = useState<TerminalSlot[]>(() => [{ key: nextKey.current++ }]);
  const [active, setActive] = useState<number>(() => slots[0]?.key ?? 0);
  const [error, setError] = useState<string | null>(null);

  const addSlot = () => {
    const slot = { key: nextKey.current++ };
    setSlots((current) => [...current, slot]);
    setActive(slot.key);
  };

  const closeSlot = (key: number) => {
    const remaining = slots.filter((slot) => slot.key !== key);
    setSlots(remaining);
    if (key === active) setActive(remaining[remaining.length - 1]?.key ?? 0);
  };

  return (
    <div className="wp-terminal">
      <div className="wp-toolbar wp-term-tabs" role="tablist" aria-label="Terminals">
        {slots.map((slot, index) => (
          <div key={slot.key} className={slot.key === active ? 'wp-term-tab is-active' : 'wp-term-tab'}>
            <button type="button" role="tab" aria-selected={slot.key === active} onClick={() => setActive(slot.key)}>
              Terminal {index + 1}
            </button>
            <button type="button" className="wp-term-close" aria-label={`Close terminal ${index + 1}`} onClick={() => closeSlot(slot.key)}>
              <X size={12} aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className="wp-btn is-ghost" aria-label="New terminal" onClick={addSlot}>
          <Plus size={14} aria-hidden />
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {slots.length === 0 && <Empty title="No terminal open">Open a terminal to run commands in this chat's folder.</Empty>}
      <div className="wp-term-stack">
        {slots.map((slot) => (
          <TerminalPane key={slot.key} cwd={rootDir} active={slot.key === active} onError={setError} />
        ))}
      </div>
    </div>
  );
}

function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalTheme() {
  return {
    background: tokenValue('--bg-code'),
    foreground: tokenValue('--text'),
    cursor: tokenValue('--accent'),
    selectionBackground: tokenValue('--accent-soft')
  };
}

/** One shell. Hidden panes stay mounted so their scrollback survives tab switches. */
function TerminalPane({ cwd, active, onError }: { cwd: string | null; active: boolean; onError(message: string): void }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: tokenValue('--font-mono'),
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let terminalId: string | null = null;
    let disposed = false;
    let exited = false;

    void invoke('terminal:open', { cwd, cols: term.cols, rows: term.rows }).then(
      (id) => {
        if (disposed) {
          void invoke('terminal:close', id);
          return;
        }
        terminalId = id;
        dataListeners.set(id, (data) => term.write(data));
        exitListeners.set(id, (code) => {
          exited = true;
          term.write(`\r\n[process exited${code === null ? '' : ` with code ${code}`}]\r\n`);
        });
        for (const chunk of earlyData.get(id) ?? []) term.write(chunk);
        earlyData.delete(id);
      },
      (failure: unknown) => onError(errorText(failure))
    );

    const input = term.onData((data) => {
      if (terminalId && !exited) void invoke('terminal:write', terminalId, data);
    });

    // Refit on any size change, including when a hidden pane is shown again.
    const observer = new ResizeObserver(() => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      fit.fit();
      if (terminalId && !exited) void invoke('terminal:resize', terminalId, term.cols, term.rows);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      if (terminalId) {
        dataListeners.delete(terminalId);
        exitListeners.delete(terminalId);
        if (!exited) void invoke('terminal:close', terminalId);
      }
      term.dispose();
    };
  }, [cwd, onError]);

  return <div className="wp-term-pane" ref={hostRef} hidden={!active} />;
}
