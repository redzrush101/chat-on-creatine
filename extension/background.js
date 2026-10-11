// Service worker: the bridge between the app's WebSocket and the ChatGPT tabs it opened.
// Frames are JSON objects with a `type`; see src/main/chatgpt/extension-host.ts for the protocol.

const DEFAULT_PORT = 8765;
const MAX_BACKOFF_MS = 30_000;
const WAKE_ALARM = 'creatine-wake';
const DRIVER_PORT = 'creatine-driver';

/** tabId -> { url, loading } for tabs the app opened. Mirrored to session storage for worker restarts. */
const managed = new Map();
/** tabId -> runtime port of the driver running in that tab. */
const ports = new Map();
/** command id -> tabId, for commands sent to a page and not yet answered. */
const inflight = new Map();

let socket = null;
let connecting = false;
let authed = false;
let backoff = 1000;
let reconnectTimer = null;
let lastError = null;

const restored = chrome.storage.session.get('managed').then(({ managed: saved = {} }) => {
  for (const [tabId, entry] of Object.entries(saved)) managed.set(tabId, entry);
});

function persist() {
  return chrome.storage.session.set({ managed: Object.fromEntries(managed) });
}

async function settings() {
  const { port = DEFAULT_PORT, token = null } = await chrome.storage.local.get(['port', 'token']);
  return { port, token };
}

function sendFrame(frame) {
  if (!authed || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function reply(id, result) {
  sendFrame({ type: 'result', id, result });
}

async function sendTabs() {
  await restored;
  sendFrame({
    type: 'tabs',
    tabs: [...managed].map(([tabId, entry]) => ({ tabId, url: entry.url, loading: entry.loading }))
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

async function connect() {
  if (socket || connecting) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  try {
    const { port, token } = await settings();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', token, pair: token === null }));
    };
    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      void onFrame(frame);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      authed = false;
      inflight.clear();
      scheduleReconnect();
    };
  } finally {
    connecting = false;
  }
}

function dropConnection() {
  const ws = socket;
  socket = null;
  authed = false;
  ws?.close();
}

async function onFrame(frame) {
  if (frame.type === 'hello') {
    if (!frame.ok) {
      lastError = frame.error;
      dropConnection();
      return;
    }
    if (frame.token) await chrome.storage.local.set({ token: frame.token });
    authed = true;
    lastError = null;
    backoff = 1000;
    void sendTabs();
    for (const port of ports.values()) port.postMessage({ type: 'replay' });
    return;
  }
  if (!authed) return;
  const result = await handleRequest(frame);
  if (result) reply(frame.id, result);
}

/** Returns the result to send back, or null when the page answers later. */
async function handleRequest(frame) {
  try {
    switch (frame.type) {
      case 'tab-open': {
        const tab = await chrome.tabs.create({ url: frame.url, active: frame.reveal === true });
        managed.set(String(tab.id), { url: frame.url, loading: true });
        await persist();
        void sendTabs();
        return { ok: true, value: { tabId: String(tab.id) } };
      }
      case 'tab-navigate':
        requireManaged(frame.tabId);
        await chrome.tabs.update(Number(frame.tabId), { url: frame.url });
        return { ok: true };
      case 'tab-close':
        await chrome.tabs.remove(Number(frame.tabId)).catch(() => {});
        return { ok: true };
      case 'tab-reveal': {
        requireManaged(frame.tabId);
        const tab = await chrome.tabs.update(Number(frame.tabId), { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }
      case 'command': {
        const port = ports.get(frame.tabId);
        if (!port) return { ok: false, code: 'not-ready', error: 'ChatGPT page is not attached' };
        inflight.set(frame.id, frame.tabId);
        try {
          port.postMessage({ type: 'command', id: frame.id, command: frame.command });
        } catch {
          inflight.delete(frame.id);
          return { ok: false, code: 'not-ready', error: 'ChatGPT page is not attached' };
        }
        return null;
      }
      default:
        return { ok: false, code: 'failed', error: `unknown request ${frame.type}` };
    }
  } catch (error) {
    return { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

function requireManaged(tabId) {
  if (!managed.has(tabId)) throw new Error('tab is not managed by the bridge');
}

/** Fails commands waiting on a page that went away, so the app does not wait for its timeout. */
function failInflight(tabId, error) {
  for (const [id, owner] of inflight) {
    if (owner !== tabId) continue;
    inflight.delete(id);
    reply(id, { ok: false, code: 'not-ready', error });
  }
}

function onPageMessage(tabId, message) {
  if (message.type === 'event') {
    sendFrame({ type: 'page-event', tabId, event: message.event });
  } else if (message.type === 'result' && inflight.has(message.id)) {
    inflight.delete(message.id);
    reply(message.id, message.result);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== DRIVER_PORT || !port.sender?.tab) return;
  const tabId = String(port.sender.tab.id);
  void restored.then(() => {
    if (!managed.has(tabId)) {
      port.postMessage({ type: 'detach' });
      port.disconnect();
      return;
    }
    ports.set(tabId, port);
    port.onMessage.addListener((message) => onPageMessage(tabId, message));
    port.onDisconnect.addListener(() => {
      if (ports.get(tabId) !== port) return;
      ports.delete(tabId);
      failInflight(tabId, 'ChatGPT page went away');
    });
    // The page may have said hello before this worker knew the tab; ask it again.
    port.postMessage({ type: 'replay' });
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  await restored;
  const entry = managed.get(String(tabId));
  if (!entry || (change.url === undefined && change.status === undefined)) return;
  if (change.url !== undefined) entry.url = change.url;
  if (change.status !== undefined) entry.loading = change.status === 'loading';
  await persist();
  void sendTabs();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await restored;
  const id = String(tabId);
  ports.delete(id);
  if (!managed.delete(id)) return;
  await persist();
  sendFrame({ type: 'tab-closed', tabId: id });
});

chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WAKE_ALARM) void connect();
});

// Popup: status, port and re-pairing.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message.type === 'status') {
      const { port, token } = await settings();
      sendResponse({ port, paired: token !== null, connected: authed, error: lastError });
    } else if (message.type === 'set-port') {
      await chrome.storage.local.set({ port: Number(message.port) });
      dropConnection();
      backoff = 1000;
      void connect();
      sendResponse({ ok: true });
    } else if (message.type === 'repair') {
      await chrome.storage.local.remove('token');
      dropConnection();
      backoff = 1000;
      void connect();
      sendResponse({ ok: true });
    }
  })();
  return true;
});

void connect();
