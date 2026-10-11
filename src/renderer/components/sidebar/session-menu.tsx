import { useState, type ReactNode } from 'react';
import { Ban, Download, Folder, Pencil, Pin, PinOff, ShieldOff, Trash2 } from 'lucide-react';
import type { Project, SessionMeta } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { downloadText } from '../../lib/download';
import { reportError } from '../common/Toasts';
import { ConfirmDialog } from '../common/ConfirmDialog';
import type { MenuEntry } from '../common/Popover';

type SessionPatch = Partial<Pick<SessionMeta, 'title' | 'pinned' | 'projectId' | 'blocked'>>;

export function updateSession(sessionId: string, patch: SessionPatch): void {
  invoke('sessions:update', sessionId, patch).catch(reportError);
}

/** The actions one chat offers, shared by its sidebar row and the chat title menu. */
export function useSessionMenu(session: SessionMeta, projects: Project[], onRename: () => void, onDeleted: (sessionId: string) => void): { entries: MenuEntry[]; dialog: ReactNode } {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const title = session.title || 'New chat';
  const update = (patch: SessionPatch) => updateSession(session.id, patch);

  const exportChat = () => {
    invoke('sessions:export', session.id)
      .then((text) => downloadText(`${title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'chat'}.md`, text))
      .catch(reportError);
  };

  const entries: MenuEntry[] = [
    { label: 'Rename', icon: Pencil, onSelect: onRename },
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

  const dialog = confirmDelete ? (
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
  ) : null;

  return { entries, dialog };
}
