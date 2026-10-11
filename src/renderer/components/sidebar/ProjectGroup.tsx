import type { ReactNode } from 'react';
import { Ellipsis, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Project } from '@shared/types';
import { InlineEdit } from '../common/InlineEdit';
import { MenuButton, type MenuEntry } from '../common/Popover';

interface ProjectGroupProps {
  project: Project;
  open: boolean;
  renaming: boolean;
  chats: ReactNode[];
  onToggle(): void;
  onNewChat(projectId: string): void;
  onCancelRename(): void;
  onRename(name: string): void;
  onRenameStart(): void;
  onRemove(): void;
}

/** A project as its own sidebar section: name, new chat, actions, then its chats. */
export function ProjectGroup({ project, open, renaming, chats, onToggle, onNewChat, onCancelRename, onRename, onRenameStart, onRemove }: ProjectGroupProps) {
  const entries: MenuEntry[] = [
    { label: 'Rename', icon: Pencil, onSelect: onRenameStart },
    { kind: 'separator' },
    { label: 'Remove from list', icon: Trash2, danger: true, onSelect: onRemove }
  ];
  return (
    <section className="sidebar-section project-group" aria-label={project.name}>
      <div className="sidebar-section-head">
        {renaming ? (
          <InlineEdit label="Project name" value={project.name} onCancel={onCancelRename} onCommit={onRename} />
        ) : (
          <button type="button" className="sidebar-section-toggle" aria-expanded={open} title={project.path} onClick={onToggle}>
            <span>{project.name}</span>
          </button>
        )}
        <div className="sidebar-section-actions">
          <button
            type="button"
            className="icon-btn row-add"
            aria-label={`New chat in ${project.name}`}
            title={`New chat in ${project.name}`}
            onClick={() => onNewChat(project.id)}
          >
            <Plus size={14} />
          </button>
          <MenuButton entries={entries} label={`Actions for ${project.name}`} icon={Ellipsis} className="row-add" />
        </div>
      </div>
      {open && (
        <div className="sidebar-section-body">
          {chats.length === 0 && <p className="sidebar-empty">No chats yet.</p>}
          {chats}
        </div>
      )}
    </section>
  );
}
