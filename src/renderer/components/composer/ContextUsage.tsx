import { CHARS_PER_TOKEN, CONTEXT_PARTS, contextPercent, type ContextUsage as Usage } from '@shared/context';
import { formatTokens } from '@shared/format';

export function ContextUsage({ tokens, advisory, usage }: { tokens: number; advisory: number; usage?: Usage }) {
  const { used, remaining } = contextPercent(tokens, advisory);
  return <>
    <p className="context-title">Context · {used}% used <span className="context-remaining">{remaining}% left</span></p>
    <progress className="context-progress" value={tokens} max={advisory} aria-label="Estimated context against the configured threshold" />
    <p className="context-figure">About {formatTokens(tokens)} of {formatTokens(advisory)} tokens</p>
    {usage && <dl className="context-breakdown">
      {Object.entries(CONTEXT_PARTS).map(([key, label]) => <div key={key}>
        <dt>{label}</dt><dd>{formatTokens(Math.ceil(usage[key as keyof Usage] / CHARS_PER_TOKEN))}</dd>
      </div>)}
    </dl>}
    <p className="context-hint">Local estimate against your threshold. Account quota and billing are managed in ChatGPT.</p>
  </>;
}
