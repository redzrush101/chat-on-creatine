import type { JSX } from 'react';
import { REASONING_EFFORTS } from '@shared/config';
import type { ReasoningEffort } from '@shared/config';
import type { AppState } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { Button, Group, NumberField, Pill, Row, SelectField, Segmented, Toggle, useRun, useSave } from '../controls';

const REASONING_LABEL: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  pro: 'Pro'
};

export function ChatGptSection({ state }: { state: AppState }): JSX.Element {
  const { config, browser, models, usage } = state;
  const save = useSave();
  const run = useRun();
  const selectedModel = models.models.find((model) => model.id === config.ui.defaultModel) ?? null;
  const reasoningOptions = selectedModel ? selectedModel.efforts : REASONING_EFFORTS;

  return (
    <div className="st-stack">
      <Group title="Browser" description="Where ChatGPT runs. Signing in happens in that browser.">
        <Row stacked label="Browser host">
          <Segmented
            label="Browser host"
            value={config.browser.host}
            options={[
              { value: 'builtin', label: 'Built-in browser' },
              { value: 'extension', label: 'Chrome extension (beta)' }
            ]}
            onChange={(host) => save({ browser: { host } })}
          />
          <p className="st-muted st-pad-top">
            {config.browser.host === 'builtin'
              ? 'The app runs its own ChatGPT window.'
              : 'Uses your Chrome profile through the companion extension. Load the extension once from chrome://extensions.'}
          </p>
        </Row>
        {config.browser.host === 'extension' && (
          <Row
            label="Extension bridge port"
            hint={browser.extensionConnected ? 'The extension is connected.' : 'Waiting for the extension to connect.'}
          >
            <NumberField
              label="Extension bridge port"
              min={1024}
              max={65535}
              value={config.browser.bridgePort}
              onCommit={(bridgePort) => save({ browser: { bridgePort } })}
            />
          </Row>
        )}
        <Row label="ChatGPT session" hint={browser.detail || undefined}>
          <span className="st-inline">
            {browser.signedIn === null ? <Pill>Unknown</Pill> : browser.signedIn ? <Pill tone="ok">Signed in</Pill> : <Pill tone="warn">Signed out</Pill>}
            {browser.signedIn !== true && (
              <Button variant="primary" onClick={() => void run(() => invoke('browser:signIn'))}>
                Sign in
              </Button>
            )}
          </span>
        </Row>
        <Row label="ChatGPT window" hint={`${browser.openTabs} open ${browser.openTabs === 1 ? 'tab' : 'tabs'}`}>
          <span className="st-inline">
            <Button onClick={() => void run(() => invoke('browser:show', null))}>Show</Button>
            <Button variant="ghost" onClick={() => void run(() => invoke('browser:hide'))}>
              Hide
            </Button>
          </span>
        </Row>
        <Row label="Close idle tabs after" hint="App-owned ChatGPT tabs close after this idle time. History is kept.">
          <NumberField
            label="Idle tab minutes"
            min={1}
            max={240}
            suffix="min"
            value={config.browser.idleTabMinutes}
            onCommit={(idleTabMinutes) => save({ browser: { idleTabMinutes } })}
          />
        </Row>
        <Row label="Allow unattributed tool calls" hint="Accept tool calls whose ChatGPT conversation cannot be identified.">
          <Toggle
            label="Allow unattributed tool calls"
            checked={config.browser.allowUnattributed}
            onChange={(allowUnattributed) => save({ browser: { allowUnattributed } })}
          />
        </Row>
      </Group>

      <Group title="Models" description="The catalog comes from your signed-in account.">
        <Row
          label="Model catalog"
          hint={
            models.state === 'error'
              ? (models.error ?? 'Could not load models.')
              : models.fetchedAt
                ? `${models.models.length} models`
                : models.state === 'loading'
                  ? 'Loading models…'
                  : 'Not loaded yet.'
          }
        >
          <Button onClick={() => void run(() => invoke('browser:refreshModels'))} disabled={models.state === 'loading'}>
            Reload ChatGPT models
          </Button>
        </Row>
        {models.models.length > 0 && (
          <ul className="st-model-list">
            {models.models.map((model) => (
              <li key={model.id}>
                <span>{model.label}</span>
                <span className="st-mono st-muted">{model.id}</span>
                <span className="st-muted">{model.efforts.map((effort) => REASONING_LABEL[effort]).join(', ') || 'No reasoning levels'}</span>
              </li>
            ))}
          </ul>
        )}
        <Row label="Default model" hint="Used for new chats unless a chat picks its own.">
          <SelectField
            label="Default model"
            value={config.ui.defaultModel ?? ''}
            options={[
              { value: '', label: 'Account default' },
              ...models.models.map((model) => ({ value: model.id, label: model.label })),
              ...(config.ui.defaultModel && !selectedModel ? [{ value: config.ui.defaultModel, label: config.ui.defaultModel }] : [])
            ]}
            onChange={(value) => save({ ui: { defaultModel: value === '' ? null : value } })}
          />
        </Row>
        <Row label="Default reasoning" hint="Used for new chats. Account default leaves the model's choice.">
          <SelectField
            label="Default reasoning"
            value={config.ui.defaultReasoning ?? ''}
            options={[
              { value: '', label: 'Account default' },
              ...reasoningOptions.map((effort) => ({ value: effort, label: REASONING_LABEL[effort] }))
            ]}
            onChange={(value) => save({ ui: { defaultReasoning: value === '' ? null : (value as ReasoningEffort) } })}
          />
        </Row>
      </Group>

      <Group title="Usage">
        <Row label="Usage limits" hint={usage.fetchedAt ? 'As reported by ChatGPT.' : 'Not fetched yet.'}>
          <span className="st-muted">{usage.summary ?? 'Unknown'}</span>
        </Row>
      </Group>
    </div>
  );
}
