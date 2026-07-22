const MESSAGES_BADGE_SELECTOR =
  '#root > div > div > section > div > nav > ul > li:nth-child(4) > button > div > div';

const NOTIFICATION_BADGE_SELECTOR =
  '#root > div > div > section > div > nav > ul > li:nth-child(9) > button > div > div';

const BADGE_POLL_INTERVAL_MS = 5000;
const BACKGROUND_BADGE_POLL_INTERVAL_MS = 30000;
const POST_RENDER_DELAY_MS = 500;

let mainWindowRef = null;
let badgePollInterval = null;
let backgroundBadgePollInterval = null;
let getPreparedViewsFn = null;
let getActiveAccountIdFn = null;
const creatorBadgeState = new Map();
const postRenderDelayTimers = new Map();

function setMainWindow(win) {
  mainWindowRef = win;
}

function parseBadgeCountText(rawText) {
  if (!rawText) {
    return 0;
  }

  const cleanedText = String(rawText).trim();
  if (!cleanedText) {
    return 0;
  }

  const count = Number.parseInt(cleanedText, 10);
  if (Number.isNaN(count)) {
    return 0;
  }

  return count;
}

function isMaloumChatUrl(url) {
  return Boolean(url) && url.includes('maloum.com') && url.includes('/chat') && !url.includes('/login');
}

async function readBadgeText(webContents, selector) {
  if (!webContents || webContents.isDestroyed()) {
    return '';
  }

  return webContents.executeJavaScript(`
    (function() {
      const badge = document.querySelector(${JSON.stringify(selector)});
      if (!badge) {
        return '';
      }
      return badge.textContent || '';
    })()
  `);
}

async function getMaloumMessageCount(webContents) {
  try {
    const rawText = await readBadgeText(webContents, MESSAGES_BADGE_SELECTOR);
    return parseBadgeCountText(rawText);
  } catch (error) {
    console.warn('Failed to read Maloum message badge count:', error);
    return 0;
  }
}

async function getMaloumNotificationCount(webContents) {
  try {
    const rawText = await readBadgeText(webContents, NOTIFICATION_BADGE_SELECTOR);
    return parseBadgeCountText(rawText);
  } catch (error) {
    console.warn('Failed to read Maloum notification badge count:', error);
    return 0;
  }
}

async function getMaloumBadgeCounts(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { messages: 0, notificationCount: 0 };
  }

  try {
    const rawCounts = await webContents.executeJavaScript(`
      (function() {
        function readBadge(selector) {
          const badge = document.querySelector(selector);
          if (!badge) {
            return '';
          }
          return badge.textContent || '';
        }

        return {
          messages: readBadge(${JSON.stringify(MESSAGES_BADGE_SELECTOR)}),
          notifications: readBadge(${JSON.stringify(NOTIFICATION_BADGE_SELECTOR)}),
        };
      })()
    `);

    return {
      messages: parseBadgeCountText(rawCounts.messages),
      notificationCount: parseBadgeCountText(rawCounts.notifications),
    };
  } catch (error) {
    console.warn('Failed to read Maloum badge counts:', error);
    return { messages: 0, notificationCount: 0 };
  }
}

async function getMaloumMessageCountFromPage(page) {
  try {
    const badge = page.locator(MESSAGES_BADGE_SELECTOR);

    if ((await badge.count()) === 0) {
      return 0;
    }

    const rawText = await badge.first().innerText().catch(() => '');
    return parseBadgeCountText(rawText);
  } catch (error) {
    console.warn('Failed to read Maloum message badge count:', error);
    return 0;
  }
}

async function getMaloumNotificationCountFromPage(page) {
  try {
    const badge = page.locator(NOTIFICATION_BADGE_SELECTOR);

    if ((await badge.count()) === 0) {
      return 0;
    }

    const rawText = await badge.first().innerText().catch(() => '');
    return parseBadgeCountText(rawText);
  } catch (error) {
    console.warn('Failed to read Maloum notification badge count:', error);
    return 0;
  }
}

function emitBadgeCountsUpdated(accountId) {
  const state = creatorBadgeState.get(accountId);
  if (!state || !mainWindowRef || mainWindowRef.isDestroyed()) {
    return;
  }

  mainWindowRef.webContents.send('creator:badge-counts-updated', {
    accountId,
    notificationCount: state.notificationCount,
    messages: state.messages,
  });
}

function updateCreatorBadgeState(accountId, partial) {
  if (!accountId) {
    return;
  }

  const existing = creatorBadgeState.get(accountId) || {
    notificationCount: 0,
    messages: 0,
  };

  const next = {
    notificationCount:
      partial.notificationCount !== undefined
        ? partial.notificationCount
        : existing.notificationCount,
    messages: partial.messages !== undefined ? partial.messages : existing.messages,
  };

  const changed =
    next.notificationCount !== existing.notificationCount ||
    next.messages !== existing.messages;

  creatorBadgeState.set(accountId, next);

  if (changed) {
    emitBadgeCountsUpdated(accountId);
  }
}

