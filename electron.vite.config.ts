import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const shared = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    // Preloads run sandboxed, so every import (including shared code) is bundled into one file.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          app: resolve(__dirname, 'src/preload/app.ts'),
          chatgpt: resolve(__dirname, 'src/preload/chatgpt.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: shared },
    build: {
      // The renderer CSP only allows same-origin fonts; never inline them as data: URLs.
      assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
});
