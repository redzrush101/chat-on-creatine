import { useState } from 'react';
import type { JSX } from 'react';
import { Eye, Plus, Trash2 } from 'lucide-react';
import type { AppState } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { Button, Dialog, Group, useRun } from '../controls';

export function SkillsSection({ state }: { state: AppState }): JSX.Element {
  const run = useRun();
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);

  const importSkill = () =>
    run(async () => {
      const folder = await invoke('app:pickFolder');
      if (folder) await invoke('skills:import', folder);
    });

  const view = (id: string, name: string) =>
    run(async () => {
      const text = await invoke('skills:read', id);
      setViewing({ name, text });
    });

  return (
    <div className="st-stack">
      <Group title="Skills" description="Folders with a SKILL.md file. ChatGPT reads a skill when its description matches the task.">
        {state.skills.length === 0 && <div className="st-row"><span className="st-muted">No skills imported yet.</span></div>}
        {state.skills.map((skill) => (
          <div key={skill.id} className="st-row">
            <div className="st-row-text">
              <div className="st-row-label">{skill.name}</div>
              <div className="st-row-hint">{skill.description}</div>
              <div className="st-row-hint st-mono st-truncate">{skill.path}</div>
            </div>
            <div className="st-row-control st-inline">
              <Button variant="ghost" aria-label={`View ${skill.name}`} onClick={() => void view(skill.id, skill.name)}>
                <Eye size={14} aria-hidden /> View
              </Button>
              <Button variant="ghost" aria-label={`Remove ${skill.name}`} onClick={() => void run(() => invoke('skills:remove', skill.id))}>
                <Trash2 size={14} aria-hidden /> Remove
              </Button>
            </div>
          </div>
        ))}
        <div className="st-row">
          <Button variant="primary" onClick={() => void importSkill()}>
            <Plus size={14} aria-hidden /> Import skill folder
          </Button>
        </div>
      </Group>

      {viewing && (
        <Dialog title={viewing.name} onClose={() => setViewing(null)}>
          <pre className="st-pre">{viewing.text}</pre>
        </Dialog>
      )}
    </div>
  );
}
