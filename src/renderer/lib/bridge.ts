import type { MainEvent, MainEvents, PreloadBridge, RendererApi, RendererChannel } from '@shared/ipc';

declare global {
  interface Window {
    creatine?: PreloadBridge;
  }
}

function missingBridge(): PreloadBridge {
  return {
    invoke: ((channel: RendererChannel) =>
      Promise.reject(new Error(`No app bridge (channel ${channel}); open the UI inside Electron`))) as PreloadBridge['invoke'],
    on: () => () => {}
  };
}

const bridge: PreloadBridge = window.creatine ?? missingBridge();

export function invoke<C extends RendererChannel>(channel: C, ...args: Parameters<RendererApi[C]>): Promise<Awaited<ReturnType<RendererApi[C]>>> {
  return bridge.invoke(channel, ...args);
}

export function subscribe<E extends MainEvent>(event: E, listener: (payload: MainEvents[E]) => void): () => void {
  return bridge.on(event, listener);
}
