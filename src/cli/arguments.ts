/** Shell-style words without executing expansions or commands. */
export function parseArguments(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\' && quote !== "'" && i + 1 < text.length && (!quote || ['"', '\\'].includes(text[i + 1]!))) {
      word += text[++i]; started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += char; started = true; }
  }
  if (quote) throw new Error('Close the quoted argument before sending.');
  if (started) words.push(word);
  return words;
}
