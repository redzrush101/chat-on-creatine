import { Lexer } from 'marked';

/** Lists remain open across blank lines; other completed blocks can be rendered once. */
export function settled(source: string): number {
  const tokens = Lexer.lex(source, { gfm: true, breaks: true });
  let end = tokens.reduce((sum, token) => sum + token.raw.length, 0);
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index]!;
    end -= token.raw.length;
    if (token.type !== 'space') return tokens[index + 1]?.type === 'space' && token.type !== 'list' ? end + token.raw.length : end;
  }
  return 0;
}
