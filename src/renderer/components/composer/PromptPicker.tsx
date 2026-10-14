import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import type { PromptTemplate, Skill } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { errorMessage } from '@shared/errors';
import { MenuList, Popover } from '../common/Popover';

/** Templates and skills invoke the same backend preparation in either frontend. */
export function PromptPicker({ cwd, skills, onChoose }: { cwd: string | null; skills: Skill[]; onChoose(text: string): void }) {
  return (
    <Popover label="Prompts and skills" panelClassName="is-picker" trigger={({ open, toggle }) => (
      <button type="button" className="icon-btn" aria-label="Prompts and skills" title="Prompts and skills" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
        <BookOpen size={15} aria-hidden="true" />
      </button>
    )}>
      {(close) => <PromptList cwd={cwd} skills={skills} onChoose={(text) => { close(); onChoose(text); }} />}
    </Popover>
  );
}

function PromptList({ cwd, skills, onChoose }: { cwd: string | null; skills: Skill[]; onChoose(text: string): void }) {
  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void invoke('chat:templates', cwd).then((value) => { if (active) setTemplates(value); }, (reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [cwd]);
  return (
    <div className="picker">
      <MenuList onClose={() => {}} entries={[
        { kind: 'label', label: 'Prompt templates' },
        ...(templates ?? []).map((template) => ({ label: `/${template.name}${template.argumentHint ? ` ${template.argumentHint}` : ''} — ${template.description}`, onSelect: () => onChoose(`/${template.name} `) })),
        { kind: 'label', label: 'Skills' },
        ...skills.map((skill) => ({ label: `/${skill.id} — ${skill.description}`, onSelect: () => onChoose(`/${skill.id} `) }))
      ]} />
      {templates === null && !error && <p className="picker-note" role="status">Loading prompts…</p>}
      {error && <p className="picker-note is-error" role="alert">{error}</p>}
      {templates?.length === 0 && <p className="picker-note">Add Markdown prompts to .creatine/prompts/ in your project.</p>}
    </div>
  );
}
