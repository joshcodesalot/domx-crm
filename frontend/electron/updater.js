const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const UPDATE_FEED_URL = 'https://domx.low7labs.cloud/crm-updates/';
const UPDATE_JSON_URL = `${UPDATE_FEED_URL.replace(/\/$/, '')}/latest.json`;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30 * 1000;

let getMainWindow = () => null;
let checkIntervalId = null;
let windowsListenersAttached = false;

const state = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: 0,
  error: null,
  macDownloadUrl: null,
  blocked: false,
};

function isUpdateBlocked() {
  return state.blocked;
}

function getUpdaterState() {
  return {
    status: state.status,
    currentVersion: state.currentVersion,
    availableVersion: state.availableVersion,
    progress: state.progress,
    error: state.error,
    macDownloadUrl: state.macDownloadUrl,
    blocked: state.blocked,
    platform: process.platform,
    updaterEnabled: app.isPackaged,
  };
}

function sendToRenderer(channel, payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function isNewerVersion(available, current) {
  const a = String(available).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const c = String(current).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, c.length);

  for (let index = 0; index < length; index += 1) {
    const av = a[index] || 0;
    const cv = c[index] || 0;
    if (av > cv) return true;
    if (av < cv) return false;
  }

  return false;
}

function enterBlockedState(info = {}) {
  state.blocked = true;
  state.status = info.downloading ? 'downloading' : info.ready ? 'ready' : 'blocked';
  state.availableVersion = info.version || state.availableVersion;
  state.macDownloadUrl = info.macDownloadUrl || state.macDownloadUrl;
  state.progress = info.progress ?? state.progress;

  const creatorBrowser = require('./creatorBrowser');
  creatorBrowser.hideAllBrowserViewsForUpdate();

  sendToRenderer('updater:blocked', getUpdaterState());

  if (info.version) {
    sendToRenderer('updater:available', getUpdaterState());
  }
}

function setReadyState() {
  state.status = 'ready';
  state.progress = 100;
  sendToRenderer('updater:ready', getUpdaterState());
}

function setCheckingState() {
  state.status = 'checking';
  state.error = null;
  sendToRenderer('updater:checking', getUpdaterState());
}

function setIdleState() {
  state.status = 'idle';
  state.blocked = false;
  state.availableVersion = null;
  state.progress = 0;
  state.error = null;
  state.macDownloadUrl = null;
}

function setErrorState(error) {
  state.status = 'error';
  state.error = error?.message || String(error);
  sendToRenderer('updater:error', getUpdaterState());
}

function attachWindowsUpdaterListeners() {
  if (windowsListenersAttached) {
    return;
  }

  windowsListenersAttached = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    setCheckingState();
  });

  autoUpdater.on('update-available', (info) => {
    enterBlockedState({
      version: info.version,
      downloading: true,
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (!state.blocked) {
      setIdleState();
      sendToRenderer('updater:not-available', getUpdaterState());
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    state.status = 'downloading';
    state.progress = Math.round(progress.percent || 0);
    sendToRenderer('updater:download-progress', getUpdaterState());
  });

  autoUpdater.on('update-downloaded', () => {
    setReadyState();
  });

  autoUpdater.on('error', (error) => {
    if (state.blocked) {
      setErrorState(error);
      return;
    }

    console.error('[updater] check failed:', error);
    setIdleState();
    sendToRenderer('updater:error', getUpdaterState());
  });
}

function checkWindowsUpdate() {
  attachWindowsUpdaterListeners();

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('error', onError);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onNotAvailable = () => finish({ available: false });
    const onAvailable = (info) => finish({ available: true, info });
    const onError = (error) => finish({ available: false, error });

    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('error', onError);

    autoUpdater.checkForUpdates().catch(onError);

    setTimeout(() => {
      finish({ available: false, error: new Error('Update check timed out') });
    }, CHECK_TIMEOUT_MS);
  });
}

async function checkMacUpdate() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(UPDATE_JSON_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Update feed returned ${response.status}`);
    }

    const manifest = await response.json();
    const latestVersion = manifest?.version;
    if (!latestVersion || !isNewerVersion(latestVersion, app.getVersion())) {
      return { available: false };
    }

    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const macDownloadUrl = manifest?.downloads?.mac?.[arch]?.url || null;

    return {
      available: true,
      version: latestVersion,
      macDownloadUrl,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runUpdateCheck() {
  if (!app.isPackaged) {
    return { available: false };
  }

  setCheckingState();

  try {
    if (process.platform === 'darwin') {
      const result = await checkMacUpdate();
      if (result.available) {
        enterBlockedState({
          version: result.version,
          macDownloadUrl: result.macDownloadUrl,
          ready: true,
        });
      } else if (!state.blocked) {
        setIdleState();
        sendToRenderer('updater:not-available', getUpdaterState());
      }
      return result;
    }

    if (process.platform === 'win32') {
      const result = await checkWindowsUpdate();
      if (!result.available && !state.blocked) {
        setIdleState();
      }
      return result;
    }

    setIdleState();
    sendToRenderer('updater:not-available', getUpdaterState());
    return { available: false };
  } catch (error) {
    console.error('[updater] update check failed:', error);
    if (!state.blocked) {
      setIdleState();
      sendToRenderer('updater:error', getUpdaterState());
    }
    return { available: false, error };
  }
}

async function runInitialUpdateCheck() {
  if (!app.isPackaged) {
    return { blocked: false };
  }

  await runUpdateCheck();
  return { blocked: isUpdateBlocked() };
}

function startPeriodicUpdateChecks() {
  if (!app.isPackaged || checkIntervalId) {
    return;
  }

  checkIntervalId = setInterval(() => {
    void runUpdateCheck();
  }, CHECK_INTERVAL_MS);
}

function installUpdateNow() {
  if (process.platform !== 'win32') {
    throw new Error('In-app install is only supported on Windows');
  }

  if (state.status !== 'ready') {
    throw new Error('Update is not ready to install');
  }

  autoUpdater.quitAndInstall(false, true);
}

async function openMacDownload() {
  if (!state.macDownloadUrl) {
    throw new Error('No macOS download URL available');
  }

  await shell.openExternal(state.macDownloadUrl);
}

function setMainWindowGetter(getter) {
  getMainWindow = getter;
}

function registerUpdaterIpc(ipcMain) {
  ipcMain.handle('updater:get-state', async () => getUpdaterState());
  ipcMain.handle('updater:install-now', async () => {
    installUpdateNow();
    return { ok: true };
  });
  ipcMain.handle('updater:open-mac-download', async () => {
    await openMacDownload();
    return { ok: true };
  });
}

module.exports = {
  isUpdateBlocked,
  getUpdaterState,
  runInitialUpdateCheck,
  startPeriodicUpdateChecks,
  registerUpdaterIpc,
  setMainWindowGetter,
  runUpdateCheck,
};
