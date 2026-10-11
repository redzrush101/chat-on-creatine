import type { JSX } from 'react';
import { DEFAULT_HANDOFF_PROMPT } from '@shared/config';
import type { AppState } from '@shared/types';
import { Button, Group, NumberField, Row, TextArea, Toggle, useSave } from '../controls';

export function ContextSection({ state }: { state: AppState }): JSX.Element {
  const { config } = state;
  const save = useSave();
  const context = config.context;

  return (
    <div className="st-stack">
      <Group title="History" description="Chats are stored on this computer only.">
        <Row label="Record chats" hint="Keep messages and tool results so chats can be searched and resumed.">
          <Toggle label="Record chats" checked={config.sessions.recording} onChange={(recording) => save({ sessions: { recording } })} />
        </Row>
        <Row label="Keep history for" hint="Days of history kept locally.">
          <NumberField
            label="Retention days"
            min={0}
            max={3650}
            suffix="days"
            value={config.sessions.retentionDays}
            onCommit={(retentionDays) => save({ sessions: { retentionDays } })}
          />
        </Row>
      </Group>

      <Group title="Context" description="The app estimates how long a chat has become. These numbers are local estimates, not the provider's.">
        <Row label="Long-chat threshold" hint="Chats above this many estimated tokens are flagged.">
          <NumberField
            label="Advisory tokens"
            min={10000}
            max={100000000}
            suffix="tokens"
            value={context.advisoryTokens}
            onCommit={(advisoryTokens) => save({ context: { advisoryTokens } })}
          />
        </Row>
        <Row label="Compact automatically" hint="When a chat gets long and work is idle, hand it to a fresh conversation with a brief.">
          <Toggle
            label="Compact automatically"
            checked={context.autoCompact}
            onChange={(autoCompact) => save({ context: { autoCompact } })}
          />
        </Row>
      </Group>

      <Group title="Handoff prompt" description="Asks the current chat for the brief that starts the next one. The continuation marker and recovery notes are fixed.">
        <div className="st-row is-stacked">
          <TextArea
            label="Handoff prompt"
            rows={8}
            mono
            value={context.handoffPrompt || DEFAULT_HANDOFF_PROMPT}
            onCommit={(handoffPrompt) => save({ context: { handoffPrompt: handoffPrompt.trim() === DEFAULT_HANDOFF_PROMPT ? '' : handoffPrompt } })}
          />
          <div className="st-actions">
            <Button
              variant="ghost"
              disabled={!context.handoffPrompt}
              onClick={() => save({ context: { handoffPrompt: '' } })}
            >
              Reset to default
            </Button>
          </div>
        </div>
      </Group>
    </div>
  );
}
