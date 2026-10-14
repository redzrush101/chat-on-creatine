import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArguments } from '@shared/arguments';
import type { PromptTemplate } from '@shared/types';

/** Project templates override personal templates; reserved commands always keep their meaning. */
export async function loadTemplates(directories: string[], reserved: string[]): Promise<PromptTemplate[]> {
  const templates = new Map<string, PromptTemplate>();
  for (const directory of directories) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.slice(0, -3);
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || reserved.includes(name)) continue;
      const path = join(directory, entry.name);
      if ((await stat(path)).size > 96_000) throw new Error(`Prompt template ${path} is too large. Keep it under 96 KB.`);
      const text = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
      const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
      const body = (frontmatter ? text.slice(frontmatter[0].length) : text).trim();
      const field = (key: string) => {
        const value = frontmatter?.[1]?.split('\n').find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? '';
        return value.replace(/^(['"])(.*)\1$/, '$2');
      };
      if (!body) continue;
      templates.set(name, { name, description: field('description') || body.split('\n').find((line) => line.trim())!.slice(0, 80), argumentHint: field('argument-hint'), body, path });
    }
  }
  return [...templates.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandTemplate(template: PromptTemplate, argument: string): string {
  const args = parseArguments(argument);
  const all = args.join(' ');
  return template.body.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (match: string, target: string | undefined, fallback: string | undefined, start: string | undefined, length: string | undefined, simple: string | undefined) => {
      if (target) return (target === '@' || target === 'ARGUMENTS' ? all : args[Number(target) - 1]) || fallback || '';
      if (start) { const offset = Math.max(0, Number(start) - 1); return args.slice(offset, length === undefined ? undefined : offset + Number(length)).join(' '); }
      if (simple === '@' || simple === 'ARGUMENTS') return all;
      return simple ? args[Number(simple) - 1] ?? '' : match;
    });
}
