import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type ShellType = 'zsh' | 'bash' | 'sh' | 'powershell' | 'cmd';

export interface ShellSpec {
  type: ShellType;
  path: string;
}

const SHELL_BY_NAME = new Map<string, ShellType>([
  ['zsh', 'zsh'],
  ['bash', 'bash'],
  ['sh', 'sh'],
  ['pwsh', 'powershell'],
  ['powershell', 'powershell'],
  ['cmd', 'cmd']
]);

const POSIX_SHELLS: ReadonlySet<ShellType> = new Set(['zsh', 'bash', 'sh']);

/** Makes `Console` output UTF-8; PowerShell otherwise uses the OEM code page when no console is attached. */
const POWERSHELL_UTF8_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

function shellTypeOf(binary: string): ShellType | null {
  const stem = path.basename(binary).replace(/\.exe$/i, '').toLowerCase();
  return SHELL_BY_NAME.get(stem) ?? null;
}

export async function isRunnableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (process.platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first runnable `name` on PATH, trying each PATHEXT extension on Windows. */
export async function findOnPath(name: string): Promise<string | null> {
  const extensions =
    process.platform === 'win32' ? ['', ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (await isRunnableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** The account's login shell from the user database, or null where there is none. */
function loginShell(): string | null {
  try {
    return os.userInfo().shell;
  } catch {
    // No passwd entry (some containers); $SHELL is the best remaining guess.
    return null;
  }
}

/**
 * The shell a command runs in when the caller names none: PowerShell on Windows; on POSIX the
 * account's login shell, as a terminal app would start, then $SHELL. $SHELL alone is not enough:
 * a dev environment such as `nix develop` points it at a bash built without readline.
 */
export async function defaultShell(): Promise<ShellSpec> {
  if (process.platform === 'win32') {
    const found = await findOnPath('pwsh') ?? await findOnPath('powershell');
    return found ? { type: shellTypeOf(found) ?? 'powershell', path: found } : { type: 'cmd', path: process.env['ComSpec'] ?? 'cmd.exe' };
  }
  const candidates = [
    loginShell(),
    process.env['SHELL'],
    ...(process.platform === 'darwin' ? ['/bin/zsh', '/bin/bash'] : ['/bin/bash', '/bin/zsh'])
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const type = shellTypeOf(candidate);
    if (type && POSIX_SHELLS.has(type) && await isRunnableFile(candidate)) return { type, path: candidate };
  }
  return { type: 'sh', path: '/bin/sh' };
}

/**
 * Resolves a shell the caller named: a recognised shell name found on PATH, or a path to the
 * executable itself (relative paths resolve against the command's working directory).
 * Returns null when it cannot be found, rather than silently substituting another shell.
 */
export async function resolveShell(requested: string | undefined, cwd: string): Promise<ShellSpec | null> {
  if (requested === undefined) return defaultShell();
  const type = shellTypeOf(requested);
  if (!type) return null;
  const pathLike = path.isAbsolute(requested) || /[\\/]/.test(requested);
  if (pathLike) {
    const file = path.resolve(cwd, requested);
    return await isRunnableFile(file) ? { type, path: file } : null;
  }
  const found = await findOnPath(requested);
  return found ? { type, path: found } : null;
}

/** argv for running one command string in the shell. */
export function shellArgv(shell: ShellSpec, script: string, login = true): string[] {
  switch (shell.type) {
    case 'zsh':
    case 'bash':
    case 'sh':
      return [shell.path, login ? '-lc' : '-c', script];
    case 'powershell':
      return [shell.path, '-NoProfile', '-Command', POWERSHELL_UTF8_PREFIX + script];
    case 'cmd':
      return [shell.path, '/c', script];
  }
}

/**
 * One script running several commands in the same shell, so variables and the working directory
 * carry from one to the next. A failing item does not stop the rest; each section prints its own
 * exit code and the script exits with the first non-zero one.
 */
export function batchScript(commands: readonly string[], type: ShellType): string {
  const count = commands.length;
  if (type === 'powershell') {
    const encoded = commands.map((command) => `'${Buffer.from(command, 'utf8').toString('base64')}'`).join(', ');
    return [
      `$__cmds = @(${encoded})`,
      '$__exit = 0',
      `for ($__i = 0; $__i -lt ${count}; $__i++) {`,
      `  [Console]::Out.WriteLine("--- command $($__i + 1)/${count} ---")`,
      '  $global:LASTEXITCODE = 0',
      '  try {',
      '    . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__cmds[$__i]))))',
      '    $__code = if ($LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
      '  } catch {',
      '    [Console]::Error.WriteLine($_.ToString())',
      '    $__code = 1',
      '  }',
      '  [Console]::Out.WriteLine("--- exit code $__code ---")',
      '  if ($__code -ne 0 -and $__exit -eq 0) { $__exit = $__code }',
      '}',
      'exit $__exit'
    ].join('\n');
  }
  if (!POSIX_SHELLS.has(type)) {
    throw new Error(`cmds needs a POSIX shell or PowerShell, not ${type}`);
  }
  const lines = ['__batch_exit=0'];
  commands.forEach((command, index) => {
    const quoted = `'${command.replace(/'/g, `'\\''`)}'`;
    lines.push(
      `printf '%s\\n' '--- command ${index + 1}/${count} ---'`,
      `eval ${quoted}`,
      '__batch_code=$?',
      `printf '%s\\n' "--- exit code $__batch_code ---"`,
      'if [ "$__batch_code" -ne 0 ] && [ "$__batch_exit" -eq 0 ]; then __batch_exit=$__batch_code; fi'
    );
  });
  lines.push('exit "$__batch_exit"');
  return lines.join('\n');
}
