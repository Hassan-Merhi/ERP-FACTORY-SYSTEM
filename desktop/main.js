const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const { createLocalMode } = require('./offline/localMode');

const APP_URL = 'https://www.hmdinternationalgroup.com';
const APP_NAME = 'ERP Warehouse';
const ICON_PATH = path.join(__dirname, 'icons', 'icon.ico');

let mainWindow = null;
let connectWindow = null;
let pendingConnect = null;

// Full offline mode: the PC's local copy (off unless enabled in offline-pc.json).
const localMode = createLocalMode({
  cloudUrl: APP_URL,
  onStatus: (event) => {
    if (event.event === 'login' && pendingConnect) {
      pendingConnect({ ok: event.ok === true });
      pendingConnect = null;
    }
    if (event.event === 'status') updateTitle();
  },
});

function updateTitle() {
  if (!mainWindow) return;
  const status = localMode.status();
  const onLocal = localMode.isLocalUrl(mainWindow.webContents.getURL());
  if (!onLocal && !status?.freshness?.warn) return mainWindow.setTitle(APP_NAME);
  const hours = status?.freshness?.hours;
  const age = hours == null ? 'never synced' : `last sync ${Math.floor(hours)}h ago`;
  mainWindow.setTitle(`${APP_NAME} — ${onLocal ? 'offline copy (read-only), ' : ''}${age}`);
}

function openConnectWindow() {
  if (connectWindow) return connectWindow.focus();
  connectWindow = new BrowserWindow({
    width: 420,
    height: 380,
    parent: mainWindow || undefined,
    title: 'Connect this PC',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'offline', 'connectPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  connectWindow.setMenu(null);
  connectWindow.loadFile(path.join(__dirname, 'offline', 'connect.html'));
  connectWindow.on('closed', () => {
    connectWindow = null;
  });
}

ipcMain.handle('offline-pc:connect', (event, { username, password } = {}) => {
  if (!connectWindow || event.sender !== connectWindow.webContents) return { ok: false };
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return { ok: false };
  if (!localMode.connect(username, password)) return { ok: false };
  return new Promise((resolve) => {
    pendingConnect = resolve;
    setTimeout(() => {
      if (pendingConnect === resolve) {
        pendingConnect = null;
        resolve({ ok: false });
      }
    }, 60_000);
  });
});

function createWindow() {
  const isDev = process.argv.includes('--dev');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: ICON_PATH,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (errorCode === -3) return;
    // An embedded frame that fails to load must not replace the running
    // application with the offline page; only a failed top-level load does.
    if (isMainFrame === false) return;
    // The cloud cannot be reached: open this PC's local copy when it is ready.
    if (localMode.ready() && !localMode.isLocalUrl(_validatedURL)) {
      mainWindow.loadURL(localMode.localUrl);
      return;
    }
    mainWindow.loadFile(path.join(__dirname, 'offline.html'));
    console.error('Page failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    // Compare full origins: a prefix check would also allow look-alike hosts
    // such as https://www.hmdinternationalgroup.com.example.net.
    if (parsed.origin === new URL(APP_URL).origin || localMode.isLocalUrl(url)) {
      return { action: 'allow' };
    }
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    updateTitle();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.webContents.reload(),
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow && mainWindow.webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: 'Alt+F4',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            if (mainWindow) {
              const factor = mainWindow.webContents.getZoomFactor();
              mainWindow.webContents.setZoomFactor(Math.min(factor + 0.1, 3.0));
            }
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            if (mainWindow) {
              const factor = mainWindow.webContents.getZoomFactor();
              mainWindow.webContents.setZoomFactor(Math.max(factor - 0.1, 0.5));
            }
          },
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow && mainWindow.webContents.setZoomFactor(1.0),
        },
        { type: 'separator' },
        {
          label: 'Toggle Fullscreen',
          accelerator: 'F11',
          click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()),
        },
      ],
    },
    ...(localMode.enabled
      ? [
          {
            label: 'Offline copy',
            submenu: [
              { label: 'Connect this PC…', click: openConnectWindow },
              { label: 'Sync now', click: () => localMode.syncNow() },
              {
                label: 'Open offline copy (read-only)',
                click: () => mainWindow && localMode.ready() && mainWindow.loadURL(localMode.localUrl),
              },
              { label: 'Back to the cloud', click: () => mainWindow && mainWindow.loadURL(APP_URL) },
            ],
          },
        ]
      : []),
    {
      label: 'Help',
      submenu: [
        {
          label: 'About ERP Warehouse',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About ERP Warehouse',
              message: 'ERP Warehouse',
              detail: `Version: ${app.getVersion()}\nHMD International Group\nhttps://www.hmdinternationalgroup.com`,
              icon: ICON_PATH,
            });
          },
        },
        {
          label: 'Open in Browser',
          click: () => shell.openExternal(APP_URL),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName(APP_NAME);

app.whenReady().then(() => {
  createWindow();
  localMode.start().catch((error) => console.error('Offline copy failed to start:', error && error.message));
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  localMode.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(navigationUrl);
    } catch {
      event.preventDefault();
      return;
    }
    const allowedHosts = ['www.hmdinternationalgroup.com', 'hmdinternationalgroup.com'];
    if (!allowedHosts.includes(parsedUrl.hostname) && !localMode.isLocalUrl(navigationUrl)) {
      event.preventDefault();
      if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
        shell.openExternal(navigationUrl);
      }
    }
  });
});
