import { readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Terminal } from './terminal';

/** Completion preserves the rest of the draft and quotes file names containing spaces. */
export async function completeFile(terminal: Terminal, cwd: string): Promise<void> {
  const { text, cursor } = terminal.editor;
  const match = /(?:^|\s)(@(?:"[^"\n]*"?|'[^'\n]*'?|[^\s]*))$/.exec(text.slice(0, cursor));
  if (!match) return;
  const token = match[1]!;
  const prefix = token.slice(1).replace(/^['"]|['"]$/g, '');
  const path = resolve(cwd, prefix || '.');
  const directory = prefix.endsWith('/') || !prefix ? path : dirname(path);
  const stem = prefix.endsWith('/') || !prefix ? '' : basename(path);
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name.startsWith(stem))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const picked = entries.length === 1 ? entries[0] : await terminal.pick('Files', entries.map((entry) => ({ label: entry.name + (entry.isDirectory() ? '/' : ''), value: entry })));
  if (!picked) return;
  const name = `${prefix.slice(0, prefix.length - stem.length)}${picked.name}${picked.isDirectory() ? '/' : ''}`;
  const replacement = `@${/\s|["']/.test(name) ? JSON.stringify(name) : name}${picked.isDirectory() ? '' : ' '}`;
  const at = cursor - token.length;
  terminal.editor.text = text.slice(0, at) + replacement + text.slice(cursor);
  terminal.editor.cursor = at + replacement.length;
}
