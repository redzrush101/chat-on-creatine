import { useMemo } from 'react';
import type { JSX } from 'react';
import { CircleCheck, CircleDashed, Circle } from 'lucide-react';
import type { SessionEvent } from '@shared/types';
import { useSessionEvents } from '../lib/store';
import { Empty } from './common';

type PlanEvent = Extract<SessionEvent, { kind: 'plan' }>;

export function PlanTab({ sessionId }: { sessionId: string }): JSX.Element {
  const events = useSessionEvents(sessionId);
  const plan = useMemo<PlanEvent | null>(() => {
    if (!events) return null;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === 'plan') return event;
    }
    return null;
  }, [events]);

  if (!events) return <Empty title="Loading plan…" />;
  if (!plan) return <Empty title="No plan yet">ChatGPT writes a plan for multi-step work. It appears here as steps progress.</Empty>;

  const done = plan.items.filter((item) => item.status === 'completed').length;
  const total = plan.items.length;

  return (
    <div className="wp-plan">
      <div className="wp-progress" aria-label={`${done} of ${total} steps done`}>
        <div className="wp-progress-text">
          <span>
            {done} of {total} done
          </span>
          <span className="wp-muted">{total === 0 ? '' : `${Math.round((done / total) * 100)}%`}</span>
        </div>
        <div className="wp-progress-track">
          <div className="wp-progress-fill" style={{ width: total === 0 ? '0%' : `${(done / total) * 100}%` }} />
        </div>
      </div>
      {plan.explanation && <p className="wp-plan-note">{plan.explanation}</p>}
      <ol className="wp-checklist">
        {plan.items.map((item, index) => {
          const Icon = item.status === 'completed' ? CircleCheck : item.status === 'in_progress' ? CircleDashed : Circle;
          return (
            <li key={index} className={`wp-check is-${item.status}`}>
              <Icon size={16} aria-hidden />
              <span>{item.step}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
