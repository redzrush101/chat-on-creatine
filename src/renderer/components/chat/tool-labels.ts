import type { SessionEvent } from '@shared/types';
import { basename } from '../../lib/format';

type ToolEvent = Extract<SessionEvent, { kind: 'tool' }>;

export type ToolCategory = 'command' | 'script' | 'read' | 'edit' | 'create' | 'delete' | 'search' | 'web' | 'open' | 'plan' | 'agent' | 'browser' | 'image' | 'other';

/** How one tool call reads in the timeline: `Ran` + `ls -la`, `Edited` + `report.md`. */
export interface ToolLabel {
  category: ToolCategory;
  /** Past tense verb for a finished call. */
  verb: string;
  /** Present participle for a running call. */
  active: string;
  /** What the call worked on, shown after the verb; null when the verb says it all. */
  target: string | null;
  /** The target is code (a command) and shows in monospace. */
  code: boolean;
  /** Files the call touched (edits), with line counts when the result carried a diff. */
  files: { path: string; added: number; removed: number }[];
  /** Everything the target names, for counting: each file read, each agent started. */
  items: string[];
}

function singleLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function listOf(names: string[], max = 3): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

/**
 * Tool names arrive bare (`exec_command`), with a ChatGPT namespace (`functions.exec`, `container.exec`)
 * or, in older recordings, as a connector path (`/Chat On Creatine Core/link_…/read`).
 */
export function toolBaseName(name: string): string {
  const last = name.split('/').filter(Boolean).pop() ?? name;
  return last.replace(/^(functions|mcp)\./, '');
}

/** Older recordings wrap the real arguments as `{ path: '/Connector/link/tool', args }`. */
function unwrapArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const record = args as Record<string, unknown>;
  if (typeof record.path === 'string' && record.path.startsWith('/') && record.args && typeof record.args === 'object') {
    return record.args as Record<string, unknown>;
  }
  return record;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : typeof value === 'string' && value ? [value] : [];

function label(category: ToolCategory, verb: string, active: string, target: string | null, code = false, files: ToolLabel['files'] = [], items?: string[]): ToolLabel {
  return { category, verb, active, target, code, files, items: items ?? files.map((file) => basename(file.path)) };
}

/** Files an apply_patch call touches, from its result diffs, else from the patch headers. */
function patchFiles(event: ToolEvent, args: Record<string, unknown>): { files: ToolLabel['files']; created: boolean; deleted: boolean } {
  const diffs = event.output.filter((part) => part.type === 'diff');
  if (diffs.length) {
    return {
      files: diffs.map((part) => ({ path: part.path, added: part.added, removed: part.removed })),
      created: diffs.every((part) => /^--- \/dev\/null/m.test(part.diff)),
      deleted: diffs.every((part) => /^\+\+\+ \/dev\/null/m.test(part.diff))
    };
  }
  const patch = str(args.patch) ?? str(args.input) ?? (typeof event.args === 'string' ? event.args : '');
  const headers = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)];
  return {
    files: headers.map((match) => ({ path: (match[2] ?? '').trim(), added: 0, removed: 0 })),
    created: headers.length > 0 && headers.every((match) => match[1] === 'Add'),
    deleted: headers.length > 0 && headers.every((match) => match[1] === 'Delete')
  };
}

export function describeTool(event: ToolEvent): ToolLabel {
  const name = toolBaseName(event.name);
  const args = unwrapArgs(event.args);
  const raw = typeof event.args === 'string' ? event.args : null;

  if (name === 'exec_command' || name === 'container.exec' || name === 'shell') {
    const command = str(args.cmd) ?? str(args.command) ?? (strings(args.command).join(' ') || raw);
    return label('command', 'Ran', 'Running', command ? singleLine(command) : 'a command', command !== null);
  }
  if (name === 'write_stdin') {
    const id = str(args.session_id) ?? (typeof args.session_id === 'number' ? String(args.session_id) : null);
    const exec = event.output.find((part) => part.type === 'exec');
    const target = exec?.type === 'exec' ? singleLine(exec.command) : id ? `command ${id}` : 'a command';
    return str(args.chars)
      ? label('command', 'Sent input to', 'Sending input to', target, exec !== undefined)
      : label('command', 'Checked', 'Waiting on', target, exec !== undefined);
  }
  if (name === 'exec') {
    const code = str(args.code) ?? raw ?? '';
    const nested = [...new Set([...code.matchAll(/tools\.(\w+)/g)].map((match) => match[1] ?? ''))].filter(Boolean);
    return label('script', 'Ran a script', 'Running a script', nested.length ? `using ${listOf(nested)}` : null);
  }
  if (name === 'read') {
    const names = strings(args.paths).concat(strings(args.path)).map(basename);
    return label('read', 'Read', 'Reading', names.length ? listOf(names) : null, false, [], names);
  }
  if (name === 'find') {
    const pattern = str(args.pattern);
    return label('search', args.mode === 'content' ? 'Searched for' : 'Looked for', 'Searching for', pattern ? singleLine(pattern, 80) : 'files');
  }
  if (name === 'apply_patch') {
    const { files, created, deleted } = patchFiles(event, args);
    const target = files.length ? listOf(files.map((file) => basename(file.path))) : null;
    if (created) return label('create', 'Created', 'Creating', target, false, files);
    if (deleted) return label('delete', 'Deleted', 'Deleting', target, false, files);
    return label('edit', 'Edited', 'Editing', target, false, files);
  }
  if (name === 'update_plan') return label('plan', 'Updated the plan', 'Updating the plan', null);
  if (name === 'agents') {
    if (args.action === 'spawn') {
      const workers = Array.isArray(args.workers) ? args.workers.map((worker) => str((worker as { label?: unknown })?.label)).filter((value): value is string => value !== null) : [];
      return label('agent', workers.length === 1 ? 'Started agent' : 'Started agents', 'Starting agents', workers.length ? listOf(workers) : null, false, [], workers);
    }
    if (args.action === 'message') {
      const to = strings(args.to);
      return label('agent', 'Messaged', 'Messaging', to.length ? listOf(to) : 'an agent');
    }
    if (args.action === 'finish') return label('agent', 'Reported the result', 'Reporting the result', null);
    return label('agent', 'Checked on agents', 'Checking on agents', null);
  }
  if (name === 'view_image') {
    const path = str(args.path);
    return label('image', 'Viewed', 'Viewing', path ? basename(path) : 'an image');
  }
  if (name.startsWith('browser_')) {
    const url = str(args.url);
    if (name === 'browser_navigate') return label('browser', 'Opened', 'Opening', url ? singleLine(url, 80) : 'a page');
    return label('browser', 'Used the browser', 'Using the browser', name.slice('browser_'.length));
  }
  if (name === 'session_finish') return label('other', 'Finished the session', 'Finishing the session', null);
  if (event.surface === 'chatgpt' && name === 'bio') return label('other', 'Updated memory', 'Updating memory', null);
  if (event.surface === 'chatgpt' && /^(web|search)/.test(name)) {
    // ChatGPT hides web queries; what it found or opened is in the result's sources.
    const sources = event.output.flatMap((part) => (part.type === 'sources' ? part.sources : []));
    const domains = [...new Set(sources.map((source) => source.domain))];
    const opened = sources.length > 0 && sources.every((source) => source.ref?.includes('view'));
    if (opened) return label('open', 'Opened', 'Opening', listOf(domains), false, [], sources.map((source) => source.url));
    return label('web', 'Searched the web', 'Searching the web', domains.length ? listOf(domains) : null, false, [], domains);
  }
  return label('other', 'Used', 'Using', name);
}

