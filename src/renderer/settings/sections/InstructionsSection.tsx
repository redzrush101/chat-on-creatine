import type { JSX } from 'react';
import type { AppState } from '@shared/types';
import { Group, Row, TextArea, Toggle, useSave } from '../controls';

export function InstructionsSection({ state }: { state: AppState }): JSX.Element {
  const { config } = state;
  const save = useSave();
  return (
    <div className="st-stack">
      <Group title="Standing instructions" description="Added to the opening context of every new chat, after the tool instructions.">
        <div className="st-row is-stacked">
          <TextArea
            label="Standing instructions"
            rows={10}
            value={config.instructions.standing}
            placeholder="For example: prefer small, focused changes and run the test suite before reporting done."
            onCommit={(standing) => save({ instructions: { standing } })}
          />
        </div>
      </Group>
      <Group title="Project context">
        <Row label="Include AGENTS.md" hint="Add the approved folder's root AGENTS.md to the opening context of new chats.">
          <Toggle
            label="Include AGENTS.md"
            checked={config.instructions.includeAgentsMd}
            onChange={(includeAgentsMd) => save({ instructions: { includeAgentsMd } })}
          />
        </Row>
      </Group>
    </div>
  );
}
