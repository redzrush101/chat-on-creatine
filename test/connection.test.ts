import { expect, it, vi } from 'vitest';
import type { Config } from '@shared/config';
import { defaultConfig } from '@shared/config';
import { ConnectionManager } from '../src/main/tunnel/connection';
import { locateBinary } from '../src/main/tunnel/locate';
import type { McpHttpServer } from '../src/main/mcp/server';

vi.mock('../src/main/tunnel/locate', () => ({ locateBinary: vi.fn(async () => null) }));

it('reuses executable discovery while streaming and discovers changed settings or installs after a config update', async () => {
  const config = defaultConfig();
  let changed: (next: Config) => void = () => {};
  const connection = new ConnectionManager({ getConfig: () => config, getSecret: () => null, binDir: '/tmp', resourcesBinDir: null,
    server: { stop: async () => {}, toolCount: () => 0 } as unknown as McpHttpServer, onConfigChange: (listener) => { changed = listener; return () => {}; } });
  await Promise.all([connection.tools(), connection.tools(), connection.tools()]);
  expect(locateBinary).toHaveBeenCalledTimes(2);
  config.connection.tunnelClientPath = '/tmp/new-client';
  vi.mocked(locateBinary).mockResolvedValueOnce('/tmp/new-client');
  changed(config);
  expect(await connection.tools()).toEqual({ tunnelClient: '/tmp/new-client', cloudflared: null });
  expect(locateBinary).toHaveBeenCalledTimes(4);
  await connection.dispose();
});
