import { useState } from 'react';
import { FileCode2 } from 'lucide-react';
import type { CodingTask, ReviewTarget } from '@shared/types';
import { Popover } from '../common/Popover';

/** Coding workflows preserve the message draft and use the same submission boundary as the CLI. */
export function CodingActions({ disabled, onRun }: { disabled: boolean; onRun(task: CodingTask, focus: string): Promise<boolean> }) {
  return (
    <Popover
      label="Coding workflows"
      panelClassName="is-coding"
      trigger={({ open, toggle }) => (
        <button type="button" className="icon-btn" aria-label="Coding workflows" title="Review changes or create project instructions" aria-expanded={open} disabled={disabled} onClick={toggle}>
          <FileCode2 size={16} aria-hidden="true" />
        </button>
      )}
    >
      {(close) => <CodingTaskForm disabled={disabled} onRun={async (task, focus) => { if (await onRun(task, focus)) close(); }} />}
    </Popover>
  );
}

function CodingTaskForm({ disabled, onRun }: { disabled: boolean; onRun(task: CodingTask, focus: string): Promise<void> }) {
  const [kind, setKind] = useState<CodingTask['kind']>('review');
  const [scope, setScope] = useState<ReviewTarget['kind']>('uncommitted');
  const [revision, setRevision] = useState('');
  const [focus, setFocus] = useState('');
  return (
    <form className="coding-task-form" onSubmit={(event) => {
      event.preventDefault();
      const task: CodingTask = kind === 'init' ? { kind } : { kind, target: scope === 'uncommitted' ? { kind: scope } : { kind: scope, revision: revision.trim() } };
      void onRun(task, kind === 'review' ? focus.trim() : '');
    }}>
      <label>
        Task
        <select aria-label="Coding task" value={kind} onChange={(event) => setKind(event.target.value as CodingTask['kind'])}>
          <option value="review">Review changes</option>
          <option value="init">Create project instructions</option>
        </select>
      </label>
      {kind === 'review' ? (
        <>
          <label>
            Review scope
            <select aria-label="Review scope" value={scope} onChange={(event) => setScope(event.target.value as ReviewTarget['kind'])}>
              <option value="uncommitted">Uncommitted changes</option>
              <option value="base">Changes since a base revision</option>
              <option value="commit">One commit</option>
            </select>
          </label>
          {scope !== 'uncommitted' && <label>
            {scope === 'base' ? 'Base branch, tag or commit' : 'Commit'}
            <input value={revision} placeholder={scope === 'base' ? 'main' : 'HEAD'} required onChange={(event) => setRevision(event.target.value)} />
          </label>}
          <label>
            Focus (optional)
            <textarea rows={2} value={focus} placeholder="Correctness, regressions, security…" onChange={(event) => setFocus(event.target.value)} />
          </label>
          <p>Find actionable bugs without editing files.</p>
        </>
      ) : <p>Inspect the project and create AGENTS.md. If it exists, suggest improvements without overwriting it.</p>}
      <button type="submit" className="btn btn-primary" disabled={disabled || kind === 'review' && scope !== 'uncommitted' && !revision.trim()}>
        {kind === 'review' ? 'Start review' : 'Create instructions'}
      </button>
    </form>
  );
}
