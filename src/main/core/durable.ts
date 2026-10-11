import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const queues = new Map<string, Promise<void>>();

/**
 * Atomically replaces a file (temp + rename). Writes to the same path are serialized so a slow
 * earlier write can never land after a newer one.
 */
export function writeFileAtomic(path: string, data: string): Promise<void> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, data, 'utf8');
      await rename(temp, path);
    });
  queues.set(path, next);
  void next.finally(() => {
    if (queues.get(path) === next) queues.delete(path);
  });
  return next;
}

export function writeJson(path: string, value: unknown): Promise<void> {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Reads JSON, returning `fallback` when missing or corrupt (corruption is the caller's to log). */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
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
