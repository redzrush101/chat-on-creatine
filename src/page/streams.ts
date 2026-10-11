import { ConversationStreamParser } from '@shared/chatgpt-stream';
import type { ChatMessage, PageEvent, SendValue } from '@shared/page-protocol';

const MESSAGE_INTERVAL_MS = 100;

export interface TapMessage {
  channel: string;
  kind: 'start' | 'chunk' | 'end' | 'error';
  streamId: string;
  requestId?: string | null;
  chunk?: string;
  error?: string;
}

interface Stream {
  id: string;
  parser: ConversationStreamParser;
  conversationId: string | null;
  complete: boolean;
  error: string | null;
  lastEmit: Map<string, number>;
  pending: Map<string, ChatMessage>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class StreamRelay {
  private readonly streams = new Map<string, Stream>();
  private readonly startWaiters = new Set<(value: SendValue) => void>();

  constructor(private readonly emit: (event: PageEvent) => void, private readonly conversationId: () => string | null) {}

  handle(data: TapMessage): void {
    switch (data.kind) {
      case 'start':
        this.openStream(data.streamId, data.requestId ?? null);
        break;
      case 'chunk':
        this.streams.get(data.streamId)?.parser.push(data.chunk ?? '');
        break;
      case 'end':
        this.streams.get(data.streamId)?.parser.end();
        this.closeStream(data.streamId, null);
        break;
      case 'error':
        this.streams.get(data.streamId)?.parser.end();
        this.closeStream(data.streamId, data.error ?? 'stream failed');
        break;
    }
  }

  /** No conversation stream is open in this page. */
  idle(): boolean {
    return this.streams.size === 0;
  }

  waitForStart(ms: number): Promise<SendValue | null> {
    return new Promise((resolve) => {
      const waiter = (value: SendValue): void => done(value);
      const done = (value: SendValue | null): void => {
        clearTimeout(timer);
        this.startWaiters.delete(waiter);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), ms);
      this.startWaiters.add(waiter);
    });
  }

  private queueMessage(stream: Stream, message: ChatMessage): void {
    const now = Date.now();
    const last = stream.lastEmit.get(message.id) ?? 0;
    if (message.status !== 'in_progress' || now - last >= MESSAGE_INTERVAL_MS) {
      stream.pending.delete(message.id);
      stream.lastEmit.set(message.id, now);
      this.emit({ type: 'message', streamId: stream.id, message });
      return;
    }
    stream.pending.set(message.id, message);
    stream.timer ??= setTimeout(() => this.flushMessages(stream), MESSAGE_INTERVAL_MS - (now - last));
  }

  private flushMessages(stream: Stream): void {
    stream.timer = null;
    const now = Date.now();
    for (const [id, message] of stream.pending) {
      stream.lastEmit.set(id, now);
      this.emit({ type: 'message', streamId: stream.id, message });
    }
    stream.pending.clear();
  }

  private openStream(streamId: string, requestId: string | null): void {
    const stream: Stream = {
      id: streamId,
      conversationId: this.conversationId(),
      complete: false,
      error: null,
      lastEmit: new Map(),
      pending: new Map(),
      timer: null,
      parser: new ConversationStreamParser({
        message: (message) => this.queueMessage(stream, message),
        conversation: (id) => {
          stream.conversationId = id;
        },
        title: (conversationId, title) => this.emit({ type: 'title', conversationId, title }),
        complete: () => {
          stream.complete = true;
        },
        error: (text) => {
          stream.error = text;
        }
      })
    };
    this.streams.set(streamId, stream);
    this.emit({ type: 'turn-start', streamId, conversationId: stream.conversationId, requestId });
    for (const waiter of [...this.startWaiters]) waiter({ conversationId: stream.conversationId, streamId });
  }

  private closeStream(streamId: string, error: string | null): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    if (stream.timer) clearTimeout(stream.timer);
    this.flushMessages(stream);
    const outcome = stream.complete ? 'complete' : error || stream.error ? 'error' : 'aborted';
    this.emit({
      type: 'turn-end',
      streamId,
      conversationId: stream.conversationId,
      outcome,
      error: error ?? stream.error
    });
  }
}
