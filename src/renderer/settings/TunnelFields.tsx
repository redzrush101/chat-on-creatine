import { useState } from 'react';
import type { JSX } from 'react';
import type { AppState } from '@shared/types';
import { Button, Pill, Row, TextField, useRun, useSave, useSecretSave } from './controls';

/** Write-only API key: the value is never read back, only whether one is saved. */
export function ApiKeyField({ secretKey, saved, label }: { secretKey: 'tunnelApiKey' | 'automationApiKey'; saved: boolean; label: string }): JSX.Element {
  const setSecret = useSecretSave();
  const run = useRun();
  const [draft, setDraft] = useState('');
  return (
    <div className="st-keyfield">
      <Pill tone={saved ? 'ok' : 'muted'}>{saved ? 'Saved' : 'Not set'}</Pill>
      <input
        type="password"
        className="st-input is-mono"
        aria-label={label}
        placeholder={saved ? 'Enter a new key to replace it' : 'Paste API key'}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draft.trim()) void run(() => setSecret(secretKey, draft.trim()).then(() => setDraft('')));
        }}
      />
      <Button
        variant="primary"
        disabled={!draft.trim()}
        onClick={() => void run(() => setSecret(secretKey, draft.trim()).then(() => setDraft('')))}
      >
        Save
      </Button>
      {saved && (
        <Button variant="ghost" onClick={() => void run(() => setSecret(secretKey, null))}>
          Clear
        </Button>
      )}
    </div>
  );
}

/** Tunnel IDs and the key for the OpenAI tunnel. `compact` keeps only what the guided setup needs. */
export function TunnelFields({ state, compact = false }: { state: AppState; compact?: boolean }): JSX.Element {
  const { config, secretsSet } = state;
  const save = useSave();
  const connection = config.connection;
  return (
    <>
      <Row label="Tunnel ID" hint="From Platform → Tunnels. Used by the Core connector.">
        <TextField
          mono
          label="Core tunnel ID"
          placeholder="tunnel_…"
          value={connection.tunnelId}
          onCommit={(tunnelId) => save({ connection: { tunnelId } })}
        />
      </Row>
      {!compact && (
        <>
          <Row label="Desktop tunnel ID" hint="Optional. Used by the Desktop connector.">
            <TextField
              mono
              label="Desktop tunnel ID"
              value={connection.desktopTunnelId}
              onCommit={(desktopTunnelId) => save({ connection: { desktopTunnelId } })}
            />
          </Row>
          <Row label="Plugins tunnel ID" hint="Optional. Used by the Plugins connector.">
            <TextField
              mono
              label="Plugins tunnel ID"
              value={connection.pluginsTunnelId}
              onCommit={(pluginsTunnelId) => save({ connection: { pluginsTunnelId } })}
            />
          </Row>
        </>
      )}
      <Row
        stacked
        label="API key"
        hint="Create a Restricted key with Tunnels: Read and Tunnels: Use. It is stored in the system keychain and cannot be shown again."
      >
        <ApiKeyField secretKey="tunnelApiKey" saved={secretsSet.includes('tunnelApiKey')} label="Tunnel API key" />
      </Row>
    </>
  );
}
