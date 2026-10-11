import type { JSX } from 'react';
import { ExternalLink, Square } from 'lucide-react';
import type { WorkerInfo, WorkerState } from '@shared/types';
import { invoke } from '../lib/bridge';
import { useAppState } from '../lib/store';
import { Empty, useAction, Notice } from './common';

const STATE_LABEL: Record<WorkerState, string> = {
  queued: 'Queued',
  working: 'Working',
  asleep: 'Idle',
  finished: 'Finished',
  failed: 'Failed'
};

const EXCERPT_LIMIT = 360;

export function WorkersTab({ sessionId }: { sessionId: string }): JSX.Element {
  const state = useAppState();
  const [error, runAction] = useAction();
  const workers = state?.agents.find((item) => item.primeSessionId === sessionId)?.workers ?? [];

  if (workers.length === 0) {
    return <Empty title="No workers">Workers this chat starts for parallel tasks appear here.</Empty>;
  }

  return (
    <div className="wp-workers">
      {error && <Notice tone="error">{error}</Notice>}
      {workers.map((worker) => (
        <WorkerCard key={worker.sessionId} worker={worker} onStop={() => void runAction(() => invoke('agents:stopWorker', worker.sessionId))} />
      ))}
    </div>
  );
}

function WorkerCard({ worker, onStop }: { worker: WorkerInfo; onStop(): void }): JSX.Element {
  const live = worker.state === 'queued' || worker.state === 'working' || worker.state === 'asleep';
  const excerpt = worker.lastResult ? excerptOf(worker.lastResult) : null;
  return (
    <article className="wp-card">
      <header className="wp-card-head">
        <strong className="wp-card-title">{worker.label}</strong>
        <span className={`wp-chip is-${worker.state}`}>{STATE_LABEL[worker.state]}</span>
      </header>
      {worker.task && <p className="wp-muted wp-clamp-2">{worker.task}</p>}
      <p className="wp-meta">
        {[worker.model, worker.reasoning].filter(Boolean).join(' · ') || 'Default model'}
      </p>
      {excerpt && <blockquote className="wp-excerpt">{excerpt}</blockquote>}
      <div className="wp-card-actions">
        <button
          type="button"
          className="wp-btn"
          onClick={() => window.dispatchEvent(new CustomEvent('creatine:open-session', { detail: worker.sessionId }))}
        >
          <ExternalLink size={14} aria-hidden /> Open
        </button>
        {live && (
          <button type="button" className="wp-btn is-danger" onClick={onStop}>
            <Square size={13} aria-hidden /> Stop
          </button>
        )}
      </div>
    </article>
  );
}

function excerptOf(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > EXCERPT_LIMIT ? `${collapsed.slice(0, EXCERPT_LIMIT)}…` : collapsed;
}
