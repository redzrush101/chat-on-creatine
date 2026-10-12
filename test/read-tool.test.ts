import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, type Config } from '@shared/config';
import { RootGuard } from '../src/main/fs/roots';
import { viewImageTool } from '../src/main/mcp/tools/view-image';
import { readTool } from '../src/main/mcp/tools/read';
import { ToolError, type ToolContext, type ToolResult } from '../src/main/mcp/tool';

/** A valid 1x1 PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function makeContext(config: Config, cwd: string | null): ToolContext {
  const unused = async () => {
    throw new Error('process runner is not used by read tools');
  };
  return {
    surface: 'core',
    requestId: null,
    caller: cwd === null ? null : { sessionId: 's', conversationId: 'c', cwd, kind: 'chat' },
    config,
    services: {
      paths: new RootGuard(() => config),
      processes: { exec: unused, writeStdin: unused },
      setPlan: () => undefined,
      agents: null,
      finish: null
    },
    signal: new AbortController().signal
  };
}

function textOf(result: ToolResult): string {
  return result.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

describe('read tool', () => {
  let base: string;
  let root: string;
  let config: Config;
  let ctx: ToolContext;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'read-tool-')));
    root = path.join(base, 'root');
    await mkdir(path.join(root, 'a'), { recursive: true });
    await writeFile(path.join(root, 'b.txt'), 'hello\n');
    config = { ...defaultConfig(), roots: [{ id: 'r1', path: root, label: '' }] };
    ctx = makeContext(config, root);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('lists a folder one level deep, directories first', async () => {
    const result = await readTool.run({ paths: [root] }, ctx);
    const text = textOf(result);
    expect(text).toContain('d a');
    expect(text).toContain('f b.txt');
    expect(text.indexOf('d a')).toBeLessThan(text.indexOf('f b.txt'));
    expect(result.isError).toBe(false);
  });

  it('returns only the requested line range, numbered from its real line numbers', async () => {
    const file = path.join(root, 'lines.txt');
    await writeFile(file, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
    const text = textOf(await readTool.run({ paths: [file], start_line: 3, end_line: 4 }, ctx));
    expect(text).toContain('lines 3-4 of 10');
    expect(text).toContain('3\tline3');
    expect(text).toContain('4\tline4');
    expect(text).not.toContain('line2');
    expect(text).not.toContain('line5');
  });

  it('truncates a file at the per-file cap and says where to continue', async () => {
    const file = path.join(root, 'big.txt');
    const line = 'x'.repeat(1000);
    await writeFile(file, Array.from({ length: 300 }, () => line).join('\n'));
    const text = textOf(await readTool.run({ paths: [file] }, ctx));
    expect(text).toContain('more lines follow; continue with start_line=');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(260 * 1024);
  });

  it('reports a binary file by its size without returning its bytes', async () => {
    const file = path.join(root, 'blob.bin');
    await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const result = await readTool.run({ paths: [file] }, ctx);
    expect(textOf(result)).toContain('Binary file');
    expect(result.content.some((part) => part.type === 'image')).toBe(false);
  });

  it('rejects invalid UTF-8 at the end of a partial sample instead of trimming it away', async () => {
    const file = path.join(root, 'invalid.txt');
    const bytes = Buffer.alloc(9000, 0x61);
    bytes[8191] = 0xff;
    await writeFile(file, bytes);
    expect(textOf(await readTool.run({ paths: [file] }, ctx))).toContain('Binary file');
  });

  it('returns a PNG as image content', async () => {
    const file = path.join(root, 'pixel.png');
    await writeFile(file, Buffer.from(PNG_BASE64, 'base64'));
    const result = await readTool.run({ paths: [file] }, ctx);
    const image = result.content.find((part) => part.type === 'image');
    expect(image).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
  });

  it('expands a glob inside the root', async () => {
    await writeFile(path.join(root, 'a', 'one.md'), 'one');
    await writeFile(path.join(root, 'a', 'two.md'), 'two');
    const text = textOf(await readTool.run({ paths: [`${root}/a/*.md`] }, ctx));
    expect(text).toContain('one.md');
    expect(text).toContain('two.md');
  });

  it('reports a path outside the roots as an error result rather than reading it', async () => {
    const outside = path.join(base, 'elsewhere.txt');
    await writeFile(outside, 'secret');
    const result = await readTool.run({ paths: [outside] }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('secret');
  });

  it('is hidden and refuses to run when read is off', async () => {
    config = { ...config, capabilities: { ...config.capabilities, read: false } };
    ctx = makeContext(config, root);
    expect(readTool.exposed(config)).toBe(false);
    const error = await readTool.run({ paths: [root] }, ctx).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('TOOL_DISABLED');
    expect(viewImageTool.exposed(config)).toBe(false);
  });
});
