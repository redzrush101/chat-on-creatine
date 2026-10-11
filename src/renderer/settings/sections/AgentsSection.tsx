import type { JSX } from 'react';
import { REASONING_EFFORTS } from '@shared/config';
import type { ReasoningEffort } from '@shared/config';
import type { AppState } from '@shared/types';
import { ApiKeyField } from '../TunnelFields';
import { Group, NumberField, Row, SelectField, Segmented, TextField, Toggle, useSave } from '../controls';

export function AgentsSection({ state }: { state: AppState }): JSX.Element {
  const { config, models, secretsSet } = state;
  const save = useSave();
  const agents = config.agents;
  const automation = config.automation;
  const isApi = automation.backend === 'api';

  return (
    <div className="st-stack">
      <Group title="Workers" description="A chat can start workers that run tasks in parallel and report back.">
        <Row label="Multi-agent workers" hint="Let a chat start and message worker chats.">
          <Toggle label="Multi-agent workers" checked={agents.enabled} onChange={(enabled) => save({ agents: { enabled } })} />
        </Row>
        <Row label="Simultaneous workers" hint="Per prime chat. Extra workers wait in the queue.">
          <NumberField label="Max concurrent workers" min={1} max={8} value={agents.maxConcurrent} onCommit={(maxConcurrent) => save({ agents: { maxConcurrent } })} />
        </Row>
        <Row label="Default worker model" hint="Used when a worker does not name a model.">
          <SelectField
            label="Default worker model"
            value={agents.defaultModel ?? ''}
            options={[
              { value: '', label: 'Same as the chat' },
              ...models.models.map((model) => ({ value: model.id, label: model.label })),
              ...(agents.defaultModel && !models.models.some((model) => model.id === agents.defaultModel)
                ? [{ value: agents.defaultModel, label: agents.defaultModel }]
                : [])
            ]}
            onChange={(value) => save({ agents: { defaultModel: value === '' ? null : value } })}
          />
        </Row>
        <Row label="Default worker reasoning">
          <SelectField
            label="Default worker reasoning"
            value={agents.defaultReasoning ?? ''}
            options={[
              { value: '', label: 'Same as the chat' },
              ...REASONING_EFFORTS.map((effort) => ({ value: effort, label: effort }))
            ]}
            onChange={(value) => save({ agents: { defaultReasoning: value === '' ? null : (value as ReasoningEffort) } })}
          />
        </Row>
        <Row label="Wait for workers" hint="Goal and Loop wait for a chat's workers before deciding the next step.">
          <Toggle label="Wait for workers" checked={agents.waitForWorkers} onChange={(waitForWorkers) => save({ agents: { waitForWorkers } })} />
        </Row>
      </Group>

      <Group title="Goal and Loop" description="Who decides the next automatic step.">
        <Row stacked label="Decision backend">
          <Segmented
            label="Automation backend"
            value={automation.backend}
            options={[
              { value: 'chatgpt', label: 'ChatGPT helper' },
              { value: 'api', label: 'API' }
            ]}
            onChange={(backend) => save({ automation: { backend } })}
          />
        </Row>
        {!isApi && (
          <Row label="Helper model" hint="A helper chat in ChatGPT makes the decisions.">
            <TextField
              mono
              label="Helper model"
              list="st-model-ids"
              value={automation.helperModel}
              onCommit={(helperModel) => save({ automation: { helperModel } })}
            />
          </Row>
        )}
        {isApi && (
          <>
            <Row label="API base URL" hint="Any OpenAI-compatible endpoint.">
              <TextField
                mono
                label="API base URL"
                value={automation.apiBaseUrl}
                onCommit={(apiBaseUrl) => save({ automation: { apiBaseUrl } })}
              />
            </Row>
            <Row label="API model">
              <TextField mono label="API model" value={automation.apiModel} onCommit={(apiModel) => save({ automation: { apiModel } })} />
            </Row>
            <Row stacked label="API key" hint="Stored in the system keychain. It is never shown again.">
              <ApiKeyField secretKey="automationApiKey" saved={secretsSet.includes('automationApiKey')} label="Automation API key" />
            </Row>
          </>
        )}
        <Row label="Maximum automatic steps" hint="Hard stop for automatic follow-ups per Goal or Loop run.">
          <NumberField label="Maximum automatic steps" min={1} max={500} value={automation.maxSteps} onCommit={(maxSteps) => save({ automation: { maxSteps } })} />
        </Row>
        <Row label="Continue unfinished answers" hint="Send Continue when an answer ends with an error or is cut off.">
          <Toggle
            label="Continue unfinished answers"
            checked={automation.autoContinue}
            onChange={(autoContinue) => save({ automation: { autoContinue } })}
          />
        </Row>
        <Row label="Session finish tool" hint="Lets a model hold its turn open for queued instructions. The composer can also end the turn.">
          <Toggle label="Session finish tool" checked={automation.finishTool} onChange={(finishTool) => save({ automation: { finishTool } })} />
        </Row>
      </Group>

      <datalist id="st-model-ids">
        {models.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </datalist>
    </div>
  );
}
