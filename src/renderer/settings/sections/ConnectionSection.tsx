import type { JSX } from 'react';
import type { AppState, SurfaceStatus } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { ago, Button, ConnectionPill, CopyButton, Group, NumberField, Row, Segmented, TextField, Toggle, useNow, useRun, useSave } from '../controls';
import { TunnelFields } from '../TunnelFields';
import type { Config } from '@shared/config';

const KINDS = [
  { value: 'openai', label: 'OpenAI tunnel' },
  { value: 'cloudflared', label: 'Cloudflare quick tunnel' },
  { value: 'manual', label: 'Manual HTTPS' }
] as const;

export function ConnectionSection({ state }: { state: AppState }): JSX.Element {
  const { config, connection, tools } = state;
  const save = useSave();
  const run = useRun();
  const now = useNow();
  const kind = config.connection.kind;
  const busy = connection.state === 'connected' || connection.state === 'connecting' || connection.state === 'starting';

  return (
    <div className="st-stack">
      <Group title="Status" description="The local MCP listener and its tunnel. Changes take effect on the next connect.">
        <Row label="Connection" hint={connection.detail || undefined}>
          <span className="st-inline">
            <ConnectionPill state={connection.state} />
            {busy ? (
              <Button onClick={() => void run(() => invoke('connection:disconnect'))}>Disconnect</Button>
            ) : (
              <Button variant="primary" onClick={() => void run(() => invoke('connection:connect'))}>
                Connect
              </Button>
            )}
          </span>
        </Row>
        <Row label="Connect automatically" hint="Connect when the app starts.">
          <Toggle
            label="Connect automatically"
            checked={config.connection.autoConnect}
            onChange={(autoConnect) => save({ connection: { autoConnect } })}
          />
        </Row>
      </Group>

      <Group title="Tunnel">
        <Row stacked label="Tunnel type">
          <Segmented
            label="Tunnel type"
            value={kind}
            options={KINDS}
            onChange={(next) => save({ connection: { kind: next as Config['connection']['kind'] } })}
          />
        </Row>
        {kind === 'openai' && <TunnelFields state={state} />}
        {kind === 'cloudflared' && (
          <Row label="Cloudflared program" hint={tools.cloudflared ?? 'Not found on this computer.'}>
            <TextField
              mono
              label="Cloudflared path"
              placeholder="Detected automatically"
              value={config.connection.cloudflaredPath}
              onCommit={(cloudflaredPath) => save({ connection: { cloudflaredPath } })}
            />
          </Row>
        )}
        {kind === 'manual' && (
          <p className="st-muted st-pad">
            Forward your own HTTPS tunnel to the loopback URL below. Keep the secret path; anyone with the full URL can use the tools.
          </p>
        )}
        {kind === 'openai' && (
          <Row label="Tunnel client" hint={tools.tunnelClient ?? 'tunnel-client was not found.'}>
            <span className="st-inline">
              <TextField
                mono
                label="Tunnel client path"
                placeholder="Detected automatically"
                value={config.connection.tunnelClientPath}
                onCommit={(tunnelClientPath) => save({ connection: { tunnelClientPath } })}
              />
              {tools.tunnelClient === null && (
                <Button onClick={() => void run(() => invoke('connection:installTunnelClient'))}>Install</Button>
              )}
            </span>
          </Row>
        )}
      </Group>

      <Group title="Local listener">
        <Row label="Fixed port" hint="0 picks a free loopback port on each connect.">
          <NumberField
            label="Fixed port"
            min={0}
            max={65535}
            value={config.connection.port}
            onCommit={(port) => save({ connection: { port } })}
          />
        </Row>
        <Row label="Connector name suffix" hint={'Added to connector names, e.g. "Core (Laptop)", when one account uses several machines.'}>
          <TextField
            label="Connector name suffix"
            placeholder="Laptop"
            value={config.connection.connectorSuffix}
            onCommit={(connectorSuffix) => save({ connection: { connectorSuffix } })}
          />
        </Row>
      </Group>

      <section className="st-group">
        <header className="st-group-head">
          <h2>Connectors</h2>
          <p>Each enabled connector is a separate app in ChatGPT. Ages update live.</p>
        </header>
        {connection.surfaces.map((surface) => (
          <SurfaceCard key={surface.id} surface={surface} now={now} />
        ))}
      </section>
    </div>
  );
}

function SurfaceCard({ surface, now }: { surface: SurfaceStatus; now: number }): JSX.Element {
  const title = surface.id === 'core' ? 'Core' : surface.id === 'desktop' ? 'Desktop' : 'Plugins';
  return (
    <div className="st-card st-surface">
      <div className="st-surface-head">
        <div>
          <strong>{title}</strong>
          <div className="st-muted st-mono">{surface.connectorName}</div>
        </div>
        <span className="st-inline">
          {!surface.enabled && <span className="st-pill is-muted">Disabled</span>}
          <ConnectionPill state={surface.state} />
        </span>
      </div>
      {surface.detail && <p className="st-muted">{surface.detail}</p>}
      <dl className="st-facts">
        <dt>Connected</dt>
        <dd>{ago(surface.handshakeAt, now)}</dd>
        <dt>Last request</dt>
        <dd>{ago(surface.lastRequestAt, now)}</dd>
        <dt>Last tool call</dt>
        <dd>{ago(surface.lastToolCallAt, now)}</dd>
        <dt>Tools</dt>
        <dd>{surface.toolCount}</dd>
      </dl>
      {surface.localUrl && (
        <div className="st-copy-line">
          <span className="st-label-inline">Local URL</span>
          <code className="st-mono st-truncate">{surface.localUrl}</code>
          <CopyButton text={surface.localUrl} />
        </div>
      )}
      {surface.publicUrl && (
        <div className="st-copy-line">
          <span className="st-label-inline">Public URL</span>
          <code className="st-mono st-truncate">{surface.publicUrl}</code>
          <CopyButton text={surface.publicUrl} />
        </div>
      )}
    </div>
  );
}
