import { parseConfig, type Config, type DeepPartial } from '@shared/config';
import { readJsonSync, writeJson } from './durable';
import { Emitter } from './emitter';

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = merge((base as Record<string, unknown>)[key], value as DeepPartial<unknown>);
  }
  return out as T;
}

/** Owns config.json. Every change is validated, persisted and broadcast as a whole new object. */
export class ConfigStore {
  private current: Config;
  private readonly events = new Emitter<{ change: { next: Config; previous: Config } }>();

  constructor(private readonly path: string) {
    this.current = parseConfig(readJsonSync<unknown>(path, {}));
  }

  get(): Config {
    return this.current;
  }

  update(patch: DeepPartial<Config>): Config {
    const previous = this.current;
    this.current = parseConfig(merge(previous, patch));
    void writeJson(this.path, this.current);
    this.events.emit('change', { next: this.current, previous });
    return this.current;
  }

  onChange(listener: (next: Config, previous: Config) => void): () => void {
    return this.events.on('change', ({ next, previous }) => listener(next, previous));
  }
}
