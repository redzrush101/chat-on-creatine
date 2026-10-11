import { describe, expect, it } from 'vitest';
import { relativeTo } from '../src/renderer/lib/format';

describe('relativeTo', () => {
  it.each([
    ['/srv/repo', '/srv/repo/src/a.ts', 'src/a.ts'],
    ['/srv/repo/', '/srv/repo/src/a.ts', 'src/a.ts'],
    ['D:\\work\\repo', 'D:\\work\\repo\\src\\a.ts', 'src\\a.ts'],
    ['C:\\', 'C:\\a.ts', 'a.ts'],
    ['/srv/repo', '/srv/repo2/a.ts', '/srv/repo2/a.ts'],
    ['/srv/repo', '/etc/hosts', '/etc/hosts']
  ])('%s + %s → %s', (root, path, expected) => {
    expect(relativeTo(root, path)).toBe(expected);
  });
});
