import { describe, expect, it } from 'vitest';
import { parseChord } from '../src/main/browser-tools/keys';
import { parseWebUrl } from '../src/main/browser-tools/navigation';

describe('browser navigation boundary', () => {
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'about:blank', 'not a URL'])('refuses %s', (url) => {
    expect(() => parseWebUrl(url)).toThrow();
  });

  it.each(['https://example.com/path?q=1#anchor', 'http://127.0.0.1:8080/'])('preserves a web URL: %s', (url) => {
    expect(parseWebUrl(url).href).toBe(url);
  });
});

describe('browser key chords', () => {
  it('keeps shortcut modifiers from inserting text', () => {
    expect(parseChord('Control+a')).toEqual({ key: 'a', code: 'KeyA', vk: 65, modifiers: 2, text: undefined });
    expect(parseChord('Cmd+Shift+a')).toMatchObject({ key: 'A', modifiers: 12, text: undefined });
  });

  it('handles printable keys, named keys and literal plus', () => {
    expect(parseChord('Shift+a')).toMatchObject({ key: 'A', text: 'A', modifiers: 8 });
    expect(parseChord('Enter')).toMatchObject({ key: 'Enter', text: '\r' });
    expect(parseChord('Shift+Tab')).toMatchObject({ key: 'Tab', modifiers: 8, text: undefined });
    expect(parseChord('Control++')).toMatchObject({ key: '+', modifiers: 2, text: undefined });
  });

  it.each(['Bogus+a', 'Control+unknown', ''])('refuses an invalid chord: %s', (chord) => {
    expect(() => parseChord(chord)).toThrow();
  });
});
