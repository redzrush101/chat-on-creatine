import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, type Config } from '@shared/config';
import { RootGuard, isInside } from '../src/main/fs/roots';
import { ToolError } from '../src/main/mcp/tool';

async function expectToolError(promise: Promise<unknown>, code: string): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe(code);
  return (error as ToolError).message;
}

describe('RootGuard', () => {
  let base: string;
  let root: string;
  let outside: string;
  let config: Config;
  let guard: RootGuard;
  let savedHome: string | undefined;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'roots-')));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, 'sub', 'file.txt'), 'inside');
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    config = { ...defaultConfig(), roots: [{ id: 'r1', path: root, label: 'Work' }] };
    guard = new RootGuard(() => config);
    savedHome = process.env.HOME;
  });

  afterEach(async () => {
    process.env.HOME = savedHome;
    await rm(base, { recursive: true, force: true });
  });

  it('resolves an absolute path inside a root to its canonical form', async () => {
    await expect(guard.resolve(path.join(root, 'sub', 'file.txt'), { cwd: null, mustExist: true })).resolves.toBe(
      path.join(root, 'sub', 'file.txt')
    );
  });

  it('rejects a path that escapes the root with ..', async () => {
    await expectToolError(
      guard.resolve(path.join(root, '..', 'outside', 'secret.txt'), { cwd: null, mustExist: true }),
      'PATH_NOT_ALLOWED'
    );
  });

  it('rejects a symlink inside the root that points outside it', async () => {
    await symlink(outside, path.join(root, 'escape'));
    await expectToolError(guard.resolve(path.join(root, 'escape', 'secret.txt'), { cwd: null, mustExist: true }), 'PATH_NOT_ALLOWED');
  });

  it('allows a symlink inside the root that points inside it', async () => {
    await symlink(path.join(root, 'sub'), path.join(root, 'alias'));
    await expect(guard.resolve(path.join(root, 'alias', 'file.txt'), { cwd: null, mustExist: true })).resolves.toBe(
      path.join(root, 'sub', 'file.txt')
    );
  });

  it('refuses a dangling symlink that would let a new file be written outside the root', async () => {
    await symlink(path.join(outside, 'new.txt'), path.join(root, 'dangling'));
    await expectToolError(guard.resolve(path.join(root, 'dangling'), { cwd: null, mustExist: false }), 'PATH_NOT_ALLOWED');
  });

  it('accepts a missing file under a root when mustExist is false, and reports NOT_FOUND when it is required', async () => {
    const target = path.join(root, 'sub', 'new.txt');
    await expect(guard.resolve(target, { cwd: null, mustExist: false })).resolves.toBe(target);
    await expectToolError(guard.resolve(target, { cwd: null, mustExist: true }), 'NOT_FOUND');
  });

  it('reports PATH_NOT_ALLOWED rather than NOT_FOUND for a missing path outside the roots', async () => {
    await expectToolError(guard.resolve(path.join(outside, 'missing.txt'), { cwd: null, mustExist: true }), 'PATH_NOT_ALLOWED');
  });

  it('expands ~ against the home folder', async () => {
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    await expect(guard.resolve('~/sub/file.txt', { cwd: null, mustExist: true })).resolves.toBe(
      path.join(root, 'sub', 'file.txt')
    );
  });

  it('resolves relative paths against cwd, and requires an absolute path when cwd is null', async () => {
    await expect(guard.resolve('sub/file.txt', { cwd: root, mustExist: true })).resolves.toBe(path.join(root, 'sub', 'file.txt'));
    await expectToolError(guard.resolve('sub/file.txt', { cwd: null, mustExist: true }), 'INVALID_ARGUMENT');
  });

  it('rejects empty paths and NUL bytes', async () => {
    await expectToolError(guard.resolve('  ', { cwd: root, mustExist: true }), 'INVALID_ARGUMENT');
    await expectToolError(guard.resolve('a\0b', { cwd: root, mustExist: true }), 'INVALID_ARGUMENT');
  });

  it('reaches any folder in YOLO mode, with or without approved folders', async () => {
    for (const roots of [config.roots, []]) {
      config = { ...config, roots, yolo: true };
      expect(await guard.resolve(path.join(outside, 'secret.txt'), { cwd: null, mustExist: true })).toBe(path.join(outside, 'secret.txt'));
    }
  });

  it('tells the user to approve a folder when no roots are configured', async () => {
    config = defaultConfig();
    expect(await guard.roots()).toEqual([]);
    const message = await expectToolError(guard.resolve(path.join(root, 'sub'), { cwd: null, mustExist: true }), 'PATH_NOT_ALLOWED');
    expect(message).toContain('Settings → Workspace');
  });

  it('names the approved folders by label when a path is outside them', async () => {
    const message = await expectToolError(guard.resolve(outside, { cwd: null, mustExist: true }), 'PATH_NOT_ALLOWED');
    expect(message).toContain('Work');
    expect(message).not.toContain(root);
  });

  it('reads the config live, and skips roots that no longer exist', async () => {
    const second = path.join(base, 'second');
    await mkdir(second);
    config = { ...config, roots: [...config.roots, { id: 'r2', path: second, label: '' }] };
    expect(await guard.roots()).toEqual([root, second]);

    await rm(second, { recursive: true });
    expect(await guard.roots()).toEqual([root]);
  });
});

describe('isInside', () => {
  it('accepts the folder itself and its descendants, and rejects siblings and prefixes', () => {
    expect(isInside('/a/root', '/a/root')).toBe(true);
    expect(isInside('/a/root', '/a/root/x/y')).toBe(true);
    expect(isInside('/a/root', '/a/rootx')).toBe(false);
    expect(isInside('/a/root', '/a')).toBe(false);
    expect(isInside('/a/root', '/a/root/../other')).toBe(false);
  });
});
