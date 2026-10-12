import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from './lib/bridge';
import { Toaster, reportError } from './components/common/Toasts';
import { Resizer } from './components/common/Resizer';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatView } from './components/chat/ChatView';
import { Home } from './components/home/Home';
import type { ModelSelection } from '@shared/types';
import type { NewChatDraft } from './components/composer/types';
import { SettingsView } from './settings/SettingsView';
import { isPanelTab, WorkPanel, type PanelTab } from './workpanel/WorkPanel';
import { chatFolder } from './lib/folders';
import { useAppState } from './lib/store';
import { useResize, useStoredState, useSystemDark, useViewportWidth } from './lib/hooks';
import { cx } from './lib/format';

const DEFAULT_SIDEBAR_WIDTH = 272;
const DEFAULT_PANEL_WIDTH = 420;
/** Below this window width the sidebar floats over the chat instead of taking its own column. */
const NARROW_WIDTH = 900;
/** The chat column keeps at least this much width; the work panel gives way before it does. */
const MIN_MAIN_WIDTH = 560;
const MIN_PANEL_WIDTH = 320;

/** Chats visited in this window, for the sidebar's back and forward buttons. Null is the new-chat page. */
interface Visits {
  entries: (string | null)[];
  index: number;
}

/** New-chat choices; `model` stays null until the user picks one, so config defaults apply. */
interface DraftChoices {
  projectId: string | null;
  model: ModelSelection | null;
  mode: NewChatDraft['mode'];
}

