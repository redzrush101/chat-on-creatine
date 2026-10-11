import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Eraser } from 'lucide-react';
import type { AppState, LogEntry } from '@shared/types';
import { invoke, subscribe } from '../../lib/bridge';
import { Button, CopyButton, Group, Row, SelectField, Toggle, useSave } from '../controls';

type Level = LogEntry['level'];
const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LINES = 1000;

export function DeveloperSection({ state }: { state: AppState }): JSX.Element {
  const { config } = state;
  const save = useSave();
  return (
    <div className="st-stack">
      <Group title="Local control API" description="Lets an agent on this computer check the app and read its chats.">
        <Row
          label="Serve the control API"
          hint={
            <span className="st-danger-text">
              Anyone who can read your user data folder can read your chat history while this is on. It is off by default.
            </span>
          }
        >
          <Toggle
            label="Serve the control API"
            checked={config.controlApi.enabled}
            onChange={(enabled) => save({ controlApi: { enabled, ...(enabled ? {} : { allowActions: false }) } })}
          />
        </Row>
        <Row
          label="Allow actions"
          hint={
            <span className="st-danger-text">
              Lets local agents send messages to chats and cancel queued messages. Those messages can make ChatGPT act under your granted permissions.
              Resets to off whenever the API is turned off.
            </span>
          }
        >
          <Toggle
            label="Allow actions"
            checked={config.controlApi.allowActions}
            disabled={!config.controlApi.enabled}
            onChange={(allowActions) => save({ controlApi: { allowActions } })}
          />
        </Row>
      </Group>

      <LogViewer />
    </div>
  );
}

function LogViewer(): JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<Level>('info');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const off = subscribe('log', (entry) => setLogs((prev) => [...prev.slice(-(MAX_LINES - 1)), entry]));
    void invoke('app:logs', MAX_LINES).then((entries) => {
      if (cancelled) return;
      // Entries pushed while the snapshot was in flight are already in `prev`; keep each once.
      setLogs((prev) => {
        const seen = new Set(entries.map((entry) => `${entry.at}|${entry.scope}|${entry.message}`));
        return [...entries, ...prev.filter((entry) => !seen.has(`${entry.at}|${entry.scope}|${entry.message}`))].slice(-MAX_LINES);
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const visible = useMemo(() => logs.filter((entry) => LEVEL_RANK[entry.level] >= LEVEL_RANK[minLevel]), [logs, minLevel]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [visible]);

  const asText = visible.map(formatLine).join('\n');

  return (
    <Group title="Activity log" description="Recent app events, newest last. Kept in memory only.">
      <div className="st-row">
        <SelectField<Level>
          label="Minimum level"
          value={minLevel}
          options={[
            { value: 'debug', label: 'Debug' },
            { value: 'info', label: 'Info' },
            { value: 'warn', label: 'Warnings' },
            { value: 'error', label: 'Errors' }
          ]}
          onChange={setMinLevel}
        />
        <span className="st-spacer" />
        <CopyButton text={asText} label="Copy logs" />
        <Button variant="ghost" onClick={() => setLogs([])} aria-label="Clear log view">
          <Eraser size={14} aria-hidden /> Clear
        </Button>
      </div>
      <div className="st-logs" ref={listRef} role="log" aria-live="off">
        {visible.length === 0 && <div className="st-muted">No entries.</div>}
        {visible.map((entry, index) => (
          <div key={`${entry.at}-${index}`} className={`st-log is-${entry.level}`}>
            {formatLine(entry)}
          </div>
        ))}
      </div>
    </Group>
  );
}

function formatLine(entry: LogEntry): string {
  const time = new Date(entry.at).toISOString().slice(11, 23);
  return `${time} ${entry.level.toUpperCase().padEnd(5)} ${entry.scope}  ${entry.message}`;
}

