import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
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

  it('accepts generated palette CSS with Windows line endings and rejects stale tokens', () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'creatine-theme-'));
    try {
      for (const folder of ['scripts', 'src/shared', 'src/renderer/styles']) mkdirSync(joinPath(dir, folder), { recursive: true });
      for (const file of ['scripts/theme.mjs', 'src/shared/palette.json']) copyFileSync(file, joinPath(dir, file));
      const file = joinPath(dir, 'src/renderer/styles/tokens.css');
      const current = readFileSync('src/renderer/styles/tokens.css', 'utf8').replace(/\r\n/g, '\n');
      const check = () => execFileSync(process.execPath, [joinPath(dir, 'scripts/theme.mjs'), '--check'], { encoding: 'utf8', stdio: 'pipe' });
      writeFileSync(file, current.replace(/\n/g, '\r\n'));
      expect(check()).toBe('shared palette: ok\n');
      writeFileSync(file, current.replace('--accent:', '--stale-accent:'));
      expect(check).toThrow('The shared palette changed.');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
