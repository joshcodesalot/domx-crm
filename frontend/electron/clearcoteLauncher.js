const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { getApiUrl } = require('./apiConfig');
const {
  buildClearcoteArgs,
  findClearcoteExecutable,
  removeProxyAuthExtension,
  startHttpProxyForwarder,
  MISSING_CLEARCOTE_MESSAGE,
} = require('./clearcote/launchArgs');
const { ensureClearcoteInstalled, CHECKSUM_FAILED_MESSAGE } = require('./clearcote/browserInstall');
const { packProfile, unpackProfile } = require('./clearcote/profileArchive');

const HEARTBEAT_MS = 15_000;

/** @type {Map<string, { child: import('child_process').ChildProcess, lostLock: boolean }>} */
const localSessions = new Map();
/** @type {Map<string, import('electron').BrowserWindow>} */
const remoteWindows = new Map();
const starting = new Set();
let quitting = false;

function profileUrl(creatorId, suffix) {
  return `${getApiUrl()}/api/browser-profiles/${creatorId}${suffix}`;
}

function sessionHeaders(token, profile, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Domx-View-Token': profile.viewToken,
    'X-Domx-Profile-Generation': String(profile.generation ?? ''),
    ...extra,
  };
}

async function readError(response) {
  const data = await response.json().catch(() => ({}));
  return data.error || 'Browser request failed';
}

async function releaseLock(token, profile) {
  await fetch(profileUrl(profile.creatorId, '/close'), {
    method: 'POST',
    headers: {
      ...sessionHeaders(token, profile),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ releaseOnly: true, viewToken: profile.viewToken }),
  });
}

