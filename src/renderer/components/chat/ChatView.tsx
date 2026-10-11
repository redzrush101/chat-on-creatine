import { useState } from 'react';
import type { AppState, SessionMeta } from '@shared/types';
import { useSessionEvents } from '../../lib/store';
import { Composer } from '../composer/Composer';
import type { NewChatDraft } from '../composer/types';
import { TopBar } from './TopBar';
import { Timeline } from './Timeline';

interface ChatViewProps {
  app: AppState;
  session: SessionMeta;
  sidebarOpen: boolean;
  workPanelOpen: boolean;
  newChat: NewChatDraft;
  onNewChatChange(patch: Partial<NewChatDraft>): void;
  onToggleSidebar(): void;
  onToggleWorkPanel(): void;
  onOpenSession(sessionId: string): void;
  onOpenSettings(section?: string): void;
}

export function ChatView({
  app,
  session,
  sidebarOpen,
  workPanelOpen,
  newChat,
  onNewChatChange,
  onToggleSidebar,
  onToggleWorkPanel,
  onOpenSession,
  onOpenSettings
}: ChatViewProps) {
  const events = useSessionEvents(session.id);
  const live = app.live[session.id];
  const busy = live !== undefined && live.turn !== 'idle';
  const [followNonce, setFollowNonce] = useState(0);

  return (
    <section className="chat" aria-label="Chat">
      <TopBar
        app={app}
        session={session}
        sidebarOpen={sidebarOpen}
        workPanelOpen={workPanelOpen}
        onToggleSidebar={onToggleSidebar}
        onToggleWorkPanel={onToggleWorkPanel}
      />
      <Timeline sessionId={session.id} events={events} busy={busy} followNonce={followNonce} onOpenSession={onOpenSession} />
      <Composer
        key={session.id}
        app={app}
        session={session}
        newChat={newChat}
        onNewChatChange={onNewChatChange}
        onCreated={onOpenSession}
        onSubmitted={() => setFollowNonce((value) => value + 1)}
        onOpenSettings={onOpenSettings}
        focusNonce={0}
      />
    </section>
  );
}
