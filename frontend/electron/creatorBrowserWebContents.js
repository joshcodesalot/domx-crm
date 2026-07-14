const { BrowserView, session } = require('electron');
const profileStorage = require('./profileStorage');
const { isLiveWebContents, isLiveBrowserView } = require('./webContentsGuards');
const {
  isNightTheme,
  refreshMaloumPageUI,
} = require('./maloumChatUi');
const {
  setMainWindow: setBadgeMainWindow,
  refreshMaloumCreatorBadgesWithDelay,
  startBadgePolling,
  getAllCreatorBadgeStates,
  getCreatorBadgeState,
} = require('./maloumBadges');
const {
  setMainWindow: setSentMessageTrackerMainWindow,
  setActiveChatter,
  registerCreatorIdMapping,
  registerCreatorIdMappings,
  installMaloumSentMessageTracker,
  uninstallMaloumSentMessageTracker,
  scheduleReapplySentBadgesForOpenChat,
  hydrateSentMessageRecords,
  startRetryMarkInterval,
  getActiveChatter,
} = require('./maloumSentMessageTracker');
const {
  setMainWindow: setNotificationTrackerMainWindow,
  installMaloumNotificationTracker,
  uninstallMaloumNotificationTracker,
} = require('./maloumNotificationTracker');
const {
  MALOUM_PROFILE_URL,
  verifyMaloumSession: runVerifyMaloumSession,
} = require('./maloumSessionVerify');

const MALOUM_LOGIN_URL = 'https://app.maloum.com/login';
const MALOUM_CHAT_URL = 'https://app.maloum.com/chat';
const MALOUM_ADD_LIST_URL = 'https://app.maloum.com/lists/add/member';
const MALOUM_VAULT_URL = 'https://app.maloum.com/vault';
const MALOUM_HOME_URL = 'https://app.maloum.com';
const MALOUM_VERIFY_DEFAULT_URL = MALOUM_PROFILE_URL;

let mainWindow = null;
let loginBrowserView = null;
let chatBrowserView = null;
const chatBrowserViews = new Map();
let verifyBrowserView = null;
let activeAccountId = null;
let activeChatAccountId = null;
let activeVerifyAccountId = null;
let activeVerifyUrl = MALOUM_VERIFY_DEFAULT_URL;
const pendingStorageByAccount = new Map();
const storageInjectedForAccount = new Set();
const warmSessionAccounts = new Set();
const preparedChatPartitions = new Set();
let prepareChatChain = Promise.resolve();
let currentDomXTheme = 'light';
const preparingChatAccounts = new Set();
const refreshMaloumChatUIChains = new Map();

function getPreparedViewsForBadgePolling() {
  const views = [];
  for (const [accountId, view] of chatBrowserViews.entries()) {
    if (!isLiveBrowserView(view)) {
      continue;
    }
    if (!isChatPrepared(accountId)) {
      continue;
    }
    views.push({ accountId, webContents: view.webContents });
  }
  return views;
}

function runRefreshMaloumPageUISerialized(webContents, theme, accountId, triggerUrl) {
  if (!webContents || webContents.isDestroyed()) {
    return Promise.resolve();
  }

  const wcId = webContents.id;
  const previous = refreshMaloumChatUIChains.get(wcId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => refreshMaloumPageUI(webContents, theme, triggerUrl, getActiveChatter()))
    .then(() => {
      if (accountId) {
        scheduleReapplySentBadgesForOpenChat(webContents, accountId);
      }
    })
    .then(() => {
      const badgeUrl = triggerUrl || webContents.getURL();
      if (accountId && isMaloumChatUrl(badgeUrl)) {
        return refreshMaloumCreatorBadgesWithDelay(webContents, accountId);
      }
    });
  refreshMaloumChatUIChains.set(wcId, next);
  return next;
}

function withPrepareLock(task) {
  const next = prepareChatChain.then(task, task);
  prepareChatChain = next.catch(() => {});
  return next;
}

function maloumChatBackgroundColor(theme = currentDomXTheme) {
  return isNightTheme(theme) ? '#0f1115' : '#ffffff';
}

function isMaloumChatUrl(url) {
  return Boolean(url) && url.includes('maloum.com') && url.includes('/chat') && !url.includes('/login');
}

function isMaloumAddListUrl(url) {
  return Boolean(url) && url.includes('maloum.com') && url.includes('/lists/add/member');
}

function isMaloumVaultUrl(url) {
  return Boolean(url) && url.includes('maloum.com') && url.includes('/vault');
}

