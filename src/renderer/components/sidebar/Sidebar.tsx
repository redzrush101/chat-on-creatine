import { Fragment, useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderPlus,
  Globe,
  History,
  LogIn,
  Palette,
  PanelLeft,
  Plug,
  Plus,
  Puzzle,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Users,
  X
} from 'lucide-react';
import type { AppState, SessionMeta } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { cx, errorMessage } from '../../lib/format';
import { connectionView, tunnelConfigured } from '../../lib/connection';
import { useStoredState } from '../../lib/hooks';
import { notify, reportError } from '../common/Toasts';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Menu, type MenuEntry } from '../common/Popover';
import { SessionRow } from './SessionRow';
import { ProjectGroup } from './ProjectGroup';
import { sidebarSessions } from './sidebar-model';

type SearchHit = { sessionId: string; eventId: string; snippet: string };

export interface NavHistory {
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
}

interface SidebarProps {
  app: AppState;
  selectedId: string | null;
  searchRef: RefObject<HTMLInputElement | null>;
  searchNonce: number;
  history: NavHistory;
  onSelect(sessionId: string): void;
  /** Opens a chat at one message, for a search hit. */
  onOpenHit(sessionId: string, eventId: string): void;
  onNewChat(projectId: string | null): void;
  onCollapse(): void;
  onOpenSettings(section?: string): void;
  onSessionDeleted(sessionId: string): void;
}

function useSidebarSearch(searchRef: RefObject<HTMLInputElement | null>, onOpenHit: (sessionId: string, eventId: string) => void) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const runSearch = () => {
    const text = query.trim();
    if (!text) {
      setHits(null);
      return;
    }
    invoke('sessions:search', text)
      .then((result) => setHits(result))
      .catch(reportError);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    } else if (event.key === 'Escape') {
      setQuery('');
      setHits(null);
      searchRef.current?.blur();
    }
  };

  const openHit = (hit: SearchHit) => {
    setHits(null);
    setQuery('');
    onOpenHit(hit.sessionId, hit.eventId);
  };

  return { query, setQuery, hits, setHits, onSearchKeyDown, openHit };
}

/** The more-menu sections: everything in Settings that is not reached from the main nav. */
const MORE_SECTIONS = [
  { id: 'agents', label: 'Agents', icon: Users },
  { id: 'context', label: 'Context & history', icon: History },
  { id: 'connection', label: 'Connection', icon: Plug },
  { id: 'appearance', label: 'Appearance', icon: Palette }
] as const;

