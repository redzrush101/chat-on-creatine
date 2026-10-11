import { useState } from 'react';
import { Asterisk, FolderOpen, Settings2 } from 'lucide-react';
import type { AppState } from '@shared/types';
import { Composer } from '../composer/Composer';
import type { NewChatDraft } from '../composer/types';
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
  focusNonce: number;
  onNewChatChange(patch: Partial<NewChatDraft>): void;
  onCreated(sessionId: string): void;
  onToggleSidebar(): void;
  onOpenSettings(section?: string): void;
}

/** New chat: a centered composer, a project choice, starters and the setup link while setup is incomplete. */
export function Home({
  app,
  newChat,
  sidebarOpen,
  focusNonce,
  onNewChatChange,
  onCreated,
  onToggleSidebar,
  onOpenSettings
}: HomeProps) {
  const [prefill, setPrefill] = useState<{ id: number; text: string } | undefined>();
  const needsSetup = app.config.roots.length === 0 || app.connection.state !== 'connected';

  return (
    <section className="home" aria-label="New chat">
      <TopBar app={app} session={null} sidebarOpen={sidebarOpen} panel={null} onToggleSidebar={onToggleSidebar} onPanel={() => undefined} />
      <div className="home-body">
        <h1 className="home-title">
          <Asterisk size={34} strokeWidth={2.5} className="home-mark" aria-hidden="true" />
          What should we work on?
        </h1>
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
