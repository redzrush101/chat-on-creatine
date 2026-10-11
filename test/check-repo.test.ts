import { describe, expect, it } from 'vitest';
import { checkFile } from '../scripts/check-repo.mjs';

// The fixtures are assembled at runtime so this file does not trip the rules it tests.
const join = (...parts: string[]) => parts.join('');

describe('repository rules', () => {
  it('rejects private files and content', () => {
    expect(checkFile('.env.local', '')).toHaveLength(1);
    expect(checkFile('src/a.ts', `const key = 'sk-proj-${'x'.repeat(24)}';`)).toHaveLength(1);
    expect(checkFile('src/a.ts', `const id = 'tunnel_${'a'.repeat(32)}';`)).toHaveLength(1);
    expect(checkFile('README.md', join('cd /ho', 'me/alice/projects'))).toHaveLength(1);
    expect(checkFile('README.md', join('mail me at someone@', 'proton.me'))).toHaveLength(1);
    expect(checkFile('README.md', 'cd /home/user/projects or ~/projects, mail test@example.com')).toEqual([]);
  });

  it('enforces the mechanical code rules', () => {
    expect(checkFile('test/x.test.ts', join('it.', "only('a', () => {});"))).toHaveLength(1);
    expect(checkFile('src/a.ts', join('const v = value as ', 'any;'))).toHaveLength(1);
    expect(checkFile('src/a.ts', "console.log('debug');")).toHaveLength(1);
    expect(checkFile('src/main/core/log.ts', 'console.log(line);')).toEqual([]);
    expect(checkFile('src/renderer/styles/app.css', 'color: #fff;')).toHaveLength(1);
    expect(checkFile('src/renderer/styles/tokens.css', '--text: #fff;')).toEqual([]);
    expect(checkFile('src/a.ts', 'x\n'.repeat(501))).toHaveLength(1);
  });

});
