import { memo, useState } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import type { SessionEvent } from '@shared/types';
import { cx, eventTime, formatDuration } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { DiffCard, ToolRow } from './ToolCard';
import { DiffBadge } from './DiffBadge';
import type { TimelineBlock } from './timeline-model';
import { describeTool, diffTotals, summarizeTools } from '@shared/tool-labels';
import { useAppState } from '../../lib/store';

type ToolEvent = Extract<SessionEvent, { kind: 'tool' }>;
type ReasoningEvent = Extract<SessionEvent, { kind: 'reasoning' }>;

/**
 * A run of tool calls as one line, "Ran 5 commands, edited report.md +1 -1", that opens into a list
 * of steps. A single edit opens straight into its diff. Thinking-only runs read "Thought for 12s".
 */
export const WorkGroup = memo(function WorkGroup({ block }: { block: Extract<TimelineBlock, { type: 'work' }> }) {
  const expandTools = useAppState((state) => state?.config.ui.expandTools ?? false);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (block.running || expandTools);
  const now = useNow(block.running);
  const tools = block.events.filter((event): event is ToolEvent => event.kind === 'tool');
  const totals = diffTotals(tools);
  const start = block.events[0]?.at ?? now;
  const end = block.running ? now : block.events.reduce((latest, event) => Math.max(latest, eventTime(event)), start);
  const elapsed = formatDuration(end - start);

  const runningTool = tools.findLast((event) => event.status === 'running');
  const lastTool = tools.at(-1);
  let title: string;
  if (tools.length === 0) title = block.running ? 'Thinking…' : end - start >= 1000 ? `Thought for ${elapsed}` : 'Thought';
  else if (block.running && (runningTool ?? lastTool)) {
    const described = describeTool(runningTool ?? lastTool!);
    title = runningTool ? `${described.active}${described.target ? ` ${described.target}` : ''}…` : `${summarizeTools(tools)}…`;
  } else title = summarizeTools(tools);

  const soloEdit = tools.length === 1 && block.events.length === 1 && lastTool?.output.some((part) => part.type === 'diff');

  return (
    <section className={cx('work-group', open && 'is-open', block.running && 'is-running')}>
      <button type="button" className="work-head" aria-expanded={open} title={`${block.running ? 'Working' : 'Worked'} for ${elapsed}`} onClick={() => setToggled(!open)}>
        {block.running && <LoaderCircle size={13} className="spin work-spin" aria-hidden="true" />}
        <span className="work-title">{title}</span>
        {totals && <DiffBadge added={totals.added} removed={totals.removed} />}
        {open ? <ChevronDown size={14} className="work-chevron" aria-hidden="true" /> : <ChevronRight size={14} className="work-chevron" aria-hidden="true" />}
      </button>
      {open &&
        (tools.length === 0 ? (
          <div className="work-thought">
            {block.events.map((event) => event.kind === 'reasoning' && <p key={event.id} className="reasoning-text">{event.text}</p>)}
          </div>
        ) : soloEdit && lastTool ? (
          <div className="work-diffs">
            {lastTool.output.map((part, index) => part.type === 'diff' && <DiffCard key={index} path={part.path} diff={part.diff} />)}
          </div>
        ) : (
          <div className="steps">
            {block.events.map((event) =>
              event.kind === 'tool' ? <ToolRow key={event.id} event={event} /> : event.kind === 'reasoning' ? <ThoughtRow key={event.id} event={event} /> : null
            )}
          </div>
        ))}
    </section>
  );
}, (previous, next) => previous.block.running === next.block.running &&
  previous.block.events.length === next.block.events.length &&
  previous.block.events.every((event, index) => event === next.block.events[index]));

function ThoughtRow({ event }: { event: ReasoningEvent }) {
  const [open, setOpen] = useState(false);
  if (!event.text.trim() && !event.streaming) return null;
  return (
    <div className={cx('step is-thought', open && 'is-open')}>
      <button type="button" className="step-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="step-label">
          <span className="step-verb">{event.streaming ? 'Thinking…' : 'Thought'}</span>
          {!open && event.text && <span className="step-target is-faint">{event.text.replace(/\s+/g, ' ').slice(0, 120)}</span>}
        </span>
        {open ? <ChevronDown size={13} className="step-chevron" aria-hidden="true" /> : <ChevronRight size={13} className="step-chevron" aria-hidden="true" />}
      </button>
      {open && (
        <div className="step-body">
          <p className="reasoning-text">{event.text}</p>
        </div>
      )}
    </div>
  );
}
