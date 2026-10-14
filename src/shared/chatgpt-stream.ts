/**
 * Parser for ChatGPT's conversation stream (`text/event-stream`, "delta encoding v1") and for the
 * `GET /backend-api/conversation/<id>` payload. Environment-agnostic: runs in the page and in Node.
 */
import type { ChatMessage } from './page-protocol';
import type { Citation, WebSource } from './types';

type Obj = Record<string, unknown>;

const ROLES = new Set<ChatMessage['role']>(['user', 'assistant', 'tool', 'system']);

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Plain text of a content object: joined string parts, or the first text-bearing field. */
function contentText(content: Obj): string {
  if (Array.isArray(content.parts)) {
    return content.parts.filter((part): part is string => typeof part === 'string').join('');
  }
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (Array.isArray(content.thoughts)) {
    return content.thoughts
      .filter(isObj)
      .map((thought) => [str(thought.summary), str(thought.content)].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/** Bounds what one message can carry; a long research answer cites a few dozen pages at most. */
const MAX_SOURCES = 40;
const MAX_CITATIONS = 80;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** ChatGPT tags every outbound link with utm_source=chatgpt.com; the page is the same without it. */
function cleanUrl(url: string): string {
  return url.replace(/([?&])utm_source=chatgpt\.com(&|$)/, (_, lead: string, tail: string) => (tail ? lead : '')).replace(/[?&]$/, '');
}

function webSource(entry: Obj, ref: string | null, attribution: string | null): WebSource | null {
  const url = str(entry.url);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const clean = cleanUrl(url);
  return { title: (str(entry.title) ?? '').trim(), url: clean, domain: attribution?.trim() || hostOf(clean), ref };
}

/** `ref_id: { turn_index: 514763, ref_type: 'view', ref_index: 0 }` → `turn514763view0`, as markers spell it. */
function refOf(value: unknown): string | null {
  if (!isObj(value) || typeof value.turn_index !== 'number' || typeof value.ref_index !== 'number') return null;
  const type = str(value.ref_type);
  return type ? `turn${value.turn_index}${type}${value.ref_index}` : null;
}

/** Pages of `metadata.search_result_groups`: what a web tool call found or opened. */
function sourcesOf(metadata: Obj): WebSource[] {
  const sources: WebSource[] = [];
  for (const group of Array.isArray(metadata.search_result_groups) ? metadata.search_result_groups : []) {
    if (!isObj(group) || !Array.isArray(group.entries)) continue;
    for (const entry of group.entries) {
      if (!isObj(entry)) continue;
      const source = webSource(entry, refOf(entry.ref_id), null);
      if (source && sources.length < MAX_SOURCES) sources.push(source);
    }
  }
  return sources;
}

/** Citation markers of an answer (`metadata.content_references`) with the pages each one cites. */
function citationsOf(metadata: Obj): Citation[] {
  const citations: Citation[] = [];
  for (const reference of Array.isArray(metadata.content_references) ? metadata.content_references : []) {
    if (!isObj(reference)) continue;
    const marker = str(reference.matched_text);
    if (!marker || !marker.includes('\ue200') || citations.some((citation) => citation.marker === marker)) continue;
    const items = Array.isArray(reference.items) ? reference.items.filter(isObj) : [];
    const sources = items
      .map((item) => webSource(item, null, str(item.attribution)))
      .filter((source): source is WebSource => source !== null);
    if (sources.length && citations.length < MAX_CITATIONS) citations.push({ marker, sources });
  }
  return citations;
}

export function normalizeMessage(raw: unknown, conversationId: string): ChatMessage | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const author = isObj(raw.author) ? raw.author : {};
  const role = str(author.role) as ChatMessage['role'] | null;
  if (!id || !role || !ROLES.has(role)) return null;
  const content = isObj(raw.content) ? raw.content : {};
  const metadata = isObj(raw.metadata) ? raw.metadata : {};
  return {
    id,
    conversationId: str(raw.conversation_id) ?? conversationId,
    role,
    authorName: str(author.name),
    recipient: str(raw.recipient) ?? 'all',
    channel: str(raw.channel),
    contentType: str(content.content_type) ?? 'text',
    text: contentText(content),
    status: str(raw.status) ?? 'in_progress',
    endTurn: typeof raw.end_turn === 'boolean' ? raw.end_turn : null,
    model: str(metadata.model_slug) ?? str(metadata.default_model_slug),
    requestId: str(metadata.request_id),
    turnId: str(metadata.turn_exchange_id),
    parentId: str(metadata.parent_id),
    createTime: typeof raw.create_time === 'number' ? raw.create_time : null,
    hidden: metadata.is_visually_hidden_from_conversation === true,
    sources: sourcesOf(metadata),
    citations: citationsOf(metadata)
  };
}

interface StreamHandlers {
  message(m: ChatMessage): void;
  conversation?(id: string): void;
  title?(conversationId: string, title: string): void;
  complete?(): void;
  error?(text: string): void;
}

/** Decodes a JSON-pointer token (`~1` is `/`, `~0` is `~`). */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function pointerTokens(path: string): string[] {
  return path === '' ? [] : path.split('/').slice(1).map(unescapeToken);
}

function lookup(root: unknown, tokens: string[]): unknown {
  let node = root;
  for (const token of tokens) {
    if (Array.isArray(node)) {
      node = node[Number(token)];
    } else if (isObj(node)) {
      node = Object.hasOwn(node, token) ? node[token] : undefined;
    } else {
      return undefined;
    }
  }
  return node;
}

/**
 * Applies one stream operation to `root` and returns the (possibly replaced) root. Malformed or
 * missing paths are ignored: a stream must never break the parser.
 */
function applyOp(root: unknown, path: string, op: string, value: unknown): unknown {
  const tokens = pointerTokens(path);
  if (tokens.some((token) => token === '__proto__' || token === 'constructor' || token === 'prototype')) return root;
  if (tokens.length === 0) {
    switch (op) {
      case 'add':
      case 'replace':
        return value;
      case 'append':
        if (isObj(root) && isObj(value)) Object.assign(root, value);
        return root;
      case 'remove':
        return null;
      case 'patch':
        return applyPatch(root, path, value);
      default:
        return root;
    }
  }

  const parent = lookup(root, tokens.slice(0, -1));
  const key = tokens[tokens.length - 1]!;
  if (op === 'patch') return applyPatch(root, path, value);
  if (!Array.isArray(parent) && !isObj(parent)) return root;
  const list = Array.isArray(parent) ? parent : null;
  const index = list ? (key === '-' ? list.length : Number(key)) : NaN;
  const target = list ? list[index] : (parent as Obj)[key];

  switch (op) {
    case 'add':
      if (list) {
        if (Number.isInteger(index) && index >= 0 && index <= list.length) list.splice(index, 0, value);
      } else {
        (parent as Obj)[key] = value;
      }
      break;
    case 'replace':
      if (list) {
        if (Number.isInteger(index) && index >= 0 && index < list.length) list[index] = value;
      } else {
        (parent as Obj)[key] = value;
      }
      break;
    case 'remove':
      if (list) {
        if (Number.isInteger(index) && index >= 0 && index < list.length) list.splice(index, 1);
      } else {
        delete (parent as Obj)[key];
      }
      break;
    case 'append':
      if (target === undefined) {
        if (list) list.push(value);
        else (parent as Obj)[key] = value;
      } else if (typeof target === 'string' && typeof value === 'string') {
        if (list) list[index] = target + value;
        else (parent as Obj)[key] = target + value;
      } else if (Array.isArray(target)) {
        target.push(...(Array.isArray(value) ? value : [value]));
      } else if (isObj(target) && isObj(value)) {
        Object.assign(target, value);
      }
      break;
    case 'truncate':
      if (typeof target === 'string' && typeof value === 'number') {
        const cut = target.slice(0, value);
        if (list) list[index] = cut;
        else (parent as Obj)[key] = cut;
      } else if (Array.isArray(target) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        target.length = Math.min(target.length, value);
      }
      break;
  }
  return root;
}

function applyPatch(root: unknown, base: string, ops: unknown): unknown {
  if (!Array.isArray(ops)) return root;
  let next = root;
  for (const sub of ops) {
    if (!isObj(sub)) continue;
    next = applyOp(next, base + (str(sub.p) ?? ''), str(sub.o) ?? 'replace', sub.v);
  }
  return next;
}

/**
 * Incremental SSE parser for the conversation stream. Chunk boundaries may fall anywhere; the
 * current message is kept as a live envelope `{message, conversation_id, error}` that delta
 * operations mutate. A delta with omitted `p`/`o` reuses the previous delta's values.
 */
export class ConversationStreamParser {
  private buffer = '';
  private scanned = 0;
  private dataLines: string[] = [];
  private envelope: unknown = null;
  private lastPath = '';
  private lastOp = 'replace';
  private conversationId: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly handlers: StreamHandlers) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let start = 0;
    let scan = this.scanned;
    for (;;) {
      const at = this.findLineEnd(scan);
      if (at < 0) break;
      const ch = this.buffer[at];
      // A lone CR at the very end may be the first half of CRLF; wait for the next chunk.
      if (ch === '\r' && at === this.buffer.length - 1) break;
      const skip = ch === '\r' && this.buffer[at + 1] === '\n' ? 2 : 1;
      this.line(this.buffer.slice(start, at));
      start = at + skip;
      scan = start;
    }
    this.scanned = this.buffer.endsWith('\r') ? this.buffer.length - start - 1 : this.buffer.length - start;
    this.buffer = this.buffer.slice(start);
  }

  /** Flushes a final unterminated line and any pending event. Does not signal completion. */
  end(): void {
    if (this.buffer !== '') this.line(this.buffer);
    this.buffer = '';
    this.scanned = 0;
    this.dispatch();
  }

  private findLineEnd(from: number): number {
    for (let i = from; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === '\n' || ch === '\r') return i;
    }
    return -1;
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
  }

  private dispatch(): void {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    this.event(data);
  }

  private event(data: string): void {
    if (data === '[DONE]') {
      this.handlers.complete?.();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObj(parsed)) return;

    this.noteConversation(parsed.conversation_id);
    if (typeof parsed.type === 'string') {
      this.typedEvent(parsed);
      return;
    }
    if ('v' in parsed || 'o' in parsed || 'p' in parsed) this.delta(parsed);
  }

  private typedEvent(event: Obj): void {
    switch (event.type) {
      case 'input_message': {
        const message = normalizeMessage(event.input_message, this.conversationId ?? '');
        if (message) this.handlers.message(message);
        break;
      }
      case 'title_generation': {
        const title = str(event.title);
        if (title) this.handlers.title?.(this.conversationId ?? str(event.conversation_id) ?? '', title);
        break;
      }
      case 'message_stream_complete':
        this.handlers.complete?.();
        break;
      default:
        break;
    }
  }

  private noteConversation(value: unknown): void {
    const id = str(value);
    if (!id || id === this.conversationId) return;
    this.conversationId = id;
    this.handlers.conversation?.(id);
  }

  private delta(event: Obj): void {
    // A bare `{v}` continues the previous operation; an explicit `o` without `p` targets the root
    // (ChatGPT starts messages with `{"o":"add","v":{"message":…}}` right after text appends).
    if (typeof event.p === 'string') this.lastPath = event.p;
    else if (typeof event.o === 'string') this.lastPath = '';
    if (typeof event.o === 'string') this.lastOp = event.o;
    // A bare message envelope always starts the next message, whatever the previous operation was.
    if (event.p === undefined && event.o === undefined && isObj(event.v) && isObj(event.v.message)) {
      this.lastPath = '';
      this.lastOp = 'add';
    }
    this.envelope = applyOp(this.envelope, this.lastPath, this.lastOp, event.v);

    if (!isObj(this.envelope)) return;
    this.noteConversation(this.envelope.conversation_id);
    const error = this.envelope.error;
    if (error && error !== this.lastError) {
      this.lastError = typeof error === 'string' ? error : JSON.stringify(error);
      this.handlers.error?.(this.lastError);
    }
    const message = normalizeMessage(
      this.envelope.message,
      this.conversationId ?? str(this.envelope.conversation_id) ?? ''
    );
    if (message) this.handlers.message(message);
  }
}

/**
 * Messages of a `GET /backend-api/conversation/<id>` payload on the current branch, oldest first.
 * Hidden system messages and nodes without content are skipped.
 */
export function conversationToMessages(json: unknown): ChatMessage[] {
  if (!isObj(json) || !isObj(json.mapping)) return [];
  const mapping = json.mapping;
  const conversationId = str(json.conversation_id) ?? '';
  const path: ChatMessage[] = [];
  const seen = new Set<string>();
  let nodeId = str(json.current_node);
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!isObj(node)) break;
    const message = isObj(node.message) ? normalizeMessage(node.message, conversationId) : null;
    if (message && !(message.hidden && message.role === 'system')) path.push(message);
    nodeId = str(node.parent);
  }
  return path.reverse();
}
