import { invoke } from '../../lib/bridge';
import { cx, formatTokens } from '../../lib/format';
import { reportError } from '../common/Toasts';
import { Popover } from '../common/Popover';

/** Context use as a small ring beside the model, like the Claude app; it opens Compact & resume. */
export function ContextMeter({ sessionId, tokens, advisory }: { sessionId: string; tokens: number; advisory: number }) {
  const ratio = advisory > 0 ? tokens / advisory : 0;
  const percent = Math.min(100, Math.round(ratio * 100));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <Popover
      label="Context"
      align="end"
      panelClassName="is-context"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={cx('context-meter', ratio >= 0.8 && 'is-high', ratio >= 1 && 'is-over')}
          aria-expanded={open}
          aria-label={`Context about ${percent}% of the advisory limit`}
          title={`Context: about ${percent}% used`}
          onClick={toggle}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r={radius} className="ring-track" />
            <circle
              cx="8"
              cy="8"
              r={radius}
              className="ring-fill"
              strokeDasharray={`${(Math.min(ratio, 1) * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
            />
          </svg>
        </button>
      )}
    >
      {(close) => (
        <div className="context-panel">
          <p className="context-title">Context · {percent}%</p>
          <p className="context-figure">
            About {formatTokens(tokens)} of {formatTokens(advisory)} tokens (local estimate)
          </p>
          <p className="context-hint">
            {ratio >= 1
              ? 'This chat is long. Compact to continue in a fresh ChatGPT chat with a handoff brief.'
              : 'Compact & resume continues in a fresh ChatGPT chat with a handoff brief.'}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              close();
              invoke('chat:compact', sessionId).catch(reportError);
            }}
          >
            Compact &amp; resume
          </button>
        </div>
      )}
    </Popover>
  );
}
