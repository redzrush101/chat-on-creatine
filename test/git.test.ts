import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitDiff, gitStatus } from '../src/main/projects/git';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
};

describe('project git', () => {
  let root: string;
  let repo: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'git-test-')));
    repo = path.join(root, 'repo');
    await writeFile(path.join(root, 'placeholder'), '');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
    await writeFile(path.join(repo, 'b.txt'), 'moved\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');

    await writeFile(path.join(repo, 'a.txt'), 'one\nTWO\n');
    git(repo, 'mv', 'b.txt', 'c.txt');
    await writeFile(path.join(repo, 'u.txt'), 'hello\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('parses branch, modified, renamed and untracked entries', async () => {
    const status = await gitStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.changes).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', status: ' M' },
        { path: 'c.txt', status: 'R ' },
        { path: 'u.txt', status: '??' }
      ])
    );
    expect(status.changes).toHaveLength(3);
  });

  it('reports a folder outside a repository as not a repo', async () => {
    const plain = path.join(root, 'plain');
    await mkdir(plain);
    const status = await gitStatus(plain);
    expect(status.isRepo).toBe(false);
    expect(status.changes).toEqual([]);
  });

  it('diffs a modified file against HEAD', async () => {
    const diff = await gitDiff(repo, 'a.txt');
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
  });

  it('renders an untracked file as all added', async () => {
    const diff = await gitDiff(repo, 'u.txt');
    expect(diff).toContain('new file mode');
    expect(diff).toContain('+hello');
  });

  it('refuses paths that leave the repository folder', async () => {
    await expect(gitDiff(repo, '../placeholder')).rejects.toThrow('inside the repository');
    await expect(gitDiff(repo, path.join(root, 'placeholder'))).rejects.toThrow('inside the repository');
  });
});
