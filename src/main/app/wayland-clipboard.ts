import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

type ClipboardData = { type: string; bytes: Buffer } | { text: string };

/** XWayland and headless Electron can see a different selection from the user's Wayland terminal. */
export async function readWaylandClipboard(): Promise<ClipboardData | null> {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return null;
  const read = async (args: string[], maxBuffer: number) => {
    try { return (await run('wl-paste', args, { encoding: 'buffer', timeout: 5000, maxBuffer })).stdout; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('The clipboard content is larger than 50 MB.');
      throw error;
    }
  };
  let types: string[];
  try { types = (await read(['--list-types'], 16_384)).toString('utf8').trim().split(/\r?\n/); }
  catch (error) {
    // wl-clipboard is optional; Electron remains the clipboard source when it is not installed.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const failure = error as ExecFileException & { stderr?: Buffer | string };
    if (failure.code === 1 && /Nothing is copied|No selection/i.test(failure.stderr?.toString() ?? '')) return { text: '' };
    throw new Error(`Cannot read the Wayland clipboard: ${error instanceof Error ? error.message : String(error)}`);
  }
  const image = IMAGE_TYPES.find((type) => types.includes(type));
  if (image) return { type: image, bytes: await read(['--no-newline', '--type', image], MAX_BYTES) };
  const text = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'TEXT', 'STRING'].find((type) => types.includes(type));
  return { text: text ? (await read(['--no-newline', '--type', text], MAX_BYTES)).toString('utf8') : '' };
}
