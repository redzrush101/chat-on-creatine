import type { JSX } from 'react';
import type { AppState } from '@shared/types';
import { ModelDefaults } from '../ModelDefaults';
import { ApiKeyField } from '../TunnelFields';
import { Group, NumberField, Row, Segmented, TextField, Toggle, useSave } from '../controls';

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
        <ModelDefaults
          catalog={models}
          value={{ model: agents.defaultModel, reasoning: agents.defaultReasoning }}
          inherited={config.ui.defaultModel ?? models.defaultModel}
          labels={{ model: 'Default worker model', modelHint: 'Used when a worker does not name a model.', reasoning: 'Default worker reasoning', unset: 'Same as the chat' }}
          onChange={({ model, reasoning }) => save({ agents: { defaultModel: model, defaultReasoning: reasoning } })}
        />
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
