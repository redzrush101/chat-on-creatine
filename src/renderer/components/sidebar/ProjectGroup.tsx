import type { ReactNode } from 'react';
import { ChevronRight, Ellipsis, Folder, Pencil, SquarePen, Trash2 } from 'lucide-react';
import type { Project } from '@shared/types';
import { cx } from '../../lib/format';
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

export function ProjectGroup({ project, open, renaming, chats, onToggle, onNewChat, onCancelRename, onRename, onRenameStart, onRemove }: ProjectGroupProps) {
  const entries: MenuEntry[] = [
    { label: 'Rename', icon: Pencil, onSelect: onRenameStart },
    { kind: 'separator' },
    { label: 'Remove from list', icon: Trash2, danger: true, onSelect: onRemove }
  ];
  return (
    <div className="project-group">
      <div className="project-head">
        {renaming ? (
          <InlineEdit
            label="Project name"
            value={project.name}
            onCancel={onCancelRename}
            onCommit={onRename}
          />
        ) : (
          <button
            type="button"
            className="project-toggle"
            aria-expanded={open}
            title={project.path}
            onClick={onToggle}
          >
            <ChevronRight size={12} className={cx('chevron', open && 'is-open')} aria-hidden="true" />
            <Folder size={13} aria-hidden="true" />
            <span className="project-name">{project.name}</span>
          </button>
        )}
        <button
          type="button"
          className="icon-btn row-add"
          aria-label={`New chat in ${project.name}`}
          title={`New chat in ${project.name}`}
          onClick={() => onNewChat(project.id)}
        >
          <SquarePen size={13} />
        </button>
        <MenuButton entries={entries} label={`Actions for ${project.name}`} icon={Ellipsis} className="row-menu" />
      </div>
      {open && (
        <div className="project-chats">
          {chats.length === 0 && <p className="sidebar-empty is-nested">No chats yet.</p>}
          {chats}
        </div>
      )}
    </div>
  );
}
