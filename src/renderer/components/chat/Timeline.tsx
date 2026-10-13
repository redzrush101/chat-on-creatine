import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowDown } from 'lucide-react';
import type { SessionEvent } from '@shared/types';
import { openExternal } from '../../lib/actions';
import { EventRow, type EventActions } from './EventRow';
import { WorkGroup } from './WorkGroup';
import { SourcesContext, sourcesByRef } from './sources';
import { buildBlocks } from './timeline-model';

const STICK_THRESHOLD_PX = 80;

interface TimelineProps {
  sessionId: string;
  events: SessionEvent[] | null;
  busy: boolean;
  /** Changes when the user sends something: the view jumps to the bottom. */
  followNonce: number;
  /** A message to scroll to and mark once its row has rendered; `at` tells repeated opens apart. */
  found: { eventId: string; at: number } | null;
  actions: EventActions;
}

export const Timeline = memo(function Timeline({ sessionId, events, busy, followNonce, found, actions }: TimelineProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const blocks = useMemo(() => (events ? buildBlocks(events, busy) : []), [events, busy]);
  // Keyed by the tool events that carry sources, so streaming text does not re-render every answer.
  const sourcesKey = (events ?? []).filter((event) => event.kind === 'tool' && event.output.some((part) => part.type === 'sources')).map((event) => event.id).join();
  const sources = useMemo(() => sourcesByRef(events ?? []), [sourcesKey]);

  useLayoutEffect(() => {
    stuck.current = true;
    setAtBottom(true);
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [sessionId, followNonce]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [blocks]);

  const shownFound = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!found || !node || shownFound.current === found.at) return;
    const row = node.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(found.eventId)}"]`);
    if (!row) return;
    shownFound.current = found.at;
    stuck.current = false;
    setAtBottom(false);
    row.scrollIntoView({ block: 'center' });
    row.classList.add('is-found');
    window.setTimeout(() => row.classList.remove('is-found'), 2000);
  }, [found, blocks]);

  // Resizing the window re-wraps text and can fire a scroll that unpins the view; keep it at the bottom while pinned.
  useEffect(() => {
    const node = scroller.current;
    const inner = node?.firstElementChild;
    if (!node || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    const near = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_THRESHOLD_PX;
    stuck.current = near;
    setAtBottom(near);
  };

  const jumpToLatest = () => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
    stuck.current = true;
    setAtBottom(true);
  };

  // Links and copy buttons live inside rendered markdown, so they are handled once here.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const copy = target.closest<HTMLButtonElement>('[data-copy]');
    if (copy) {
      const code = copy.closest('.md-code')?.querySelector('code')?.textContent ?? '';
      void navigator.clipboard.writeText(code).then(() => {
        copy.textContent = 'Copied';
        window.setTimeout(() => (copy.textContent = 'Copy'), 1200);
      });
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a[data-external]');
    if (link?.href) {
      event.preventDefault();
      openExternal(link.href);
    }
  };

  return (
    <div className="timeline-wrap">
      <div ref={scroller} className="timeline scroll" onScroll={onScroll} onClick={onClick} role="log" aria-live="polite">
        <SourcesContext.Provider value={sources}>
          <div className="timeline-inner">
            {events === null && <p className="timeline-status">Loading conversation…</p>}
            {events !== null && events.length === 0 && <p className="timeline-status">No messages yet.</p>}
            {blocks.map((block) =>
              block.type === 'event' ? <EventRow key={block.event.id} event={block.event} actions={actions} /> : <WorkGroup key={block.id} block={block} />
            )}
          </div>
        </SourcesContext.Provider>
      </div>
      {!atBottom && (
        <button type="button" className="jump-latest" aria-label="Jump to latest" title="Jump to latest" onClick={jumpToLatest}>
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});