export function App() {
  const app = useAppState();
  const systemDark = useSystemDark();
  const viewport = useViewportWidth();
  const [selectedId, setSelectedId] = useStoredState<string | null>('creatine.selected', null);
  const [visits, setVisits] = useState<Visits>(() => ({ entries: [selectedId], index: 0 }));
  const [storedTab, setPanelTab] = useStoredState<string>('creatine.workPanel.tab', 'tasks');
  const panelTab: PanelTab = isPanelTab(storedTab) ? storedTab : 'tasks';
  const [panelWide, setPanelWide] = useStoredState('creatine.workPanel.wide', false);
  const [sidebarOpen, setSidebarOpen] = useStoredState('creatine.sidebarOpen', true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [floatingPanel, setFloatingPanel] = useState(false);
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
    min: MIN_PANEL_WIDTH,
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

  const narrow = viewport < NARROW_WIDTH;
  // Narrow windows start with the sidebar hidden; the toggle floats it over the chat.
  const sidebarShown = narrow ? overlayOpen : sidebarOpen;
  const sidebarInFlow = sidebarShown && !narrow;
  const toggleSidebar = () => (narrow ? setOverlayOpen(!overlayOpen) : setSidebarOpen(!sidebarOpen));
  const showSidebar = () => (narrow ? setOverlayOpen(true) : setSidebarOpen(true));

  const roomForPanel = viewport - (sidebarInFlow ? sidebar.width : 0) - MIN_MAIN_WIDTH;
  // Without room beside the chat (a tiled or half-screen window) the panel floats over it,
  // opened per window like the narrow sidebar, so a remembered open panel never covers the chat.
  const panelFloats = roomForPanel < MIN_PANEL_WIDTH;
  const panelOpen = panelFloats ? floatingPanel : workPanelOpen;
  const showPanel = (open: boolean) => (panelFloats ? setFloatingPanel(open) : setWorkPanel(open));

  // Opening a chat drops the forward history, like a browser.
  const visit = (sessionId: string | null) => {
    setSelectedId(sessionId);
    setVisits((current) => {
      if (current.entries[current.index] === sessionId) return current;
      const entries = [...current.entries.slice(0, current.index + 1), sessionId].slice(-50);
      return { entries, index: entries.length - 1 };
    });
  };
  // Chats deleted since they were visited are skipped.
  const reachable = (entry: string | null | undefined) => entry === null || (app?.sessions.some((item) => item.id === entry) ?? false);
  const stepTarget = (delta: number) => {
    let index = visits.index + delta;
    while (index >= 0 && index < visits.entries.length && !reachable(visits.entries[index])) index += delta;
    return index >= 0 && index < visits.entries.length ? index : null;
  };
  const step = (delta: number) => {
    const index = stepTarget(delta);
    if (index === null) return;
    setVisits({ ...visits, index });
    setSelectedId(visits.entries[index] ?? null);
    setSettings(null);
  };

  const [found, setFound] = useState<{ sessionId: string; eventId: string; at: number } | null>(null);
  const openLatest = useRef((sessionId: string) => void sessionId);
  openLatest.current = (sessionId: string) => {
    setSettings(null);
    setOverlayOpen(false);
    setFound(null);
    visit(sessionId);
  };
  // Stable identity: timeline rows are memoized and receive it.
  const openSession = useCallback((sessionId: string) => openLatest.current(sessionId), []);
  const openHit = (sessionId: string, eventId: string) => {
    openSession(sessionId);
    setFound({ sessionId, eventId, at: Date.now() });
  };
  const onSessionDeleted = (sessionId: string) => {
    if (sessionId === selectedId) setSelectedId(null);
  };

  const openNewChat = () => {
    visit(null);
    setSettings(null);
    setOverlayOpen(false);
    setFocusNonce((value) => value + 1);
  };

  const onKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.key === 'Escape' && settings) {
      setSettings(null);
      return;
    }
    if (event.key === 'Escape' && narrow && overlayOpen) {
      setOverlayOpen(false);
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'n') {
      event.preventDefault();
      openNewChat();
    } else if (key === 'k') {
      event.preventDefault();
      showSidebar();
      setSearchNonce((value) => value + 1);
    } else if (key === ',') {
      event.preventDefault();
      setSettings({});
    } else if (key === 'b') {
      event.preventDefault();
      toggleSidebar();
    } else if (key === 'j' && app && !settings) {
      event.preventDefault();
      showPanel(!panelOpen);
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
  const onPanel = (tab: PanelTab | null) => {
    if (tab) setPanelTab(tab);
    showPanel(tab !== null);
  };
  // Beside the chat the panel leaves the chat column its minimum width; floating, it leaves an edge to click away.
  const panelWidth = panelFloats ? Math.min(panel.width, viewport - 48) : panelWide ? roomForPanel : Math.min(panel.width, roomForPanel);
  const panelVisible = panelOpen && !settings && session !== null;

  return (
    <div className="shell">
      {narrow && overlayOpen && <button type="button" className="sidebar-scrim" aria-label="Close sidebar" onClick={() => setOverlayOpen(false)} />}
      {sidebarShown && (
        <aside className={cx('sidebar', narrow && 'is-overlay')} style={{ width: sidebar.width }} aria-label="Sidebar">
          <Sidebar
            app={app}
            selectedId={session?.id ?? null}
            searchRef={searchRef}
            searchNonce={searchNonce}
            history={{
              canBack: stepTarget(-1) !== null,
              canForward: stepTarget(1) !== null,
              back: () => step(-1),
              forward: () => step(1)
            }}
            onSelect={openSession}
            onOpenHit={openHit}
            onNewChat={(projectId) => {
              setDraft((current) => ({ ...current, projectId }));
              openNewChat();
            }}
            onCollapse={toggleSidebar}
            onOpenSettings={(section) => setSettings({ section })}
            onSessionDeleted={onSessionDeleted}
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
            sidebarOpen={sidebarShown}
            panel={panelVisible ? panelTab : null}
            rootDir={chatFolder(app, session)}
            newChat={newChat}
            onNewChatChange={onNewChatChange}
            onToggleSidebar={toggleSidebar}
            onPanel={onPanel}
            onOpenSession={openSession}
            onOpenSettings={(section) => setSettings({ section })}
            onDeleted={onSessionDeleted}
            found={found?.sessionId === session.id ? found : null}
          />
        ) : (
          <Home
            app={app}
            newChat={newChat}
            sidebarOpen={sidebarShown}
            focusNonce={focusNonce}
            onNewChatChange={onNewChatChange}
            onCreated={openSession}
            onToggleSidebar={toggleSidebar}
            onOpenSettings={(section) => setSettings({ section })}
          />
        )}
      </main>

      {panelVisible && panelFloats && <button type="button" className="panel-scrim" aria-label="Close panel" onClick={() => showPanel(false)} />}
      {panelVisible && session && (
        <aside className={cx('panel', panelFloats && 'is-overlay')} style={{ width: panelWidth }} aria-label="Work panel">
          <Resizer
            side="left"
            label="Work panel width"
            width={panel.width}
            onPointerDown={panel.onPointerDown}
            onKeyDown={panel.onKeyDown}
            onReset={() => void invoke('config:update', { ui: { workPanelWidth: DEFAULT_PANEL_WIDTH } }).catch(reportError)}
          />
          <WorkPanel
            sessionId={session.id}
            tab={panelTab}
            wide={panelWide}
            onTab={setPanelTab}
            onToggleWide={() => setPanelWide(!panelWide)}
            onClose={() => onPanel(null)}
            onOpenSession={openSession}
          />
        </aside>
      )}

      <Toaster />
    </div>
  );
}

