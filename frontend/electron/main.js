const path = require('path');
const fs = require('fs');

function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing env files in local development.
  }
}

loadEnvFile(path.join(__dirname, '../.env'));
loadEnvFile(path.join(__dirname, '../../backend/.env'));

const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { initializeAppPaths } = require('./app-paths');

initializeAppPaths();

const creatorBrowser = require('./creatorBrowser');
const { registerCreatorIpc } = require('./ipc/creator');
const {
  registerUpdaterIpc,
  runInitialUpdateCheck,
  startUpdateChecks,
} = require('./ipc/updater');
const { applyWebContentsGuards } = require('./webContentsGuards');

const isDev = !app.isPackaged;

let mainWindow = null;

function getMainWindow() {
  return mainWindow;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1366,
    minHeight: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'DomX',
    show: false,
  });

  applyWebContentsGuards(win.webContents);

  creatorBrowser.setMainWindow(win);

  win.on('closed', () => {
    creatorBrowser.setMainWindow(null);
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.on('resize', () => {
    win.webContents.send('creator:window-resized');
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
}

async function bootstrap() {
  Menu.setApplicationMenu(null);
  registerCreatorIpc();
  registerUpdaterIpc(ipcMain);

  if (!isDev) {
    await runInitialUpdateCheck();
  }

  mainWindow = createWindow();
  startUpdateChecks(getMainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      startUpdateChecks(getMainWindow);
    }
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
