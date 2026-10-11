import type { JSX } from 'react';
import { effortLabel } from '@shared/model-selection';
import type { AppState } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { ModelDefaults } from '../ModelDefaults';
import { Button, Group, NumberField, Pill, Row, Segmented, Toggle, useRun, useSave } from '../controls';

export function ChatGptSection({ state }: { state: AppState }): JSX.Element {
  const { config, browser, models, usage } = state;
  const save = useSave();
  const run = useRun();

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

      <Group title="Models" description="Models and thinking levels match your signed-in ChatGPT picker.">
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
                <span className="st-muted">{model.presets?.map((preset) => preset.label).join(', ') || model.efforts.map((effort) => effortLabel(model, effort)).join(', ') || 'No reasoning levels'}</span>
              </li>
            ))}
          </ul>
        )}
        <ModelDefaults
          catalog={models}
          value={{ model: config.ui.defaultModel, reasoning: config.ui.defaultReasoning }}
          inherited={models.defaultModel}
          labels={{
            model: 'Default model',
            modelHint: 'Used for new chats unless a chat picks its own.',
            reasoning: 'Default reasoning',
            reasoningHint: "Used for new chats. Account default leaves the model's choice.",
            unset: 'Account default'
          }}
          onChange={({ model, reasoning }) => save({ ui: { defaultModel: model, defaultReasoning: reasoning } })}
        />
      </Group>

      <Group title="Usage">
        <Row label="Usage limits" hint={usage.fetchedAt ? 'As reported by ChatGPT.' : 'Not fetched yet.'}>
          <span className="st-muted">{usage.summary ?? 'Unknown'}</span>
        </Row>
      </Group>
    </div>
  );
}
