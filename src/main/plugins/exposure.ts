import { createHash } from 'node:crypto';

interface ExposureSource {
  /** Plugin server id. */
  id: string;
  /** Server name, used as the prefix when a tool name is claimed by several servers. */
  name: string;
  /** Upstream names of the tools that are exposed from this server. */
  toolNames: string[];
}

/**
 * Exposed name per server id and upstream tool name. Names are kept as upstream declares them;
 * shared names get a readable server prefix, with a stable suffix if that also collides.
 */
export function exposedNames(sources: ExposureSource[]): Map<string, Map<string, string>> {
  const claims = new Map<string, number>();
  for (const source of sources) {
    for (const name of new Set(source.toolNames)) claims.set(name, (claims.get(name) ?? 0) + 1);
  }
  const result = new Map<string, Map<string, string>>();
  const used = new Set([...claims].filter(([, count]) => count === 1).map(([name]) => name));
  for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
    const prefix = source.name.replace(/[^A-Za-z0-9_-]+/g, '_');
    const names = new Map<string, string>();
    for (const name of source.toolNames) {
      if (names.has(name)) continue;
      let exposed = name;
      if ((claims.get(name) ?? 0) > 1) {
        const base = `${prefix}_${name}`;
        exposed = base;
        const suffix = createHash('sha256').update(source.id).digest('hex').slice(0, 8);
        for (let index = 0; used.has(exposed); index++) exposed = `${base}_${suffix}${index ? `_${index}` : ''}`;
        used.add(exposed);
      }
      names.set(name, exposed);
    }
    result.set(source.id, names);
  }
  return result;
}
