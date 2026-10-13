import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitDiff, gitStatus, resolveReviewTarget } from '../src/main/projects/git';

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
    // a.txt: one line changed; u.txt: one untracked line; the staged rename has no line changes.
    expect(status.added).toBe(2);
    expect(status.removed).toBe(1);
  });

  it('scopes status and diffs to a subfolder of the repository', async () => {
    const mono = path.join(root, 'mono');
    const pkg = path.join(mono, 'pkg');
    await mkdir(pkg, { recursive: true });
    git(mono, 'init', '-q');
    await writeFile(path.join(mono, 'top.txt'), 'top\n');
    await writeFile(path.join(pkg, 'a.txt'), 'one\n');
    git(mono, 'add', '.');
    git(mono, 'commit', '-q', '-m', 'init');
    await writeFile(path.join(mono, 'top.txt'), 'TOP\n');
    await writeFile(path.join(pkg, 'a.txt'), 'ONE\n');
    await writeFile(path.join(pkg, 'n.txt'), 'new\n');

    const status = await gitStatus(pkg);
    expect(status.changes).toEqual([
      { path: 'a.txt', status: ' M' },
      { path: 'n.txt', status: '??' }
    ]);
    expect(status.added).toBe(2);
    expect(status.removed).toBe(1);
    expect(await gitDiff(pkg, 'a.txt')).toContain('+ONE');
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

  it('resolves review commits and merge bases, including initial commits, without accepting Git options', async () => {
    const reviewRepo = path.join(root, 'review');
    await mkdir(reviewRepo);
    git(reviewRepo, 'init', '-q', '-b', 'main');
    expect(await resolveReviewTarget(reviewRepo, { kind: 'uncommitted' })).toEqual({ kind: 'uncommitted' });
    await writeFile(path.join(reviewRepo, 'file.txt'), 'initial\n');
    git(reviewRepo, 'add', '.'); git(reviewRepo, 'commit', '-qm', 'initial');
    const initial = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: reviewRepo, encoding: 'utf8' }).trim();
    git(reviewRepo, 'checkout', '-qb', 'feature');
    await writeFile(path.join(reviewRepo, 'file.txt'), 'feature\n');
    git(reviewRepo, 'commit', '-qam', 'feature');
    const feature = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: reviewRepo, encoding: 'utf8' }).trim();
    git(reviewRepo, 'checkout', '-q', 'main');
    await writeFile(path.join(reviewRepo, 'other.txt'), 'main\n');
    git(reviewRepo, 'add', '.'); git(reviewRepo, 'commit', '-qm', 'main advances');
    git(reviewRepo, 'checkout', '-q', 'feature');
    expect(await resolveReviewTarget(reviewRepo, { kind: 'base', revision: 'main' })).toEqual({ kind: 'base', revision: initial });
    expect(await resolveReviewTarget(reviewRepo, { kind: 'commit', revision: 'HEAD' })).toEqual({ kind: 'commit', revision: feature });
    expect(await resolveReviewTarget(reviewRepo, { kind: 'commit', revision: initial })).toEqual({ kind: 'commit', revision: initial });
    for (const revision of ['missing', '--help']) await expect(resolveReviewTarget(reviewRepo, { kind: 'base', revision })).rejects.toThrow('not a commit');
    await expect(resolveReviewTarget(root, { kind: 'uncommitted' })).rejects.toThrow('Git working tree');
  });
});