async function downloadArchive(token, profile) {
  if (!profile.hasArchive) return null;
  const response = await fetch(profileUrl(profile.creatorId, '/archive'), {
    headers: sessionHeaders(token, profile),
    signal: AbortSignal.timeout(120000),
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return Buffer.from(await response.arrayBuffer());
}

async function uploadArchive(token, profile, userDataDir) {
  const zip = packProfile(userDataDir);
  const response = await fetch(profileUrl(profile.creatorId, '/archive'), {
    method: 'PUT',
    headers: sessionHeaders(token, profile, {
      'Content-Type': 'application/octet-stream',
    }),
    body: zip,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function heartbeat(token, profile) {
  const response = await fetch(profileUrl(profile.creatorId, '/heartbeat'), {
    method: 'POST',
    headers: {
      ...sessionHeaders(token, profile),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ viewToken: profile.viewToken }),
  });
  return response.ok;
}

async function closeRemote(token, profile) {
  await fetch(profileUrl(profile.creatorId, '/close'), {
    method: 'POST',
    headers: {
      ...sessionHeaders(token, profile),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ viewToken: profile.viewToken }),
  });
}

function maybeQuit() {
  if (quitting && localSessions.size === 0 && remoteWindows.size === 0 && starting.size === 0) {
    app.quit();
  }
}

function profileDir(creatorId) {
  return path.join(app.getPath('userData'), 'clearcote-profiles', creatorId);
}

async function resolveExecutable(token, profile, onProgress) {
  if (process.platform !== 'win32') {
    return findClearcoteExecutable();
  }

  const beat = setInterval(() => {
    heartbeat(token, profile).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    await heartbeat(token, profile);
    return await ensureClearcoteInstalled({ onProgress });
  } catch (err) {
    if (err.message === CHECKSUM_FAILED_MESSAGE) throw err;
    const existing = findClearcoteExecutable();
    if (existing) return existing;
    throw err;
  } finally {
    clearInterval(beat);
  }
}

async function launchLocal(payload, onProgress) {
  const token = payload?.token;
  const profile = payload?.profile;
  if (!token || !profile?.creatorId || !profile.viewToken) {
    return { ok: false, error: 'Browser session is missing.' };
  }
  if (process.platform === 'darwin') {
    return { ok: false, error: 'This Mac opens the Debian browser view.' };
  }
  if (localSessions.has(profile.creatorId) || starting.has(profile.creatorId)) {
    return { ok: true, alreadyRunning: true };
  }

  let executable = null;
  try {
    executable = await resolveExecutable(token, profile, onProgress);
  } catch (err) {
    try {
      await releaseLock(token, profile);
    } catch {
      // The lock expires on its own if this release does not land.
    }
    return {
      ok: false,
      code: err.code || 'CLEARCOTE_DOWNLOAD_FAILED',
      error: err.message || MISSING_CLEARCOTE_MESSAGE,
    };
  }
  if (!executable) {
    try {
      await releaseLock(token, profile);
    } catch {
      // The lock expires on its own if this release does not land.
    }
    return { ok: false, code: 'CLEARCOTE_MISSING', error: MISSING_CLEARCOTE_MESSAGE };
  }

  starting.add(profile.creatorId);
  const userDataDir = profileDir(profile.creatorId);
  let child = null;
  let lostLock = false;
  let spawnFailed = false;
  let proxyForwarder = null;
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    removeProxyAuthExtension(userDataDir);
    const archive = await downloadArchive(token, profile);
    if (archive) {
      unpackProfile(archive, userDataDir);
    }
    proxyForwarder = await startHttpProxyForwarder(profile.proxyUrl);
    const args = buildClearcoteArgs({
      userDataDir,
      fingerprintSeed: profile.fingerprintSeed,
      fingerprintPlatform: profile.fingerprintPlatform,
      encryptionKey: profile.encryptionKey,
      proxyUrl: profile.proxyUrl,
      timezone: profile.timezone,
      acceptLanguage: profile.acceptLanguage,
      localProxyServer: proxyForwarder ? proxyForwarder.proxyServer : undefined,
    });
    child = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
  } catch (err) {
    starting.delete(profile.creatorId);
    try {
      await releaseLock(token, profile);
    } catch {
      // The chatter can retry after the lock expires.
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeProxyAuthExtension(userDataDir);
    if (proxyForwarder) proxyForwarder.close();
    return { ok: false, error: err.message || 'Could not open the browser.' };
  }

  const session = { child, lostLock: false };
  localSessions.set(profile.creatorId, session);
  starting.delete(profile.creatorId);

  const timer = setInterval(() => {
    heartbeat(token, profile)
      .then((ok) => {
        if (!ok) {
          lostLock = true;
          session.lostLock = true;
          try {
            child.kill();
          } catch {
            // The process is already gone.
          }
        }
      })
      .catch(() => {});
  }, HEARTBEAT_MS);

  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    localSessions.delete(profile.creatorId);
    try {
      if (spawnFailed) {
        await releaseLock(token, profile);
      } else if (!lostLock && !session.lostLock) {
        try {
          await uploadArchive(token, profile, userDataDir);
        } catch (err) {
          const message = err.message || 'Could not save the browser profile.';
          const replaced = /replaced|released/i.test(message);
          if (!replaced) {
            dialog.showErrorBox('Browser profile was not saved', message);
            try {
              await releaseLock(token, profile);
            } catch {
              // The lock expires if the release does not land.
            }
          }
        }
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      removeProxyAuthExtension(userDataDir);
      if (proxyForwarder) proxyForwarder.close();
      maybeQuit();
    }
  };

  child.once('error', () => {
    spawnFailed = true;
    void finish();
  });
  child.once('exit', () => {
    void finish();
  });

  return { ok: true };
}

function allowRemoteClipboard(ses) {
  const clipboardPermission = (permission) =>
    permission === 'clipboard-read' || permission === 'clipboard-sanitized-write';
  ses.setPermissionCheckHandler((_webContents, permission) => clipboardPermission(permission));
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(clipboardPermission(permission));
  });
}

function pasteIntoRemoteView(win) {
  const text = clipboard.readText();
  if (!text || win.isDestroyed()) return;
  const script = `(() => {
    const target = document.getElementById('noVNC_keyboardinput');
    if (!target) return;
    const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(text)});
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: data });
    target.dispatchEvent(paste);
  })()`;
  win.webContents.executeJavaScript(script).catch(() => {});
}

function openRemoteView(payload) {
  const token = payload?.token;
  const profile = payload?.profile;
  if (!token || !profile?.creatorId || !profile.viewToken) {
    return { ok: false, error: 'Browser session is missing.' };
  }
  const existing = remoteWindows.get(profile.creatorId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return { ok: true, alreadyRunning: true };
  }
  if (!profile.viewUrl) {
    return { ok: false, error: 'The browser view URL is missing.' };
  }

  const win = new BrowserWindow({
    width: 1366,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: profile.displayName ? `Browser — ${profile.displayName}` : 'Browser',
    show: false,
    webPreferences: {
      partition: 'persist:clearcote-remote',
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  allowRemoteClipboard(win.webContents.session);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    if (!(input.control || input.meta)) return;
    if (String(input.key).toLowerCase() !== 'v') return;
    event.preventDefault();
    pasteIntoRemoteView(win);
  });
  remoteWindows.set(profile.creatorId, win);

  const timer = setInterval(() => {
    heartbeat(token, profile)
      .then((ok) => {
        if (!ok && !win.isDestroyed()) {
          clearInterval(timer);
          win.close();
        }
      })
      .catch(() => {});
  }, HEARTBEAT_MS);

  let closed = false;
  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    clearInterval(timer);
    const current = remoteWindows.get(profile.creatorId);
    if (current === win) remoteWindows.delete(profile.creatorId);
    if (closed) {
      maybeQuit();
      return;
    }
    closed = true;
    closeRemote(token, profile)
      .catch((err) => {
        dialog.showErrorBox(
          'Browser profile was not saved',
          err.message || 'Could not close the remote browser.'
        );
      })
      .finally(() => maybeQuit());
  });

  void win.loadURL(profile.viewUrl);
  return { ok: true };
}

function registerClearcoteIpc(ipcMain) {
  ipcMain.handle('clearcote:launch-local', async (event, payload) => {
    try {
      return await launchLocal(payload || {}, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('clearcote:install-progress', progress);
        }
      });
    } catch (err) {
      return { ok: false, error: err.message || 'Could not open the browser.' };
    }
  });
  ipcMain.handle('clearcote:open-remote', async (_event, payload) => {
    try {
      return openRemoteView(payload || {});
    } catch (err) {
      return { ok: false, error: err.message || 'Could not open the browser.' };
    }
  });
}

function registerClearcoteLifecycle() {
  app.on('before-quit', (event) => {
    const busy = localSessions.size > 0 || remoteWindows.size > 0 || starting.size > 0;
    if (!busy || quitting) return;
    event.preventDefault();
    quitting = true;
    for (const session of localSessions.values()) {
      try {
        session.child.kill();
      } catch {
        // The window is already closing.
      }
    }
    for (const win of remoteWindows.values()) {
      if (!win.isDestroyed()) win.close();
    }
    setTimeout(() => {
      quitting = true;
      app.quit();
    }, 20000);
  });
}

module.exports = {
  registerClearcoteIpc,
  registerClearcoteLifecycle,
};
