import { Fragment, useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ChevronRight, FolderPlus, PanelLeftClose, Search, Settings, SquarePen, X } from 'lucide-react';
import type { AppState, SessionMeta } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { cx, errorMessage } from '../../lib/format';
import { connectionView, tunnelConfigured, type ConnectionView } from '../../lib/connection';
import { useStoredState } from '../../lib/hooks';
import { notify, reportError } from '../common/Toasts';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { SessionRow } from './SessionRow';
import { ProjectGroup } from './ProjectGroup';
import { sidebarSessions } from './sidebar-model';

type SearchHit = { sessionId: string; eventId: string; snippet: string };

interface SidebarProps {
  app: AppState;
  selectedId: string | null;
  searchRef: RefObject<HTMLInputElement | null>;
  searchNonce: number;
  onSelect(sessionId: string): void;
  onNewChat(projectId: string | null): void;
  onCollapse(): void;
  onOpenSettings(section?: string): void;
  onSessionDeleted(sessionId: string): void;
}

function useSidebarSearch(searchRef: RefObject<HTMLInputElement | null>, onSelect: (sessionId: string) => void) {
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

  const openHit = (sessionId: string) => {
    setHits(null);
    setQuery('');
    onSelect(sessionId);
  };

  return { query, setQuery, hits, setHits, onSearchKeyDown, openHit };
}

export function Sidebar({
  app,
  selectedId,
  searchRef,
  searchNonce,
  onSelect,
  onNewChat,
  onCollapse,
  onOpenSettings,
  onSessionDeleted
}: SidebarProps) {
  const { query, setQuery, hits, setHits, onSearchKeyDown, openHit } = useSidebarSearch(searchRef, onSelect);
  const [collapsed, setCollapsed] = useStoredState<Record<string, boolean>>('creatine.sidebar.collapsed', {});
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [removingProject, setRemovingProject] = useState<string | null>(null);

  useEffect(() => {
    if (searchNonce) searchRef.current?.focus();
  }, [searchNonce, searchRef]);

  const { projects, live, platform } = app;
  const { chats, sessionById, pinned, chatsByProject, loose, workersOf, workerStateOf } = sidebarSessions(app);

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

  const section = (key: string, title: string, actions: ReactNode, children: ReactNode, count?: number) => {
    return <SidebarSection title={title} actions={actions} count={count} open={!collapsed[key]} onToggle={() => toggleGroup(key)}>{children}</SidebarSection>;
  };

  return (
    <nav className="sidebar-inner" aria-label="Chats">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">C</span>
        <span className="brand-name">Chat on Creatine</span>
        <button type="button" className="icon-btn" title="Hide sidebar (Ctrl+B)" aria-label="Hide sidebar" onClick={onCollapse}>
          <PanelLeftClose size={15} />
        </button>
      </div>

      <button type="button" className="btn sidebar-new" onClick={() => onNewChat(null)} title="New chat (Ctrl+N)">
        <SquarePen size={14} />
        <span>New chat</span>
        <kbd>{platform === 'darwin' ? '⌘N' : 'Ctrl N'}</kbd>
      </button>

      <div className="sidebar-search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search chats"
          aria-label="Search chats"
          title="Search (Ctrl+K). Enter searches message history."
          value={query}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setHits(null);
          }}
          onKeyDown={onSearchKeyDown}
        />
      </div>

      <div className="sidebar-scroll scroll">
        {searching ? (
          <div className="sidebar-results">
            <div className="sidebar-results-head">
              <span>Titles</span>
            </div>
            {titleMatches.length ? titleMatches.map((chat) => rowFor(chat)) : <p className="sidebar-empty">No chat titles match.</p>}
            {hits !== null && (
              <>
                <div className="sidebar-results-head">
                  <span>Messages</span>
                  <button type="button" className="icon-btn" aria-label="Clear message results" title="Clear message results" onClick={() => setHits(null)}>
                    <X size={12} />
                  </button>
                </div>
                {hits.length === 0 && <p className="sidebar-empty">No messages match.</p>}
                {hits.map((hit) => (
                  <button key={`${hit.sessionId}:${hit.eventId}`} type="button" className="search-hit" onClick={() => openHit(hit.sessionId)}>
                    <span className="search-hit-title">{sessionById.get(hit.sessionId)?.title || 'New chat'}</span>
                    <span className="search-hit-snippet">{hit.snippet}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        ) : (
          <>
            {pinned.length > 0 && section('pinned', 'Pinned', null, pinned.map(chatBlock), pinned.length)}

            {section(
              'projects',
              'Projects',
              <button type="button" className="icon-btn" aria-label="Add project folder" title="Add project folder" onClick={addProject}>
                <FolderPlus size={14} />
              </button>,
              projects.length === 0 ? (
                <p className="sidebar-empty">Add a folder to group chats by project.</p>
              ) : (
                projects.map((project) => {
                  const projectChats = chatsByProject.get(project.id) ?? [];
                  const open = !collapsed[`project:${project.id}`];
                  return (
                    <ProjectGroup
                      key={project.id}
                      project={project}
                      open={open}
                      renaming={renamingProject === project.id}
                      chats={projectChats.map(chatBlock)}
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
                  );
                })
              ),
              projects.length
            )}

            {section('chats', 'Chats', null, loose.length ? loose.map(chatBlock) : <p className="sidebar-empty">No chats outside projects.</p>)}
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
        <ConnectionPill
          view={connectionView(app.connection.state, tunnelConfigured(app))}
          detail={app.connection.detail}
          onClick={() => onOpenSettings('connection')}
        />
        <button type="button" className="icon-btn" aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => onOpenSettings()}>
          <Settings size={15} />
        </button>
      </div>
    </nav>
  );
}

function ConnectionPill({ view, detail, onClick }: { view: ConnectionView; detail: string; onClick(): void }) {
  return (
    <button type="button" className={cx('connection-pill', `is-${view.tone}`)} title={detail || view.label} onClick={onClick}>
      <span className="status-dot" aria-hidden="true" />
      <span>{view.label}</span>
    </button>
  );
}

function SidebarSection({ title, actions, children, count, open, onToggle }: { title: string; actions: ReactNode; children: ReactNode; count?: number; open: boolean; onToggle(): void }) {
  return (
    <section className="sidebar-section" aria-label={title}>
      <div className="sidebar-section-head">
        <button type="button" className="sidebar-section-toggle" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={12} className={cx('chevron', open && 'is-open')} aria-hidden="true" />
          <span>{title}</span>
          {count !== undefined && count > 0 && <span className="sidebar-count">{count}</span>}
        </button>
        <div className="sidebar-section-actions">{actions}</div>
      </div>
      {open && <div className="sidebar-section-body">{children}</div>}
    </section>
  );
}
