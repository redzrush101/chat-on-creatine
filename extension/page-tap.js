(() => {
  // src/page/tap.ts
  function installFetchTap(channel) {
    const flag = `__chatOnCreatineTap_${channel}`;
    const host = window;
    if (host[flag]) return;
    host[flag] = true;
    const original = window.fetch;
    const endsWithConversation = (pathname) => pathname.endsWith("/backend-api/f/conversation") || pathname.endsWith("/backend-api/conversation");
    const post = (payload) => {
      try {
        window.postMessage({ channel, ...payload }, location.origin);
      } catch {
      }
    };
    const pump = async (body, streamId, requestId) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          post({ kind: "chunk", streamId, requestId, chunk: decoder.decode(value, { stream: true }) });
        }
        post({ kind: "chunk", streamId, requestId, chunk: decoder.decode() });
        post({ kind: "end", streamId, requestId });
      } catch (error) {
        post({
          kind: "error",
          streamId,
          requestId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };
    const tapped = async function(input, init) {
      const response = await original.call(window, input, init);
      try {
        const rawUrl = input instanceof Request ? input.url : String(input);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const pathname = new URL(rawUrl, location.href).pathname;
        if (method !== "POST" || !endsWithConversation(pathname) || !response.body) return response;
        const [forPage, forTap] = response.body.tee();
        const streamId = crypto.randomUUID();
        const requestId = response.headers.get("x-oai-request-id");
        post({ kind: "start", streamId, requestId, status: response.status });
        void pump(forTap, streamId, requestId);
        return new Response(forPage, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers)
        });
      } catch {
        return response;
      }
    };
    window.fetch = tapped;
  }

  // page-tap-entry.ts
  installFetchTap("creatine-tap");
})();
