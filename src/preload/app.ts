import { contextBridge, ipcRenderer } from 'electron';
import { MAIN_EVENTS, RENDERER_CHANNELS, type PreloadBridge } from '@shared/ipc';

const channels = new Set<string>(RENDERER_CHANNELS);
const events = new Set<string>(MAIN_EVENTS);

const bridge: PreloadBridge = {
  invoke: (channel, ...args) => {
    if (!channels.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (event, listener) => {
    if (!events.has(event)) throw new Error(`Unknown event ${event}`);
    const handler = (_: unknown, payload: unknown) => listener(payload as never);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  }
};

contextBridge.exposeInMainWorld('creatine', bridge);
