// Points git at the versioned hooks in .githooks/ (run by `npm install` through `prepare`).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git') && !process.env.CI) {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
  console.log('git hooks: .githooks');
}
