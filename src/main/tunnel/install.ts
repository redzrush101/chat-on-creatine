import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { TUNNEL_CLIENT, UPSTREAM_OS } from '../../../scripts/tunnel-client-pins.mjs';

const run = promisify(execFile);

/** Lays the release's executables in `<binDir>`, after the archive matches its pinned SHA-256. */
export async function installTunnelClient(binDir: string): Promise<string> {
  const target = TUNNEL_CLIENT.targets[process.platform]?.[process.arch];
  if (!target) throw new Error(`No tunnel-client release for ${process.platform}-${process.arch}`);
  const tag = TUNNEL_CLIENT.version;
  const asset = `tunnel-client-${tag}-${UPSTREAM_OS[process.platform]}-${target.upstreamArch}.zip`;
  const url = `https://github.com/openai/tunnel-client/releases/download/${tag}/${asset}`;
  const suffix = process.platform === 'win32' ? '.exe' : '';

  await mkdir(binDir, { recursive: true });
  const work = await mkdtemp(path.join(os.tmpdir(), 'creatine-tunnel-'));
  try {
    const zip = path.join(work, asset);
    const res = await fetch(url, { headers: { 'user-agent': 'chat-on-creatine' } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${asset}`);
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));

    const digest = createHash('sha256').update(await readFile(zip)).digest('hex');
    if (digest !== target.sha256) throw new Error(`Checksum mismatch for ${asset}: expected ${target.sha256}, got ${digest}`);

    const out = path.join(work, 'out');
    await mkdir(out);
    if (process.platform === 'win32') await run('tar.exe', ['-xf', zip, '-C', out]);
    else await run('unzip', ['-q', '-o', zip, '-d', out]);
    const root = await unwrapSingleDirectory(out);

    for (const name of ['tunnel-client', 'cloudflared']) {
      const source = path.join(root, `${name}${suffix}`);
      if (!existsSync(source)) throw new Error(`${name}${suffix} is missing from ${asset}`);
      const dest = path.join(binDir, `${name}${suffix}`);
      const staging = `${dest}.tmp`;
      await copyFile(source, staging);
      if (process.platform !== 'win32') await chmod(staging, 0o755);
      await rename(staging, dest);
    }
    await writeFile(path.join(binDir, 'VERSION'), `${tag}\n`, 'utf8');
    return path.join(binDir, `tunnel-client${suffix}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function unwrapSingleDirectory(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const only = entries.length === 1 && entries[0]!.isDirectory() ? entries[0]! : null;
  return only ? path.join(dir, only.name) : dir;
}
