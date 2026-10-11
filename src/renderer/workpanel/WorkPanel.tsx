import { lazy, Suspense, type JSX } from 'react';
import { ChevronDown, FileDiff, FolderOpen, Layers, ListChecks, Maximize2, Minimize2, SquareTerminal, X } from 'lucide-react';
import { chatFolder } from '../lib/folders';
import { useAppState } from '../lib/store';
import { Menu } from '../components/common/Popover';
import { ChangesTab } from './ChangesTab';
import { PlanTab } from './PlanTab';
import { TasksTab } from './TasksTab';
import './workpanel.css';

// The file viewer (CodeMirror) and the terminal (xterm) are most of the app's code; load them when opened.
const FilesTab = lazy(() => import('./FilesTab').then((module) => ({ default: module.FilesTab })));
const TerminalTab = lazy(() => import('./TerminalTab').then((module) => ({ default: module.TerminalTab })));

export type PanelTab = 'tasks' | 'plan' | 'files' | 'changes' | 'terminal';

const PANEL_TABS: readonly { id: PanelTab; label: string; icon: typeof ListChecks }[] = [
  { id: 'tasks', label: 'Background tasks', icon: Layers },
  { id: 'plan', label: 'Plan', icon: ListChecks },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal }
];

export function isPanelTab(value: unknown): value is PanelTab {
  return PANEL_TABS.some((tab) => tab.id === value);
}

interface WorkPanelProps {
  sessionId: string;
  tab: PanelTab;
  wide: boolean;
  onTab(tab: PanelTab): void;
  onToggleWide(): void;
  onClose(): void;
  onOpenSession(sessionId: string): void;
}

/** The side panel beside a chat, one view at a time, switched from the top bar or this title menu. */
export function WorkPanel({ sessionId, tab, wide, onTab, onToggleWide, onClose, onOpenSession }: WorkPanelProps): JSX.Element {
  const state = useAppState();
  const session = state?.sessions.find((item) => item.id === sessionId) ?? null;
  const rootDir = state ? chatFolder(state, session) : null;
  const current = PANEL_TABS.find((item) => item.id === tab) ?? PANEL_TABS[0]!;

  return (
    <aside className="wp">
      <header className="wp-head">
        <Menu
          label="Panel view"
          entries={PANEL_TABS.map((item) => ({ label: item.label, icon: item.icon, checked: item.id === tab, onSelect: () => onTab(item.id) }))}
          trigger={({ open, toggle }) => (
            <button type="button" className="wp-title" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <span>{current.label}</span>
              <ChevronDown size={13} aria-hidden />
            </button>
          )}
        />
        <span className="wp-spacer" />
        <button type="button" className="icon-btn" aria-label={wide ? 'Narrow panel' : 'Widen panel'} title={wide ? 'Narrow panel' : 'Widen panel'} onClick={onToggleWide}>
          {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button type="button" className="icon-btn" aria-label="Close panel" title="Close panel (Ctrl+J)" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <div className="wp-body" role="region" aria-label={current.label}>
        {tab === 'tasks' && <TasksTab sessionId={sessionId} onOpenSession={onOpenSession} />}
        {tab === 'plan' && <PlanTab sessionId={sessionId} />}
        <Suspense fallback={null}>
          {tab === 'files' && <FilesTab rootDir={rootDir} />}
          {tab === 'changes' && <ChangesTab rootDir={rootDir} />}
          {tab === 'terminal' && <TerminalTab rootDir={rootDir} />}
        </Suspense>
      </div>
    </aside>
  );
}
