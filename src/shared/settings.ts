import { configSchema, defaultConfig, type Config, type DeepPartial } from './config';
import { parseArguments } from './arguments';

export interface SettingEntry { key: string; value: string | number | boolean | null }

export function settingEdit(config: Config, argument: string): { key: string; patch: DeepPartial<Config> } | null {
  const args = parseArguments(argument);
  if (args.length < 2) return null;
  const reset = args[0] === 'reset';
  if (reset && args.length !== 2) throw new Error('Usage: /settings reset <key>');
  const key = args[reset ? 1 : 0]!;
  return { key, patch: settingPatch(config, key, args.slice(1).join(' '), reset) };
}

/** Scalar preferences share the same keys and validation in both interfaces. */
export function settingsEntries(config: Config): SettingEntry[] {
  const entries: SettingEntry[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value) || path === 'version') return;
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
    } else if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') entries.push({ key: path, value });
  };
  visit(config, '');
  return entries;
}

export function settingPatch(config: Config, key: string, text: string, reset = false): DeepPartial<Config> {
  const entry = settingsEntries(config).find((entry) => entry.key === key);
  if (!entry) throw new Error(`Unknown setting ${key}. Use /settings to search available keys.`);
  let value: SettingEntry['value'] = text;
  if (reset) value = settingsEntries(defaultConfig()).find((entry) => entry.key === key)!.value;
  else if (typeof entry.value === 'boolean') {
    if (!['true', 'false', 'on', 'off'].includes(text)) throw new Error(`${key} expects on or off.`);
    value = text === 'true' || text === 'on';
  } else if (typeof entry.value === 'number') value = text.trim() ? Number(text) : NaN;
  else if (entry.value === null && ['null', 'default'].includes(text)) value = null;
  const next: Record<string, unknown> = structuredClone(config);
  const parts = key.split('.');
  let parent = next;
  for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
  parent[parts.at(-1)!] = value;
  const parsed = configSchema.safeParse(next);
  if (!parsed.success) throw new Error(`${key}: ${parsed.error.issues[0]?.message ?? 'Invalid value'}`);
  let patch: unknown = value;
  for (const part of parts.reverse()) patch = { [part]: patch };
  return patch as DeepPartial<Config>;
}
