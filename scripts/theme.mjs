import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../src/renderer/styles/tokens.css', import.meta.url));
const palette = JSON.parse(readFileSync(new URL('../src/shared/palette.json', import.meta.url), 'utf8'));
const current = readFileSync(file, 'utf8');
const marker = '/* Palette generated from src/shared/palette.json by scripts/theme.mjs. */';
if (!current.includes(marker)) throw new Error('Keep the shared palette marker in tokens.css so generation preserves its layout tokens.');
const prefix = current.slice(0, current.indexOf(marker));
const themes = Object.entries(palette).map(([theme, tokens]) => {
  const selector = theme === 'dark' ? ':root' : ":root[data-theme='light']";
  return `${selector} {\n${Object.entries(tokens).map(([name, value]) => `  --${name}: ${value};`).join('\n')}\n  color-scheme: ${theme};\n}`;
});
const next = `${prefix}${marker}\n${themes.join('\n\n')}\n`;
if (process.argv.includes('--check')) {
  if (next !== current) throw new Error('The shared palette changed. Run node scripts/theme.mjs to update tokens.css.');
  process.stdout.write('shared palette: ok\n');
} else if (next !== current) writeFileSync(file, next);
