import { join } from 'node:path';
import { BrowserWindow, app, session } from 'electron';
import type { MainEvent, MainEvents } from '@shared/ipc';
import { flushWrites } from './core/durable';
import { createLogger, onLog, setLogFile } from './core/log';
import { resolvePaths } from './core/paths';
import { registerIpc } from './app/ipc';
import { createServices, type Services } from './app/services';
import { StateHub } from './app/state';
import { createMainWindow, createTray } from './app/window';

const log = createLogger('app');
app.setName('Chat on Creatine');
if (process.env.CREATINE_USER_DATA) app.setPath('userData', process.env.CREATINE_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start();
}

async function start(): Promise<void> {
  let services: Services | null = null;
  let window: BrowserWindow | null = null;
  const markQuitting = () => ((app as unknown as { quitting?: boolean }).quitting = true);

  const send = <E extends MainEvent>(event: E, payload: MainEvents[E]): void => {
    if (window && !window.isDestroyed()) window.webContents.send(event, payload);
  };
  const hub = new StateHub(() => services, send);

  app.on('second-instance', () => {
    window?.show();
    window?.focus();
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

  registerIpc(() => services, () => hub.snapshot(), (contents) => contents === window?.webContents);

  window = createMainWindow({ preloadDir, resourcesDir, closeToTray: () => services?.config.get().ui.closeToTray ?? false });
  createTray(resourcesDir, {
    show: () => {
      window?.show();
      window?.focus();
    },
    showChatGpt: () => services?.host.reveal(null),
    quit: () => {
      markQuitting();
      app.quit();
    }
  });

  await services.host.start();
  services.router.start();
  if (services.config.get().connection.autoConnect) void services.connection.connect();
  // Learn the account's models (and sign-in state) shortly after startup.
  setTimeout(() => {
    if (services?.host.status().signedIn) void services.models.refresh();
  }, 3_000);
  log.info(`started ${app.getVersion()} (userData ${paths.userData})`);

  let disposed = false;
  app.on('before-quit', (event) => {
    markQuitting();
    if (disposed || !services) return;
    event.preventDefault();
    disposed = true;
    void services
      .dispose()
      .catch((error: unknown) => log.error('shutdown failed', error))
      .then(() => flushWrites())
      .finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => {
    if (!services?.config.get().ui.closeToTray) app.quit();
  });
}
