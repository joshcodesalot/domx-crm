const path = require('path');
const { app, BrowserWindow } = require('electron');
const { applyWebContentsGuards } = require('./webContentsGuards');

const isDev = !app.isPackaged;

let messageProWindow = null;

function getMessageProWindow() {
  return messageProWindow && !messageProWindow.isDestroyed() ? messageProWindow : null;
}

function getAppLoadTarget() {
  if (isDev) {
    return { type: 'url', value: 'http://localhost:5173/#/message-pro' };
  }
  return {
    type: 'file',
    value: path.join(__dirname, '../dist/index.html'),
    hash: '/message-pro',
  };
}

function openMessageProWindow() {
  const existing = getMessageProWindow();
  if (existing) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
    return { opened: true, focused: true };
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'DomX Message Pro',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  applyWebContentsGuards(win.webContents);
  messageProWindow = win;

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    if (messageProWindow === win) {
      messageProWindow = null;
    }
  });

  const target = getAppLoadTarget();
  if (target.type === 'url') {
    void win.loadURL(target.value);
  } else {
    void win.loadFile(target.value, { hash: target.hash });
  }

  return { opened: true, focused: false };
}

function closeMessageProWindow() {
  const win = getMessageProWindow();
  if (!win) {
    messageProWindow = null;
    return { closed: false };
  }

  try {
    win.close();
  } catch {
    // Best-effort close.
  }
  messageProWindow = null;
  return { closed: true };
}

module.exports = {
  openMessageProWindow,
  closeMessageProWindow,
  getMessageProWindow,
};
