import { describe, expect, it } from 'vitest';
import { requestIdFromHeader } from '../src/main/mcp/server';

describe('MCP attribution header', () => {
  it('extracts the join key independently of the hop suffix', () => {
    expect(requestIdFromHeader(' wfr_abc /hop')).toBe('wfr_abc');
    expect(requestIdFromHeader(['wfr_abc/another-hop'])).toBe('wfr_abc');
  });

  it.each([undefined, '', '/hop', [], ['first', 'second'], 'x'.repeat(101), 'wfr abc/hop', 'wfr_abc,other/hop'])('refuses ambiguous or malformed identity: %j', (value) => {
    expect(requestIdFromHeader(value)).toBeNull();
  });
});
