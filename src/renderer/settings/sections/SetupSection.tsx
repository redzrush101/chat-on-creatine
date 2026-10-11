import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { CircleCheck, Circle, PartyPopper } from 'lucide-react';
import type { AppState, SurfaceStatus } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { Button, ConnectionPill, CopyButton, Pill, Row, useRun, useSave } from '../controls';
import { TunnelFields } from '../TunnelFields';

export function SetupSection({ state }: { state: AppState }): JSX.Element {
  const { config, connection, browser, tools, secretsSet } = state;
  const save = useSave();
  const run = useRun();
  const [toolResult, setToolResult] = useState<string | null>(null);

  const kind = config.connection.kind;
  const credentialsReady =
    kind === 'openai'
      ? secretsSet.includes('tunnelApiKey') && config.connection.tunnelId !== ''
      : kind === 'cloudflared'
        ? tools.cloudflared !== null
        : true;
  const enabledSurfaces = connection.surfaces.filter((surface) => surface.enabled);
  const appAdded = enabledSurfaces.some((surface) => surface.handshakeAt !== null);
  const signedIn = browser.signedIn === true;
  const folderReady = config.roots.length > 0;
  const connected = connection.state === 'connected';

  const addFolder = () =>
    run(async () => {
      const path = await invoke('app:pickFolder');
      if (path && !config.roots.some((root) => root.path === path)) {
        save({ roots: [...config.roots, { id: crypto.randomUUID(), path, label: '' }] });
      }
    });

  const installTunnel = () =>
    run(async () => {
      setToolResult('Installing tunnel-client…');
      const path = await invoke('connection:installTunnelClient');
      setToolResult(`Installed at ${path}`);
    });

  const allDone = folderReady && credentialsReady && appAdded && signedIn;

  return (
    <div className="st-setup">
      {allDone && (
        <div className="st-ready">
          <PartyPopper size={20} aria-hidden />
          <div>
            <strong>You are ready.</strong>
            <span>Start a chat from the sidebar. Tools are available while the connection is up.</span>
          </div>
        </div>
      )}

      <Step index={1} title="Approve a project folder" done={folderReady}>
        <p className="st-muted">ChatGPT's file tools only reach folders you approve.</p>
        {config.roots.length > 0 && (
          <ul className="st-plain-list">
            {config.roots.map((root) => (
              <li key={root.id} className="st-mono">
                {root.label ? `${root.label} · ` : ''}
                {root.path}
              </li>
            ))}
          </ul>
        )}
        <div className="st-actions">
          <Button variant={folderReady ? 'default' : 'primary'} onClick={() => void addFolder()}>
            Add folder
          </Button>
        </div>
      </Step>

      <Step index={2} title="Connect the local tools" done={credentialsReady && connected}>
        {kind === 'openai' ? (
          <>
            <p className="st-muted">Enter the tunnel ID and key from the OpenAI platform, then press Connect.</p>
            <div className="st-card is-inset">
              <TunnelFields state={state} compact />
            </div>
          </>
        ) : kind === 'cloudflared' ? (
          <p className="st-muted">
            The Cloudflare quick tunnel needs the cloudflared program. The public URL changes each time the app connects.
          </p>
        ) : (
          <p className="st-muted">Manual: forward your own HTTPS tunnel to the loopback URL shown in Connection.</p>
        )}

        {kind === 'cloudflared' && tools.cloudflared === null && (
          <p className="st-warn">cloudflared was not found. Install it, or set its path in Connection.</p>
        )}
        {tools.tunnelClient === null && kind === 'openai' && (
          <div className="st-actions">
            <Button onClick={() => void installTunnel()}>Install tunnel-client</Button>
            {toolResult && <span className="st-muted">{toolResult}</span>}
          </div>
        )}

        <div className="st-status-line">
          <ConnectionPill state={connection.state} />
          <span className="st-muted">{connection.detail}</span>
          <span className="st-spacer" />
          {connected || connection.state === 'connecting' || connection.state === 'starting' ? (
            <Button onClick={() => void run(() => invoke('connection:disconnect'))}>Disconnect</Button>
          ) : (
            <Button
              variant="primary"
              disabled={!credentialsReady}
              onClick={() => void run(() => invoke('connection:connect'))}
            >
              Connect
            </Button>
          )}
        </div>
      </Step>

      <Step index={3} title="Add the app in ChatGPT" done={appAdded}>
        {enabledSurfaces.length === 0 ? (
          <p className="st-muted">No connector is enabled. Enable one in Workspace.</p>
        ) : (
          <>
            <ol className="st-steps-inline">
              <li>Open ChatGPT, go to Plugins, click Add and choose Create MCP App.</li>
              {kind === 'openai' ? (
                <li>Under Connection choose Tunnel, pick your tunnel and select No authentication.</li>
              ) : (
                <li>Under Connection choose the URL option and paste the public URL shown below. Select No authentication.</li>
              )}
              <li>Name the app exactly as shown, then create it and enable its actions.</li>
            </ol>
            {enabledSurfaces.map((surface) => (
              <ConnectorCard key={surface.id} surface={surface} kind={kind} />
            ))}
          </>
        )}
      </Step>

      <Step index={4} title="Sign in to ChatGPT" done={signedIn}>
        <p className="st-muted">
          {browser.signedIn === null
            ? 'Checking the ChatGPT session…'
            : signedIn
              ? 'Signed in. Chats and models come from this account.'
              : 'Sign in once in the ChatGPT window the app opens.'}
        </p>
        <div className="st-actions">
          {!signedIn && (
            <Button variant="primary" onClick={() => void run(() => invoke('browser:signIn'))}>
              Open ChatGPT sign-in
            </Button>
          )}
          <Button variant="ghost" onClick={() => void run(() => invoke('browser:show', null))}>
            Show ChatGPT window
          </Button>
        </div>
      </Step>
    </div>
  );
}