function getCreatorBadgeState(accountId) {
  const state = creatorBadgeState.get(accountId);
  return state ? { ...state } : { notificationCount: 0, messages: 0 };
}

function getAllCreatorBadgeStates() {
  const result = {};
  for (const [accountId, state] of creatorBadgeState.entries()) {
    result[accountId] = { ...state };
  }
  return result;
}

async function refreshMaloumCreatorBadges(webContents, accountId) {
  if (!accountId || !webContents || webContents.isDestroyed()) {
    return;
  }

  const url = webContents.getURL();
  if (!isMaloumChatUrl(url)) {
    return;
  }

  const { messages, notificationCount } = await getMaloumBadgeCounts(webContents);
  updateCreatorBadgeState(accountId, { messages, notificationCount });
}

function schedulePostRenderBadgeRefresh(webContents, accountId) {
  if (!webContents || webContents.isDestroyed() || !accountId) {
    return;
  }

  const wcId = webContents.id;
  const existingTimer = postRenderDelayTimers.get(wcId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    postRenderDelayTimers.delete(wcId);
    if (!webContents.isDestroyed()) {
      void refreshMaloumCreatorBadges(webContents, accountId);
    }
  }, POST_RENDER_DELAY_MS);

  postRenderDelayTimers.set(wcId, timer);
}

async function refreshMaloumCreatorBadgesWithDelay(webContents, accountId) {
  await refreshMaloumCreatorBadges(webContents, accountId);
  schedulePostRenderBadgeRefresh(webContents, accountId);
}

function shouldSkipBadgePolling() {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    return true;
  }

  if (mainWindowRef.isMinimized() || !mainWindowRef.isVisible()) {
    return true;
  }

  return false;
}

function pollPreparedViewBadges({ accountId, webContents }, activeAccountId, scope) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  const isActive = accountId === activeAccountId;
  if (scope === 'active' && !isActive) {
    return;
  }
  if (scope === 'background' && isActive) {
    return;
  }

  const url = webContents.getURL();
  if (!isMaloumChatUrl(url)) {
    return;
  }

  void refreshMaloumCreatorBadges(webContents, accountId);
}

function runBadgePoll(scope) {
  if (shouldSkipBadgePolling()) {
    return;
  }

  const views = typeof getPreparedViewsFn === 'function' ? getPreparedViewsFn() : [];
  if (!views || views.length === 0) {
    return;
  }

  const activeAccountId =
    typeof getActiveAccountIdFn === 'function' ? getActiveAccountIdFn() : null;

  for (const view of views) {
    pollPreparedViewBadges(view, activeAccountId, scope);
  }
}

function startBadgePolling(getPreparedViews, getActiveAccountId) {
  if (badgePollInterval) {
    return;
  }

  getPreparedViewsFn = getPreparedViews;
  getActiveAccountIdFn = getActiveAccountId;

  badgePollInterval = setInterval(() => {
    try {
      runBadgePoll('active');
    } catch (err) {
      console.warn('Badge polling skipped due to error:', err.message);
    }
  }, BADGE_POLL_INTERVAL_MS);

  backgroundBadgePollInterval = setInterval(() => {
    try {
      runBadgePoll('background');
    } catch (err) {
      console.warn('Background badge polling skipped due to error:', err.message);
    }
  }, BACKGROUND_BADGE_POLL_INTERVAL_MS);
}

function stopBadgePolling() {
  if (badgePollInterval) {
    clearInterval(badgePollInterval);
    badgePollInterval = null;
  }

  if (backgroundBadgePollInterval) {
    clearInterval(backgroundBadgePollInterval);
    backgroundBadgePollInterval = null;
  }

  getPreparedViewsFn = null;
  getActiveAccountIdFn = null;

  for (const timer of postRenderDelayTimers.values()) {
    clearTimeout(timer);
  }
  postRenderDelayTimers.clear();
}

module.exports = {
  MESSAGES_BADGE_SELECTOR,
  NOTIFICATION_BADGE_SELECTOR,
  setMainWindow,
  parseBadgeCountText,
  parseNotificationBadgeText: parseBadgeCountText,
  getMaloumMessageCount,
  getMaloumNotificationCount,
  getMaloumBadgeCounts,
  getMaloumMessageCountFromPage,
  getMaloumNotificationCountFromPage,
  updateCreatorBadgeState,
  getCreatorBadgeState,
  getAllCreatorBadgeStates,
  refreshMaloumCreatorBadges,
  refreshMaloumCreatorBadgesWithDelay,
  schedulePostRenderBadgeRefresh,
  startBadgePolling,
  stopBadgePolling,
};
