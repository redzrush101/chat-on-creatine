import { useState } from 'react';
import type { JSX } from 'react';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { CAPABILITIES } from '@shared/config';
import type { Capability } from '@shared/config';
import type { AppState } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { Button, Group, Row, Segmented, TextField, Toggle, useRun, useSave } from '../controls';

const CAPABILITY_HELP: Record<Capability, string> = {
  read: 'Read files inside approved folders.',
  write: 'Edit existing files and apply patches.',
  create: 'Create new files and folders.',
  delete: 'Delete files and folders.',
  move: 'Rename and move files.',
  exec: 'Run shell commands with your user privileges. Commands are not limited to approved folders.',
  search: 'Search file names and contents inside approved folders.',
  browser: 'Let tools open web pages in the app’s browser.'
};

export function WorkspaceSection({ state }: { state: AppState }): JSX.Element {
  const { config } = state;
  const save = useSave();
  const run = useRun();
  const policy = config.commandPolicy;

  const addFolder = () =>
    run(async () => {
      const path = await invoke('app:pickFolder');
      if (path && !config.roots.some((root) => root.path === path)) {
        save({ roots: [...config.roots, { id: crypto.randomUUID(), path, label: '' }] });
      }
    });

  const setRules = (rules: string[]) => save({ commandPolicy: { rules } });

  return (
    <div className="st-stack">
      <Group title="Approved folders" description="File tools reach only these folders and everything inside them.">
        {config.roots.length === 0 && <Row label="No folders yet" hint="Add a project folder so ChatGPT can work with its files." />}
        {config.roots.map((root) => (
          <Row key={root.id} stacked label={root.path}>
            <div className="st-root-edit">
              <TextField
                label={`Label for ${root.path}`}
                placeholder="Label (optional)"
                value={root.label}
                onCommit={(label) =>
                  save({ roots: config.roots.map((item) => (item.id === root.id ? { ...item, label } : item)) })
                }
              />
              <Button variant="ghost" aria-label="Reveal folder" onClick={() => void run(() => invoke('app:revealPath', root.path))}>
                <FolderOpen size={14} aria-hidden /> Reveal
              </Button>
              <Button
                variant="ghost"
                aria-label="Remove folder"
                onClick={() => save({ roots: config.roots.filter((item) => item.id !== root.id) })}
              >
                <Trash2 size={14} aria-hidden /> Remove
              </Button>
            </div>
          </Row>
        ))}
        <div className="st-row">
          <Button variant="primary" onClick={() => void addFolder()}>
            <Plus size={14} aria-hidden /> Add folder
          </Button>
        </div>
      </Group>

      <Group title="Read-only mode">
        <Row label="Read-only" hint="Blocks writing, creating, deleting, moving, command execution and desktop control. Overrides the switches below.">
          <Toggle label="Read-only mode" checked={config.readOnly} onChange={(readOnly) => save({ readOnly })} />
        </Row>
      </Group>

      <Group title="Capabilities" description="What ChatGPT's tools may do.">
        {CAPABILITIES.map((capability) => (
          <Row key={capability} label={capability[0]!.toUpperCase() + capability.slice(1)} hint={CAPABILITY_HELP[capability]}>
            <Toggle
              label={`Allow ${capability}`}
              checked={config.capabilities[capability]}
              onChange={(value) => save({ capabilities: { [capability]: value } })}
            />
          </Row>
        ))}
      </Group>

      <Group title="Command policy" description="Limits which shell commands the exec capability may run.">
        <Row label="Restrict commands" hint="When on, commands must match the rules below.">
          <Toggle
            label="Restrict commands"
            checked={policy.enabled}
            onChange={(enabled) => save({ commandPolicy: { enabled } })}
          />
        </Row>
        <Row
          label="Mode"
          hint={policy.mode === 'allowlist' ? 'Only commands matching a rule run.' : 'Commands matching a rule are blocked; the rest run.'}
        >
          <Segmented
            label="Command policy mode"
            value={policy.mode}
            options={[
              { value: 'allowlist', label: 'Allowlist' },
              { value: 'denylist', label: 'Denylist' }
            ]}
            onChange={(mode) => save({ commandPolicy: { mode } })}
          />
        </Row>
        <div className="st-rules">
          <p className="st-muted">
            One rule per line as an argument prefix, such as <code className="st-mono">git status</code> or <code className="st-mono">npm run *</code>.
          </p>
          {policy.rules.map((rule, index) => (
            <div key={`${index}:${rule}`} className="st-rule">
              <TextField
                mono
                label={`Rule ${index + 1}`}
                value={rule}
                onCommit={(next) => {
                  const rules = next.trim() === '' ? policy.rules.filter((_, i) => i !== index) : policy.rules.map((item, i) => (i === index ? next.trim() : item));
                  setRules(rules);
                }}
              />
              <Button variant="ghost" aria-label={`Remove rule ${index + 1}`} onClick={() => setRules(policy.rules.filter((_, i) => i !== index))}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          ))}
          <NewRule onAdd={(rule) => setRules([...policy.rules, rule])} />
        </div>
      </Group>
    </div>
  );
}

function NewRule({ onAdd }: { onAdd(rule: string): void }): JSX.Element {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const rule = draft.trim();
    if (!rule) return;
    onAdd(rule);
    setDraft('');
  };
  return (
    <div className="st-rule">
      <input
        className="st-input is-mono"
        aria-label="New command rule"
        placeholder="git status"
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
        }}
      />
      <Button onClick={submit} disabled={!draft.trim()}>
        Add rule
      </Button>
    </div>
  );
}
