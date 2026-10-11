import { useEffect, useRef, useState } from 'react';
import { invoke } from './lib/bridge';
import { Toaster, reportError } from './components/common/Toasts';
import { Resizer } from './components/common/Resizer';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatView } from './components/chat/ChatView';
import { Home } from './components/home/Home';
import type { ModelValue } from './components/composer/ModelPicker';
import type { NewChatDraft } from './components/composer/Composer';
import { SettingsView } from './settings/SettingsView';
import { WorkPanel } from './workpanel/WorkPanel';
import { useAppState } from './lib/store';
import { useResize, useStoredState, useSystemDark } from './lib/hooks';

const DEFAULT_SIDEBAR_WIDTH = 272;
const DEFAULT_PANEL_WIDTH = 420;

/** New-chat choices; `model` stays null until the user picks one, so config defaults apply. */
interface DraftChoices {
  projectId: string | null;
  model: ModelValue | null;
  mode: NewChatDraft['mode'];
}

export function App() {
  const app = useAppState();
  const systemDark = useSystemDark();
  const [selectedId, setSelectedId] = useStoredState<string | null>('creatine.selected', null);
  const [sidebarOpen, setSidebarOpen] = useStoredState('creatine.sidebarOpen', true);
  const [settings, setSettings] = useState<{ section?: string } | null>(null);
  const [draft, setDraft] = useState<DraftChoices>({ projectId: null, model: null, mode: 'off' });
  const [focusNonce, setFocusNonce] = useState(0);
  const [searchNonce, setSearchNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const sidebar = useResize(app?.config.ui.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, {
    min: 200,
    max: 480,
    direction: 1,
    onCommit: (width) => void invoke('config:update', { ui: { sidebarWidth: width } }).catch(reportError)
  });
  const panel = useResize(app?.config.ui.workPanelWidth ?? DEFAULT_PANEL_WIDTH, {
    min: 280,
    max: 900,
    direction: -1,
    onCommit: (width) => void invoke('config:update', { ui: { workPanelWidth: width } }).catch(reportError)
  });

  const theme = app?.config.ui.theme ?? 'dark';
  const fontScale = app?.config.ui.fontScale ?? 1;
  const workPanelOpen = app?.config.ui.workPanelOpen ?? true;

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  }, [theme, systemDark]);

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(fontScale));
  }, [fontScale]);

  const setWorkPanel = (open: boolean) => {
    invoke('config:update', { ui: { workPanelOpen: open } }).catch(reportError);
  };

  const openNewChat = () => {
    setSelectedId(null);
    setSettings(null);
    setFocusNonce((value) => value + 1);
  };

  const onKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.key === 'Escape' && settings) {
      setSettings(null);
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'n') {
      event.preventDefault();
      openNewChat();
    } else if (key === 'k') {
      event.preventDefault();
      setSidebarOpen(true);
      setSearchNonce((value) => value + 1);
    } else if (key === ',') {
      event.preventDefault();
      setSettings({});
    } else if (key === 'b') {
      event.preventDefault();
      setSidebarOpen(!sidebarOpen);
    } else if (key === 'j' && app && !settings) {
      event.preventDefault();
      setWorkPanel(!workPanelOpen);
    }
  };

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onKeyDown(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });

  if (!app) {
    return (
      <div className="splash">
        <span>Starting…</span>
        <Toaster />
      </div>
    );
  }

  const session = app.sessions.find((item) => item.id === selectedId) ?? null;
  const newChat: NewChatDraft = {
    projectId: draft.projectId,
    mode: draft.mode,
    model: draft.model ?? { model: app.config.ui.defaultModel, reasoning: app.config.ui.defaultReasoning }
  };
  const onNewChatChange = (patch: Partial<NewChatDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const openSession = (sessionId: string) => {
    setSettings(null);
    setSelectedId(sessionId);
  };
  const toggleSidebar = () => setSidebarOpen(!sidebarOpen);
  const toggleWorkPanel = () => setWorkPanel(!workPanelOpen);

  return (
    <div className="shell">
      {sidebarOpen && (
        <aside className="sidebar" style={{ width: sidebar.width }} aria-label="Sidebar">
          <Sidebar
            app={app}
            selectedId={session?.id ?? null}
            searchRef={searchRef}
            searchNonce={searchNonce}
            onSelect={openSession}
            onNewChat={(projectId) => {
              setDraft((current) => ({ ...current, projectId }));
              openNewChat();
            }}
            onCollapse={toggleSidebar}
            onOpenSettings={(section) => setSettings({ section })}
            onSessionDeleted={(sessionId) => {
              if (sessionId === selectedId) setSelectedId(null);
            }}
          />
          <Resizer
            side="right"
            label="Sidebar width"
            width={sidebar.width}
            onPointerDown={sidebar.onPointerDown}
            onKeyDown={sidebar.onKeyDown}
            onReset={() => void invoke('config:update', { ui: { sidebarWidth: DEFAULT_SIDEBAR_WIDTH } }).catch(reportError)}
          />
        </aside>
      )}

      <main className="main">
        {settings ? (
          <SettingsView onClose={() => setSettings(null)} section={settings.section} />
        ) : session ? (
          <ChatView
            key={session.id}
            app={app}
            session={session}
            sidebarOpen={sidebarOpen}
            workPanelOpen={workPanelOpen}
            newChat={newChat}
            onNewChatChange={onNewChatChange}
            onToggleSidebar={toggleSidebar}
            onToggleWorkPanel={toggleWorkPanel}
            onOpenSession={openSession}
            onOpenSettings={(section) => setSettings({ section })}
          />
        ) : (
          <Home
            app={app}
            newChat={newChat}
            sidebarOpen={sidebarOpen}
            workPanelOpen={workPanelOpen}
            focusNonce={focusNonce}
            onNewChatChange={onNewChatChange}
            onCreated={openSession}
            onToggleSidebar={toggleSidebar}
            onToggleWorkPanel={toggleWorkPanel}
            onOpenSettings={(section) => setSettings({ section })}
          />
        )}
      </main>

      {workPanelOpen && !settings && (
        <aside className="panel" style={{ width: panel.width }} aria-label="Work panel">
          <Resizer
            side="left"
            label="Work panel width"
            width={panel.width}
            onPointerDown={panel.onPointerDown}
            onKeyDown={panel.onKeyDown}
            onReset={() => void invoke('config:update', { ui: { workPanelWidth: DEFAULT_PANEL_WIDTH } }).catch(reportError)}
          />
          <WorkPanel sessionId={session?.id ?? null} />
        </aside>
      )}

      <Toaster />
    </div>
  );
}

