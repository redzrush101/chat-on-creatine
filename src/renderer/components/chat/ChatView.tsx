import { useMemo, useState } from 'react';
import type { AppState, SessionMeta } from '@shared/types';
import { useSessionEvents } from '../../lib/store';
import { Composer } from '../composer/Composer';
import type { NewChatDraft } from '../composer/types';
import type { PanelTab } from '../../workpanel/WorkPanel';
import type { EventActions } from './EventRow';
import { TopBar } from './TopBar';
import { Timeline } from './Timeline';
import { turnActivity } from './turn-activity';

interface ChatViewProps {
  app: AppState;
  session: SessionMeta;
  sidebarOpen: boolean;
  panel: PanelTab | null;
  /** The folder the chat works in, for its git changes. */
  rootDir: string | null;
  newChat: NewChatDraft;
  onNewChatChange(patch: Partial<NewChatDraft>): void;
  onToggleSidebar(): void;
  onPanel(tab: PanelTab | null): void;
  onOpenSession(sessionId: string): void;
  onOpenSettings(section?: string): void;
  onDeleted(sessionId: string): void;
  /** A search hit in this chat to scroll to. */
  found: { eventId: string; at: number } | null;
}

export function ChatView({
  app,
  session,
  sidebarOpen,
  panel,
  rootDir,
  newChat,
  onNewChatChange,
  onToggleSidebar,
  onPanel,
  onOpenSession,
  onOpenSettings,
  onDeleted,
  found
}: ChatViewProps) {
  const events = useSessionEvents(session.id);
  const live = app.live[session.id];
  const busy = live !== undefined && live.turn !== 'idle';
  const [followNonce, setFollowNonce] = useState(0);
  const [prefill, setPrefill] = useState<{ id: number; text: string } | undefined>();
  // Stable, so memoized timeline rows do not re-render on every state push.
  const actions = useMemo<EventActions>(() => ({ onOpenSession, onReuse: (text) => setPrefill({ id: Date.now(), text }) }), [onOpenSession]);

  return (
    <section className="chat" aria-label="Chat">
      <TopBar app={app} session={session} sidebarOpen={sidebarOpen} panel={panel} onToggleSidebar={onToggleSidebar} onPanel={onPanel} onDeleted={onDeleted} />
      <Timeline sessionId={session.id} events={events} busy={busy} followNonce={followNonce} found={found} actions={actions} />
      <Composer
        key={session.id}
        app={app}
        session={session}
        activity={turnActivity(session, live, events)}
        newChat={newChat}
        onNewChatChange={onNewChatChange}
        onCreated={onOpenSession}
        onSubmitted={() => setFollowNonce((value) => value + 1)}
        onOpenSettings={onOpenSettings}
        focusNonce={0}
        prefill={prefill}
        rootDir={rootDir}
        onReviewChanges={() => onPanel('changes')}
      />
    </section>
  );
}