function Step({ index, title, done, children }: { index: number; title: string; done: boolean; children: ReactNode }): JSX.Element {
  const Icon = done ? CircleCheck : Circle;
  return (
    <section className={done ? 'st-step is-done' : 'st-step'}>
      <header className="st-step-head">
        <Icon size={18} aria-hidden className="st-step-icon" />
        <h2>
          <span className="st-step-index">{index}.</span> {title}
        </h2>
        {done && <Pill tone="ok">Done</Pill>}
      </header>
      <div className="st-step-body">{children}</div>
    </section>
  );
}

function ConnectorCard({ surface, kind }: { surface: SurfaceStatus; kind: AppState['config']['connection']['kind'] }): JSX.Element {
  return (
    <div className="st-card is-inset st-connector">
      <div className="st-connector-head">
        <strong>{surface.id === 'core' ? 'Core' : surface.id === 'desktop' ? 'Desktop' : 'Plugins'}</strong>
        <ConnectionPill state={surface.state} />
      </div>
      <Row stacked label="Connector name">
        <div className="st-copy-line">
          <code className="st-mono">{surface.connectorName}</code>
          <CopyButton text={surface.connectorName} />
        </div>
      </Row>
      <Row stacked label="Description">
        <div className="st-copy-line">
          <span className="st-muted">{surface.connectorDescription}</span>
          <CopyButton text={surface.connectorDescription} />
        </div>
      </Row>
      {kind !== 'openai' && (
        <Row stacked label="Public URL">
          {surface.publicUrl ? (
            <div className="st-copy-line">
              <code className="st-mono st-truncate">{surface.publicUrl}</code>
              <CopyButton text={surface.publicUrl} />
            </div>
          ) : (
            <span className="st-muted">Connect first; the public URL appears here.</span>
          )}
        </Row>
      )}
      {surface.handshakeAt !== null && <span className="st-muted">ChatGPT has connected to this app.</span>}
    </div>
  );
}
