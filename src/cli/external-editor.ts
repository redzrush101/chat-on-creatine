import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments } from './arguments';

/** The temporary draft is private and removed even when the editor fails. */
export async function editExternal(text: string, command = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi')): Promise<string> {
  const args = parseArguments(command);
  const executable = args.shift();
  if (!executable) throw new Error('Set VISUAL or EDITOR to an editor command, such as "code --wait".');
  const dir = await mkdtemp(join(tmpdir(), 'creatine-draft-'));
  try {
    const file = join(dir, 'prompt.md');
    await writeFile(file, text, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [...args, file], { stdio: 'inherit' });
      child.on('error', (error) => reject(new Error(`Cannot start ${executable}: ${error.message}. Set VISUAL or EDITOR to an installed editor.`)));
      child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Editor ${signal ? `stopped by ${signal}` : `exited with code ${code}`}. Your draft was kept.`)));
    });
    return await readFile(file, 'utf8');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
