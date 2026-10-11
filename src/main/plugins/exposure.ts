export interface ExposureSource {
  /** Plugin server id. */
  id: string;
  /** Server name, used as the prefix when a tool name is claimed by several servers. */
  name: string;
  /** Upstream names of the tools that are exposed from this server. */
  toolNames: string[];
}

/**
 * Exposed name per server id and upstream tool name. Names are kept as upstream declares them;
 * a name claimed by more than one server is prefixed with each claiming server's name.
 */
export function exposedNames(sources: ExposureSource[]): Map<string, Map<string, string>> {
  const claims = new Map<string, number>();
  for (const source of sources) {
    for (const name of new Set(source.toolNames)) claims.set(name, (claims.get(name) ?? 0) + 1);
  }
  const result = new Map<string, Map<string, string>>();
  for (const source of sources) {
    const prefix = source.name.replace(/[^A-Za-z0-9_-]+/g, '_');
    const names = new Map<string, string>();
    for (const name of source.toolNames) {
      names.set(name, (claims.get(name) ?? 0) > 1 ? `${prefix}_${name}` : name);
    }
    result.set(source.id, names);
  }
  return result;
}
