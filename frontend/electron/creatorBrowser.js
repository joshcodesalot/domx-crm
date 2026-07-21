const { BrowserView, session } = require('electron');
const profileStorage = require('./profileStorage');
const { applyWebContentsGuards, isLiveWebContents, isLiveBrowserView } = require('./webContentsGuards');
const {
  isNightTheme,
  isMaloumAppUrl,
  refreshMaloumPageUI,
  applyTranslationSettings,
  resetMaloumPageObservers,
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
  waitForNetworkIdle,
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
let lastVisibleChatBounds = null;
let lastVisibleChatAccountId = null;
let currentDomXTheme = 'light';
const currentTranslationSettings = {
  preSendEnabled: true,
  historyEnabled: true,
};
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

const fullBrowserAccessByAccountId = new Map();
const preparedBrowserModeByAccountId = new Map();

function isFullBrowserAccess(accountId) {
  return fullBrowserAccessByAccountId.get(accountId) === true;
}

function browserModeKey(fullBrowserAccess) {
  return fullBrowserAccess ? 'full' : 'restricted';
}

function shouldRefreshMaloumUI(url, fullBrowserAccess) {
  if (fullBrowserAccess) {
    return isMaloumAppUrl(url);
  }
  return isMaloumManagedMaloumUrl(url);
}

function runRefreshMaloumPageUISerialized(webContents, theme, accountId, triggerUrl) {
  if (!webContents || webContents.isDestroyed()) {
    return Promise.resolve();
  }

  const fullBrowserAccess = isFullBrowserAccess(accountId);
  const wcId = webContents.id;
  const previous = refreshMaloumChatUIChains.get(wcId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() =>
      refreshMaloumPageUI(
        webContents,
        theme,
        triggerUrl,
        getActiveChatter(),
        currentTranslationSettings,
        { fullBrowserAccess }
      )
    )
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

const localLoginChains = new Map();

function withAccountLoginLock(accountId, task) {
  const previous = localLoginChains.get(accountId) || Promise.resolve();
  const next = previous.then(task, task);
  localLoginChains.set(accountId, next.catch(() => {}));
  return next;
}

function classifyMaloumLoginError(message) {
  const normalized = String(message || '').toLowerCase();

  if (
    normalized.includes('email and/or password') ||
    normalized.includes('incorrect') ||
    normalized.includes('invalid credentials')
  ) {
    return {
      ok: false,
      reason: 'invalid_credentials',
      message: message || 'Maloum rejected the saved email or password.',
    };
  }

  if (
    normalized.includes('security check') ||
    normalized.includes('login form did not become ready') ||
    normalized.includes('login timed out') ||
    normalized.includes('finish signing in') ||
    normalized.includes('login is not complete')
  ) {
    return {
      ok: false,
      reason: 'interaction_required',
      message:
        message ||
        'Maloum requires additional verification. Complete it in the embedded browser, then try again.',
    };
  }

  return {
    ok: false,
    reason: 'transient_failure',
    message: message || 'Maloum login failed.',
  };
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

async function waitForMaloumChatRoot(webContents, attempts = 100) {
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

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

async function prepareMaloumFullBrowserPage(webContents, accountId) {
  preparingChatAccounts.add(accountId);
  try {
    await ensureSessionStorageReady(webContents, accountId);

    const currentUrl = webContents.getURL();
    if (!isMaloumAppUrl(currentUrl)) {
      await navigateToUrl(webContents, MALOUM_HOME_URL, accountId);
      const urlAfterNav = webContents.getURL();
      if (urlAfterNav.includes('/login')) {
        throw new Error('Session expired or invalid — Maloum redirected to login.');
      }
    }

    await acceptCookieConsent(webContents);
    await runRefreshMaloumPageUISerialized(
      webContents,
      currentDomXTheme,
      accountId,
      webContents.getURL()
    );

    preparedBrowserModeByAccountId.set(accountId, 'full');
    return { ready: true };
  } finally {
    preparingChatAccounts.delete(accountId);
  }
}

async function prepareMaloumChatPage(webContents, accountId) {
  if (isFullBrowserAccess(accountId)) {
    return prepareMaloumFullBrowserPage(webContents, accountId);
  }

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
      await waitForNetworkIdle(webContents, 15000).catch(() => {});
    }

    const ready = await waitForMaloumChatRoot(webContents);
    if (!ready) {
      const stalledUrl = webContents.isDestroyed() ? null : webContents.getURL();
      throw new Error(
        `Maloum chat page did not finish loading${stalledUrl ? ` (url=${stalledUrl})` : ''}.`
      );
    }

    await acceptCookieConsent(webContents);
    await runRefreshMaloumPageUISerialized(webContents, currentDomXTheme, accountId, webContents.getURL());

    preparedBrowserModeByAccountId.set(accountId, 'restricted');
    return { ready: true };
  } finally {
    preparingChatAccounts.delete(accountId);
  }
}

async function loadPreparedChatView(webContents, accountId) {
  if (isFullBrowserAccess(accountId)) {
    const currentUrl = webContents.getURL();
    if (!isMaloumAppUrl(currentUrl)) {
      await navigateToUrl(webContents, MALOUM_HOME_URL, accountId);
      if (webContents.getURL().includes('/login')) {
        throw new Error('Session expired or invalid — Maloum redirected to login.');
      }
    }

    await runRefreshMaloumPageUISerialized(webContents, currentDomXTheme, accountId, webContents.getURL());
    void acceptCookieConsent(webContents);
    preparedBrowserModeByAccountId.set(accountId, 'full');
    return;
  }

  const currentUrl = webContents.getURL();
  const onChatReady =
    currentUrl.includes('/chat') && !currentUrl.includes('/login');

  if (!onChatReady) {
    await navigateToUrl(webContents, MALOUM_CHAT_URL, accountId);
    if (webContents.getURL().includes('/login')) {
      throw new Error('Session expired or invalid — Maloum redirected to login.');
    }
    await waitForMaloumChatRoot(webContents);
  }

  await runRefreshMaloumPageUISerialized(webContents, currentDomXTheme, accountId, webContents.getURL());
  void acceptCookieConsent(webContents);
  preparedBrowserModeByAccountId.set(accountId, 'restricted');
}

async function ensureChatViewMatchesMode(webContents, accountId) {
  const targetMode = browserModeKey(isFullBrowserAccess(accountId));
  const preparedMode = preparedBrowserModeByAccountId.get(accountId);

  if (preparedMode === targetMode) {
    return;
  }

  await resetMaloumPageObservers(webContents);
  await prepareMaloumChatPage(webContents, accountId);
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
  if (!shouldRefreshMaloumUI(url, isFullBrowserAccess(accountId))) {
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
  if (!isLiveBrowserView(view)) {
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
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor(maloumChatBackgroundColor());
  applyWebContentsGuards(view.webContents);
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

function releaseCreatorChat(accountId) {
  if (!accountId) {
    return { released: false };
  }

  destroyChatView(accountId);
  return { released: true, accountId };
}

async function releaseAllCreatorChats() {
  const accountIds = new Set([
    ...chatBrowserViews.keys(),
    ...warmSessionAccounts,
    ...preparedChatPartitions,
  ]);

  try {
    const fs = require('fs');
    const { getProfilesRoot } = require('./app-paths');
    for (const entry of fs.readdirSync(getProfilesRoot(), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        accountIds.add(entry.name);
      }
    }
  } catch {
    // Ignore missing profiles root during cleanup.
  }

  for (const accountId of accountIds) {
    await clearSession(accountId);
  }

  return { released: accountIds.size, accountIds: [...accountIds] };
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

function raiseLoginBrowser(bounds) {
  if (!mainWindow || !loginBrowserView || !bounds) {
    return;
  }

  applyLoginBounds(bounds);

  if (typeof mainWindow.setTopBrowserView === 'function') {
    mainWindow.setTopBrowserView(loginBrowserView);
  }
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

  lastVisibleChatBounds = bounds;
  if (activeChatAccountId) {
    lastVisibleChatAccountId = activeChatAccountId;
  }

  chatBrowserView.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
}

function restoreVisibleChatIfNeeded(excludeAccountId) {
  const accountId = lastVisibleChatAccountId;
  if (!accountId || accountId === excludeAccountId || !mainWindow || !lastVisibleChatBounds) {
    return;
  }

  const view = getChatView(accountId);
  if (!view) {
    return;
  }

  if (!mainWindow.getBrowserViews().includes(view)) {
    mainWindow.addBrowserView(view);
  }

  setActiveChatView(accountId, view);
  view.setBackgroundColor(maloumChatBackgroundColor());
  applyChatBounds(lastVisibleChatBounds);
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

      function findLoginSubmitButton() {
        const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
        const labeled = buttons.find((button) =>
          /log\\s*in|sign\\s*in|anmelden/i.test(button.textContent || '')
        );
        return labeled || buttons[0] || null;
      }

      const emailInput = document.querySelector('input[name="usernameOrEmail"]');
      const passwordInput = document.querySelector('input[name="password"]');
      const loginButton = findLoginSubmitButton();

      if (!emailInput || !passwordInput) {
        return { ok: false, error: 'Login form not found on the page.' };
      }
      if (!loginButton) {
        return { ok: false, error: 'Login button not found on the page.' };
      }

      setNativeValue(emailInput, ${safeEmail});
      setNativeValue(passwordInput, ${safePassword});
      loginButton.click();
      return { ok: true };
    })()
  `;
}

const LOGIN_FORM_READY_SCRIPT = `
  (function() {
    function findLoginSubmitButton() {
      const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
      const labeled = buttons.find((button) =>
        /log\\s*in|sign\\s*in|anmelden/i.test(button.textContent || '')
      );
      return labeled || buttons[0] || null;
    }

    const emailInput = document.querySelector('input[name="usernameOrEmail"]');
    const passwordInput = document.querySelector('input[name="password"]');
    const loginButton = findLoginSubmitButton();
    return Boolean(
      emailInput &&
      passwordInput &&
      loginButton &&
      !emailInput.disabled
    );
  })()
`;

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
    applyWebContentsGuards(loginBrowserView.webContents);
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
  raiseLoginBrowser(bounds);
  return { accountId, partitionId: `persist:creator-${accountId}` };
}

function resizeLoginBrowser(bounds) {
  raiseLoginBrowser(bounds);
}

function hideLoginBrowser() {
  detachLoginBrowser();
}

async function submitLoginOnWebContents(webContents, email, password) {
  if (!isLiveWebContents(webContents)) {
    throw new Error('Browser view is not available');
  }

  await acceptCookieConsent(webContents);

  const result = await webContents.executeJavaScript(
    buildSubmitLoginScript(email, password)
  );

  if (!result?.ok) {
    throw new Error(result?.error || 'Failed to submit login in embedded browser');
  }

  return { submitted: true };
}

async function submitLogin({ accountId, email, password }) {
  if (!loginBrowserView || activeAccountId !== accountId) {
    throw new Error('Login browser is not active');
  }

  return submitLoginOnWebContents(loginBrowserView.webContents, email, password);
}

async function waitForLoginFormReady(webContents, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isLiveWebContents(webContents)) {
      throw new Error('Login browser closed unexpectedly');
    }

    await acceptCookieConsent(webContents).catch(() => {});

    const ready = await webContents
      .executeJavaScript(LOGIN_FORM_READY_SCRIPT)
      .catch(() => false);

    if (ready) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    'Maloum login form did not become ready. Complete any security checks in the embedded browser, then try again.'
  );
}

async function findMaloumCredentialError(webContents) {
  return webContents.executeJavaScript(`
    (function() {
      const pattern = /email and\\/or password are incorrect/i;
      const selectors = ['[role="alert"]', '.error', '[class*="error"]', 'form p', 'form span'];
      for (const selector of selectors) {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
          const text = (node.textContent || '').trim();
          if (pattern.test(text)) {
            return text;
          }
        }
      }
      return null;
    })()
  `).catch(() => null);
}

async function waitForMaloumLoginOutcome(webContents, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isLiveWebContents(webContents)) {
      throw new Error('Login browser closed unexpectedly');
    }

    const url = webContents.getURL();
    if (isPostLoginUrl(url)) {
      return { success: true, url };
    }

    const credentialError = await findMaloumCredentialError(webContents);
    if (credentialError) {
      return { success: false, error: credentialError };
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return {
    success: false,
    error:
      'Login timed out. If a security check appeared, complete it in the embedded browser and try again.',
  };
}

async function captureMaloumSessionFromWebContents(accountId, webContents) {
  if (!isLiveWebContents(webContents)) {
    throw new Error('Browser view closed unexpectedly');
  }

  const currentUrl = webContents.getURL();
  if (!isPostLoginUrl(currentUrl)) {
    throw new Error(
      'Maloum login is not complete yet. Finish signing in inside the embedded browser, then continue.'
    );
  }

  warmSessionAccounts.add(accountId);

  const profileMeta = await scrapeMaloumProfileMetadata(webContents);
  const exported = await profileStorage.exportProfileFromPartition(accountId, webContents);

  if (!exported.cookies?.length) {
    throw new Error('Login succeeded but no Maloum cookies were captured.');
  }

  profileStorage.writeLocalProfile(accountId, exported);
  pendingStorageByAccount.set(accountId, exported.origins || []);
  storageInjectedForAccount.add(accountId);

  return {
    accountId,
    partitionId: `persist:creator-${accountId}`,
    displayName: profileMeta.displayName,
    username: profileMeta.username,
    postLoginUrl: profileMeta.postLoginUrl,
    avatarUrl: profileMeta.avatarUrl,
    cookies: exported.cookies,
    origins: exported.origins || [],
  };
}

async function captureMaloumSessionFromLoginView(accountId) {
  if (!loginBrowserView || activeAccountId !== accountId) {
    throw new Error('Login browser is not active');
  }

  return captureMaloumSessionFromWebContents(accountId, loginBrowserView.webContents);
}

async function reloginMaloumInWebContents({ accountId, webContents, email, password }) {
  if (!accountId || !email || !password) {
    throw new Error('Account ID, email, and password are required');
  }

  if (!isLiveWebContents(webContents)) {
    throw new Error('Browser view is not available');
  }

  await safeLoadURL(webContents, MALOUM_LOGIN_URL);
  await waitForLoginFormReady(webContents);
  await submitLoginOnWebContents(webContents, email.trim(), password);

  const outcome = await waitForMaloumLoginOutcome(webContents, 90000);
  if (!outcome.success) {
    throw new Error(outcome.error || 'Maloum login failed');
  }

  return captureMaloumSessionFromWebContents(accountId, webContents);
}

async function reloginMaloumOnVerifyView({ accountId, email, password }) {
  if (!verifyBrowserView || activeVerifyAccountId !== accountId) {
    throw new Error('Verify browser is not active for this account');
  }

  return reloginMaloumInWebContents({
    accountId,
    webContents: verifyBrowserView.webContents,
    email,
    password,
  });
}

async function loginCreatorLocallyInner({ accountId, email, password, clearExisting = true }) {
  if (!mainWindow) {
    return {
      ok: false,
      reason: 'transient_failure',
      message: 'Main window is not available',
    };
  }

  if (!accountId || !email || !password) {
    return {
      ok: false,
      reason: 'missing_credentials',
      message: 'Account ID, email, and password are required',
    };
  }

  if (clearExisting) {
    await clearSession(accountId);
  }

  parkActiveChatView();

  const view = createChatView(accountId);
  setActiveChatView(accountId, view);
  attachOffScreenChatView(view);

  try {
    await reloginMaloumInWebContents({
      accountId,
      webContents: view.webContents,
      email: email.trim(),
      password,
    });

    preparedChatPartitions.delete(accountId);
    return { ok: true, accountId };
  } catch (err) {
    warmSessionAccounts.delete(accountId);
    preparedChatPartitions.delete(accountId);
    return classifyMaloumLoginError(err instanceof Error ? err.message : String(err));
  } finally {
    destroyChatView(accountId);
    if (activeChatAccountId === accountId) {
      chatBrowserView = null;
      activeChatAccountId = null;
    }
  }
}

async function loginCreatorLocally(payload) {
  const accountId = payload?.accountId;
  return withAccountLoginLock(accountId, () => loginCreatorLocallyInner(payload));
}

async function scrapeMaloumProfileMetadata(webContents) {
  await safeLoadURL(webContents, MALOUM_PROFILE_URL);
  await waitUntilNavigated(
    webContents,
    45000,
    (current) => Boolean(current) && current.includes('maloum.com')
  );

  const currentUrl = webContents.getURL();
  if (currentUrl.includes('/login')) {
    throw new Error('Session was redirected to login while loading the Maloum profile.');
  }

  await new Promise((resolve) => setTimeout(resolve, 750));

  const scraped = await webContents.executeJavaScript(`
    (function() {
      const pathname = window.location.pathname || '';
      const creatorMatch = pathname.match(/\\/creator\\/([^/]+)/);
      const slug = creatorMatch ? creatorMatch[1] : null;
      const name =
        document.querySelector('h1.notranslate')?.textContent?.trim() ||
        document.querySelector('div.min-w-0 h1')?.textContent?.trim() ||
        null;
      const avatarUrl =
        document.querySelector('img.rounded-full.object-cover')?.src ||
        document.querySelector('div.relative.w-fit img.rounded-full')?.src ||
        null;
      return {
        displayName: name || (slug ? slug : 'Maloum Creator'),
        username: slug ? '@' + slug : null,
        avatarUrl,
        postLoginUrl: window.location.href,
      };
    })()
  `);

  return scraped;
}

/**
 * Runs Maloum login inside the embedded Electron BrowserView (staff machine egress),
 * then exports cookies/localStorage for the API to encrypt and store.
 */
async function loginAndCaptureMaloumSession({
  accountId,
  email,
  password,
  bounds,
  timeoutMs = 90000,
}) {
  if (!mainWindow) {
    throw new Error('Main window is not available');
  }

  if (!accountId || !email || !password) {
    throw new Error('Account ID, email, and password are required');
  }

  await clearSession(accountId);

  try {
    await showLoginBrowser({ accountId, bounds });
    await waitForLoginFormReady(loginBrowserView.webContents, timeoutMs);
    await submitLogin({ accountId, email: email.trim(), password });

    const outcome = await waitForMaloumLoginOutcome(
      loginBrowserView.webContents,
      timeoutMs
    );
    if (!outcome.success) {
      throw new Error(outcome.error || 'Maloum login failed');
    }

    return captureMaloumSessionFromLoginView(accountId);
  } catch (err) {
    if (bounds) {
      raiseLoginBrowser(bounds);
    }
    throw err;
  }
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

function getLocalCreatorProfileMeta(accountId) {
  return profileStorage.getLocalProfileMeta(accountId);
}

async function loadCreatorSession({ accountId, cookies, origins, force = false, savedAt = null }) {
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

  if (maloumCookies.length === 0) {
    warmSessionAccounts.delete(accountId);
    throw new Error('Failed to import Maloum session cookies.');
  }

  warmSessionAccounts.add(accountId);

  profileStorage.writeLocalProfile(accountId, {
    cookies,
    origins: origins || [],
    savedAt: savedAt || undefined,
  });

  return {
    imported: cookies.length,
    cookiesSet,
    cookiesFailed,
    accountId,
    partitionId: `persist:creator-${accountId}`,
  };
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
      force: Boolean(entry.force),
      savedAt: entry.savedAt || null,
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
  fullBrowserAccessByAccountId.delete(accountId);
  preparedBrowserModeByAccountId.delete(accountId);
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

/**
 * Download a Maloum avatar using the creator's Electron session so Maloum
 * sees the client IP, not the DomX backend/VPS.
 */
async function fetchCreatorAvatarImage({ accountId, sourceUrl }) {
  if (!accountId || typeof accountId !== 'string') {
    throw new Error('accountId is required');
  }

  if (!sourceUrl || typeof sourceUrl !== 'string') {
    throw new Error('sourceUrl is required');
  }

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error('Invalid source URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Source URL must be http or https');
  }

  const partitionSession = getPartitionSession(accountId);
  const response = await partitionSession.fetch(sourceUrl, {
    method: 'GET',
    headers: {
      Accept: 'image/*,*/*;q=0.8',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download avatar (${response.status})`);
  }

  const contentTypeHeader = response.headers.get('content-type') || '';
  const contentType = contentTypeHeader.split(';')[0].trim().toLowerCase() || 'image/jpeg';

  if (contentTypeHeader && !contentType.startsWith('image/')) {
    throw new Error('Downloaded content is not an image');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error('Downloaded avatar is empty');
  }

  if (buffer.length > 4 * 1024 * 1024) {
    throw new Error('Avatar image is too large (max 4MB)');
  }

  return {
    contentType,
    base64: buffer.toString('base64'),
    byteLength: buffer.length,
  };
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
  applyWebContentsGuards(view.webContents);
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
    if (isLiveWebContents(view.webContents)) {
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

async function prepareChatBrowserInner(accountId, options = {}) {
  const boot = options.boot === true;

  if (!mainWindow) {
    throw new Error('Main window is not available');
  }

  if (isChatPrepared(accountId)) {
    if (!boot) {
      const existingView = getChatView(accountId);
      if (existingView) {
        await refreshMaloumCreatorBadgesWithDelay(existingView.webContents, accountId);
      }
    }
    return { accountId, prepared: true, skipped: true };
  }

  if (hasLoadedChatView(accountId)) {
    const targetMode = browserModeKey(isFullBrowserAccess(accountId));
    if (preparedBrowserModeByAccountId.get(accountId) === targetMode) {
      preparedChatPartitions.add(accountId);
      const existingView = getChatView(accountId);
      if (existingView && !boot) {
        await refreshMaloumCreatorBadgesWithDelay(existingView.webContents, accountId);
      }
      return { accountId, prepared: true, skipped: true };
    }

    preparedChatPartitions.delete(accountId);
    const existingView = getChatView(accountId);
    if (existingView) {
      await ensureChatViewMatchesMode(existingView.webContents, accountId);
      preparedChatPartitions.add(accountId);
      return { accountId, prepared: true, skipped: true };
    }
  }

  if (preparedChatPartitions.has(accountId)) {
    preparedChatPartitions.delete(accountId);
  }

  if (!warmSessionAccounts.has(accountId)) {
    throw new Error('Session partition is not warm. Load session before preparing chat.');
  }

  const previouslyVisible =
    !boot && activeChatAccountId && activeChatAccountId !== accountId
      ? activeChatAccountId
      : null;

  if (!boot) {
    parkActiveChatView();
  }

  const view = createChatView(accountId);
  if (!boot) {
    setActiveChatView(accountId, view);
  }

  attachOffScreenChatView(view);

  try {
    await prepareMaloumChatPage(view.webContents, accountId);
  } catch (err) {
    destroyChatView(accountId);
    throw err;
  } finally {
    parkChatView(accountId);
    if (!boot) {
      if (activeChatAccountId === accountId) {
        chatBrowserView = null;
        activeChatAccountId = null;
      }
      if (previouslyVisible) {
        restoreVisibleChatIfNeeded(accountId);
      }
    }
  }

  const finalUrl = view.webContents.getURL();
  if (finalUrl.includes('/login')) {
    destroyChatView(accountId);
    throw new Error('Session expired or invalid — Maloum redirected to login.');
  }

  preparedChatPartitions.add(accountId);

  if (boot) {
    void saveCreatorProfile(accountId, view.webContents);
  } else {
    await saveCreatorProfile(accountId, view.webContents);
    await refreshMaloumCreatorBadgesWithDelay(view.webContents, accountId);
  }

  return { accountId, prepared: true };
}

function isChatPrepared(accountId) {
  return preparedChatPartitions.has(accountId) || hasLoadedChatView(accountId);
}

async function prepareAllChatBrowsers(accountIds) {
  const total = accountIds.length;
  let preparedCount = 0;
  const results = [];

  for (const accountId of accountIds) {
    try {
      const result = await prepareChatBrowser(accountId);
      preparedCount += 1;
      results.push({ accountId, ok: true, ...result });
      if (mainWindow) {
        mainWindow.webContents.send('creator:chat-prepare-progress', {
          accountId,
          ok: true,
          prepared: preparedCount,
          total,
        });
      }
    } catch (err) {
      preparedCount += 1;
      results.push({
        accountId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      if (mainWindow) {
        mainWindow.webContents.send('creator:chat-prepare-progress', {
          accountId,
          ok: false,
          prepared: preparedCount,
          total,
        });
      }
    }
  }

  return {
    prepared: results.filter((r) => r.ok).length,
    results,
  };
}

async function prepareAllChatBrowsersParallel(accountIds, concurrency = 3) {
  const uniqueIds = [...new Set(accountIds)];
  const toPrepare = uniqueIds.filter(
    (accountId) => !isChatPrepared(accountId) && warmSessionAccounts.has(accountId)
  );

  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < toPrepare.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const accountId = toPrepare[currentIndex];

      try {
        const result = await prepareChatBrowserInner(accountId, { boot: true });
        results.push({ accountId, ok: true, ...result });
      } catch (err) {
        results.push({
          accountId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), toPrepare.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    prepared: results.filter((entry) => entry.ok).length,
    results,
  };
}

async function showChatBrowser({ accountId, bounds, fullBrowserAccess = false }) {
  return withPrepareLock(() =>
    showChatBrowserInner({ accountId, bounds, fullBrowserAccess })
  );
}

async function showChatBrowserInner({ accountId, bounds, fullBrowserAccess = false }) {
  if (!mainWindow) {
    throw new Error('Main window is not available');
  }

  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Chat browser bounds are not available');
  }

  fullBrowserAccessByAccountId.set(accountId, Boolean(fullBrowserAccess));

  if (activeChatAccountId && activeChatAccountId !== accountId) {
    parkChatView(activeChatAccountId);
  }

  if (!isChatPrepared(accountId)) {
    if (!warmSessionAccounts.has(accountId)) {
      throw new Error('Session partition is not warm. Load session before showing chat.');
    }
    await prepareChatBrowserInner(accountId);
  }

  let view = getChatView(accountId);
  const reusedWarmView = Boolean(view && hasLoadedChatView(accountId));

  if (view) {
    await ensureChatViewMatchesMode(view.webContents, accountId);
  }

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
  lastVisibleChatAccountId = null;
  lastVisibleChatBounds = null;
  if (!loginBrowserView && !verifyBrowserView) {
    activeAccountId = null;
  }
}

function hideAllBrowserViewsForUpdate() {
  hideLoginBrowser();
  hideVerifyBrowser();

  for (const accountId of [...chatBrowserViews.keys()]) {
    parkChatView(accountId);
  }

  chatBrowserView = null;
  activeChatAccountId = null;
  if (!loginBrowserView && !verifyBrowserView) {
    activeAccountId = null;
  }
}

async function reloadChatBrowser(accountId) {
  const resolvedId = accountId || activeChatAccountId;
  if (!resolvedId) {
    throw new Error('No active chat browser to reload');
  }

  const view = getChatView(resolvedId);
  if (!isLiveBrowserView(view)) {
    throw new Error('Chat browser not available');
  }

  const webContents = view.webContents;
  const currentUrl = webContents.getURL();
  if (!currentUrl || currentUrl === 'about:blank') {
    throw new Error('No page loaded to reload');
  }

  await webContents.reload();
  return { accountId: resolvedId, url: currentUrl };
}

async function setDomXTheme(theme) {
  currentDomXTheme = theme;

  for (const [accountId, view] of chatBrowserViews.entries()) {
    if (!isLiveBrowserView(view)) {
      continue;
    }

    view.setBackgroundColor(maloumChatBackgroundColor(theme));

    const url = view.webContents.getURL();
    if (!shouldRefreshMaloumUI(url, isFullBrowserAccess(accountId))) {
      continue;
    }

    try {
      await runRefreshMaloumPageUISerialized(view.webContents, theme, accountId, url);
    } catch {
      // View may be mid-navigation
    }
  }
}

function getTranslationSettings() {
  return { ...currentTranslationSettings };
}

async function applyTranslationSettingsToAllChatViews(settings) {
  for (const [, view] of chatBrowserViews.entries()) {
    if (!isLiveBrowserView(view)) {
      continue;
    }

    const url = view.webContents.getURL();
    if (!isMaloumChatUrl(url)) {
      continue;
    }

    try {
      await applyTranslationSettings(view.webContents, settings);
    } catch {
      // View may be mid-navigation
    }
  }
}

async function setTranslationSettings(settings = {}) {
  if (typeof settings.preSendEnabled === 'boolean') {
    currentTranslationSettings.preSendEnabled = settings.preSendEnabled;
  }

  if (typeof settings.historyEnabled === 'boolean') {
    currentTranslationSettings.historyEnabled = settings.historyEnabled;
  }

  await applyTranslationSettingsToAllChatViews(currentTranslationSettings);
  return getTranslationSettings();
}

module.exports = {
  setMainWindow,
  showLoginBrowser,
  resizeLoginBrowser,
  hideLoginBrowser,
  submitLogin,
  loginAndCaptureMaloumSession,
  completeLoginCaptureFromActiveLogin: captureMaloumSessionFromLoginView,
  importCookies,
  loadCreatorSession,
  hydrateCreatorProfile,
  hasLocalCreatorProfile,
  getLocalCreatorProfileMeta,
  preloadCreatorSessions,
  isCreatorSessionWarm,
  getActiveChatAccountId,
  prepareChatBrowser,
  prepareAllChatBrowsers,
  prepareAllChatBrowsersParallel,
  isChatPrepared,
  clearSession,
  showChatBrowser,
  resizeChatBrowser,
  hideChatBrowser,
  hideAllBrowserViewsForUpdate,
  reloadChatBrowser,
  showVerifyBrowser,
  resizeVerifyBrowser,
  hideVerifyBrowser,
  verifyMaloumSessionForAccount,
  reloginMaloumOnVerifyView,
  loginCreatorLocally,
  fetchCreatorAvatarImage,
  setDomXTheme,
  getTranslationSettings,
  setTranslationSettings,
  getAllCreatorBadgeStates,
  getCreatorBadgeState,
  setActiveChatter,
  registerCreatorMapping: registerCreatorIdMapping,
  hydrateSentMessages: hydrateSentMessageRecords,
  releaseCreatorChat,
  releaseAllCreatorChats,
};
