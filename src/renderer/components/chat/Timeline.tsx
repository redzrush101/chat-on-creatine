import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowDown, ChevronRight, Wrench } from 'lucide-react';
import type { SessionEvent } from '@shared/types';
import { openExternal } from '../../lib/actions';
import { cx, eventTime, formatDuration } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { EventRow } from './EventRow';
import { buildBlocks, type TimelineBlock } from './timeline-model';

const STICK_THRESHOLD_PX = 80;

interface TimelineProps {
  sessionId: string;
  events: SessionEvent[] | null;
  busy: boolean;
  /** Changes when the user sends something: the view jumps to the bottom. */
  followNonce: number;
  onOpenSession(sessionId: string): void;
}

export function Timeline({ sessionId, events, busy, followNonce, onOpenSession }: TimelineProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const blocks = useMemo(() => (events ? buildBlocks(events, busy) : []), [events, busy]);

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
        <div className="timeline-inner">
          {events === null && <p className="timeline-status">Loading conversation…</p>}
          {events !== null && events.length === 0 && <p className="timeline-status">No messages yet.</p>}
          {blocks.map((block) =>
            block.type === 'event' ? (
              <EventRow key={block.event.id} event={block.event} onOpenSession={onOpenSession} />
            ) : (
              <WorkGroup key={block.id} block={block} onOpenSession={onOpenSession} />
            )
          )}
        </div>
      </div>
      {!atBottom && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <ArrowDown size={13} aria-hidden="true" />
          Jump to latest
        </button>
      )}
    </div>
  );
}

const WorkGroup = function WorkGroup({
  block,
  onOpenSession
}: {
  block: Extract<TimelineBlock, { type: 'work' }>;
  onOpenSession(sessionId: string): void;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? block.running;
  const now = useNow(block.running);
  const start = block.events[0]?.at ?? now;
  const end = block.running ? now : block.events.reduce((latest, event) => Math.max(latest, eventTime(event)), start);
  const elapsed = formatDuration(end - start);
  const toolLabel = block.tools === 1 ? '1 tool call' : `${block.tools} tool calls`;

  return (
    <section className={cx('work-group', open && 'is-open', block.running && 'is-running')}>
      <button type="button" className="work-head" aria-expanded={open} onClick={() => setToggled(!open)}>
        <Wrench size={13} aria-hidden="true" />
        <span className="work-title">
          {block.running ? `Working for ${elapsed}` : `Worked for ${elapsed}`}
          {block.tools > 0 && <span className="work-meta"> · {toolLabel}</span>}
        </span>
        <ChevronRight size={12} className={cx('chevron', open && 'is-open')} aria-hidden="true" />
      </button>
      {open && (
        <div className="work-body">
          {block.events.map((event) => (
            <EventRow key={event.id} event={event} onOpenSession={onOpenSession} />
          ))}
        </div>
      )}
    </section>
  );
};
