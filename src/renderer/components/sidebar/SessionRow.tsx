import { useState } from 'react';
import { Ellipsis, LoaderCircle, Pin, Wrench } from 'lucide-react';
import type { AppState, SessionLive, SessionMeta, WorkerState } from '@shared/types';
import { cx, formatAgo } from '../../lib/format';
import { InlineEdit } from '../common/InlineEdit';
import { MenuButton } from '../common/Popover';
import { updateSession, useSessionMenu } from './session-menu';

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
  const { entries, dialog } = useSessionMenu(session, projects, () => setEditing(true), onDeleted);
  const title = session.title || 'New chat';
  const generating = live !== undefined && live.turn !== 'idle';
  const tooltip = `${title}${session.blocked ? ' (tools blocked)' : ''} · ${formatAgo(session.updatedAt)}`;

  return (
    <div className={cx('session-row', selected && 'is-selected', nested && 'is-nested', session.blocked && 'is-blocked')}>
      {editing ? (
        <InlineEdit
          label="Chat title"
          value={session.title}
          className="inline-edit row-edit"
          onCommit={(text) => {
            setEditing(false);
            updateSession(session.id, { title: text });
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          className="session-row-main"
          aria-current={selected ? 'true' : undefined}
          title={tooltip}
          onClick={() => onSelect(session.id)}
          onDoubleClick={() => setEditing(true)}
        >
          {generating ? (
            <LoaderCircle size={12} className="spin row-live" aria-label="Generating" />
          ) : (
            <span className={cx('row-dot', nested && 'is-worker', workerState && `is-${workerState}`)} aria-hidden="true" />
          )}
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
          <MenuButton entries={entries} label={`Actions for ${title}`} icon={Ellipsis} className="row-menu" />
        </div>
      )}
      {dialog}
    </div>
  );
}