function isMaloumManagedMaloumUrl(url) {
  return isMaloumChatUrl(url) || isMaloumAddListUrl(url) || isMaloumVaultUrl(url);
}

async function safeLoadURL(webContents, url) {
  try {
    await webContents.loadURL(url);
  } catch (err) {
    if (err?.code !== 'ERR_ABORTED' && err?.errno !== -3) {
      throw err;
    }
  }
}

function waitUntilNavigated(webContents, timeoutMs = 45000, urlMatcher) {
  const start = Date.now();
  const matches =
    typeof urlMatcher === 'function'
      ? urlMatcher
      : (current) =>
          Boolean(current) &&
          !current.startsWith('about:') &&
          current.includes(urlMatcher);

  return new Promise((resolve, reject) => {
    async function poll() {
      if (webContents.isDestroyed()) {
        reject(new Error('WebContents destroyed'));
        return;
      }

      const current = webContents.getURL();
      if (!webContents.isLoading() && matches(current)) {
        resolve(current);
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        reject(
          new Error(
            `Navigation timed out after ${timeoutMs}ms (url=${current || 'empty'})`
          )
        );
        return;
      }

      setTimeout(poll, 100);
    }

    poll();
  });
}

async function navigateToUrl(webContents, url, accountId, timeoutMs = 45000) {

  await safeLoadURL(webContents, url);
  const landed = await waitUntilNavigated(
    webContents,
    timeoutMs,
    (current) => current.includes('maloum.com')
  );

  return landed;
}

function originMatchesUrl(origin, url) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

async function injectStorageForAccount(webContents, accountId) {
  if (storageInjectedForAccount.has(accountId)) {
    return false;
  }

  const origins = pendingStorageByAccount.get(accountId);
  if (!origins?.length) {
    return false;
  }

  const currentUrl = webContents.getURL();
  const matched = origins.find((entry) => originMatchesUrl(entry.origin, currentUrl));
  if (!matched?.localStorage?.length) {
    return false;
  }

  const injectedCount = await webContents.executeJavaScript(`
    (function() {
      const items = ${JSON.stringify(matched.localStorage)};
      let count = 0;
      for (const item of items) {
        try {
          localStorage.setItem(item.name, item.value);
          count += 1;
        } catch (e) {}
      }
      return count;
    })()
  `);

  storageInjectedForAccount.add(accountId);

  return injectedCount > 0;
}

async function injectSessionStorageIfNeeded(webContents, accountId) {
  const injected = await injectStorageForAccount(webContents, accountId);
  if (injected) {
    const reloadUrl = webContents.getURL();
    await safeLoadURL(webContents, reloadUrl);
    await waitUntilNavigated(webContents, 30000, (current) =>
      current.includes('maloum.com')
    );
  }
  return injected;
}

async function ensureSessionStorageReady(webContents, accountId) {
  if (storageInjectedForAccount.has(accountId)) {
    return;
  }

  const origins = pendingStorageByAccount.get(accountId) || [];
  if (!origins.length) {
    return;
  }

  const maloumEntry =
    origins.find((entry) => entry.origin?.includes('app.maloum.com')) || origins[0];
  const seedUrl = maloumEntry?.origin || MALOUM_HOME_URL;
  const currentUrl = webContents.getURL();

  if (!originMatchesUrl(seedUrl, currentUrl)) {
    await navigateToUrl(webContents, seedUrl, accountId);
  }

  await injectSessionStorageIfNeeded(webContents, accountId);
}

async function handleEmbeddedPageLoad(webContents, accountId, { withConsent = false } = {}) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  if (withConsent) {
    await acceptCookieConsent(webContents);
  }

  await injectSessionStorageIfNeeded(webContents, accountId);
}

