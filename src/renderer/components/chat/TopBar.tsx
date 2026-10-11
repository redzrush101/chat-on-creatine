import { useState } from 'react';
import { ChevronDown, Ellipsis, FileDiff, FolderOpen, Globe, Layers, ListChecks, MessageSquare, PanelLeft, PanelRightClose, Repeat, Target, Minimize2, SquareTerminal } from 'lucide-react';
import type { AppState, GoalState, SessionMeta } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { cx } from '../../lib/format';
import { reportError } from '../common/Toasts';
import { InlineEdit } from '../common/InlineEdit';
import { Menu, MenuButton, type MenuEntry } from '../common/Popover';
import { updateSession, useSessionMenu } from '../sidebar/session-menu';
import type { PanelTab } from '../../workpanel/WorkPanel';

interface TopBarProps {
  app: AppState;
  session: SessionMeta | null;
  sidebarOpen: boolean;
  /** The work panel tab on show, or null while the panel is closed. */
  panel: PanelTab | null;
  onToggleSidebar(): void;
  onPanel(tab: PanelTab | null): void;
  onDeleted?(sessionId: string): void;
}

const PANEL_BUTTONS: { tab: PanelTab; label: string; icon: typeof SquareTerminal }[] = [
  { tab: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { tab: 'changes', label: 'Changes', icon: FileDiff },
  { tab: 'files', label: 'Files', icon: FolderOpen }
];

export function TopBar({ app, session, sidebarOpen, panel, onToggleSidebar, onPanel, onDeleted }: TopBarProps) {
  const project = session?.projectId ? app.projects.find((item) => item.id === session.projectId) : null;
  const togglePanel = (tab: PanelTab) => onPanel(panel === tab ? null : tab);
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
            <TitleMenu key={session.id} app={app} session={session} onDeleted={onDeleted ?? (() => undefined)} />
            <span className="chip topbar-optional" title={session.cwd ?? project?.path ?? 'No project folder'}>
              <span className="chip-text">{project?.name ?? 'No project'}</span>
            </span>
            {session.goal.mode !== 'off' && <GoalBadge goal={session.goal} maxSteps={app.config.automation.maxSteps} />}
          </>
        )}
      </div>
      {session && (
        <div className="topbar-end">
          {PANEL_BUTTONS.map(({ tab, label, icon: Icon }) => (
            <button
              key={tab}
              type="button"
              className={cx('icon-btn', panel === tab && 'is-active')}
              aria-label={label}
              aria-pressed={panel === tab}
              title={label}
              onClick={() => togglePanel(tab)}
            >
              <Icon size={16} />
            </button>
          ))}
          <button
            type="button"
            className="icon-btn"
            aria-label="Show ChatGPT"
            title="Open the ChatGPT page for this chat"
            onClick={() => invoke('browser:show', session.id).catch(reportError)}
          >
            <Globe size={16} />
          </button>
          <MenuButton
            label="More"
            icon={Ellipsis}
            entries={[
              { label: 'Background tasks', icon: Layers, checked: panel === 'tasks', onSelect: () => togglePanel('tasks') },
              { label: 'Plan', icon: ListChecks, checked: panel === 'plan', onSelect: () => togglePanel('plan') },
              { kind: 'separator' },
              { label: 'Compact & resume', icon: Minimize2, onSelect: () => invoke('chat:compact', session.id).catch(reportError) },
              ...(panel ? [{ label: 'Hide panel', icon: PanelRightClose, onSelect: () => onPanel(null) } satisfies MenuEntry] : [])
            ]}
          />
        </div>
      )}
    </header>
  );
}

/** Chat title with a chevron, like the Claude app: it opens the chat's actions; Rename edits in place. */
function TitleMenu({ app, session, onDeleted }: { app: AppState; session: SessionMeta; onDeleted(sessionId: string): void }) {
  const [editing, setEditing] = useState(false);
  const { entries, dialog } = useSessionMenu(session, app.projects, () => setEditing(true), onDeleted);
  if (editing) {
    return (
      <InlineEdit
        className="inline-edit title-edit"
        label="Chat title"
        value={session.title}
        onCancel={() => setEditing(false)}
        onCommit={(title) => {
          setEditing(false);
          updateSession(session.id, { title });
        }}
      />
    );
  }
  return (
    <>
      <Menu
        entries={entries}
        label="Chat actions"
        trigger={({ open, toggle }) => (
          <button type="button" className="title" aria-haspopup="menu" aria-expanded={open} title={session.title || 'New chat'} onClick={toggle} onDoubleClick={() => setEditing(true)}>
            <MessageSquare size={15} className="title-icon" aria-hidden="true" />
            <span className="title-text">{session.title || 'New chat'}</span>
            <ChevronDown size={14} className="title-chevron" aria-hidden="true" />
          </button>
        )}
      />
      {dialog}
    </>
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
