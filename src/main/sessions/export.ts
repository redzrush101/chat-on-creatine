import type { SessionEvent, SessionMeta, ToolOutputPart } from '@shared/types';

/** A Markdown transcript: messages, compact tool calls and plans as checklists. Reasoning is left out. */
export function exportMarkdown(meta: SessionMeta, events: SessionEvent[]): string {
  const blocks: string[] = [`# ${meta.title}`];
  for (const event of events) {
    const block = renderEvent(event);
    if (block) blocks.push(block);
  }
  return `${blocks.join('\n\n')}\n`;
}

function renderEvent(event: SessionEvent): string | null {
  switch (event.kind) {
    case 'user': {
      const files = event.attachments.map((file) => `_Attached: ${file.name}_`).join('\n');
      return ['## You', event.text, files].filter(Boolean).join('\n\n');
    }
    case 'assistant':
      return `## Assistant\n\n${event.text}`;
    case 'tool': {
      const args = event.args === undefined ? '' : fence('json', JSON.stringify(event.args, null, 2));
      const output = outputText(event.output);
      const result = output ? fence('text', output) : '';
      return [`**Tool** \`${event.name}\` (${event.status})`, args, result].filter(Boolean).join('\n\n');
    }
    case 'plan': {
      const items = event.items.map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${item.step}`);
      return ['**Plan**', event.explanation, ...items].filter((line): line is string => Boolean(line)).join('\n');
    }
    case 'notice':
      return `> ${event.text}`;
    case 'agent':
      return `_${event.label} ${event.action}: ${event.text}_`;
    case 'handoff':
      return `_Handed off to a new chat: ${event.brief}_`;
    case 'reasoning':
    case 'turn':
      return null;
  }
}

function outputText(parts: ToolOutputPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : part.type === 'exec' ? part.output : ''))
    .filter(Boolean)
    .join('\n');
}

/** Fences content with a backtick run longer than any inside it, so the block cannot break. */
function fence(language: string, content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}${language}\n${content}\n${marks}`;
}
