import { execFile, spawn, type ExecFileException } from 'node:child_process';
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

/** Use the same native selection for copying responses and pasting drafts. */
export async function writeWaylandClipboard(text: string): Promise<boolean> {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return false;
  return new Promise((resolve, reject) => {
    const child = spawn('wl-copy', ['--type', 'text/plain;charset=utf-8'], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 5000 });
    let detail = '';
    child.stderr.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString()).slice(-4096); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') resolve(false);
      else reject(new Error(`Cannot write the Wayland clipboard: ${error.message}`));
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // A failed child reports its exit status; EPIPE only means it stopped reading.
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`Cannot write the Wayland clipboard: ${detail.trim() || `wl-copy exited with code ${code}`}`));
    });
    child.stdin.end(text);
  });
}
