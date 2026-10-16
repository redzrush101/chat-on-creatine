import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { defaultConfig } from '../src/shared/config';
import { settingPatch } from '../src/shared/settings';
import { ConfigStore } from '../src/main/core/config-store';
import { flushWrites } from '../src/main/core/durable';

it('validates shared settings without losing previous preferences on a bad edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'creatine-settings-'));
  try {
    const store = new ConfigStore(join(dir, 'config.json'));
    store.update(settingPatch(store.get(), 'ui.theme', 'light'));
    store.update(settingPatch(store.get(), 'ui.expandTools', 'on'));
    store.update(settingPatch(store.get(), 'ui.chatWidth', '1008'));
    expect(store.get().ui).toMatchObject({ theme: 'light', expandTools: true, chatWidth: 1008 });
    expect(() => settingPatch(store.get(), '__proto__.polluted', 'true')).toThrow('Unknown setting');
    expect(() => settingPatch(store.get(), 'ui.chatWidth', '5000')).toThrow('ui.chatWidth');
    expect(() => settingPatch(store.get(), 'ui.expandTools', 'maybe')).toThrow('on or off');
    expect(() => store.update({ ui: { fontScale: 5 } })).toThrow();
    expect(store.get().ui.theme).toBe('light');
    store.update(settingPatch(store.get(), 'ui.theme', '', true));
    expect(store.get().ui.theme).toBe(defaultConfig().ui.theme);
    await flushWrites();
    expect(new ConfigStore(join(dir, 'config.json')).get().ui.expandTools).toBe(true);
  } finally { await flushWrites(); await rm(dir, { recursive: true, force: true }); }
});