export function Sidebar({ app, selectedId, searchRef, searchNonce, history, onSelect, onOpenHit, onNewChat, onCollapse, onOpenSettings, onSessionDeleted }: SidebarProps) {
  const { query, setQuery, hits, setHits, onSearchKeyDown, openHit } = useSidebarSearch(searchRef, onOpenHit);
  const [collapsed, setCollapsed] = useStoredState<Record<string, boolean>>('creatine.sidebar.collapsed', {});
  const [moreOpen, setMoreOpen] = useStoredState('creatine.sidebar.more', false);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [removingProject, setRemovingProject] = useState<string | null>(null);

  useEffect(() => {
    if (searchNonce) searchRef.current?.focus();
  }, [searchNonce, searchRef]);

  const { projects, live, platform } = app;
  const { chats, sessionById, pinned, chatsByProject, loose, workersOf, workerStateOf } = sidebarSessions(app);
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+';

  const searching = query.trim().length > 0;
  const titleMatches = searching ? chats.filter((chat) => chat.title.toLowerCase().includes(query.trim().toLowerCase())) : [];

  const rowFor = (session: SessionMeta, nested = false) => (
    <SessionRow
      key={session.id}
      session={session}
      live={live[session.id]}
      projects={projects}
      workerState={nested ? workerStateOf(session.id) : null}
      selected={session.id === selectedId}
      nested={nested}
      onSelect={onSelect}
      onDeleted={onSessionDeleted}
    />
  );

  const chatBlock = (chat: SessionMeta) => (
    <Fragment key={chat.id}>
      {rowFor(chat)}
      {(workersOf.get(chat.id) ?? []).map((worker) => rowFor(worker, true))}
    </Fragment>
  );

  const toggleGroup = (key: string) => setCollapsed({ ...collapsed, [key]: !collapsed[key] });

  const addProject = () => {
    invoke('app:pickFolder')
      .then((path) => (path ? invoke('projects:add', path) : null))
      .then((project) => project && notify(`Added project ${project.name}`, 'success'))
      .catch(reportError);
  };

  return (
    <nav className="sidebar-inner" aria-label="Chats">
      <div className="sidebar-top">
        <button type="button" className="icon-btn" title={`Hide sidebar (${mod}B)`} aria-label="Hide sidebar" onClick={onCollapse}>
          <PanelLeft size={16} />
        </button>
        <button type="button" className="icon-btn" title="Back" aria-label="Back" disabled={!history.canBack} onClick={history.back}>
          <ArrowLeft size={16} />
        </button>
        <button type="button" className="icon-btn" title="Forward" aria-label="Forward" disabled={!history.canForward} onClick={history.forward}>
          <ArrowRight size={16} />
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search"
          aria-label="Search chats"
          title={`Search (${mod}K). Enter searches message history.`}
          value={query}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setHits(null);
          }}
          onKeyDown={onSearchKeyDown}
        />
      </div>

      <div className="sidebar-nav">
        <button type="button" className="nav-item is-new" onClick={() => onNewChat(null)} title={`New chat (${mod}N)`}>
          <span className="nav-new-icon" aria-hidden="true">
            <Plus size={13} />
          </span>
          <span>New chat</span>
        </button>
        <button type="button" className="nav-item" onClick={addProject} title="Add a project folder">
          <FolderPlus size={15} aria-hidden="true" />
          <span>New project</span>
        </button>
        <button type="button" className="nav-item" onClick={() => onOpenSettings('skills')}>
          <Sparkles size={15} aria-hidden="true" />
          <span>Skills</span>
        </button>
        <button type="button" className="nav-item" onClick={() => onOpenSettings('plugins')}>
          <Puzzle size={15} aria-hidden="true" />
          <span>Plugins</span>
        </button>
        <button type="button" className="nav-item" onClick={() => onOpenSettings('instructions')}>
          <SlidersHorizontal size={15} aria-hidden="true" />
          <span>Customize</span>
        </button>
        <button type="button" className="nav-item is-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
          {moreOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          <span>More</span>
        </button>
        {moreOpen &&
          MORE_SECTIONS.map((item) => (
            <button key={item.id} type="button" className="nav-item is-sub" onClick={() => onOpenSettings(item.id)}>
              <item.icon size={14} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
      </div>

      <div className="sidebar-scroll scroll">
        {searching ? (
          <div className="sidebar-results">
            <div className="sidebar-results-head">
              <span>Titles</span>
            </div>
            {titleMatches.length ? titleMatches.map((chat) => rowFor(chat)) : <p className="sidebar-empty">No chat titles match.</p>}
            {hits === null ? (
              <p className="sidebar-empty">Press Enter to search messages.</p>
            ) : (
              <>
                <div className="sidebar-results-head">
                  <span>Messages</span>
                  <button type="button" className="icon-btn" aria-label="Clear message results" title="Clear message results" onClick={() => setHits(null)}>
                    <X size={12} />
                  </button>
                </div>
                {hits.length === 0 && <p className="sidebar-empty">No messages match.</p>}
                {hits.map((hit) => (
                  <button key={`${hit.sessionId}:${hit.eventId}`} type="button" className="search-hit" onClick={() => openHit(hit)}>
                    <span className="search-hit-title">{sessionById.get(hit.sessionId)?.title || 'New chat'}</span>
                    <span className="search-hit-snippet">{hit.snippet}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <SidebarSection title="Pinned" open={!collapsed.pinned} onToggle={() => toggleGroup('pinned')}>
                {pinned.map(chatBlock)}
              </SidebarSection>
            )}

            {projects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                open={!collapsed[`project:${project.id}`]}
                renaming={renamingProject === project.id}
                chats={(chatsByProject.get(project.id) ?? []).map(chatBlock)}
                onToggle={() => toggleGroup(`project:${project.id}`)}
                onNewChat={onNewChat}
                onCancelRename={() => setRenamingProject(null)}
                onRename={(name) => {
                  setRenamingProject(null);
                  invoke('projects:update', project.id, { name }).catch(reportError);
                }}
                onRenameStart={() => setRenamingProject(project.id)}
                onRemove={() => setRemovingProject(project.id)}
              />
            ))}

            <SidebarSection
              title="Recents"
              open={!collapsed.chats}
              onToggle={() => toggleGroup('chats')}
              actions={
                <button type="button" className="icon-btn row-add" aria-label="New chat" title="New chat" onClick={() => onNewChat(null)}>
                  <Plus size={14} />
                </button>
              }
            >
              {loose.length ? loose.map(chatBlock) : <p className="sidebar-empty">{projects.length ? 'No chats outside projects.' : 'No chats yet.'}</p>}
            </SidebarSection>
          </>
        )}
      </div>

      {removingProject && (
        <ConfirmDialog
          title="Remove project?"
          message="The project leaves this list. Its folder and chats are not deleted."
          confirmLabel="Remove"
          danger
          onCancel={() => setRemovingProject(null)}
          onConfirm={() => {
            const id = removingProject;
            setRemovingProject(null);
            invoke('projects:remove', id).catch((error) => notify(errorMessage(error), 'error'));
          }}
        />
      )}

      <div className="sidebar-footer">
        <AccountMenu app={app} onOpenSettings={onOpenSettings} />
        <button type="button" className="icon-btn" aria-label="Settings" title={`Settings (${mod},)`} onClick={() => onOpenSettings()}>
          <Settings size={15} />
        </button>
      </div>
    </nav>
  );
}

/** ChatGPT account and local-tools status, like the account chip in the Claude app. */
function AccountMenu({ app, onOpenSettings }: { app: AppState; onOpenSettings(section?: string): void }) {
  const view = connectionView(app.connection.state, tunnelConfigured(app));
  const signedIn = app.browser.signedIn;
  const account = signedIn === false ? 'Not signed in' : 'ChatGPT';
  const entries: MenuEntry[] = [
    { kind: 'label', label: `Local tools · ${view.label}` },
    signedIn === false
      ? { label: 'Sign in to ChatGPT', icon: LogIn, onSelect: () => invoke('browser:signIn').catch(reportError) }
      : { label: 'Show ChatGPT', icon: Globe, onSelect: () => invoke('browser:show', null).catch(reportError) },
    { label: 'Connection', icon: Plug, onSelect: () => onOpenSettings('connection') },
    { label: 'ChatGPT settings', icon: Globe, onSelect: () => onOpenSettings('chatgpt') },
    { label: 'Instructions', icon: FileText, onSelect: () => onOpenSettings('instructions') },
    { kind: 'separator' },
    { label: 'Settings', icon: Settings, onSelect: () => onOpenSettings() }
  ];
  return (
    <Menu
      entries={entries}
      label="Account"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={cx('account', `is-${view.tone}`)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={app.connection.detail || view.label}
          onClick={toggle}
        >
          <span className="account-avatar" aria-hidden="true">
            G<span className="status-dot" />
          </span>
          <span className="account-text">
            <span className="account-name">{account}</span>
            <span className="account-plan">{view.label}</span>
          </span>
          <ChevronDown size={13} className="account-chevron" aria-hidden="true" />
        </button>
      )}
    />
  );
}

function SidebarSection({ title, actions, children, open, onToggle }: { title: string; actions?: ReactNode; children: ReactNode; open: boolean; onToggle(): void }) {
  return (
    <section className="sidebar-section" aria-label={title}>
      <div className="sidebar-section-head">
        <button type="button" className="sidebar-section-toggle" aria-expanded={open} onClick={onToggle}>
          <span>{title}</span>
        </button>
        {actions && <div className="sidebar-section-actions">{actions}</div>}
      </div>
      {open && <div className="sidebar-section-body">{children}</div>}
    </section>
  );
}
