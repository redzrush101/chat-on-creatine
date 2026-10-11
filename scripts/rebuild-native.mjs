// Rebuilds native modules (node-pty) against the Electron ABI. Run after `npm install`.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const ptyDir = dirname(require.resolve('node-pty/package.json'));
// npm ships node-gyp; find it next to the npm CLI that is running this script.
const npmRoot = join(dirname(realpathSync(process.env.npm_execpath ?? join(dirname(process.execPath), 'npm'))), '..');
const gyp = require.resolve('node-gyp/bin/node-gyp.js', { paths: [npmRoot] });

execFileSync(process.execPath, [gyp, 'rebuild', `--target=${electronVersion}`, '--runtime=electron', '--dist-url=https://electronjs.org/headers'], {
  cwd: ptyDir,
  stdio: 'inherit'
});
console.log(`node-pty rebuilt for Electron ${electronVersion}`);
