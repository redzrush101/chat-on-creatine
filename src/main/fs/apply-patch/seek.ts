/**
 * Finds where a patch's old lines sit in the file, trying progressively looser comparisons the way
 * Codex's `seek_sequence` does: exact, then ignoring trailing whitespace, then ignoring surrounding
 * whitespace, then ignoring typographic punctuation differences.
 */

export function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  // A chunk marked end-of-file is tried at the end first, so a repeated line near the bottom wins.
  const last = lines.length - pattern.length;
  const eofStart = Math.max(last, start);
  const from = eof ? eofStart : start;

  const scan = (same: (line: string, expected: string) => boolean): number | null => {
    const ranges: [number, number][] = eof && from > start ? [[from, last], [start, from - 1]] : [[from, last]];
    for (const [lo, hi] of ranges) {
      for (let index = lo; index <= hi; index++) {
        let matched = true;
        for (let offset = 0; offset < pattern.length && matched; offset++) {
          matched = same(lines[index + offset]!, pattern[offset]!);
        }
        if (matched) return index;
      }
    }
    return null;
  };

  return (
    scan((line, expected) => line === expected) ??
    scan((line, expected) => line.trimEnd() === expected.trimEnd()) ??
    scan((line, expected) => line.trim() === expected.trim()) ??
    scan((line, expected) => normalizePunctuation(line) === normalizePunctuation(expected))
  );
}

const PUNCTUATION: Record<string, string> = {
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' '
};

function normalizePunctuation(value: string): string {
  let out = '';
  for (const character of value.trim()) out += PUNCTUATION[character] ?? character;
  return out;
}
