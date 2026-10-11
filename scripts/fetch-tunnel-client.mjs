// Downloads the pinned tunnel-client release for this machine into resources/bin/ (dev and packaging).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUNNEL_CLIENT, UPSTREAM_OS } from './tunnel-client-pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'resources', 'bin');

const target = TUNNEL_CLIENT.targets[process.platform]?.[process.arch];
if (!target) throw new Error(`No tunnel-client pin for ${process.platform}-${process.arch}`);

const tag = TUNNEL_CLIENT.version;
const asset = `tunnel-client-${tag}-${UPSTREAM_OS[process.platform]}-${target.upstreamArch}.zip`;
const url = `https://github.com/openai/tunnel-client/releases/download/${tag}/${asset}`;
const suffix = process.platform === 'win32' ? '.exe' : '';

const work = await mkdtemp(path.join(os.tmpdir(), 'creatine-fetch-'));
try {
  const zip = path.join(work, asset);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));

  const digest = createHash('sha256').update(await readFile(zip)).digest('hex');
  if (digest !== target.sha256) throw new Error(`Checksum mismatch for ${asset}\n  expected ${target.sha256}\n  got      ${digest}`);

  const extracted = path.join(work, 'out');
  await mkdir(extracted);
  if (process.platform === 'win32') execFileSync('tar.exe', ['-xf', zip, '-C', extracted], { stdio: 'inherit' });
  else execFileSync('unzip', ['-q', '-o', zip, '-d', extracted], { stdio: 'inherit' });

  const entries = await readdir(extracted, { withFileTypes: true });
  const dir = entries.length === 1 && entries[0].isDirectory() ? path.join(extracted, entries[0].name) : extracted;

  await mkdir(outDir, { recursive: true });
  for (const name of ['tunnel-client', 'cloudflared']) {
    const source = path.join(dir, `${name}${suffix}`);
    if (!existsSync(source)) throw new Error(`${name}${suffix} is missing from ${asset}`);
    const dest = path.join(outDir, `${name}${suffix}`);
    await copyFile(source, dest);
    if (process.platform !== 'win32') await chmod(dest, 0o755);
  }
  await writeFile(path.join(outDir, 'VERSION'), `${tag}\n`, 'utf8');
  process.stdout.write(`tunnel-client ${tag} ${process.platform}-${process.arch} written to resources/bin\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
