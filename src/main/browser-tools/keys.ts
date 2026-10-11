const MODIFIERS: Record<string, number> = {
  alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8
};

const NAMED_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 }
};

interface ParsedKey {
  key: string;
  code: string;
  vk: number;
  modifiers: number;
  text?: string;
}

/** Parses chords such as `Enter`, `Control+a` or `Shift+Tab` into CDP key-event fields. */
export function parseChord(chord: string): ParsedKey {
  const trimmed = chord.trim();
  const parts = trimmed.endsWith('+') && trimmed.length > 1 ? [...trimmed.slice(0, -2).split('+'), '+'] : trimmed.split('+');
  const name = parts.pop() ?? '';
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${part}". Use Control, Shift, Alt or Meta.`);
    modifiers |= bit;
  }
  const textAllowed = (modifiers & 6) === 0;
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return { ...named, modifiers, text: textAllowed ? named.text : undefined };
  if (name.length !== 1) throw new Error(`Unknown key "${name}".`);
  const isLetter = /[a-z]/i.test(name);
  const isDigit = /\d/.test(name);
  const key = isLetter && (modifiers & 8) !== 0 ? name.toUpperCase() : name;
  const code = isLetter ? `Key${name.toUpperCase()}` : isDigit ? `Digit${name}` : name === ' ' ? 'Space' : '';
  const vk = isLetter || isDigit ? name.toUpperCase().charCodeAt(0) : 0;
  return { key, code, vk, modifiers, text: textAllowed ? key : undefined };
}

