import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const queues = new Map<string, Promise<void>>();

/** Serializes writes to a path so an earlier append or replacement cannot land after a newer one. */
function queueWrite(path: string, write: () => Promise<void>): Promise<void> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await write();
    });
  queues.set(path, next);
  const clear = () => {
    if (queues.get(path) === next) queues.delete(path);
  };
  void next.then(clear, clear);
  return next;
}

/** Replaces a file with temp + rename inside its write queue. */
export function writeFileAtomic(path: string, data: string): Promise<void> {
  return queueWrite(path, async () => {
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  });
}

/** Appends in the same queue as atomic replacements, so log compaction cannot race an append. */
export function appendText(path: string, data: string): Promise<void> {
  return queueWrite(path, () => appendFile(path, data, { encoding: 'utf8', mode: 0o600 }));
}

export function writeJson(path: string, value: unknown): Promise<void> {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonSync<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Resolves once every queued write has landed (used on shutdown). */
export async function flushWrites(): Promise<void> {
  await Promise.allSettled([...queues.values()]);
}