async function waitForMaloumChatRoot(webContents, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (webContents.isDestroyed()) {
      return false;
    }

    const pageState = await webContents.executeJavaScript(`
      (function() {
        const hasRoot = Boolean(document.querySelector('#root'));
        const path = window.location.pathname || '';
        const onLogin = path.includes('/login');
        return { hasRoot, onLogin, path };
      })()
    `);
    if (pageState.hasRoot && !pageState.onLogin) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

async function prepareMaloumChatPage(webContents, accountId) {
  preparingChatAccounts.add(accountId);
  try {
    await ensureSessionStorageReady(webContents, accountId);

    const currentUrl = webContents.getURL();
    const onChatPage =
      currentUrl.includes('maloum.com') &&
      currentUrl.includes('/chat') &&
      !currentUrl.includes('/login');

    if (!onChatPage) {
      await navigateToUrl(webContents, MALOUM_CHAT_URL, accountId);
      const urlAfterNav = webContents.getURL();
      if (urlAfterNav.includes('/login')) {
        throw new Error('Session expired or invalid — Maloum redirected to login.');
      }
    }

    const ready = await waitForMaloumChatRoot(webContents);
    if (!ready) {
      const stalledUrl = webContents.isDestroyed() ? null : webContents.getURL();
      throw new Error('Maloum chat page did not finish loading.');
    }

    await acceptCookieConsent(webContents);
    await runRefreshMaloumPageUISerialized(webContents, currentDomXTheme, accountId, webContents.getURL());

    return { ready: true };
  } finally {
    preparingChatAccounts.delete(accountId);
  }
}

async function loadPreparedChatView(webContents, accountId) {
  const currentUrl = webContents.getURL();
  const onChatReady =
    currentUrl.includes('/chat') && !currentUrl.includes('/login');

  if (!onChatReady) {
    await navigateToUrl(webContents, MALOUM_CHAT_URL, accountId);
    if (webContents.getURL().includes('/login')) {
      throw new Error('Session expired or invalid — Maloum redirected to login.');
    }
    await waitForMaloumChatRoot(webContents, 20);
  }

  await runRefreshMaloumPageUISerialized(webContents, currentDomXTheme, accountId, webContents.getURL());
  void acceptCookieConsent(webContents);
}

let refreshMaloumInFlight = 0;

function refreshMaloumPageIfNeeded(webContents, accountId, eventName) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  if (preparingChatAccounts.has(accountId)) {
    return;
  }

  const url = webContents.getURL();
  if (!isMaloumManagedMaloumUrl(url)) {
    return;
  }

  refreshMaloumInFlight += 1;

  handleEmbeddedPageLoad(webContents, accountId)
    .then(() => runRefreshMaloumPageUISerialized(webContents, currentDomXTheme, accountId, url))
    .catch(() => {})
    .finally(() => {
      refreshMaloumInFlight -= 1;
    });
}

function attachChatPageListener(view, accountId) {
  const webContents = view.webContents;

  webContents.on('did-finish-load', () => {
    refreshMaloumPageIfNeeded(webContents, accountId, 'did-finish-load');
    scheduleReapplySentBadgesForOpenChat(webContents, accountId);
  });

  webContents.on('did-navigate', () => {
    refreshMaloumPageIfNeeded(webContents, accountId, 'did-navigate');
    scheduleReapplySentBadgesForOpenChat(webContents, accountId);
  });

  webContents.on('did-navigate-in-page', () => {
    refreshMaloumPageIfNeeded(webContents, accountId, 'did-navigate-in-page');
    scheduleReapplySentBadgesForOpenChat(webContents, accountId);
  });
}

function attachStorageInjectionListener(view, accountId) {
  view.webContents.on('did-finish-load', () => {
    handleEmbeddedPageLoad(view.webContents, accountId).catch(() => {});
  });
}

function isPostLoginUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('maloum.com')) {
      return false;
    }
    return !parsed.pathname.includes('/login');
  } catch {
    return false;
  }
}

function setMainWindow(win) {
  mainWindow = win;
  setBadgeMainWindow(win);
  setSentMessageTrackerMainWindow(win);
  setNotificationTrackerMainWindow(win);
  startBadgePolling(getPreparedViewsForBadgePolling);
  startRetryMarkInterval(getPreparedViewsForBadgePolling);
}

function getPartitionSession(accountId) {
  return session.fromPartition(`persist:creator-${accountId}`);
}

function detachLoginBrowser() {
  if (!mainWindow || !loginBrowserView) {
    loginBrowserView = null;
    if (!hasAnyChatView()) {
      activeAccountId = null;
    }
    return;
  }

  mainWindow.removeBrowserView(loginBrowserView);
  if (isLiveWebContents(loginBrowserView?.webContents)) {
    loginBrowserView.webContents.close();
  }
  loginBrowserView = null;
  if (!hasAnyChatView()) {
    activeAccountId = null;
  }
}

function hasAnyChatView() {
  return chatBrowserViews.size > 0;
}

function getChatView(accountId) {
  const view = chatBrowserViews.get(accountId);
  if (!view || view.webContents.isDestroyed()) {
    if (view) {
      chatBrowserViews.delete(accountId);
    }
    return null;
  }
  return view;
}

function hasLoadedChatView(accountId) {
  const view = getChatView(accountId);
  if (!view) {
    return false;
  }
  const url = view.webContents.getURL();
  return url.includes('/chat') && !url.includes('/login');
}

