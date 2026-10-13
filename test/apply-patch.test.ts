import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, type Config } from '@shared/config';
import { parseApplyPatchInvocationWithCwd, runApplyPatch } from '../src/main/fs/apply-patch';
import { parsePatch, PatchParseError } from '../src/main/fs/apply-patch/parser';
import { ToolError, type PathGuard, type ToolContext } from '../src/main/mcp/tool';

/** Confines paths to the temp root; the real RootGuard lives in fs/roots.ts. */
function confinedGuard(root: string): PathGuard {
  return {
    roots: () => [root],
    async resolve(requested, { cwd, mustExist }) {
      const abs = path.resolve(cwd ?? root, requested);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new ToolError('PATH_NOT_ALLOWED', `${requested} is outside the approved root`);
      }
      if (mustExist) {
        await access(abs).catch(() => {
          throw new ToolError('NOT_FOUND', `${requested} does not exist`);
        });
      }
      return abs;
    }
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'coc-apply-patch-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctxFor(config: Config = configSchema.parse({})): ToolContext {
  return {
    surface: 'core',
    requestId: null,
    caller: { sessionId: 's', conversationId: 'c', cwd: root, kind: 'chat' },
    config,
    services: { paths: confinedGuard(root) },
    signal: new AbortController().signal
  } as unknown as ToolContext;
}

const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

describe('apply_patch file operations', () => {
  it('adds a file, creating parent folders, and reports it in Codex summary style', async () => {
    const result = await runApplyPatch(patch('*** Add File: deep/new.txt', '+hello', '+world'), ctxFor());

    expect(await readFile(path.join(root, 'deep/new.txt'), 'utf8')).toBe('hello\nworld\n');
    expect(result.content[0]).toEqual({ type: 'text', text: 'Success. Updated the following files:\nA deep/new.txt' });
    expect(result.display).toEqual([
      expect.objectContaining({ type: 'diff', path: 'deep/new.txt', added: 2, removed: 0 })
    ]);
  });

  it('applies several chunks in file order, each located by its @@ context', async () => {
    const file = path.join(root, 'f.ts');
    await writeFile(file, 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n');

    await runApplyPatch(
      patch(
        '*** Update File: f.ts',
        '@@ function a() {',
        '-  return 1;',
        '+  return 3;',
        '@@ function b() {',
        '-  return 1;',
        '+  return 2;'
      ),
      ctxFor()
    );

    expect(await readFile(file, 'utf8')).toBe('function a() {\n  return 3;\n}\n\nfunction b() {\n  return 2;\n}\n');
  });

  it('moves a file and edits it, and deletes a file', async () => {
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'a.txt'), 'hello\n');
    await writeFile(path.join(root, 'gone.txt'), 'bye\n');

    const result = await runApplyPatch(
      patch(
        '*** Update File: a.txt',
        '*** Move to: sub/b.txt',
        '-hello',
        '+hi',
        '*** Delete File: gone.txt'
      ),
      ctxFor()
    );

    expect(await readFile(path.join(root, 'sub/b.txt'), 'utf8')).toBe('hi\n');
    await expect(access(path.join(root, 'a.txt'))).rejects.toThrow();
    await expect(access(path.join(root, 'gone.txt'))).rejects.toThrow();
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Success. Updated the following files:\nM sub/b.txt\nD gone.txt'
    });
  });

  it('matches context that differs only in trailing whitespace and typographic punctuation', async () => {
    const file = path.join(root, 'f.txt');
    await writeFile(file, 'const a = 1;   \nconst s = “x”;\n');

    await runApplyPatch(patch('*** Update File: f.txt', '-const a = 1;', '+const a = 2;', ' const s = "x";'), ctxFor());

    expect(await readFile(file, 'utf8')).toBe('const a = 2;\nconst s = “x”;\n');
  });

  it('keeps CRLF line endings and the missing final newline of the file', async () => {
    const crlf = path.join(root, 'crlf.txt');
    await writeFile(crlf, 'one\r\ntwo\r\nthree\r\n');
    await runApplyPatch(patch('*** Update File: crlf.txt', ' one', '-two', '+TWO', ' three', '+four'), ctxFor());
    expect(await readFile(crlf, 'utf8')).toBe('one\r\nTWO\r\nthree\r\nfour\r\n');

    const bare = path.join(root, 'bare.txt');
    await writeFile(bare, 'a\nb');
    await runApplyPatch(patch('*** Update File: bare.txt', '-b', '+c'), ctxFor());
    expect(await readFile(bare, 'utf8')).toBe('a\nc');
  });

  it('applies nothing when a later hunk fails to match', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x\n');
    await writeFile(path.join(root, 'b.txt'), 'y\n');

    const attempt = runApplyPatch(
      patch('*** Add File: created.txt', '+new', '*** Update File: a.txt', '-x', '+z', '*** Update File: b.txt', '-nope', '+q'),
      ctxFor()
    );

    await expect(attempt).rejects.toMatchObject({ code: 'PATCH_FAILED' });
    await expect(attempt).rejects.toThrow(/hunk 3 \(Update File: b\.txt\)/);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('x\n');
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('y\n');
    await expect(access(path.join(root, 'created.txt'))).rejects.toThrow();
  });

  // Root ignores permission bits and Windows has no POSIX modes, so the setup cannot reproduce it there.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'edits a writable file in a folder it may not create files in, keeping the file itself',
    async () => {
      const dir = path.join(root, 'locked');
      await mkdir(dir);
      await writeFile(path.join(dir, 'a.txt'), 'one\n');
      await chmod(dir, 0o555);
      try {
        const result = await runApplyPatch('*** Begin Patch\n*** Update File: locked/a.txt\n@@\n-one\n+two\n*** End Patch', ctxFor());
        expect(result.isError).toBeFalsy();
        expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('two\n');
      } finally {
        await chmod(dir, 0o755);
      }
    }
  );

  it('refuses to add a file that already exists', async () => {
    await writeFile(path.join(root, 'taken.txt'), 'mine\n');
    await expect(runApplyPatch(patch('*** Add File: taken.txt', '+theirs'), ctxFor())).rejects.toMatchObject({
      code: 'PATCH_FAILED'
    });
    expect(await readFile(path.join(root, 'taken.txt'), 'utf8')).toBe('mine\n');
  });

  it('rejects paths outside the approved root without touching disk', async () => {
    await expect(runApplyPatch(patch('*** Add File: ../escape.txt', '+x'), ctxFor())).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED'
    });
    await expect(access(path.join(root, '../escape.txt'))).rejects.toThrow();
  });
});

