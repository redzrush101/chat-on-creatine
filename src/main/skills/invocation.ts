import path from 'node:path';
import type { Skill } from '@shared/types';

const PREFIXED_COMMAND = /^\s*\/skill\s+([a-z0-9][a-z0-9._-]*)(?=\s|$)/i;
const DIRECT_COMMAND = /^\s*\/([a-z0-9][a-z0-9._-]*)(?=\s|$)/i;

/**
 * A message that starts with `/<skill-id>` or `/skill <skill-id>` gets that skill's SKILL.md inlined
 * ahead of the rest of the message. Commands naming no known skill, and commands later in the
 * message, stay literal text.
 */
export function expandSkillInvocation(
  text: string,
  skills: readonly Skill[],
  readSkill: (id: string) => string
): { text: string; skillId: string | null } {
  for (const command of [PREFIXED_COMMAND, DIRECT_COMMAND]) {
    const match = command.exec(text);
    const skill = match && skills.find((candidate) => candidate.id === match[1]!.toLowerCase());
    if (!match || !skill) continue;

    const rest = text.slice(match[0].length).trim();
    const block = [
      `Skill "${skill.id}" (folder: ${path.dirname(skill.path)}). Read other files in that folder with the read tool when the instructions refer to them.`,
      '<skill-instructions>',
      readSkill(skill.id).trimEnd(),
      '</skill-instructions>'
    ].join('\n');
    return { text: rest ? `${block}\n\n${rest}` : block, skillId: skill.id };
  }
  return { text, skillId: null };
}

/**
 * Picks the one skill whose id or name appears in the text. Case, hyphens and whitespace do not
 * matter; other punctuation does. When more than one skill matches, nothing is selected.
 */
export function autoSelectSkill(text: string, skills: readonly Skill[]): string | null {
  const words = tokens(text);
  if (!words.length) return null;
  const matched = skills.filter((skill) =>
    [skill.id, skill.name].some((value) => {
      const phrase = tokens(value);
      return phrase.length > 0 && containsPhrase(words, phrase);
    })
  );
  return matched.length === 1 ? matched[0]!.id : null;
}

/** Words and single punctuation marks. Hyphens and whitespace separate words but are not kept. */
function tokens(value: string): string[] {
  return value.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}\s-]/gu) ?? [];
}

function containsPhrase(words: readonly string[], phrase: readonly string[]): boolean {
  return Array.from({ length: words.length - phrase.length + 1 }, (_, start) => start).some((start) =>
    phrase.every((word, offset) => words[start + offset] === word)
  );
}