/** "Ran 5 commands, edited report.md": the finished calls of a group, phrase by phrase in first-seen order. */
export function summarizeTools(events: ToolEvent[]): string {
  const counts = new Map<ToolCategory, { calls: number; items: string[]; only: ToolLabel }>();
  for (const event of events) {
    const described = describeTool(event);
    const entry = counts.get(described.category) ?? { calls: 0, items: [], only: described };
    entry.calls += 1;
    for (const item of described.items) if (!entry.items.includes(item)) entry.items.push(item);
    counts.set(described.category, entry);
  }
  // Code-mode scripts are recorded next to the nested calls they make; those calls tell the story.
  if (counts.size > 1) counts.delete('script');
  const phrases: string[] = [];
  const counted = (calls: number, one: string, many: (n: number) => string) => (calls === 1 ? one : many(calls));
  const files = (verb: string, items: string[]) => (items.length === 1 ? `${verb} ${items[0]}` : items.length > 1 ? `${verb} ${items.length} files` : `${verb} a file`);
  // A single call of a kind reads best as itself: "started agent Reviewer", "opened example.com".
  const itself = (described: ToolLabel) => `${described.verb[0]!.toLowerCase()}${described.verb.slice(1)}${described.target ? ` ${described.target}` : ''}`;
  for (const [category, { calls, items, only }] of counts) {
    switch (category) {
      case 'command': phrases.push(counted(calls, 'ran a command', (n) => `ran ${n} commands`)); break;
      case 'script': phrases.push(counted(calls, 'ran a script', (n) => `ran ${n} scripts`)); break;
      case 'read': phrases.push(files('read', items)); break;
      case 'edit': phrases.push(files('edited', items)); break;
      case 'create': phrases.push(files('created', items)); break;
      case 'delete': phrases.push(files('deleted', items)); break;
      case 'search': phrases.push(counted(calls, itself(only), (n) => `searched ${n} times`)); break;
      case 'web': phrases.push(counted(calls, 'searched the web', (n) => `searched the web ${n} times`)); break;
      case 'open': phrases.push(counted(items.length || calls, 'opened a page', (n) => `opened ${n} pages`)); break;
      case 'plan': phrases.push('updated the plan'); break;
      case 'agent': phrases.push(counted(calls, itself(only), (n) => `used agents ${n} times`)); break;
      case 'browser': phrases.push(counted(calls, itself(only), (n) => `used the browser ${n} times`)); break;
      case 'image': phrases.push(counted(calls, 'viewed an image', (n) => `viewed ${n} images`)); break;
      case 'other': phrases.push(counted(calls, itself(only), (n) => `used ${n} tools`)); break;
    }
  }
  const text = phrases.join(', ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : 'Worked';
}

/** Lines added and removed across the edits of a group. */
export function diffTotals(events: ToolEvent[]): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let any = false;
  for (const event of events) {
    for (const part of event.output) {
      if (part.type !== 'diff') continue;
      any = true;
      added += part.added;
      removed += part.removed;
    }
  }
  return any ? { added, removed } : null;
}

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'gap';
  /** New-file line number for added and context lines, old-file number for removed lines. */
  line: number | null;
  text: string;
}

/** A unified diff as display rows with line numbers; file headers are dropped and hunks become gaps. */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let seenHunk = false;
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      if (seenHunk) rows.push({ kind: 'gap', line: null, text: '' });
      seenHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!seenHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) rows.push({ kind: 'add', line: newLine++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ kind: 'del', line: oldLine++, text: line.slice(1) });
    else {
      rows.push({ kind: 'ctx', line: newLine, text: line.slice(1) });
      oldLine++;
      newLine++;
    }
  }
  return rows;
}
