import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Skill } from '@shared/types';
import { autoSelectSkill, expandSkillInvocation } from '../src/main/skills/invocation';
import { SkillLibrary, parseFrontmatter } from '../src/main/skills/library';

describe('skill frontmatter', () => {
  it('reads folded and literal multi-line descriptions', () => {
    const folded = parseFrontmatter(
      ['---', 'name: "Git Worktrees"', 'description: >', '  Create worktrees', '  for parallel work.', '', '  Second paragraph.', '---', 'body'].join('\n')
    );
    expect(folded).toEqual({
      name: 'Git Worktrees',
      description: 'Create worktrees for parallel work.\nSecond paragraph.'
    });

    const literal = parseFrontmatter('---\nname: x\ndescription: |\n  line one\n  line two\n---\n');
    expect(literal.description).toBe('line one\nline two');
  });

  it('returns nothing without a header', () => {
    expect(parseFrontmatter('# just markdown')).toEqual({});
  });
});

describe('skill library', () => {
  let base: string;
  let source: string;
  let library: SkillLibrary;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skills-test-')));
    source = path.join(base, 'source', 'Demo Folder');
    await mkdir(path.join(source, 'scripts'), { recursive: true });
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: Demo Skill\ndescription: Does a demo.\n---\nDo the demo.\n');
    await writeFile(path.join(source, 'scripts', 'run.sh'), 'echo demo\n');
    library = new SkillLibrary(path.join(base, 'library'));
    await library.load();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('imports a folder under the frontmatter name and removes it again', async () => {
    const skill = await library.import(source);
    expect(skill).toMatchObject({ id: 'demo-skill', name: 'Demo Skill', description: 'Does a demo.' });
    expect(library.list().map((entry) => entry.id)).toEqual(['demo-skill']);
    expect(library.read('demo-skill')).toContain('Do the demo.');

    await library.remove('demo-skill');
    expect(library.list()).toEqual([]);
  });

  it('rediscovers imported skills after a reload', async () => {
    await library.import(source);
    const reloaded = new SkillLibrary(path.join(base, 'library'));
    await reloaded.load();
    expect(reloaded.list().map((entry) => entry.id)).toEqual(['demo-skill']);
  });

  it('refuses folders without SKILL.md, symbolic links and oversized content', async () => {
    const bare = path.join(base, 'bare');
    await mkdir(bare);
    await expect(library.import(bare)).rejects.toThrow('SKILL.md');

    await symlink('/etc', path.join(source, 'link'));
    await expect(library.import(source)).rejects.toThrow('symbolic links');
    await rm(path.join(source, 'link'));

    await writeFile(path.join(source, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(library.import(source)).rejects.toThrow('5 MB');
  });

  it('keeps one copy per id', async () => {
    await library.import(source);
    await expect(library.import(source)).rejects.toThrow('already exists');
  });
});

const skills: Skill[] = [
  { id: 'demo-skill', name: 'Demo Skill', description: '', path: '/lib/demo-skill/SKILL.md' },
  { id: 'pdf', name: 'PDF Tools', description: '', path: '/lib/pdf/SKILL.md' },
  { id: 'pdf-forms', name: 'Forms', description: '', path: '/lib/pdf-forms/SKILL.md' }
];

describe('skill invocation', () => {
  const readSkill = (id: string): string => `instructions for ${id}\n`;

  it('inlines a skill for a leading /id command and keeps the rest', () => {
    const result = expandSkillInvocation('/demo-skill fix the report', skills, readSkill);
    expect(result.skillId).toBe('demo-skill');
    expect(result.text).toContain('instructions for demo-skill');
    expect(result.text).toContain('folder: /lib/demo-skill');
    expect(result.text.endsWith('fix the report')).toBe(true);
  });

  it('accepts the /skill <id> form', () => {
    expect(expandSkillInvocation('/skill pdf-forms', skills, readSkill).skillId).toBe('pdf-forms');
  });

  it('leaves unknown or mid-message commands literal', () => {
    expect(expandSkillInvocation('/nope go', skills, readSkill)).toEqual({ text: '/nope go', skillId: null });
    expect(expandSkillInvocation('please /demo-skill go', skills, readSkill)).toEqual({
      text: 'please /demo-skill go',
      skillId: null
    });
  });

  it('auto-selects a skill named literally, ignoring case, hyphens and spacing', () => {
    expect(autoSelectSkill('Please use demo skill on this', skills)).toBe('demo-skill');
    expect(autoSelectSkill('use DEMO-SKILL', skills)).toBe('demo-skill');
  });

  it('selects nothing when several skills match the text', () => {
    expect(autoSelectSkill('convert this pdf', skills)).toBe('pdf');
    // "pdf" names one skill and "pdf forms" also names another.
    expect(autoSelectSkill('fill in pdf forms', skills)).toBeNull();
    expect(autoSelectSkill('nothing relevant here', skills)).toBeNull();
  });
});
