import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Live tests drive the real app against a signed-in ChatGPT account; see test/live/README.md.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['test/live/**/*.live.ts'],
    environment: 'node',
    // One app at a time: every run shares the account's tunnel.
    fileParallelism: false,
    testTimeout: 15 * 60_000,
    hookTimeout: 3 * 60_000
  }
});
