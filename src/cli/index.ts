import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_HELP, parseOptions } from './options';

/** Help and version work before loading terminal rendering, configuration or backend clients. */
export async function runCli(args: string[], root: string): Promise<void> {
  try {
    const options = parseOptions(args);
    if (options.help) { process.stdout.write(CLI_HELP); return; }
    if (options.version) {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
      process.stdout.write(`${pkg.version}\n`);
      return;
    }
    const { startCli } = await import('./run');
    await startCli(options, root);
  } catch (error) {
    const { safeText } = await import('./format');
    const message = safeText(error instanceof Error ? error.message : String(error));
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`);
    else process.stderr.write(`creatine: ${message}\n`);
    process.exitCode = 1;
  }
}
