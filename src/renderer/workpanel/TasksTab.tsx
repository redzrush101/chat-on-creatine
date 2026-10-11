import { useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { ChevronDown, ChevronRight, Square } from 'lucide-react';
import type { SessionEvent, ToolOutputPart, WorkerInfo, WorkerState } from '@shared/types';
import { invoke } from '../lib/bridge';
import { useAppState, useSessionEvents } from '../lib/store';
import { cx, formatClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Empty, useAction, Notice } from './common';

const WORKER_STATE: Record<WorkerState, string> = {
  queued: 'Queued',
  working: 'Running',
  asleep: 'Idle',
  finished: 'Finished',
  failed: 'Stopped'
};

type ExecPart = Extract<ToolOutputPart, { type: 'exec' }>;

interface CommandTask {
  id: string;
  part: ExecPart;
  startedAt: number;
  endedAt: number | null;
}

/**
 * Commands this chat ran, newest state per command: a background command polled with write_stdin
 * shows once, under the call that started it.
 */
function commandTasks(events: SessionEvent[]): CommandTask[] {
  const byKey = new Map<string, CommandTask>();
  for (const event of events) {
    if (event.kind !== 'tool') continue;
    event.output.forEach((part, index) => {
      if (part.type !== 'exec') return;
      // Process ids restart with the app, so the command text keeps two runs apart.
      const key = part.sessionId ? `exec:${part.sessionId}:${part.command}` : `${event.id}:${index}`;
      const known = byKey.get(key);
      const endedAt = part.running ? null : (event.endedAt ?? event.at);
      byKey.set(key, { id: key, part, startedAt: known?.startedAt ?? event.at, endedAt });
    });
  }
  return [...byKey.values()].reverse();
}

/** Agents and commands of this chat, like the Claude app's background tasks panel. */
export function TasksTab({ sessionId, onOpenSession }: { sessionId: string; onOpenSession(sessionId: string): void }): JSX.Element {
  const state = useAppState();
  const events = useSessionEvents(sessionId);
  const [error, runAction] = useAction();
  const workers = state?.agents.find((item) => item.primeSessionId === sessionId)?.workers ?? [];
  const commands = useMemo(() => (events ? commandTasks(events) : []), [events]);
  const liveWorker = (worker: WorkerInfo) => worker.state === 'queued' || worker.state === 'working' || worker.state === 'asleep';
  const running = workers.filter((worker) => worker.state === 'working' || worker.state === 'queued').length + commands.filter((task) => task.part.running).length;
  const done = workers.length + commands.length - running;

  if (workers.length === 0 && commands.length === 0) {
    return <Empty title="No background tasks">Agents this chat starts and commands it runs appear here.</Empty>;
  }

  return (
    <div className="wp-tasks">
      {error && <Notice tone="error">{error}</Notice>}
      <TaskGroup title="Running" count={running}>
        {workers.filter((worker) => worker.state === 'working' || worker.state === 'queued').map((worker) => (
          <WorkerCard key={worker.sessionId} worker={worker} onOpen={() => onOpenSession(worker.sessionId)} onStop={() => void runAction(() => invoke('agents:stopWorker', worker.sessionId))} />
        ))}
        {commands.filter((task) => task.part.running).map((task) => <CommandCard key={task.id} task={task} />)}
      </TaskGroup>
      <TaskGroup title="Done" count={done}>
        {workers.filter((worker) => worker.state !== 'working' && worker.state !== 'queued').map((worker) => (
          <WorkerCard
            key={worker.sessionId}
            worker={worker}
            onOpen={() => onOpenSession(worker.sessionId)}
            onStop={liveWorker(worker) ? () => void runAction(() => invoke('agents:stopWorker', worker.sessionId)) : undefined}
          />
        ))}
        {commands.filter((task) => !task.part.running).map((task) => <CommandCard key={task.id} task={task} />)}
      </TaskGroup>
    </div>
  );
}

function TaskGroup({ title, count, children }: { title: string; count: number; children: ReactNode }): JSX.Element | null {
  const [open, setOpen] = useState(true);
  if (count === 0) return null;
  return (
    <section className="wp-task-group">
      <button type="button" className="wp-task-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title} {count}
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
      </button>
      {open && <div className="wp-task-list">{children}</div>}
    </section>
  );
}

function WorkerCard({ worker, onOpen, onStop }: { worker: WorkerInfo; onOpen(): void; onStop?: () => void }): JSX.Element {
  return (
    <article className="wp-task">
      <div className="wp-task-title" title={worker.task}>{worker.label}</div>
      <div className="wp-task-meta">
        <span>Agent</span>
        <span className={cx('wp-task-state', `is-${worker.state}`)}>{WORKER_STATE[worker.state]}</span>
      </div>
      <div className="wp-task-meta">
        <span>{[worker.model, worker.reasoning].filter(Boolean).join(' · ') || 'Default model'}</span>
        <button type="button" className="wp-link" onClick={onOpen}>
          View transcript
        </button>
        {onStop && (
          <button type="button" className="wp-link is-danger" onClick={onStop}>
            <Square size={10} aria-hidden /> Stop
          </button>
        )}
      </div>
      {worker.lastResult && <p className="wp-task-excerpt">{worker.lastResult.replace(/\s+/g, ' ').trim().slice(0, 360)}</p>}
    </article>
  );
}

function CommandCard({ task }: { task: CommandTask }): JSX.Element {
  const [open, setOpen] = useState(false);
  const now = useNow(task.part.running);
  const elapsed = formatClock((task.endedAt ?? now) - task.startedAt);
  const { part } = task;
  const status = part.running ? 'Running' : part.exitCode === 0 ? 'Completed' : part.exitCode === null ? 'Ended' : `Failed (exit ${part.exitCode})`;
  return (
    <article className={cx('wp-task', open && 'is-open')}>
      <button type="button" className="wp-task-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="wp-task-title is-code" title={part.command}>{part.command.replace(/\s+/g, ' ')}</span>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
      </button>
      <div className="wp-task-meta">
        <span>Shell</span>
        <span className={cx('wp-task-state', part.running ? 'is-working' : part.exitCode === 0 ? 'is-finished' : 'is-failed')}>{status}</span>
        <span className="wp-task-clock">{elapsed}</span>
      </div>
      {open && (
        <div className="wp-task-body">
          <pre className="wp-task-cmd">
            <span aria-hidden>$ </span>
            {part.command}
          </pre>
          {part.output ? <pre className="wp-task-out">{part.output}</pre> : <p className="wp-muted">No output.</p>}
        </div>
      )}
    </article>
  );
}
