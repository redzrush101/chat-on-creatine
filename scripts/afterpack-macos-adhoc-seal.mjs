// Seals the packaged macOS app ad hoc and verifies the seal (electron-builder afterPack hook).
//
// Releases are unsigned (`mac.identity: null`). On Apple Silicon the linker still signs every Mach-O
// ad hoc, so an unsealed bundle has executables that claim a resource seal the bundle lacks, and
// macOS refuses to open it as "damaged". An ad-hoc seal carries no identity and changes nothing for
// Gatekeeper; it only makes the bundle consistent. A failed verify fails the build.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || result.error?.message}`);
  }
  return result;
}

export default async function sealMacOsBundle(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!existsSync(app)) throw new Error(`afterPack could not find ${app}`);
  // A uniform ad-hoc seal without entitlements: --deep signs nested frameworks and helpers alike.
  run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  console.log(`  • sealed ${path.basename(app)} ad hoc`);
}
