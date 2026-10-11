import { startOpenAi } from './openai';
import { startCloudflared } from './cloudflared';
import type { TunnelHandle, TunnelOptions } from './types';

export async function startTunnel(opts: TunnelOptions): Promise<TunnelHandle> {
  switch (opts.adapter) {
    case 'manual':
      opts.report({
        state: 'connected',
        detail: 'Local server running. Expose it with your own tunnel and use the URL below.',
        publicUrl: null,
        handshakeAt: null
      });
      return { stop: async () => {} };
    case 'cloudflared':
      return startCloudflared(opts);
    case 'openai':
      return startOpenAi(opts);
  }
}
