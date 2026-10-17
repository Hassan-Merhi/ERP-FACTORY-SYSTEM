const { app, BrowserWindow, Menu, shell, dialog, nativeTheme } = require('electron');
const path = require('path');

const APP_URL = 'https://www.hmdinternationalgroup.com';
const APP_NAME = 'ERP Warehouse';
const ICON_PATH = path.join(__dirname, 'icons', 'icon.ico');

let mainWindow = null;

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

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (errorCode === -3) return;
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
    if (parsed.origin === new URL(APP_URL).origin) {
      return { action: 'allow' };
    }
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(APP_NAME);
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    const allowedHosts = ['www.hmdinternationalgroup.com', 'hmdinternationalgroup.com'];
    if (!allowedHosts.includes(parsedUrl.hostname)) {
      event.preventDefault();
      if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
        shell.openExternal(navigationUrl);
      }
    }
  });
});
