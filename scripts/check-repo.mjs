// Repository rules that a machine can check: privacy (nothing private is committed) and the
// mechanical part of the code rules in AGENTS.md. Run by CI, `npm run check` and the git hooks.
//
//   node scripts/check-repo.mjs                    every tracked file
//   node scripts/check-repo.mjs --staged           staged changes (pre-commit hook)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Files that must never be committed: secrets, local state and build output. */
const FORBIDDEN_PATHS = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)info\.txt$/,
  /(^|\/)secrets?\.json$/,
  /(^|\/)mcp-tokens\.json$/,
  /\.(pem|key|p12|pfx|keystore)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /^(node_modules|out|release|dist)\//,
  /^resources\/bin\//
];

/** Content that must never be committed. Each entry: what it is, and how it looks. */
const PRIVATE_CONTENT = [
  ['an OpenAI API key', /\bsk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ['an OpenAI tunnel ID', /\btunnel_[0-9a-f]{32}\b/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a personal home path', /(\/home\/(?!user\/|runner\/|me\/)[a-z][\w.-]*\/|\/Users\/(?!Shared\/|runner\/|user\/|me\/)[A-Za-z][\w.-]*\/|[A-Z]:\\\\?Users\\\\?(?!Public|runner|user)[A-Za-z])/],
  ['a personal email address', /\b[\w.+-]+@(gmail|googlemail|proton|protonmail|pm|outlook|hotmail|live|icloud|me|yahoo|gmx|web)\.(com|me|de|net|ch)\b/i]
];

/** Mechanical code rules (AGENTS.md explains the rest). */
const CODE_RULES = [
  { files: /^test\/.*\.ts$/, what: 'a focused or skipped test', pattern: /\b(it|test|describe)\.(only|skip|todo)\(/ },
  { files: /^(src|test)\/.*\.tsx?$/, what: 'a type-check escape', pattern: /@ts-(ignore|nocheck|expect-error)|\bas any\b|:\s*any\b|<any>/ },
  { files: /^(src|test)\/.*\.(tsx?|css)$/, what: 'a TODO-style marker (open an issue instead)', pattern: /\b(TODO|FIXME|XXX|HACK)\b/ },
  { files: /^src\/(?!main\/core\/(log|emitter)\.ts$).*\.tsx?$/, what: 'a console call (use the logger)', pattern: /\bconsole\.(log|info|warn|error|debug)\(/ },
  { files: /^src\/renderer\/(?!styles\/tokens\.css$).*\.css$/, what: 'a raw color (add a token to tokens.css)', pattern: /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(/ }
];

/** Size caps keep modules focused and test files about behavior, not volume. */
const SIZE_RULES = [
  { files: /^src\/.*\.tsx?$/, max: 500, what: 'source file' },
  { files: /^test\/.*\.test\.ts$/, max: 400, what: 'test file' }
];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Problems in one file: its path, then each line against the privacy and code rules. */
export function checkFile(path, text) {
  const problems = [];
  if (FORBIDDEN_PATHS.some((pattern) => pattern.test(path))) problems.push(`${path}: must not be committed (secrets, local state or build output)`);
  if (text === null) return problems;
  const lines = text.split('\n');
  const rules = CODE_RULES.filter((rule) => rule.files.test(path));
  lines.forEach((line, index) => {
    for (const [what, pattern] of PRIVATE_CONTENT) if (pattern.test(line)) problems.push(`${path}:${index + 1}: looks like ${what}`);
    for (const rule of rules) if (rule.pattern.test(line)) problems.push(`${path}:${index + 1}: ${rule.what}`);
  });
  for (const rule of SIZE_RULES) {
    if (rule.files.test(path) && lines.length > rule.max) problems.push(`${path}: ${lines.length} lines; a ${rule.what} stays under ${rule.max} (split it by responsibility)`);
  }
  return problems;
}

function isText(buffer) {
  return !buffer.subarray(0, 8000).includes(0);
}

function checkTree() {
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  const problems = [];
  for (const path of files) {
    if (path === 'package-lock.json') {
      problems.push(...checkFile(path, null));
      continue;
    }
    let buffer;
    try {
      buffer = readFileSync(path);
    } catch {
      continue; // deleted in the working tree
    }
    problems.push(...checkFile(path, isText(buffer) ? buffer.toString('utf8') : null));
  }
  return problems;
}

function checkStaged() {
  const files = git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT').split('\0').filter(Boolean);
  return files.flatMap((path) => {
    const buffer = execFileSync('git', ['show', `:${path}`], { maxBuffer: 256 * 1024 * 1024 });
    return checkFile(path, path === 'package-lock.json' || !isText(buffer) ? null : buffer.toString('utf8'));
  });
}

function main([mode]) {
  const problems = mode === '--staged' ? checkStaged() : checkTree();
  if (problems.length === 0) {
    console.log('repository rules: ok');
    return 0;
  }
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`\n${problems.length} problem(s). The rules are in AGENTS.md; remove the cause rather than bypassing the check.`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
