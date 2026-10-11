// Bundles the page scripts of the companion extension (extension/) and copies its icon.
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'extension');
const tapSource = join(root, 'src/page/tap.ts');
const driverEntry = join(root, 'src/page/extension-entry.ts');

const shared = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome125',
  logLevel: 'warning'
};

mkdirSync(join(out, 'icons'), { recursive: true });

// The MAIN-world tap must run before any page script, so it is a tiny IIFE of its own.
await esbuild.build({
  ...shared,
  stdin: {
    contents: `import { installFetchTap } from ${JSON.stringify(tapSource)};\ninstallFetchTap('creatine-tap');\n`,
    resolveDir: root,
    sourcefile: 'page-tap-entry.ts',
    loader: 'ts'
  },
  outfile: join(out, 'page-tap.js')
});

await esbuild.build({ ...shared, entryPoints: [driverEntry], outfile: join(out, 'page-driver.js') });

copyFileSync(join(root, 'resources/icon.png'), join(out, 'icons/icon.png'));
console.log(`extension built into ${out}`);
