import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { FolderTree, GitBranch, ListChecks, SquareTerminal, Users } from 'lucide-react';
import { useAppState } from '../lib/store';
import { ChangesTab } from './ChangesTab';
import { Empty } from './common';
import { FilesTab } from './FilesTab';
import { PlanTab } from './PlanTab';
import { TerminalTab } from './TerminalTab';
import { WorkersTab } from './WorkersTab';
import './workpanel.css';

type TabId = 'plan' | 'workers' | 'files' | 'changes' | 'terminal';

const TABS: readonly { id: TabId; label: string; icon: typeof ListChecks }[] = [
  { id: 'plan', label: 'Plan', icon: ListChecks },
  { id: 'workers', label: 'Workers', icon: Users },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'changes', label: 'Changes', icon: GitBranch },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal }
];

const TAB_KEY = 'creatine.workPanel.tab';

function readTab(): TabId {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    return TABS.some((tab) => tab.id === stored) ? (stored as TabId) : 'plan';
  } catch {
    return 'plan';
  }
}

export function WorkPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const state = useAppState();
  const [tab, setTab] = useState<TabId>(readTab);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Remembering the tab is a convenience; the panel works without it.
    }
  }, [tab]);

  if (!sessionId) {
    return (
      <aside className="wp">
        <Empty title="No chat selected">Open a chat to see its plan, workers, files, changes and terminal here.</Empty>
      </aside>
    );
  }

  const session = state?.sessions.find((item) => item.id === sessionId) ?? null;
  const project = session?.projectId ? state?.projects.find((item) => item.id === session.projectId) : undefined;
  // The folder the chat works in: its own cwd, then its project, then the first approved folder.
  const rootDir = session?.cwd ?? project?.path ?? state?.config.roots[0]?.path ?? null;

  return (
    <aside className="wp">
      <div className="wp-tabs" role="tablist" aria-label="Work panel">
        {TABS.map((item) => {
          const Icon = item.icon;
          const active = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={active ? 'wp-tab is-active' : 'wp-tab'}
              title={item.label}
              onClick={() => setTab(item.id)}
            >
              <Icon size={15} aria-hidden />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="wp-body" role="tabpanel">
        {tab === 'plan' && <PlanTab sessionId={sessionId} />}
        {tab === 'workers' && <WorkersTab sessionId={sessionId} />}
        {tab === 'files' && <FilesTab rootDir={rootDir} />}
        {tab === 'changes' && <ChangesTab rootDir={rootDir} />}
        {tab === 'terminal' && <TerminalTab rootDir={rootDir} />}
      </div>
    </aside>
  );
}
