import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { expandFileReferences } from '../src/main/app/file-context';
import { expandTemplate, loadTemplates } from '../src/main/app/prompts';
import { parseArguments } from '../src/shared/arguments';
import { completeFile } from '../src/cli/completion';
import { Editor } from '../src/cli/editor';
import type { Terminal } from '../src/cli/terminal';

let dir = '';
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'creatine-context-'))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('includes quoted files and line ranges once while preserving prose and literal @ mentions', async () => {
  await writeFile(join(dir, 'source file.ts'), 'one\ntwo\nthree\nfour');
  const result = await expandFileReferences('Review @"source file.ts":2-3 and @"source file.ts":2-3. Email user@example.com; @@literal', dir);
  expect(result.text).toContain('Review source file.ts:2-3');
  expect(result.text).toContain('user@example.com; @literal');
  expect(result.text).toContain('2: two\n3: three');
  expect(result.text).not.toContain('1: one');
  expect(result.text.match(/File "source file.ts"/g)).toHaveLength(1);
  expect(result.paths).toEqual([]);
});

it('bounds large file context and reports missing, binary and invalid range inputs', async () => {
  await writeFile(join(dir, 'large.txt'), 'x'.repeat(100_000));
  expect((await expandFileReferences('Read @large.txt', dir)).text.length).toBeLessThan(17_000);
  expect((await expandFileReferences('@large.txt', dir)).text).toContain('Excerpt truncated');
  await expect(expandFileReferences('@missing.ts', dir)).rejects.toThrow('Cannot include');
  await expect(expandFileReferences('@large.txt:0', dir)).rejects.toThrow('Invalid line range');
  await expect(expandFileReferences('@large.txt:5-2', dir)).rejects.toThrow('Invalid line range');
  await expect(expandFileReferences('@large.txt:2', dir)).rejects.toThrow('does not exist');
  await writeFile(join(dir, 'data.bin'), Buffer.from([0, 1, 2]));
  expect((await expandFileReferences('@data.bin', dir)).paths).toEqual([join(dir, 'data.bin')]);
  await expect(expandFileReferences('@data.bin:1', dir)).rejects.toThrow('text file');
  await expect(expandFileReferences('@.', dir)).rejects.toThrow('folder');
});

it('attaches inline images and PDFs without treating their bytes as prompt text', async () => {
  await copyFile(join(process.cwd(), 'resources', 'icon.png'), join(dir, 'screen.png'));
  await writeFile(join(dir, 'guide.pdf'), '%PDF-1.7');
  const result = await expandFileReferences('Describe @screen.png using @guide.pdf', dir);
  expect(result).toEqual({ text: 'Describe screen.png using guide.pdf', paths: [join(dir, 'screen.png'), join(dir, 'guide.pdf')] });
  await expect(expandFileReferences('@screen.png:1', dir)).rejects.toThrow('text file');
});

it('loads project prompt overrides and keeps built-in command names reserved', async () => {
  const user = join(dir, 'user');
  const project = join(dir, 'project');
  await mkdir(user); await mkdir(project);
  await writeFile(join(user, 'review.md'), 'Personal $1');
  await writeFile(join(project, 'review.md'), '---\ndescription: "Review a change"\nargument-hint: "[focus]"\n---\nProject ${1:-correctness}\n');
  await writeFile(join(project, 'exit.md'), 'Cannot replace exit');
  await writeFile(join(project, 'empty.md'), '');
  const templates = await loadTemplates([join(dir, 'missing'), user, project], ['exit']);
  expect(templates).toHaveLength(1);
  expect(templates[0]).toMatchObject({ name: 'review', description: 'Review a change', argumentHint: '[focus]', path: join(project, 'review.md') });
  expect(expandTemplate(templates[0]!, '')).toBe('Project correctness');
  expect(expandTemplate(templates[0]!, '"API compatibility"')).toBe('Project API compatibility');
});

it('substitutes quoted positional arguments, defaults and slices without evaluating or recursively expanding them', () => {
  const template = { name: 'test', description: '', argumentHint: '', path: '', body: '$1 | $2 | $@ | $ARGUMENTS | ${3:-fallback} | ${@:2:1} | ${@:2}' };
  expect(expandTemplate(template, "'literal $2' \"two words\"")).toBe('literal $2 | two words | literal $2 two words | literal $2 two words | fallback | two words | two words');
  expect(parseArguments('one\\ two "" \'three four\'')).toEqual(['one two', '', 'three four']);
  expect(() => parseArguments('"open')).toThrow('quoted');
});

it('completes a quoted path at the cursor without replacing the following draft', async () => {
  await writeFile(join(dir, 'source file.ts'), 'content');
  const editor = new Editor();
  editor.set('Inspect @"source f" then explain');
  editor.cursor = 'Inspect @"source f"'.length;
  await completeFile({ editor } as unknown as Terminal, dir);
  expect(editor.text).toBe('Inspect @"source file.ts"  then explain');
  expect(editor.cursor).toBe('Inspect @"source file.ts" '.length);
});
