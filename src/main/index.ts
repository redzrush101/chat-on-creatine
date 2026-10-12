import { join } from 'node:path';
import { BrowserWindow, app, session } from 'electron';
import type { MainEvent, MainEvents } from '@shared/ipc';
import { flushWrites } from './core/durable';
import { createLogger, onLog, setLogFile } from './core/log';
import { resolvePaths } from './core/paths';
import { registerIpc } from './app/ipc';
import { createApi } from './app/api';
import { FrontendServer } from './app/frontend-server';
import { createServices, type Services } from './app/services';
import { StateHub } from './app/state';
import { createMainWindow } from './app/window';

const log = createLogger('app');
const headless = process.argv.includes('--creatine-headless');
app.setName('Chat on Creatine');
// Frontend lifetimes decide when to quit; Electron must not quit on the last GUI window alone.
app.on('window-all-closed', () => {});
// Electron picks plain-text secret storage on desktops it does not recognise (Hyprland, Sway…);
// ask for the Secret Service keyring explicitly unless the user chose a store.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store')) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}
if (process.env.CREATINE_USER_DATA) app.setPath('userData', process.env.CREATINE_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start().catch((error: unknown) => { log.error('startup failed', error); app.exit(1); });
}

async function start(): Promise<void> {
  let services: Services | null = null;
  let window: BrowserWindow | null = null;
  let frontend: FrontendServer | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let quitting = false;
  const markQuitting = () => { quitting = true; };

  const send = <E extends MainEvent>(event: E, payload: MainEvents[E]): void => {
    if (window && !window.isDestroyed()) window.webContents.send(event, payload);
    frontend?.broadcast(event, payload);
  };
  const hub = new StateHub(() => services, send);

  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--creatine-headless')) show();
  });

  await app.whenReady();
  const paths = resolvePaths(app.getPath('userData'));
  setLogFile(join(paths.logs, 'main.log'));
  onLog((entry) => send('log', entry));

  const preloadDir = join(__dirname, '../preload');
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
  const resourcesBin = join(resourcesDir, 'bin');

  // The app's own pages need no permissions at all.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  services = createServices(paths, preloadDir, resourcesBin, {
    version: app.getVersion(),
    changed: () => hub.changed(),
    terminalData: (terminalId, data) => send('terminal:data', { terminalId, data }),
    terminalExit: (terminalId, code) => send('terminal:exit', { terminalId, code })
  });
  services.store.onEvents((sessionId, events) => hub.events(sessionId, events));
  // Test harnesses drive the running app through the main-process inspector.
  if (process.env.CREATINE_DEBUG_GLOBAL) (globalThis as { creatine?: Services }).creatine = services;

  const api = createApi(() => services, () => hub.snapshot(), { show, quit: () => app.quit() });
  registerIpc(api, (contents) => contents === window?.webContents);

  await services.host.start();
  services.router.start();
  if (services.config.get().connection.autoConnect) void services.connection.connect();
  frontend = new FrontendServer(join(paths.state, 'frontend.json'), api, (count) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = count === 0 && !window ? setTimeout(() => app.quit(), 3000) : null;
  });
  await frontend.start();
  if (headless) idleTimer = setTimeout(() => app.quit(), 60_000);
  else show();
  log.info(`started ${app.getVersion()} (userData ${paths.userData})`);

  let disposed = false;
  app.on('before-quit', (event) => {
    markQuitting();
    if (disposed || !services) return;
    event.preventDefault();
    disposed = true;
    if (idleTimer) clearTimeout(idleTimer);
    void Promise.resolve(frontend?.close())
      .then(() => services!.dispose())
      .catch((error: unknown) => log.error('shutdown failed', error))
      .then(() => flushWrites())
      .finally(() => app.exit(0));
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());

  function show(): void {
    if (!services) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (!window || window.isDestroyed()) {
      window = createMainWindow({
        preloadDir: join(__dirname, '../preload'),
        resourcesDir: app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'),
        isQuitting: () => quitting, closeToTray: () => services?.config.get().ui.closeToTray ?? false,
        showChatGpt: () => services?.host.reveal(null),
        quit: () => app.quit(),
        closed: () => {
          window = null;
          if (!frontend?.clientCount) app.quit();
        }
      });
    }
    window.show();
    window.focus();
  }
}
