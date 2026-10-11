import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { findOnPath, isRunnableFile } from '../exec/shell';

type BinaryName = 'tunnel-client' | 'cloudflared';

interface LocateOptions {
  /** Path the user chose in Settings: an executable or the folder containing it. Wins outright when set. */
  explicit: string;
  /** Downloaded copy under the app's user-data folder. */
  binDir: string;
  /** Copy shipped with the app, if any. */
  resourcesBinDir: string | null;
}

function executableName(name: BinaryName, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Finds a tunnel executable: the explicit setting, then the app's own download, then the bundled
 * copy, then PATH. An explicit setting that does not resolve yields null rather than a silent
 * fallback, so a wrong path is visible instead of being replaced by some other binary.
 */
export function locateBinary(name: BinaryName, options: LocateOptions): string | null {
  const file = executableName(name);
  const explicit = options.explicit.trim();
  if (explicit) {
    if (existsSync(explicit) && statSync(explicit).isDirectory()) {
      const inside = path.join(explicit, file);
      return isRunnableFile(inside) ? inside : null;
    }
    return isRunnableFile(explicit) ? explicit : null;
  }
  for (const dir of [options.binDir, options.resourcesBinDir]) {
    if (!dir) continue;
    const candidate = path.join(dir, file);
    if (isRunnableFile(candidate)) return candidate;
  }
  return findOnPath(file);
}
