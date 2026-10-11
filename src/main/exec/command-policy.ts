import type { Config } from '@shared/config';

export type CommandPolicyDecision = { allowed: true } | { allowed: false; reason: string };

type Policy = Config['commandPolicy'];

interface Invocation {
  argv: string[];
  /** A rule ending in a standalone `*` matches any extra trailing arguments. */
  wildcard: boolean;
}

class UnsupportedSyntax extends Error {}

/** Characters that would make the shell do something other than run the literal argv. */
const UNSAFE_UNQUOTED = /[|;&<>(){}$`\\*?[\]~#!%^]/;

/**
 * Parses a command into the literal argv a POSIX-style shell would pass. Anything that needs a
 * shell to interpret it (operators, expansion, globs, escapes, env assignments) is rejected,
 * because the policy can only vouch for what it can read exactly.
 */
function parseInvocation(source: string, allowWildcard: boolean): Invocation {
  const argv: string[] = [];
  let wildcard = false;
  let index = 0;
  const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t';

  while (index < source.length) {
    if (isSpace(source[index])) {
      index++;
      continue;
    }
    if (source[index] === '\r' || source[index] === '\n') throw new UnsupportedSyntax('Newlines are not supported.');
    if (allowWildcard && source[index] === '*') {
      if (argv.length === 0 || source.slice(index + 1).trim() !== '') {
        throw new UnsupportedSyntax('A wildcard must be a standalone final argument after the executable.');
      }
      wildcard = true;
      break;
    }

    let word = '';
    let started = false;
    while (index < source.length && !isSpace(source[index])) {
      const char = source[index]!;
      if (char === '"' || char === "'") {
        if (started) throw new UnsupportedSyntax('Quoted arguments must be wholly quoted.');
        const close = source.indexOf(char, index + 1);
        if (close === -1) throw new UnsupportedSyntax('Unclosed quote.');
        const body = source.slice(index + 1, close);
        if (/[\r\n]/.test(body)) throw new UnsupportedSyntax('Newlines are not supported.');
        if (char === '"' && /[$`\\]/.test(body)) {
          throw new UnsupportedSyntax('Expansion and escaping inside double quotes are not supported.');
        }
        word = body;
        started = true;
        index = close + 1;
        if (index < source.length && !isSpace(source[index])) {
          throw new UnsupportedSyntax('Quoted arguments must be wholly quoted.');
        }
        break;
      }
      if (UNSAFE_UNQUOTED.test(char)) throw new UnsupportedSyntax(`Unsupported shell syntax ${JSON.stringify(char)}.`);
      word += char;
      started = true;
      index++;
    }
    if (!started) throw new UnsupportedSyntax('Expected a literal argument.');
    argv.push(word);
  }

  if (argv.length === 0) throw new UnsupportedSyntax('The command is empty.');
  if (!allowWildcard && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) {
    throw new UnsupportedSyntax('Leading environment assignments are not supported.');
  }
  return { argv, wildcard };
}

function ruleMatches(rule: Invocation, argv: readonly string[]): boolean {
  if (rule.wildcard ? argv.length < rule.argv.length : argv.length !== rule.argv.length) return false;
  return rule.argv.every((expected, index) => expected === argv[index]);
}

/**
 * Checks one command against the command policy. Disabled policy allows everything. Allowlist
 * mode needs a rule that matches the executable and the full argument list exactly (or a
 * trailing `*`); denylist mode refuses commands a rule matches.
 */
export function checkCommandPolicy(policy: Policy, command: string): CommandPolicyDecision {
  if (!policy.enabled) return { allowed: true };

  const rules: Invocation[] = [];
  for (const [index, rule] of policy.rules.entries()) {
    try {
      rules.push(parseInvocation(rule.trim(), true));
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Invalid rule.';
      return { allowed: false, reason: `Command policy rule ${index + 1} is invalid: ${detail}` };
    }
  }

  let invocation: Invocation;
  try {
    invocation = parseInvocation(command.trim(), false);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unsupported shell syntax.';
    return { allowed: false, reason: `${detail} Only a plain command with literal arguments can be checked by the command policy.` };
  }

  const matched = rules.some((rule) => ruleMatches(rule, invocation.argv));
  if (policy.mode === 'allowlist') {
    return matched
      ? { allowed: true }
      : { allowed: false, reason: 'No command policy allow rule matches this executable and argument list.' };
  }
  return matched
    ? { allowed: false, reason: 'A command policy deny rule matches this executable and argument list.' }
    : { allowed: true };
}
