const NOTIFICATIONS_API_REGEX =
  /^https:\/\/api\.maloum\.com\/notifications(?:\?|$)/;

const profileStorage = require('./profileStorage');

const NOTIFICATION_POLL_INTERVAL_MS = 20000;
const SALE_NOTIFICATION_TYPE = 'CHAT_PRODUCT_SOLD';

const DOMX_API_BASE = process.env.DOMX_API_URL || 'http://localhost:3001';
const DOMX_SERVICE_KEY = process.env.DOMX_ELECTRON_SERVICE_KEY || '';

const notificationRequestIds = new Set();
const responseStatusByRequestId = new Map();
const processedNotificationIds = new Set();
const pollIntervalsByAccount = new Map();
const trackerStateByAccount = new Map();
const authTokenByAccount = new Map();

const MALOUM_API_HOST = 'api.maloum.com';

let mainWindowRef = null;

function setMainWindow(win) {
  mainWindowRef = win;
}

function isMaloumNotificationsUrl(url, method = 'GET') {
  return method === 'GET' && NOTIFICATIONS_API_REGEX.test(url || '');
}

function parseSaleNotifications(responseBody) {
  if (!responseBody) {
    return [];
  }

  try {
    const parsed = JSON.parse(responseBody);
    const data = Array.isArray(parsed?.data) ? parsed.data : [];

    return data
      .map((entry) => {
        if (entry?.type !== SALE_NOTIFICATION_TYPE || !entry?.messageId) {
          return null;
        }

        const rawNet = entry.net;
        const net =
          typeof rawNet === 'number'
            ? rawNet
            : typeof rawNet === 'string' && rawNet.trim() !== ''
              ? Number.parseFloat(rawNet)
              : NaN;

        if (!Number.isFinite(net)) {
          return null;
        }

        const notificationId = String(entry._id || entry.id || '');
        const messageId = String(entry.messageId);

        if (!notificationId || !messageId) {
          return null;
        }

        return {
          notificationId,
          messageId,
          net,
          fanId: entry.fanId ? String(entry.fanId) : null,
          fanUsername: entry.fanUsername ? String(entry.fanUsername) : null,
          createdAt: entry.createdAt || null,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function applyUnlockSale(notification) {
  if (!notification?.messageId || processedNotificationIds.has(notification.notificationId)) {
    return { updated: false };
  }

  if (!DOMX_SERVICE_KEY) {
    return { updated: false, reason: 'missing_service_key' };
  }

  try {
    const response = await fetch(`${DOMX_API_BASE}/api/messaging-dashboard/internal/unlock-sale`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DomX-Service-Key': DOMX_SERVICE_KEY,
      },
      body: JSON.stringify({
        maloumMessageId: notification.messageId,
        priceNet: notification.net,
        notificationId: notification.notificationId,
      }),
    });

    if (!response.ok) {
      return { updated: false, reason: `http_${response.status}` };
    }

    const payload = await response.json();

    if (payload?.updated || payload?.reason === 'already_purchased') {
      processedNotificationIds.add(notification.notificationId);
    }

    if (payload?.updated && payload?.entry && mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('dashboard:entry-updated', {
        entry: payload.entry,
      });
    }

    return payload;
  } catch (error) {
    return {
      updated: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function processSaleNotifications(responseBody) {
  const sales = parseSaleNotifications(responseBody);

  for (const sale of sales) {
    await applyUnlockSale(sale);
  }
}

async function handleNotificationsResponse(requestId, debuggerSession) {
  if (!notificationRequestIds.has(requestId)) {
    return;
  }

  notificationRequestIds.delete(requestId);

  const status = responseStatusByRequestId.get(requestId);
  responseStatusByRequestId.delete(requestId);

  if (!status || status < 200 || status >= 300) {
    return;
  }

  let responseBody = '';

  try {
    const bodyResult = await debuggerSession.sendCommand('Network.getResponseBody', {
      requestId,
    });
    responseBody = bodyResult?.body || '';
  } catch {
    return;
  }

  await processSaleNotifications(responseBody);
}

function captureMaloumAuthToken(accountId, params) {
  if (!accountId) {
    return;
  }

  const url = params?.request?.url || '';
  if (!url.includes(MALOUM_API_HOST)) {
    return;
  }

  const headers = params?.request?.headers || {};
  const authHeader = headers.Authorization || headers.authorization;

  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    authTokenByAccount.set(accountId, authHeader.slice('Bearer '.length));
  }
}

async function readMaloumAuthTokenFromPage(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return null;
  }

  try {
    return await webContents.executeJavaScript(`
      (function() {
        try {
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key || !key.startsWith('sb-') || !key.endsWith('-auth-token')) {
              continue;
            }

            const raw = localStorage.getItem(key);
            if (!raw) {
              continue;
            }

            const parsed = JSON.parse(raw);
            const token =
              parsed?.access_token ||
              parsed?.currentSession?.access_token ||
              parsed?.session?.access_token;

            if (typeof token === 'string' && token.length > 0) {
              return token;
            }
          }
        } catch {
          // Ignore malformed auth storage.
        }

        return null;
      })()
    `);
  } catch {
    return null;
  }
}

function readMaloumAuthTokenFromProfile(accountId) {
  if (!accountId) {
    return null;
  }

  const profile = profileStorage.readLocalProfile(accountId);
  if (!profile?.origins?.length) {
    return null;
  }

  for (const originEntry of profile.origins) {
    if (!originEntry?.origin?.includes('maloum.com')) {
      continue;
    }

    for (const item of originEntry.localStorage || []) {
      if (
        !item?.name ||
        !item.name.startsWith('sb-') ||
        !item.name.endsWith('-auth-token')
      ) {
        continue;
      }

      try {
        const parsed = JSON.parse(item.value);
        const token =
          parsed?.access_token ||
          parsed?.currentSession?.access_token ||
          parsed?.session?.access_token;

        if (typeof token === 'string' && token.length > 0) {
          return token;
        }
      } catch {
        // Ignore malformed auth storage.
      }
    }
  }

  return null;
}

async function resolveMaloumAuthToken(webContents, accountId) {
  const cachedToken = authTokenByAccount.get(accountId);
  if (cachedToken) {
    return cachedToken;
  }

  const pageToken = await readMaloumAuthTokenFromPage(webContents);
  if (pageToken) {
    authTokenByAccount.set(accountId, pageToken);
    return pageToken;
  }

  const profileToken = readMaloumAuthTokenFromProfile(accountId);
  if (profileToken) {
    authTokenByAccount.set(accountId, profileToken);
    return profileToken;
  }

  return null;
}

function handleNotificationsRequest(params) {
  const { request } = params;
  const url = request?.url || '';
  const method = request?.method || '';

  if (!isMaloumNotificationsUrl(url, method)) {
    return;
  }

  notificationRequestIds.add(params.requestId);
}

function handleNotificationsResponseReceived(params) {
  const { response, requestId } = params;

  if (!response?.url || !isMaloumNotificationsUrl(response.url, 'GET')) {
    return;
  }

  responseStatusByRequestId.set(requestId, response.status);
}

async function triggerNotificationsFetch(webContents, accountId) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  try {
    const token = await resolveMaloumAuthToken(webContents, accountId);
    const headers = {
      accept: 'application/json',
    };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const response = await webContents.session.fetch(
      'https://api.maloum.com/notifications?limit=15',
      {
        method: 'GET',
        headers,
      }
    );

    const body = await response.text();
    const responseBody = response.ok && body.length > 0 ? body : null;

    if (responseBody) {
      await processSaleNotifications(responseBody);
    }
  } catch {
    // Best-effort polling only.
  }
}

function startNotificationPolling(webContents, accountId) {
  if (!webContents || webContents.isDestroyed() || !accountId) {
    return;
  }

  stopNotificationPolling(accountId);

  void triggerNotificationsFetch(webContents, accountId);

  const intervalId = setInterval(() => {
    if (webContents.isDestroyed()) {
      stopNotificationPolling(accountId);
      return;
    }

    void triggerNotificationsFetch(webContents, accountId);
  }, NOTIFICATION_POLL_INTERVAL_MS);

  pollIntervalsByAccount.set(accountId, intervalId);
}

function stopNotificationPolling(accountId) {
  const intervalId = pollIntervalsByAccount.get(accountId);

  if (intervalId) {
    clearInterval(intervalId);
    pollIntervalsByAccount.delete(accountId);
  }
}

function getTrackerState(accountId) {
  if (!trackerStateByAccount.has(accountId)) {
    trackerStateByAccount.set(accountId, {
      installed: false,
      debuggerHandler: null,
      webContents: null,
    });
  }

  return trackerStateByAccount.get(accountId);
}

async function installMaloumNotificationTracker(webContents, accountId) {
  if (!webContents || webContents.isDestroyed() || !accountId) {
    return;
  }

  const state = getTrackerState(accountId);
  state.webContents = webContents;

  startNotificationPolling(webContents, accountId);

  if (state.installed) {
    return;
  }

  const debuggerSession = webContents.debugger;

  try {
    if (!debuggerSession.isAttached()) {
      debuggerSession.attach('1.3');
    }
  } catch (error) {
    if (!String(error?.message || error).includes('Already attached')) {
      console.warn('Failed to attach CDP debugger for notification tracking:', error);
      return;
    }
  }

  try {
    await debuggerSession.sendCommand('Network.enable');
  } catch {
    // Network may already be enabled by the sent-message tracker.
  }

  const onDebuggerMessage = async (_event, method, params) => {
    try {
      if (method === 'Network.requestWillBeSent') {
        captureMaloumAuthToken(accountId, params);
        handleNotificationsRequest(params);
        return;
      }

      if (method === 'Network.responseReceived') {
        handleNotificationsResponseReceived(params);
        return;
      }

      if (method === 'Network.loadingFinished') {
        await handleNotificationsResponse(params.requestId, debuggerSession);
      }
    } catch (error) {
      console.warn('Maloum notification tracker CDP handler error:', error);
    }
  };

  debuggerSession.on('message', onDebuggerMessage);
  state.debuggerHandler = onDebuggerMessage;
  state.installed = true;
}

function uninstallMaloumNotificationTracker(accountId) {
  stopNotificationPolling(accountId);

  const state = trackerStateByAccount.get(accountId);
  if (!state) {
    return;
  }

  const { webContents, debuggerHandler } = state;

  if (webContents && !webContents.isDestroyed() && debuggerHandler) {
    try {
      webContents.debugger.removeListener('message', debuggerHandler);
    } catch {
      // Ignore detach errors.
    }
  }

  trackerStateByAccount.delete(accountId);
  authTokenByAccount.delete(accountId);
}

module.exports = {
  setMainWindow,
  installMaloumNotificationTracker,
  uninstallMaloumNotificationTracker,
  parseSaleNotifications,
  applyUnlockSale,
};
