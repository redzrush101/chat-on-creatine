#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
if (existsSync('/etc/NIXOS') && !process.env.ELECTRON_OVERRIDE_DIST_PATH) {
  const child = spawn('nix', ['develop', root, '-c', 'node', script, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else if (!existsSync(resolve(root, 'out/main/cli.js'))) {
  process.stderr.write('Build the CLI first: npm run build (inside nix develop on NixOS).\n');
  process.exitCode = 1;
} else {
  const { runCli } = createRequire(import.meta.url)(resolve(root, 'out/main/cli.js'));
  await runCli(process.argv.slice(2), root);
}
