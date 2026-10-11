import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron';

interface WindowOptions {
  preloadDir: string;
  resourcesDir: string;
  closeToTray: () => boolean;
  isQuitting: () => boolean;
}

/** The app's own window: loads the renderer, refuses navigation, opens links externally. */
export function createMainWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Chat on Creatine',
    backgroundColor: '#0f1012',
    icon: join(options.resourcesDir, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(options.preloadDir, 'app.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.on('close', (event) => {
    if (!options.isQuitting() && options.closeToTray()) {
      event.preventDefault();
      window.hide();
    }
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  return window;
}

export function createTray(resourcesDir: string, actions: { show(): void; showChatGpt(): void; quit(): void }): Tray | null {
  try {
    const tray = new Tray(nativeImage.createFromPath(join(resourcesDir, 'tray.png')));
    tray.setToolTip('Chat on Creatine');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Chat on Creatine', click: actions.show },
        { label: 'Show ChatGPT window', click: actions.showChatGpt },
        { type: 'separator' },
        { label: 'Quit', click: actions.quit }
      ])
    );
    tray.on('click', actions.show);
    return tray;
  } catch {
    // Desktops without a status area: closing the window then quits instead.
    return null;
  }
}
