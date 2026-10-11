import { useState } from 'react';
import { Folder, Globe, PanelLeft, PanelRight, Repeat, Target } from 'lucide-react';
import type { AppState, GoalState, SessionMeta } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { cx, formatTokens } from '../../lib/format';
import { reportError } from '../common/Toasts';
import { InlineEdit } from '../common/InlineEdit';
import { Popover } from '../common/Popover';
import { ModelPicker } from '../composer/ModelPicker';

interface TopBarProps {
  app: AppState;
  session: SessionMeta | null;
  sidebarOpen: boolean;
  workPanelOpen: boolean;
  onToggleSidebar(): void;
  onToggleWorkPanel(): void;
}

export function TopBar({ app, session, sidebarOpen, workPanelOpen, onToggleSidebar, onToggleWorkPanel }: TopBarProps) {
  const project = session?.projectId ? app.projects.find((item) => item.id === session.projectId) : null;
  return (
    <header className={cx('topbar', !sidebarOpen && 'is-sidebar-hidden')}>
      <div className="topbar-start">
        {!sidebarOpen && (
          <button type="button" className="icon-btn" aria-label="Show sidebar" title="Show sidebar (Ctrl+B)" onClick={onToggleSidebar}>
            <PanelLeft size={16} />
          </button>
        )}
        {session && (
          <>
            <TitleEditor key={session.id} session={session} />
            <span className="chip" title={session.cwd ?? project?.path ?? 'No project folder'}>
              <Folder size={12} aria-hidden="true" />
              <span className="chip-text">{project?.name ?? 'No project'}</span>
            </span>
            <ModelPicker
              value={{ model: session.model, reasoning: session.reasoning }}
              catalog={app.models}
              onChange={(value) => {
                invoke('sessions:update', session.id, { model: value.model, reasoning: value.reasoning }).catch(reportError);
              }}
            />
            {session.goal.mode !== 'off' && <GoalBadge goal={session.goal} maxSteps={app.config.automation.maxSteps} />}
          </>
        )}
      </div>
      <div className="topbar-end">
        {session && (
          <>
            <ContextMeter sessionId={session.id} tokens={session.contextTokens} advisory={app.config.context.advisoryTokens} />
            <button
              type="button"
              className="btn btn-ghost"
              title="Open the ChatGPT page for this chat"
              onClick={() => invoke('browser:show', session.id).catch(reportError)}
            >
              <Globe size={14} aria-hidden="true" />
              <span>Show ChatGPT</span>
            </button>
          </>
        )}
        <button
          type="button"
          className={cx('icon-btn', workPanelOpen && 'is-active')}
          aria-label={workPanelOpen ? 'Hide work panel' : 'Show work panel'}
          aria-pressed={workPanelOpen}
          title={`${workPanelOpen ? 'Hide' : 'Show'} work panel (Ctrl+J)`}
          onClick={onToggleWorkPanel}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  );
}

function TitleEditor({ session }: { session: SessionMeta }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <InlineEdit
        className="inline-edit title-edit"
        label="Chat title"
        value={session.title}
        onCancel={() => setEditing(false)}
        onCommit={(title) => {
          setEditing(false);
          invoke('sessions:update', session.id, { title }).catch(reportError);
        }}
      />
    );
  }
  return (
    <button type="button" className="title" title="Rename chat" onClick={() => setEditing(true)}>
      {session.title || 'New chat'}
    </button>
  );
}

const GOAL_STATUS: Record<GoalState['status'], string> = {
  idle: 'Active',
  deciding: 'Deciding next step',
  'waiting-workers': 'Waiting for workers',
  done: 'Done',
  stopped: 'Stopped',
  error: 'Error'
};

function GoalBadge({ goal, maxSteps }: { goal: GoalState; maxSteps: number }) {
  const isLoop = goal.mode === 'loop';
  const Icon = isLoop ? Repeat : Target;
  return (
    <span className={cx('chip goal-badge', `is-${goal.status}`)} title={goal.objective || undefined}>
      <Icon size={12} aria-hidden="true" />
      <span className="chip-text">
        {isLoop ? 'Loop' : 'Goal'} · {GOAL_STATUS[goal.status]} · {goal.steps}/{maxSteps}
      </span>
    </span>
  );
}

function ContextMeter({ sessionId, tokens, advisory }: { sessionId: string; tokens: number; advisory: number }) {
  const ratio = advisory > 0 ? tokens / advisory : 0;
  const percent = Math.min(100, Math.round(ratio * 100));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <Popover
      label="Context"
      align="end"
      panelClassName="is-context"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={cx('context-meter', ratio >= 0.8 && 'is-high', ratio >= 1 && 'is-over')}
          aria-expanded={open}
          aria-label={`Context about ${percent}% of the advisory limit`}
          title="Context estimate"
          onClick={toggle}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r={radius} className="ring-track" />
            <circle
              cx="8"
              cy="8"
              r={radius}
              className="ring-fill"
              strokeDasharray={`${(Math.min(ratio, 1) * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
            />
          </svg>
          <span>{percent}%</span>
        </button>
      )}
    >
      {(close) => (
        <div className="context-panel">
          <p className="context-title">Context</p>
          <p className="context-figure">
            About {formatTokens(tokens)} of {formatTokens(advisory)} tokens (local estimate)
          </p>
          <p className="context-hint">
            {ratio >= 1
              ? 'This chat is long. Compact to continue in a fresh ChatGPT chat with a handoff brief.'
              : 'Compact & resume continues in a fresh ChatGPT chat with a handoff brief.'}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              close();
              invoke('chat:compact', sessionId).catch(reportError);
            }}
          >
            Compact &amp; resume
          </button>
        </div>
      )}
    </Popover>
  );
}
