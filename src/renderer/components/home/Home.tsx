import { useState } from 'react';
import { FolderOpen, Settings2 } from 'lucide-react';
import type { AppState } from '@shared/types';
import { Composer, type NewChatDraft } from '../composer/Composer';
import { TopBar } from '../chat/TopBar';

const STARTERS = [
  'Summarize how this project is organized',
  'Find the failing tests and explain why they fail',
  'Review my uncommitted changes for bugs',
  'Write a short README for this folder'
];

interface HomeProps {
  app: AppState;
  newChat: NewChatDraft;
  sidebarOpen: boolean;
  workPanelOpen: boolean;
  focusNonce: number;
  onNewChatChange(patch: Partial<NewChatDraft>): void;
  onCreated(sessionId: string): void;
  onToggleSidebar(): void;
  onToggleWorkPanel(): void;
  onOpenSettings(section?: string): void;
}

/** New chat: a centered composer, a project choice, starters and the setup link while setup is incomplete. */
export function Home({
  app,
  newChat,
  sidebarOpen,
  workPanelOpen,
  focusNonce,
  onNewChatChange,
  onCreated,
  onToggleSidebar,
  onToggleWorkPanel,
  onOpenSettings
}: HomeProps) {
  const [prefill, setPrefill] = useState<{ id: number; text: string } | undefined>();
  const needsSetup = app.config.roots.length === 0 || app.connection.state !== 'connected';

  return (
    <section className="home" aria-label="New chat">
      <TopBar app={app} session={null} sidebarOpen={sidebarOpen} workPanelOpen={workPanelOpen} onToggleSidebar={onToggleSidebar} onToggleWorkPanel={onToggleWorkPanel} />
      <div className="home-body">
        <h1 className="home-title">What should we work on?</h1>
        <label className="home-project">
          <FolderOpen size={13} aria-hidden="true" />
          <span>Project</span>
          <select
            value={newChat.projectId ?? ''}
            onChange={(event) => onNewChatChange({ projectId: event.target.value || null })}
          >
            <option value="">No project</option>
            {app.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <Composer
          hero
          app={app}
          session={null}
          newChat={newChat}
          onNewChatChange={onNewChatChange}
          onCreated={onCreated}
          onSubmitted={() => undefined}
          onOpenSettings={onOpenSettings}
          focusNonce={focusNonce}
          prefill={prefill}
        />
        <ul className="starters" aria-label="Starter prompts">
          {STARTERS.map((text) => (
            <li key={text}>
              <button type="button" className="starter" onClick={() => setPrefill({ id: Date.now(), text })}>
                {text}
              </button>
            </li>
          ))}
        </ul>
        {needsSetup && (
          <button type="button" className="setup-link" onClick={() => onOpenSettings('setup')}>
            <Settings2 size={13} aria-hidden="true" />
            Finish setup: approve a folder and connect ChatGPT tools
          </button>
        )}
      </div>
    </section>
  );
}
