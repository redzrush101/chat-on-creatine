// Starts a packaged build with a throwaway profile and calls its local MCP tools, so a release
// proves the parts that break only when packaged: the asar layout, node-pty and the QuickJS worker.
// Usage: node scripts/smoke-packaged.mjs [release-dir]   (Linux: run under xvfb-run)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const releaseDir = path.resolve(process.argv[2] ?? 'release');
const TIMEOUT_MS = 90_000;

function findExecutable() {
  const dirs = readdirSync(releaseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(releaseDir, entry.name));
  for (const dir of dirs) {
    const candidates = {
      linux: [path.join(dir, 'chat-on-creatine')],
      win32: [path.join(dir, 'Chat on Creatine.exe')],
      darwin: [path.join(dir, 'Chat on Creatine.app', 'Contents', 'MacOS', 'Chat on Creatine')]
    }[process.platform] ?? [];
    const found = candidates.find((file) => existsSync(file));
    if (found) return found;
  }
  throw new Error(`No unpacked app for ${process.platform} in ${releaseDir}`);
}

const executable = findExecutable();
const profile = mkdtempSync(path.join(os.tmpdir(), 'creatine-smoke-'));
const workspace = path.join(profile, 'workspace');
mkdirSync(workspace);
writeFileSync(path.join(workspace, 'hello.txt'), 'smoke\n');
// One approved folder and no tunnel ID: connecting starts the local MCP server, and the tunnel
// stays off for want of an ID, so nothing connects outward.
writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ version: 1, roots: [{ id: 'smoke', path: workspace, label: 'smoke' }] }));

console.log(`smoke: ${executable}`);
const child = spawn(executable, process.platform === 'linux' ? ['--no-sandbox'] : [], {
  env: { ...process.env, CREATINE_USER_DATA: profile, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
const collect = (chunk) => {
  log += chunk;
  process.stdout.write(chunk);
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);
const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(`exited with ${code ?? signal}`)));

function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGKILL');
}

async function waitFor(pattern) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const match = pattern.exec(log);
    if (match) return match;
    const done = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 250))]);
    if (done) throw new Error(`The app ${done} before printing ${pattern}`);
  }
  throw new Error(`Timed out waiting for ${pattern}`);
}

/** The token file is written asynchronously, so it can land shortly after the server listens. */
async function readTokens(file) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${file} never appeared`);
}

function textOf(result) {
  return result.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
}

let failed = false;
try {
  await waitFor(/\[app\] started/);
  const port = (await waitFor(/\[mcp\] listening on 127\.0\.0\.1:(\d+)/))[1];
  const tokens = await readTokens(path.join(profile, 'state', 'mcp-tokens.json'));
  const client = new Client({ name: 'smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${tokens.core}`)));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  console.log(`smoke: core tools ${names.join(', ')}`);

  const checks = [
    ['read', { paths: [path.join(workspace, 'hello.txt')] }, (text) => text.includes('smoke')],
    ['exec_command', { cmd: 'echo pty-ok', workdir: workspace, yield_time_ms: 5000 }, (text) => text.includes('pty-ok')],
    ['exec', { code: 'text(String(6 * 7))' }, (text) => text.includes('42')]
  ];
  for (const [name, args, ok] of checks) {
    if (!names.includes(name)) throw new Error(`Tool ${name} is missing`);
    const result = await client.callTool({ name, arguments: args });
    const text = textOf(result);
    if (result.isError || !ok(text)) throw new Error(`${name} failed: ${text.slice(0, 500)}`);
    console.log(`smoke: ${name} ok`);
  }
  await client.close();
  if (/\bERROR \[/.test(log)) throw new Error('The app logged an error');
  console.log('smoke: passed');
} catch (error) {
  failed = true;
  console.error(`smoke: FAILED: ${error instanceof Error ? error.message : error}`);
} finally {
  stop();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
