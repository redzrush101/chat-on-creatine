import { useState } from 'react';
import type { JSX } from 'react';
import { Plus, RotateCw, Trash2 } from 'lucide-react';
import type { PluginServerConfig } from '@shared/config';
import type { AppState, PluginStatus } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { Button, Group, Pill, Row, Segmented, TextArea, TextField, Toggle, useRun, useSave } from '../controls';

const STATE_TONE: Record<PluginStatus['state'], 'ok' | 'warn' | 'bad' | 'accent' | 'muted'> = {
  running: 'ok',
  starting: 'accent',
  stopped: 'muted',
  error: 'bad'
};

export function PluginsSection({ state }: { state: AppState }): JSX.Element {
  const { config } = state;
  const save = useSave();
  const run = useRun();
  const [adding, setAdding] = useState(false);

  const update = (id: string, change: Partial<PluginServerConfig>) =>
    save({ plugins: config.plugins.map((server) => (server.id === id ? { ...server, ...change } : server)) });

  return (
    <div className="st-stack">
      <Group title="Plugin servers" description="External MCP servers whose tools ChatGPT can call through the Plugins connector.">
        {config.plugins.length === 0 && <div className="st-row"><span className="st-muted">No plugin servers yet.</span></div>}
      </Group>

      {config.plugins.map((server) => {
        const status = state.plugins.find((item) => item.id === server.id) ?? null;
        return (
          <section key={server.id} className="st-card st-plugin">
            <div className="st-surface-head">
              <div>
                <strong>{server.name}</strong>
                <div className="st-muted st-mono st-truncate">
                  {server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}
                </div>
              </div>
              <span className="st-inline">
                <Pill tone={status ? STATE_TONE[status.state] : 'muted'}>{status?.state ?? (server.enabled ? 'not started' : 'off')}</Pill>
                <Toggle label={`Enable ${server.name}`} checked={server.enabled} onChange={(enabled) => update(server.id, { enabled })} />
              </span>
            </div>
            {status?.detail && <p className="st-muted">{status.detail}</p>}

            {status && status.tools.length > 0 && (
              <ul className="st-tool-list">
                {status.tools.map((tool) => {
                  const off = server.disabledTools.includes(tool.name);
                  return (
                    <li key={tool.name}>
                      <div>
                        <div className="st-mono">{tool.name}</div>
                        {tool.description && <div className="st-row-hint">{tool.description}</div>}
                      </div>
                      <Toggle
                        label={`Allow ${tool.name}`}
                        checked={!off}
                        onChange={(on) =>
                          update(server.id, {
                            disabledTools: on ? server.disabledTools.filter((name) => name !== tool.name) : [...server.disabledTools, tool.name]
                          })
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="st-actions">
              <Button variant="ghost" onClick={() => void run(() => invoke('plugins:restart', server.id))}>
                <RotateCw size={14} aria-hidden /> Restart
              </Button>
              <Button variant="ghost" onClick={() => save({ plugins: config.plugins.filter((item) => item.id !== server.id) })}>
                <Trash2 size={14} aria-hidden /> Remove
              </Button>
            </div>
          </section>
        );
      })}

      {adding ? (
        <AddPluginForm
          onCancel={() => setAdding(false)}
          onAdd={(server) => {
            save({ plugins: [...config.plugins, server] });
            setAdding(false);
          }}
        />
      ) : (
        <div className="st-row">
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden /> Add server
          </Button>
        </div>
      )}
    </div>
  );
}

function AddPluginForm({ onAdd, onCancel }: { onAdd(server: PluginServerConfig): void; onCancel(): void }): JSX.Element {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState('');

  const ready = name.trim() !== '' && (transport === 'stdio' ? command.trim() !== '' : url.trim() !== '');

  const submit = () => {
    if (!ready) return;
    onAdd({
      id: crypto.randomUUID(),
      name: name.trim(),
      enabled: true,
      transport,
      command: transport === 'stdio' ? command.trim() : '',
      args: transport === 'stdio' ? lines(args) : [],
      env: transport === 'stdio' ? parseEnv(env) : {},
      url: transport === 'http' ? url.trim() : '',
      disabledTools: []
    });
  };

  return (
    <section className="st-card st-plugin-form">
      <h3>Add plugin server</h3>
      <Row label="Name">
        <TextField label="Server name" value={name} placeholder="Memory" onCommit={setName} />
      </Row>
      <Row label="Transport" hint={transport === 'stdio' ? 'The app starts the program and talks over its standard input and output.' : 'The app connects to a server that is already running.'}>
        <Segmented<'stdio' | 'http'>
          label="Transport"
          value={transport}
          options={[
            { value: 'stdio', label: 'Local program' },
            { value: 'http', label: 'HTTP' }
          ]}
          onChange={setTransport}
        />
      </Row>
      {transport === 'stdio' ? (
        <>
          <Row label="Command">
            <TextField mono label="Command" placeholder="npx" value={command} onCommit={setCommand} />
          </Row>
          <Row stacked label="Arguments" hint="One per line.">
            <TextArea mono rows={3} label="Arguments" value={args} onCommit={setArgs} />
          </Row>
          <Row stacked label="Environment" hint="KEY=VALUE, one per line. Do not put secrets here.">
            <TextArea mono rows={3} label="Environment" value={env} onCommit={setEnv} />
          </Row>
        </>
      ) : (
        <Row label="URL">
          <TextField mono label="Server URL" placeholder="https://example.com/mcp" value={url} onCommit={setUrl} />
        </Row>
      )}
      <div className="st-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready} onClick={submit}>
          Add server
        </Button>
      </div>
    </section>
  );
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of lines(text)) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}
