// Self-contained: serialized with toString() for executeInMainWorld, so no outer-scope references.
export function installFetchTap(channel: string): void {
  const flag = `__chatOnCreatineTap_${channel}`;
  if (Reflect.get(window, flag)) return;
  Reflect.set(window, flag, true);

  const original = window.fetch;
  const endsWithConversation = (pathname: string): boolean =>
    pathname.endsWith('/backend-api/f/conversation') || pathname.endsWith('/backend-api/conversation');

  const post = (payload: Record<string, unknown>): void => {
    try {
      window.postMessage({ channel, ...payload }, location.origin);
    } catch {
      // The page must never see a tap failure.
    }
  };

  const pump = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    streamId: string,
    requestId: string | null
  ): Promise<void> => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        post({ kind: 'chunk', streamId, requestId, chunk: decoder.decode(value, { stream: true }) });
      }
      post({ kind: 'chunk', streamId, requestId, chunk: decoder.decode() });
      post({ kind: 'end', streamId, requestId });
    } catch (error) {
      // The page cancelling its own request (the Stop button) is an end, not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') {
        post({ kind: 'end', streamId, requestId });
        return;
      }
      post({
        kind: 'error',
        streamId,
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const tapped = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const response = await original.call(window, input, init);
    try {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const pathname = new URL(rawUrl, location.href).pathname;
      if (method !== 'POST' || !endsWithConversation(pathname) || !response.body) return response;

      const forTap = response.clone().body!.getReader();
      const body = response.body;
      // A clone's tee waits for both branches; observing must not hold up native cancellation.
      const cancelTap = (reason?: unknown): void => {
        void forTap.cancel(reason).catch(() => {
          // Observer errors must not change the page's own cancellation result.
        });
      };
      const cancelBody = body.cancel.bind(body);
      body.cancel = (reason?: unknown) => { cancelTap(reason); return cancelBody(reason); };
      const getReader = body.getReader.bind(body);
      Object.defineProperty(body, 'getReader', { configurable: true, writable: true, value: (options?: ReadableStreamGetReaderOptions) => {
        const reader = getReader(options);
        const cancelReader = reader.cancel.bind(reader);
        reader.cancel = (reason?: unknown) => { cancelTap(reason); return cancelReader(reason); };
        return reader;
      } });
      const streamId = crypto.randomUUID();
      const requestId = response.headers.get('x-oai-request-id');
      post({ kind: 'start', streamId, requestId, status: response.status });
      void pump(forTap, streamId, requestId);
      return response;
    } catch {
      return response;
    }
  };

  window.fetch = tapped as typeof window.fetch;
}