function createChatView(accountId) {
  const existing = getChatView(accountId);
  if (existing) {
    return existing;
  }

  const partitionSession = getPartitionSession(accountId);
  const view = new BrowserView({
    webPreferences: {
      session: partitionSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.setBackgroundColor(maloumChatBackgroundColor());
  attachChatPageListener(view, accountId);
  void installMaloumSentMessageTracker(view.webContents, accountId);
  void installMaloumNotificationTracker(view.webContents, accountId);
  chatBrowserViews.set(accountId, view);
  return view;
}

function parkChatView(accountId) {
  if (!accountId || !mainWindow) {
    return;
  }
  const view = getChatView(accountId);
  if (!view) {
    return;
  }
  if (mainWindow.getBrowserViews().includes(view)) {
    mainWindow.removeBrowserView(view);
  }
}

function parkActiveChatView() {
  if (activeChatAccountId) {
    parkChatView(activeChatAccountId);
  }
}

function setActiveChatView(accountId, view) {
  chatBrowserView = view;
  activeChatAccountId = accountId;
  activeAccountId = accountId;
}

function destroyChatView(accountId) {
  uninstallMaloumSentMessageTracker(accountId);
  uninstallMaloumNotificationTracker(accountId);

  const view = getChatView(accountId);
  if (!view) {
    preparedChatPartitions.delete(accountId);
    return;
  }

  parkChatView(accountId);
  if (isLiveWebContents(view?.webContents)) {
    view.webContents.close();
  }
  chatBrowserViews.delete(accountId);
  preparedChatPartitions.delete(accountId);

  if (activeChatAccountId === accountId) {
    chatBrowserView = null;
    activeChatAccountId = null;
    if (!loginBrowserView && !verifyBrowserView) {
      activeAccountId = null;
    }
  }
}

function releaseChatBrowserView() {
  if (activeChatAccountId) {
    destroyChatView(activeChatAccountId);
    return;
  }

  chatBrowserView = null;
  activeChatAccountId = null;
  if (!loginBrowserView && !verifyBrowserView) {
    activeAccountId = null;
  }
}

function destroyChatBrowser() {
  if (activeChatAccountId) {
    destroyChatView(activeChatAccountId);
  }
}

function isChatBrowserAttached() {
  return Boolean(
    mainWindow &&
      chatBrowserView &&
      mainWindow.getBrowserViews().includes(chatBrowserView)
  );
}

function applyLoginBounds(bounds) {
  if (!mainWindow || !loginBrowserView || !bounds) {
    return;
  }

  const { x, y, width, height } = bounds;
  if (width <= 0 || height <= 0) {
    return;
  }

  loginBrowserView.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
}

function detachVerifyBrowser() {
  if (!mainWindow || !verifyBrowserView) {
    verifyBrowserView = null;
    activeVerifyAccountId = null;
    activeVerifyUrl = MALOUM_VERIFY_DEFAULT_URL;
    if (!loginBrowserView && !hasAnyChatView()) {
      activeAccountId = null;
    }
    return;
  }

  mainWindow.removeBrowserView(verifyBrowserView);
  if (isLiveWebContents(verifyBrowserView?.webContents)) {
    verifyBrowserView.webContents.close();
  }
  verifyBrowserView = null;
  activeVerifyAccountId = null;
  activeVerifyUrl = MALOUM_VERIFY_DEFAULT_URL;
  if (!loginBrowserView && !hasAnyChatView()) {
    activeAccountId = null;
  }
}

function applyVerifyBounds(bounds) {
  if (!mainWindow || !verifyBrowserView || !bounds) {
    return;
  }

  const { x, y, width, height } = bounds;
  if (width <= 0 || height <= 0) {
    return;
  }

  verifyBrowserView.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
}
function applyChatBounds(bounds) {
  if (!mainWindow || !chatBrowserView || !bounds) {
    return;
  }

  const { x, y, width, height } = bounds;
  if (width <= 0 || height <= 0) {
    return;
  }

  chatBrowserView.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
}

function attachOffScreenChatView(view) {
  if (!mainWindow || !view) {
    return;
  }

  if (!mainWindow.getBrowserViews().includes(view)) {
    mainWindow.addBrowserView(view);
  }

  const [contentWidth, contentHeight] = mainWindow.getContentSize();
  view.setBounds({
    x: -(Math.max(contentWidth, 1280) + 100),
    y: 0,
    width: Math.max(contentWidth, 1280),
    height: Math.max(contentHeight, 720),
  });
}

function detachChatViewFromWindow(view) {
  if (!mainWindow || !view) {
    return;
  }

  if (mainWindow.getBrowserViews().includes(view)) {
    mainWindow.removeBrowserView(view);
  }
}

function attachNavigationListener(view) {
  const notifyIfLoggedIn = (_event, url) => {
    if (isPostLoginUrl(url) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('creator:login-detected', { url });
    }
  };

  view.webContents.on('did-navigate', notifyIfLoggedIn);
  view.webContents.on('did-navigate-in-page', notifyIfLoggedIn);
}

function buildSubmitLoginScript(email, password) {
  const safeEmail = JSON.stringify(email);
  const safePassword = JSON.stringify(password);

  return `
    (function() {
      function setNativeValue(element, value) {
        const descriptor = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        );
        descriptor.set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const emailInput = document.querySelector('input[name="usernameOrEmail"]');
      const passwordInput = document.querySelector('input[name="password"]');
      const loginButton = Array.from(
        document.querySelectorAll('button[type="submit"]')
      ).find((button) => /login/i.test(button.textContent || ''));

      if (!emailInput || !passwordInput || !loginButton) {
        return { ok: false, error: 'Login form not found on the page.' };
      }

      setNativeValue(emailInput, ${safeEmail});
      setNativeValue(passwordInput, ${safePassword});
      loginButton.click();
      return { ok: true };
    })()
  `;
}

async function acceptCookieConsent(webContents, maxAttempts = 4) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (webContents.isDestroyed()) {
      return false;
    }

    const accepted = await webContents.executeJavaScript(`
      (function() {
        const button = document.querySelector('#cmpwelcomebtnyes .cmpboxbtnyes');
        if (button) {
          button.click();
          return true;
        }
        return false;
      })()
    `);

    if (accepted) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return false;
}

async function showLoginBrowser({ accountId, bounds }) {
  if (!mainWindow) {
    throw new Error('Main window is not available');
  }

  if (loginBrowserView && activeAccountId !== accountId) {
    detachLoginBrowser();
  }

  if (!loginBrowserView) {
    const partitionSession = getPartitionSession(accountId);
    loginBrowserView = new BrowserView({
      webPreferences: {
        session: partitionSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    activeAccountId = accountId;
    mainWindow.addBrowserView(loginBrowserView);
    attachNavigationListener(loginBrowserView);

    loginBrowserView.webContents.on('did-finish-load', () => {
      if (loginBrowserView?.webContents && !loginBrowserView.webContents.isDestroyed()) {
        acceptCookieConsent(loginBrowserView.webContents).catch(() => {});
      }
    });

    await loginBrowserView.webContents.loadURL(MALOUM_LOGIN_URL);
    await acceptCookieConsent(loginBrowserView.webContents);
  }

  applyLoginBounds(bounds);
  return { accountId, partitionId: `persist:creator-${accountId}` };
}

function resizeLoginBrowser(bounds) {
  applyLoginBounds(bounds);
}

function hideLoginBrowser() {
  detachLoginBrowser();
}

async function submitLogin({ accountId, email, password }) {
  if (!loginBrowserView || activeAccountId !== accountId) {
    throw new Error('Login browser is not active');
  }

  const webContents = loginBrowserView.webContents;
  await acceptCookieConsent(webContents);

  const result = await webContents.executeJavaScript(
    buildSubmitLoginScript(email, password)
  );

  if (!result?.ok) {
    throw new Error(result?.error || 'Failed to submit login in embedded browser');
  }

  return { submitted: true };
}

function playwrightCookieToElectron(cookie) {
  const domain = cookie.domain?.startsWith('.')
    ? cookie.domain.slice(1)
    : cookie.domain;
  const protocol = cookie.secure ? 'https' : 'http';
  const url = `${protocol}://${domain}${cookie.path || '/'}`;

  const electronCookie = {
    url,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };

  if (cookie.expires && cookie.expires > 0) {
    electronCookie.expirationDate = cookie.expires;
  }

  if (cookie.sameSite) {
    const sameSite = String(cookie.sameSite).toLowerCase();
    if (sameSite === 'strict') {
      electronCookie.sameSite = 'strict';
    } else if (sameSite === 'lax') {
      electronCookie.sameSite = 'lax';
    } else if (sameSite === 'none') {
      // Electron uses 'no_restriction' for SameSite=None (Playwright returns 'None')
      electronCookie.sameSite = 'no_restriction';
    }
  }

  return electronCookie;
}

async function importCookies({ accountId, cookies }) {
  const partitionSession = getPartitionSession(accountId);

  for (const cookie of cookies) {
    try {
      await partitionSession.cookies.set(playwrightCookieToElectron(cookie));
    } catch (err) {
      console.warn('Failed to import cookie:', cookie.name, err.message);
    }
  }

  if (loginBrowserView && activeAccountId === accountId) {
    await loginBrowserView.webContents.loadURL(MALOUM_CHAT_URL);
  }

  return { imported: cookies.length };
}

async function saveCreatorProfile(accountId, webContents) {
  const profile = await profileStorage.exportProfileFromPartition(accountId, webContents);
  if (!profile.cookies.length) {
    return { saved: false, reason: 'no-cookies' };
  }

  const pendingOrigins = pendingStorageByAccount.get(accountId) || [];
  if (pendingOrigins.length && profile.origins.length === 0) {
    profile.origins = pendingOrigins;
  }

  profileStorage.writeLocalProfile(accountId, profile);

  return { saved: true, cookieCount: profile.cookies.length };
}

async function hydrateCreatorProfile(accountId) {
  if (warmSessionAccounts.has(accountId)) {
    return { hydrated: true, source: 'memory', accountId };
  }

  const partitionSession = getPartitionSession(accountId);
  const existingCookies = await partitionSession.cookies.get({});
  const maloumCookies = existingCookies.filter((cookie) =>
    (cookie.domain || '').includes('maloum.com')
  );

  if (maloumCookies.length > 0) {
    const localProfile = profileStorage.readLocalProfile(accountId);
    pendingStorageByAccount.set(accountId, localProfile?.origins || []);
    storageInjectedForAccount.add(accountId);
    warmSessionAccounts.add(accountId);

    return { hydrated: true, source: 'partition', accountId };
  }

  const localProfile = profileStorage.readLocalProfile(accountId);
  if (localProfile?.cookies?.length) {
    await loadCreatorSession({
      accountId,
      cookies: localProfile.cookies,
      origins: localProfile.origins || [],
      force: true,
    });

    return { hydrated: true, source: 'file', accountId };
  }

  return { hydrated: false, accountId };
}

function hasLocalCreatorProfile(accountId) {
  return profileStorage.hasLocalProfile(accountId);
}

async function loadCreatorSession({ accountId, cookies, origins, force = false }) {
  if (!force && warmSessionAccounts.has(accountId)) {
    pendingStorageByAccount.set(accountId, origins || []);
    storageInjectedForAccount.delete(accountId);
    return {
      imported: cookies.length,
      accountId,
      partitionId: `persist:creator-${accountId}`,
      skipped: true,
      warm: true,
    };
  }

  const partitionSession = getPartitionSession(accountId);
  await partitionSession.clearStorageData();
  await partitionSession.clearCache();

  pendingStorageByAccount.set(accountId, origins || []);
  storageInjectedForAccount.delete(accountId);

  let cookiesSet = 0;
  let cookiesFailed = 0;
  const failedNames = [];
  for (const cookie of cookies) {
    try {
      await partitionSession.cookies.set(playwrightCookieToElectron(cookie));
      cookiesSet += 1;
    } catch (err) {
      cookiesFailed += 1;
      failedNames.push(cookie.name);
      console.warn('Failed to import cookie:', cookie.name, err.message);
    }
  }

  const storedCookies = await partitionSession.cookies.get({});
  const maloumCookies = storedCookies.filter((c) =>
    (c.domain || '').includes('maloum.com')
  );

  warmSessionAccounts.add(accountId);

  return { imported: cookies.length, accountId, partitionId: `persist:creator-${accountId}` };
}

async function preloadCreatorSessions(sessions) {
  registerCreatorIdMappings(sessions);

  const results = [];
  for (const entry of sessions) {
    if (!entry?.accountId) {
      continue;
    }

    if (entry.hydrated) {
      results.push({
        accountId: entry.accountId,
        skipped: true,
        warm: true,
        source: entry.source || 'hydrated',
      });
      continue;
    }

    if (!entry.cookies?.length) {
      continue;
    }

    const result = await loadCreatorSession({
      accountId: entry.accountId,
      cookies: entry.cookies,
      origins: entry.origins || [],
    });
    results.push(result);
  }
  return { preloaded: results.length, results };
}

function isCreatorSessionWarm(accountId) {
  return warmSessionAccounts.has(accountId);
}

function getActiveChatAccountId() {
  return activeChatAccountId;
}

async function clearSession(accountId) {
  const partitionSession = getPartitionSession(accountId);
  await partitionSession.clearStorageData();
  await partitionSession.clearCache();

  pendingStorageByAccount.delete(accountId);
  storageInjectedForAccount.delete(accountId);
  warmSessionAccounts.delete(accountId);
  preparedChatPartitions.delete(accountId);
  profileStorage.deleteLocalProfile(accountId);

  if (loginBrowserView && activeAccountId === accountId) {
    detachLoginBrowser();
  }

  destroyChatView(accountId);

  if (verifyBrowserView && activeVerifyAccountId === accountId) {
    detachVerifyBrowser();
  }

  return { accountId, partitionId: `persist:creator-${accountId}` };
}

async function createVerificationBrowserView(accountId) {
  const partitionSession = getPartitionSession(accountId);
  const view = new BrowserView({
    webPreferences: {
      session: partitionSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  attachStorageInjectionListener(view, accountId);
  return view;
}

async function verifyMaloumSessionForAccount({
  accountId,
  theme = currentDomXTheme,
  bounds = null,
  reuseVisibleView = false,
}) {
  if (!warmSessionAccounts.has(accountId)) {
    throw new Error('Session partition is not warm. Load session before verifying.');
  }

  let view = null;
  let ownsView = false;

  if (reuseVisibleView && verifyBrowserView && activeVerifyAccountId === accountId) {
    view = verifyBrowserView;
  } else if (reuseVisibleView && mainWindow && bounds) {
    await showVerifyBrowser({
      accountId,
      bounds,
      url: MALOUM_PROFILE_URL,
    });
    view = verifyBrowserView;
  } else {
    view = await createVerificationBrowserView(accountId);
    ownsView = true;
    await ensureSessionStorageReady(view.webContents, accountId);
  }

  const webContents = view.webContents;

  const result = await runVerifyMaloumSession(webContents, accountId, {
    currentDomXTheme: theme,
    beforeNavigate: async (wc, id) => {
      await handleEmbeddedPageLoad(wc, id, { withConsent: true });
    },
  });

  if (ownsView && view) {
    if (isLiveWebContents(view?.webContents)) {
      view.webContents.close();
    }
  }

  return result;
}

async function showVerifyBrowser({ accountId, bounds, url }) {
  if (!mainWindow) {
    throw new Error('Main window is not available');
  }

  const targetUrl = url || MALOUM_VERIFY_DEFAULT_URL;
  activeVerifyUrl = targetUrl;

  if (verifyBrowserView && activeVerifyAccountId !== accountId) {
    detachVerifyBrowser();
  }

  if (!verifyBrowserView) {
    const partitionSession = getPartitionSession(accountId);
    verifyBrowserView = new BrowserView({
      webPreferences: {
        session: partitionSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    activeVerifyAccountId = accountId;
    activeAccountId = accountId;
    mainWindow.addBrowserView(verifyBrowserView);
    attachStorageInjectionListener(verifyBrowserView, accountId);

    await safeLoadURL(verifyBrowserView.webContents, targetUrl);
    await handleEmbeddedPageLoad(verifyBrowserView.webContents, accountId, {
      withConsent: true,
    });
  } else if (verifyBrowserView.webContents.getURL() !== targetUrl) {
    await safeLoadURL(verifyBrowserView.webContents, targetUrl);
    await handleEmbeddedPageLoad(verifyBrowserView.webContents, accountId, {
      withConsent: true,
    });
  }

  applyVerifyBounds(bounds);
  return { accountId, partitionId: `persist:creator-${accountId}`, url: targetUrl };
}

function resizeVerifyBrowser(bounds) {
  applyVerifyBounds(bounds);
}

function hideVerifyBrowser() {
  detachVerifyBrowser();
}

async function prepareChatBrowser(accountId) {
  return withPrepareLock(() => prepareChatBrowserInner(accountId));
}

async function prepareChatBrowserInner(accountId) {
  if (!mainWindow) {
    throw new Error('Main window is not available');
  }

  if (hasLoadedChatView(accountId)) {
    preparedChatPartitions.add(accountId);
    const existingView = getChatView(accountId);
    if (existingView) {
      await refreshMaloumCreatorBadgesWithDelay(existingView.webContents, accountId);
    }
    return { accountId, prepared: true, skipped: true };
  }

  if (preparedChatPartitions.has(accountId)) {
    preparedChatPartitions.delete(accountId);
  }

  if (!warmSessionAccounts.has(accountId)) {
    throw new Error('Session partition is not warm. Load session before preparing chat.');
  }

  parkActiveChatView();

  const view = createChatView(accountId);
  setActiveChatView(accountId, view);

  attachOffScreenChatView(view);

  try {
    await prepareMaloumChatPage(view.webContents, accountId);
  } catch (err) {
    destroyChatView(accountId);
    throw err;
  } finally {
    parkChatView(accountId);
    if (activeChatAccountId === accountId) {
      chatBrowserView = null;
      activeChatAccountId = null;
    }
  }

  const finalUrl = view.webContents.getURL();
  if (finalUrl.includes('/login')) {
    destroyChatView(accountId);
    throw new Error('Session expired or invalid — Maloum redirected to login.');
  }

  preparedChatPartitions.add(accountId);

  await saveCreatorProfile(accountId, view.webContents);

  await refreshMaloumCreatorBadgesWithDelay(view.webContents, accountId);

  return { accountId, prepared: true };
}

function isChatPrepared(accountId) {
  return preparedChatPartitions.has(accountId) || hasLoadedChatView(accountId);
}

async function prepareAllChatBrowsers(accountIds) {

  const results = [];
  for (const accountId of accountIds) {
    try {
      const result = await prepareChatBrowser(accountId);
      results.push({ accountId, ok: true, ...result });
    } catch (err) {
      results.push({
        accountId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    prepared: results.filter((r) => r.ok).length,
    results,
  };
}

async function showChatBrowser({ accountId, bounds }) {
  if (!mainWindow) {
    throw new Error('Main window is not available');
  }

  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Chat browser bounds are not available');
  }

  if (activeChatAccountId && activeChatAccountId !== accountId) {
    parkChatView(activeChatAccountId);
  }

  if (!isChatPrepared(accountId)) {
    if (!warmSessionAccounts.has(accountId)) {
      throw new Error('Session partition is not warm. Load session before showing chat.');
    }
    await prepareChatBrowser(accountId);
  }

  let view = getChatView(accountId);
  const reusedWarmView = Boolean(view && hasLoadedChatView(accountId));

  if (!view) {
    view = createChatView(accountId);
    setActiveChatView(accountId, view);
    attachOffScreenChatView(view);
    try {
      await prepareMaloumChatPage(view.webContents, accountId);
    } finally {
      parkChatView(accountId);
    }

    const loadedUrl = view.webContents.getURL();
    if (loadedUrl.includes('/login')) {
      destroyChatView(accountId);
      throw new Error('Session expired or invalid — Maloum redirected to login.');
    }

    preparedChatPartitions.add(accountId);
  } else {
    setActiveChatView(accountId, view);
  }

  if (!mainWindow.getBrowserViews().includes(view)) {
    mainWindow.addBrowserView(view);
  }

  view.setBackgroundColor(maloumChatBackgroundColor());
  applyChatBounds(bounds);

  if (!reusedWarmView) {
    void saveCreatorProfile(accountId, view.webContents);
  }

  const currentUrl = view.webContents.getURL() || null;

  await refreshMaloumCreatorBadgesWithDelay(view.webContents, accountId);

  return { accountId, partitionId: `persist:creator-${accountId}` };
}

function resizeChatBrowser(bounds) {
  applyChatBounds(bounds);
}

function hideChatBrowser() {
  parkActiveChatView();
  chatBrowserView = null;
  activeChatAccountId = null;
  if (!loginBrowserView && !verifyBrowserView) {
    activeAccountId = null;
  }
}


async function setDomXTheme(theme) {
  currentDomXTheme = theme;

  for (const [accountId, view] of chatBrowserViews.entries()) {
    if (!isLiveBrowserView(view)) {
      continue;
    }

    view.setBackgroundColor(maloumChatBackgroundColor(theme));

    const url = view.webContents.getURL();
    if (!isMaloumManagedMaloumUrl(url)) {
      continue;
    }

    try {
      await runRefreshMaloumPageUISerialized(view.webContents, theme, accountId, url);
    } catch {
      // View may be mid-navigation
    }
  }
}

module.exports = {
  setMainWindow,
  showLoginBrowser,
  resizeLoginBrowser,
  hideLoginBrowser,
  submitLogin,
  importCookies,
  loadCreatorSession,
  hydrateCreatorProfile,
  hasLocalCreatorProfile,
  preloadCreatorSessions,
  isCreatorSessionWarm,
  getActiveChatAccountId,
  prepareChatBrowser,
  prepareAllChatBrowsers,
  isChatPrepared,
  clearSession,
  showChatBrowser,
  resizeChatBrowser,
  hideChatBrowser,
  showVerifyBrowser,
  resizeVerifyBrowser,
  hideVerifyBrowser,
  verifyMaloumSessionForAccount,
  setDomXTheme,
  getAllCreatorBadgeStates,
  getCreatorBadgeState,
  setActiveChatter,
  registerCreatorMapping: registerCreatorIdMapping,
  hydrateSentMessages: hydrateSentMessageRecords,
};
