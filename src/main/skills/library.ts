import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Skill } from '@shared/types';
import { Emitter } from '../core/emitter';

const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const SKILL_FILE = 'SKILL.md';

interface Entry {
  skill: Skill;
  folder: string;
}

/** The user's skill library: one folder per skill, each holding a SKILL.md and optional sibling files. */
export class SkillLibrary {
  private entries = new Map<string, Entry>();
  private readonly emitter = new Emitter<{ change: Skill[] }>();

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    const next = new Map<string, Entry>();
    const dirents = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      const id = slugify(dirent.name);
      if (!dirent.isDirectory() || !id || next.has(id)) continue;
      const folder = path.join(this.dir, dirent.name);
      const skill = await readSkill(id, folder).catch(() => null);
      if (skill) next.set(id, { skill, folder });
    }
    this.entries = next;
    this.emitter.emit('change', this.list());
  }

  list(): Skill[] {
    return [...this.entries.values()].map((entry) => entry.skill).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Copies a folder with a SKILL.md into the library. Its id is the frontmatter name, else the folder name. */
  async import(folder: string): Promise<Skill> {
    if (!(await stat(folder)).isDirectory()) throw new Error('Choose a skill folder');
    if (!(await lstat(path.join(folder, SKILL_FILE)).catch(() => null))?.isFile()) {
      throw new Error(`The folder needs a ${SKILL_FILE} file`);
    }
    const total = (await listFileSizes(folder)).reduce((sum, size) => sum + size, 0);
    if (total > MAX_SKILL_BYTES) throw new Error('A skill folder may be at most 5 MB');

    const { name } = parseFrontmatter(readFileSync(path.join(folder, SKILL_FILE), 'utf8'));
    const id = slugify(name ?? '') || slugify(path.basename(folder));
    if (!id) throw new Error('The skill needs a name');
    if (this.entries.has(id)) throw new Error(`A skill named "${id}" already exists`);

    // Copy into a staging folder first so a failed copy never leaves a half-made skill behind.
    const target = path.join(this.dir, id);
    const staging = path.join(this.dir, `.import-${randomBytes(6).toString('hex')}`);
    await mkdir(staging, { recursive: true });
    try {
      await cp(folder, staging, { recursive: true });
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }

    const skill = await readSkill(id, target);
    this.entries.set(id, { skill, folder: target });
    this.emitter.emit('change', this.list());
    return skill;
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Skill not found');
    await rm(entry.folder, { recursive: true, force: true });
    this.entries.delete(id);
    this.emitter.emit('change', this.list());
  }

  read(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Skill not found');
    return readFileSync(entry.skill.path, 'utf8');
  }

  onChange(listener: (skills: Skill[]) => void): () => void {
    return this.emitter.on('change', listener);
  }
}

/** Lowercase letters, digits and `._-`, starting alphanumeric: the form skill ids take in `/id` commands. */
function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[-._]+$/, '');
}

/**
 * Reads `name` and `description` from YAML-style frontmatter. Supports plain, quoted, folded (`>`),
 * literal (`|`) and indented continuation values. Anything else in the header is ignored.
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const header = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!header) return {};
  const lines = header[1]!.split(/\r?\n/);
  const fields: Record<string, string> = {};

  for (let index = 0; index < lines.length; index++) {
    const key = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[index]!);
    if (!key) continue;
    const block: string[] = [];
    while (index + 1 < lines.length && (lines[index + 1]!.trim() === '' || /^\s/.test(lines[index + 1]!))) {
      block.push(lines[++index]!);
    }
    fields[key[1]!] = scalarValue((key[2] ?? '').trim(), block);
  }
  return {
    ...(fields['name'] !== undefined ? { name: fields['name'] } : {}),
    ...(fields['description'] !== undefined ? { description: fields['description'] } : {})
  };
}

function scalarValue(value: string, block: string[]): string {
  if (/^[|>][+-]?$/.test(value)) return blockScalar(value.startsWith('|'), block);
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]!)) {
    return value.slice(1, -1);
  }
  // A plain scalar may continue on indented lines, which YAML folds into single spaces.
  return [value, ...block.map((line) => line.trim())].filter(Boolean).join(' ');
}

function blockScalar(literal: boolean, block: string[]): string {
  const indents = block.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length);
  const strip = indents.length ? Math.min(...indents) : 0;
  const lines = block.map((line) => line.slice(strip));
  if (literal) return lines.join('\n').trim();
  // Folded: lines of one paragraph join with spaces; blank lines become line breaks.
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim()) {
      current.push(line.trim());
    } else if (current.length) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n').trim();
}

async function readSkill(id: string, folder: string): Promise<Skill> {
  const file = path.join(folder, SKILL_FILE);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Invalid skill file');
  const { name, description } = parseFrontmatter(readFileSync(file, 'utf8'));
  // The catalog shows one line per field; the SKILL.md text itself is left untouched.
  return { id, name: oneLine(name) || id, description: oneLine(description), path: file };
}

function oneLine(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Sizes of all files below a folder. Symbolic links are refused because they could point outside it. */
async function listFileSizes(folder: string): Promise<number[]> {
  const sizes: number[] = [];
  for (const dirent of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, dirent.name);
    if (dirent.isSymbolicLink()) throw new Error('A skill folder may not contain symbolic links');
    if (dirent.isDirectory()) sizes.push(...(await listFileSizes(full)));
    else if (dirent.isFile()) sizes.push((await stat(full)).size);
  }
  return sizes;
}
