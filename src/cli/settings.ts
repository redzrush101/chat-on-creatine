import { settingEdit, settingsEntries, settingPatch } from '@shared/settings';
import { CHARS_PER_TOKEN, CONTEXT_PARTS, contextPercent, contextUsage, usageTokens } from '@shared/context';
import { formatTokens } from '@shared/format';
import type { CliSession } from './session';

export async function settingsCommand(session: CliSession, argument: string): Promise<string> {
  const edit = settingEdit(session.state.config, argument);
  if (edit) {
    const config = await session.client.invoke('config:update', edit.patch);
    return `${edit.key} = ${String(settingsEntries(config).find((entry) => entry.key === edit.key)!.value)}`;
  }
  const entries = settingsEntries(session.state.config).filter((entry) => entry.key.toLowerCase().includes(argument.toLowerCase()));
  const terminal = session.terminal!;
  const entry = await terminal.pick('Settings · shared with the desktop · type to filter', entries.map((entry) => ({ label: entry.key, detail: String(entry.value), value: entry })));
  if (!entry) return '';
  const value = typeof entry.value === 'boolean' ? String(!entry.value)
    : await terminal.ask(`${entry.key} · current: ${String(entry.value)}`, false, String(entry.value ?? ''));
  if (value === null) return '';
  await session.client.invoke('config:update', settingPatch(session.state.config, entry.key, value));
  return `${entry.key} = ${value}`;
}

export async function usageText(session: CliSession): Promise<string> {
  if (!session.id) return 'Send a message or resume a chat to see its usage.';
  const events = await session.client.invoke('sessions:events', session.id);
  const usage = session.meta?.contextUsage ?? contextUsage(events);
  const tokens = session.meta?.contextTokens || usageTokens(usage);
  const advisory = session.state.config.context.advisoryTokens;
  const percent = contextPercent(tokens, advisory);
  const turns = events.filter((event) => event.kind === 'turn' && event.phase === 'end').length;
  const calls = events.filter((event) => event.kind === 'tool');
  const current = events.slice(events.findLastIndex((event) => event.kind === 'handoff') + 1);
  return `Context · ~${formatTokens(tokens)} / ${formatTokens(advisory)} tokens · ${percent.used}% used · ${percent.remaining}% left\n` +
    Object.entries(CONTEXT_PARTS).map(([key, label]) => `  ${label.padEnd(24)} ~${formatTokens(Math.ceil(usage[key as keyof typeof usage] / CHARS_PER_TOKEN))}`).join('\n') +
    `\n${turns} completed turns · ${calls.length} tool calls · ${calls.filter((event) => event.kind === 'tool' && event.status === 'error').length} tool errors\n` +
    `${current.filter((event) => event.kind === 'user').length} messages since the last compaction\n` +
    'Estimates against your configured threshold; account quota and billing are managed in ChatGPT.\n/compact starts a fresh chat with a handoff brief.';
}
