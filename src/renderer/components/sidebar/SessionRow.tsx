import { useState } from 'react';
import { Ban, Download, Ellipsis, Folder, LoaderCircle, Pencil, Pin, PinOff, ShieldOff, Trash2, Wrench } from 'lucide-react';
import type { AppState, SessionLive, SessionMeta, WorkerState } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { downloadText } from '../../lib/download';
import { cx, formatRelative } from '../../lib/format';
import { reportError } from '../common/Toasts';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { InlineEdit } from '../common/InlineEdit';
import { MenuButton, type MenuEntry } from '../common/Popover';

interface SessionRowProps {
  session: SessionMeta;
  live: SessionLive | undefined;
  projects: AppState['projects'];
  workerState: WorkerState | null;
  selected: boolean;
  nested: boolean;
  onSelect(sessionId: string): void;
  onDeleted(sessionId: string): void;
}

export function SessionRow({ session, live, projects, workerState, selected, nested, onSelect, onDeleted }: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const title = session.title || 'New chat';
  const generating = live !== undefined && live.turn !== 'idle';

  const update = (patch: Partial<Pick<SessionMeta, 'title' | 'pinned' | 'projectId' | 'blocked'>>) => {
    invoke('sessions:update', session.id, patch).catch(reportError);
  };

  const exportChat = () => {
    invoke('sessions:export', session.id)
      .then((text) => downloadText(`${title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'chat'}.md`, text))
      .catch(reportError);
  };

  const entries: MenuEntry[] = [
    { label: 'Rename', icon: Pencil, onSelect: () => setEditing(true) },
    session.pinned
      ? { label: 'Unpin', icon: PinOff, onSelect: () => update({ pinned: false }) }
      : { label: 'Pin', icon: Pin, onSelect: () => update({ pinned: true }) },
    { kind: 'label', label: 'Move to project' },
    ...projects.map((project) => ({
      label: project.name,
      icon: Folder,
      checked: session.projectId === project.id,
      onSelect: () => update({ projectId: project.id })
    })),
    { label: 'No project', icon: Folder, checked: session.projectId === null, onSelect: () => update({ projectId: null }) },
    { kind: 'separator' },
    { label: 'Export', icon: Download, onSelect: exportChat },
    session.blocked
      ? { label: 'Allow tools', icon: ShieldOff, onSelect: () => update({ blocked: false }) }
      : { label: 'Block tools', icon: Ban, onSelect: () => update({ blocked: true }) },
    { kind: 'separator' },
    { label: 'Delete', icon: Trash2, danger: true, onSelect: () => setConfirmDelete(true) }
  ];

  return (
    <div className={cx('session-row', selected && 'is-selected', nested && 'is-nested', session.blocked && 'is-blocked')}>
      {editing ? (
        <InlineEdit
          label="Chat title"
          value={session.title}
          className="inline-edit row-edit"
          onCommit={(text) => {
            setEditing(false);
            update({ title: text });
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          className="session-row-main"
          aria-current={selected ? 'true' : undefined}
          title={session.blocked ? `${title} (tools blocked)` : title}
          onClick={() => onSelect(session.id)}
          onDoubleClick={() => setEditing(true)}
        >
          {nested ? (
            <span className={cx('worker-dot', workerState && `is-${workerState}`)} aria-hidden="true" />
          ) : generating ? (
            <LoaderCircle size={12} className="spin row-live" aria-label="Generating" />
          ) : null}
          <span className="session-row-title">{title}</span>
        </button>
      )}
      {!editing && (
        <div className="session-row-trail">
          {session.pinned && <Pin size={11} className="row-pin" aria-label="Pinned" />}
          {live && live.runningTools > 0 && (
            <span className="row-tools" title={`${live.runningTools} tool call(s) running`}>
              <Wrench size={11} aria-hidden="true" />
              {live.runningTools}
            </span>
          )}
          {!nested && <time className="row-time" dateTime={new Date(session.updatedAt).toISOString()}>{formatRelative(session.updatedAt)}</time>}
          <MenuButton entries={entries} label={`Actions for ${title}`} icon={Ellipsis} className="row-menu" />
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete chat?"
          message={`"${title}" and its history will be removed from this app. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            invoke('sessions:delete', session.id)
              .then(() => onDeleted(session.id))
              .catch(reportError);
          }}
        />
      )}
    </div>
  );
}

