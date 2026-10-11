// node-pty 1.1.0 ships its macOS spawn-helper without the executable bit, so every spawn fails
// with "posix_spawnp failed". Restores it after install (npm `postinstall`); packages keep the mode.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const prebuilds = path.join('node_modules', 'node-pty', 'prebuilds');
for (const target of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
  const helper = path.join(prebuilds, target, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