describe('apply_patch permissions', () => {
  it.each([
    ['create', patch('*** Add File: n.txt', '+x'), { capabilities: { create: false } }],
    ['delete', patch('*** Delete File: f.txt'), { capabilities: { delete: false } }],
    ['write', patch('*** Update File: f.txt', '-old', '+new'), { capabilities: { write: false } }],
    ['move', patch('*** Update File: f.txt', '*** Move to: g.txt', '-old', '+new'), { capabilities: { move: false } }],
    ['delete (read-only mode)', patch('*** Delete File: f.txt'), { readOnly: true }]
  ])('denies the %s operation and leaves files alone', async (_name, text, override) => {
    await writeFile(path.join(root, 'f.txt'), 'old\n');
    await expect(runApplyPatch(text, ctxFor(configSchema.parse(override)))).rejects.toMatchObject({ code: 'TOOL_DISABLED' });
    expect(await readFile(path.join(root, 'f.txt'), 'utf8')).toBe('old\n');
  });

});

describe('apply_patch parsing', () => {
  it('accepts a heredoc wrapper around the envelope', () => {
    const hunks = parsePatch("<<'EOF'\n*** Begin Patch\n*** Delete File: a\n*** End Patch\nEOF");
    expect(hunks).toEqual([{ kind: 'delete', path: 'a' }]);
  });

  it('reports the line number of a malformed update line', () => {
    const text = patch('*** Update File: a', '@@', ' keep', 'oops');
    expect(() => parsePatch(text)).toThrow(PatchParseError);
    expect(() => parsePatch(text)).toThrow(/line 5/);
  });

  it('extracts the patch from heredoc and direct invocations, with an optional cd', () => {
    const body = '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch';
    expect(parseApplyPatchInvocationWithCwd(`apply_patch <<'EOF'\n${body}\nEOF`)).toEqual({ patch: body, cd: null });
    expect(parseApplyPatchInvocationWithCwd(`apply_patch "${body}"`)).toEqual({ patch: body, cd: null });
    expect(parseApplyPatchInvocationWithCwd(`cd 'sub dir' && apply_patch <<'EOF'\n${body}\nEOF`)).toEqual({
      patch: body,
      cd: 'sub dir'
    });
  });

  it('does not treat compound or expanding shell commands as an invocation', () => {
    const body = '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch';
    for (const command of [
      `cd a; apply_patch <<'EOF'\n${body}\nEOF`,
      `echo hi && apply_patch <<'EOF'\n${body}\nEOF`,
      `apply_patch <<'EOF'\n${body}\nEOF\necho done`,
      `apply_patch <<'EOF'\n${body}`,
      `apply_patch "${body.replace('a', '$HOME')}"`,
      'ls -la'
    ]) {
      expect(parseApplyPatchInvocationWithCwd(command), command).toBeNull();
    }
  });
});
