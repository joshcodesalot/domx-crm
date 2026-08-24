const path = require('path');
const { app, BrowserWindow } = require('electron');
const { applyWebContentsGuards } = require('./webContentsGuards');
const { attachActivityKeyListener } = require('./activityKeyListener');

const isDev = !app.isPackaged;

/** @type {Map<string, import('electron').BrowserWindow>} */
const windowsByRoute = new Map();

function normalizePlatform(platform) {
  if (platform === '4based') return '4based';
  if (platform === 'telegram') return 'telegram';
  return 'maloum';
}

function routeForPlatform(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === '4based') return '/message-pro/4based';
  if (normalized === 'telegram') return '/message-pro/telegram';
  return '/message-pro';
}

function titleForPlatform(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === '4based') return 'DomX Message Pro (4based)';
  if (normalized === 'telegram') return 'DomX Message Pro (Telegram)';
  return 'DomX Message Pro';
}

function getMessageProWindow(platform = 'maloum') {
  const route = routeForPlatform(platform);
  const win = windowsByRoute.get(route);
  return win && !win.isDestroyed() ? win : null;
}

function getAppLoadTarget(route) {
  if (isDev) {
    return { type: 'url', value: `http://localhost:5173/#${route}` };
  }
  return {
    type: 'file',
    value: path.join(__dirname, '../dist/index.html'),
    hash: route,
  };
}

function openMessageProWindow(platform = 'maloum') {
  const route = routeForPlatform(platform);
  const existing = getMessageProWindow(platform);
  if (existing) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
    return { opened: true, focused: true, route };
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: titleForPlatform(platform),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  applyWebContentsGuards(win.webContents);
  attachActivityKeyListener(win.webContents);
  windowsByRoute.set(route, win);

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    const current = windowsByRoute.get(route);
    if (current === win) {
      windowsByRoute.delete(route);
    }
  });

  const target = getAppLoadTarget(route);
  if (target.type === 'url') {
    void win.loadURL(target.value);
  } else {
    void win.loadFile(target.value, { hash: target.hash });
  }

  return { opened: true, focused: false, route };
}

function closeMessageProWindow(platform) {
  if (platform) {
    const win = getMessageProWindow(platform);
    if (!win) {
      return { closed: false };
    }
    try {
      win.close();
    } catch {
      // Best-effort close.
    }
    windowsByRoute.delete(routeForPlatform(platform));
    return { closed: true };
  }

  let closedAny = false;
  for (const [route, win] of windowsByRoute.entries()) {
    if (!win || win.isDestroyed()) {
      windowsByRoute.delete(route);
      continue;
    }
    try {
      win.close();
      closedAny = true;
    } catch {
      // Best-effort close.
    }
  }
  windowsByRoute.clear();
  return { closed: closedAny };
}

module.exports = {
  openMessageProWindow,
  closeMessageProWindow,
  getMessageProWindow,
};
