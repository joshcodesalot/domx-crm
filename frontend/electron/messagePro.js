const path = require('path');
const { app, BrowserWindow, BrowserView, session } = require('electron');
const { applyWebContentsGuards, isLiveWebContents, isLiveBrowserView } = require('./webContentsGuards');
const { refreshMaloumPageUI } = require('./maloumChatUi');
const { getDomXTheme } = require('./creatorBrowser');

const MALOUM_CHAT_URL = 'https://app.maloum.com/chat';
const OPEN_FAN_TAB_SENTINEL = '__domx_mp__';
const HOME_TAB_ID = 'home';

const isDev = !app.isPackaged;

let messageProWindow = null;
/** @type {Map<string, import('electron').BrowserView>} */
const messageProViews = new Map();
let activeViewKey = null;
let lastBounds = null;

function viewKey(accountId, tabId) {
  return `${accountId}:${tabId}`;
}

function getPartitionSession(accountId) {
  return session.fromPartition(`persist:creator-${accountId}`);
}

function maloumChatBackgroundColor(theme = getDomXTheme()) {
  return theme === 'dark' || theme === 'night' ? '#0a0a0a' : '#ffffff';
}

function chatUrlForTab(tabId) {
  if (!tabId || tabId === HOME_TAB_ID) {
    return MALOUM_CHAT_URL;
  }
  return `${MALOUM_CHAT_URL}/${tabId}`;
}

function getMessageProWindow() {
  return messageProWindow && !messageProWindow.isDestroyed() ? messageProWindow : null;
}

function parkView(key) {
  const win = getMessageProWindow();
  const view = messageProViews.get(key);
  if (!win || !view) {
    return;
  }
  if (win.getBrowserViews().includes(view)) {
    win.removeBrowserView(view);
  }
}

function parkActiveView() {
  if (activeViewKey) {
    parkView(activeViewKey);
  }
}

function destroyView(key) {
  const view = messageProViews.get(key);
  if (!view) {
    return;
  }

  parkView(key);

  if (isLiveWebContents(view.webContents)) {
    try {
      view.webContents.close();
    } catch {
      // Best-effort close.
    }
  }

  messageProViews.delete(key);
  if (activeViewKey === key) {
    activeViewKey = null;
  }
}

function destroyCreatorViews(accountId) {
  for (const key of [...messageProViews.keys()]) {
    if (key.startsWith(`${accountId}:`)) {
      destroyView(key);
    }
  }
}

function destroyAllViews() {
  for (const key of [...messageProViews.keys()]) {
    destroyView(key);
  }
  activeViewKey = null;
  lastBounds = null;
}

function applyBounds(bounds) {
  const win = getMessageProWindow();
  if (!win || !bounds) {
    return;
  }

  lastBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };

  if (!activeViewKey) {
    return;
  }

  const view = messageProViews.get(activeViewKey);
  if (!view || !win.getBrowserViews().includes(view)) {
    return;
  }

  if (lastBounds.width <= 0 || lastBounds.height <= 0) {
    return;
  }

  view.setBounds(lastBounds);
}

async function refreshMessageProViewUI(webContents) {
  if (!isLiveWebContents(webContents)) {
    return;
  }

  const theme = getDomXTheme();
  try {
    await refreshMaloumPageUI(webContents, theme, webContents.getURL(), null, {}, {
      fullBrowserAccess: false,
    });
  } catch {
    // View may be mid-navigation.
  }

  await injectOpenInTabButtons(webContents);
}

function buildOpenInTabInjectionScript() {
  return `
    (function() {
      if (window.__domxMessageProInjected) {
        return true;
      }
      window.__domxMessageProInjected = true;

      const STYLE_ID = 'domx-mp-open-tab-style';
      const BUTTON_CLASS = 'domx-mp-open-tab';
      const SENTINEL = ${JSON.stringify(OPEN_FAN_TAB_SENTINEL)};

      function ensureStyle() {
        if (document.getElementById(STYLE_ID)) {
          return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = \`
          .\${BUTTON_CLASS} {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            margin-left: 6px;
            border-radius: 6px;
            border: 1px solid rgba(148, 163, 184, 0.45);
            background: rgba(59, 130, 246, 0.15);
            color: #60a5fa;
            cursor: pointer;
            flex-shrink: 0;
            padding: 0;
            line-height: 1;
            z-index: 20;
          }
          .\${BUTTON_CLASS}:hover {
            background: rgba(59, 130, 246, 0.3);
            color: #93c5fd;
          }
          .\${BUTTON_CLASS} svg {
            width: 12px;
            height: 12px;
            pointer-events: none;
          }
        \`;
        document.head.appendChild(style);
      }

      function extractChatId(href) {
        if (!href) {
          return null;
        }
        try {
          const url = new URL(href, window.location.origin);
          const match = url.pathname.match(/\\/chat\\/([a-fA-F0-9]+)/);
          return match ? match[1] : null;
        } catch {
          const match = String(href).match(/\\/chat\\/([a-fA-F0-9]+)/);
          return match ? match[1] : null;
        }
      }

      function findConversationAnchor(node) {
        if (!(node instanceof Element)) {
          return null;
        }
        if (node.matches('a[href*="/chat/"]')) {
          const chatId = extractChatId(node.getAttribute('href'));
          if (chatId) {
            return node;
          }
        }
        return node.querySelector('a[href*="/chat/"]');
      }

      function findRowContainer(anchor) {
        let node = anchor;
        for (let i = 0; i < 8 && node; i += 1) {
          if (
            node.parentElement &&
            (node.parentElement.id === 'leftColumn' ||
              node.parentElement.getAttribute('role') === 'list' ||
              node.parentElement.classList.contains('overflow-y-auto'))
          ) {
            return node;
          }
          node = node.parentElement;
        }
        return anchor.closest('a[href*="/chat/"]') || anchor;
      }

      function readFanMeta(row, chatId) {
        const text = (row.innerText || '').trim();
        const lines = text
          .split('\\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const displayName = lines[0] || chatId;
        const img = row.querySelector('img');
        const avatarUrl = img ? img.src || null : null;
        return { displayName, avatarUrl };
      }

      function createButton(chatId, displayName, avatarUrl) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = BUTTON_CLASS;
        button.title = 'Open in Message Pro tab';
        button.setAttribute('data-domx-chat-id', chatId);
        button.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 8h5"/><path d="M14 12h5"/><path d="M14 16h5"/></svg>';
        button.addEventListener(
          'click',
          (event) => {
            event.preventDefault();
            event.stopPropagation();
            console.log(
              SENTINEL +
                JSON.stringify({
                  chatId,
                  displayName,
                  avatarUrl,
                })
            );
          },
          true
        );
        return button;
      }

      function injectForAnchor(anchor) {
        const chatId = extractChatId(anchor.getAttribute('href'));
        if (!chatId) {
          return;
        }

        const row = findRowContainer(anchor);
        if (!row || row.querySelector('.' + BUTTON_CLASS + '[data-domx-chat-id="' + chatId + '"]')) {
          return;
        }

        const { displayName, avatarUrl } = readFanMeta(row, chatId);
        const button = createButton(chatId, displayName, avatarUrl);

        const tipOrMeta =
          row.querySelector('[class*="tip"]') ||
          row.querySelector('span') ||
          null;

        if (tipOrMeta && tipOrMeta.parentElement) {
          tipOrMeta.parentElement.insertBefore(button, tipOrMeta.nextSibling);
        } else {
          row.appendChild(button);
        }
      }

      function scan() {
        if (!window.location.pathname.includes('/chat')) {
          return;
        }
        // Only inject on the inbox (home) path, not an open conversation.
        if (/\\/chat\\/[a-fA-F0-9]+/.test(window.location.pathname)) {
          return;
        }

        ensureStyle();
        const root = document.querySelector('#leftColumn') || document.body;
        const anchors = root.querySelectorAll('a[href*="/chat/"]');
        anchors.forEach((anchor) => injectForAnchor(anchor));
      }

      const observer = new MutationObserver(() => {
        scan();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      scan();
      setInterval(scan, 1500);
      return true;
    })()
  `;
}

async function injectOpenInTabButtons(webContents) {
  if (!isLiveWebContents(webContents)) {
    return;
  }

  const url = webContents.getURL();
  if (!url.includes('/chat') || /\/chat\/[a-fA-F0-9]+/.test(url)) {
    return;
  }

  try {
    await webContents.executeJavaScript(buildOpenInTabInjectionScript());
  } catch {
    // Page may not be ready yet.
  }
}

function attachOpenFanTabListener(webContents, accountId) {
  webContents.on('console-message', (event, _level, message) => {
    const text =
      typeof message === 'string'
        ? message
        : typeof event?.message === 'string'
          ? event.message
          : '';

    if (!text.startsWith(OPEN_FAN_TAB_SENTINEL)) {
      return;
    }

    try {
      const payload = JSON.parse(text.slice(OPEN_FAN_TAB_SENTINEL.length));
      const win = getMessageProWindow();
      if (!win) {
        return;
      }

      win.webContents.send('messagepro:open-fan-tab', {
        accountId,
        chatId: payload.chatId,
        displayName: payload.displayName || payload.chatId,
        avatarUrl: payload.avatarUrl || null,
      });
    } catch {
      // Ignore malformed payloads.
    }
  });
}

function attachViewListeners(view, accountId, tabId) {
  const webContents = view.webContents;

  const refresh = () => {
    void refreshMessageProViewUI(webContents);
  };

  webContents.on('did-finish-load', refresh);
  webContents.on('did-navigate', refresh);
  webContents.on('did-navigate-in-page', refresh);

  if (tabId === HOME_TAB_ID) {
    attachOpenFanTabListener(webContents, accountId);
  }
}

function createView(accountId, tabId) {
  const key = viewKey(accountId, tabId);
  const existing = messageProViews.get(key);
  if (existing && isLiveBrowserView(existing)) {
    return existing;
  }

  const view = new BrowserView({
    webPreferences: {
      session: getPartitionSession(accountId),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  view.setBackgroundColor(maloumChatBackgroundColor());
  applyWebContentsGuards(view.webContents);
  attachViewListeners(view, accountId, tabId);
  messageProViews.set(key, view);
  return view;
}

async function ensureViewLoaded(accountId, tabId) {
  const key = viewKey(accountId, tabId);
  let view = messageProViews.get(key);

  if (!view || !isLiveBrowserView(view)) {
    view = createView(accountId, tabId);
  }

  const targetUrl = chatUrlForTab(tabId);
  const currentUrl = view.webContents.getURL();
  const needsLoad =
    !currentUrl ||
    currentUrl === 'about:blank' ||
    (tabId === HOME_TAB_ID
      ? !currentUrl.includes('/chat') || /\/chat\/[a-fA-F0-9]+/.test(currentUrl)
      : !currentUrl.includes(`/chat/${tabId}`));

  if (needsLoad) {
    await view.webContents.loadURL(targetUrl);
  }

  const loadedUrl = view.webContents.getURL();
  if (loadedUrl.includes('/login')) {
    destroyView(key);
    throw new Error('Session expired or invalid — Maloum redirected to login.');
  }

  await refreshMessageProViewUI(view.webContents);
  return view;
}

async function showView({ accountId, tabId = HOME_TAB_ID, bounds }) {
  const win = getMessageProWindow();
  if (!win) {
    throw new Error('Message Pro window is not available');
  }

  const nextKey = viewKey(accountId, tabId || HOME_TAB_ID);

  if (activeViewKey && activeViewKey !== nextKey) {
    parkView(activeViewKey);
  }

  const view = await ensureViewLoaded(accountId, tabId || HOME_TAB_ID);

  if (!win.getBrowserViews().includes(view)) {
    win.addBrowserView(view);
  }

  activeViewKey = nextKey;
  view.setBackgroundColor(maloumChatBackgroundColor());
  applyBounds(bounds || lastBounds);

  return { accountId, tabId: tabId || HOME_TAB_ID };
}

function setBounds(bounds) {
  applyBounds(bounds);
}

function hideActiveView() {
  parkActiveView();
  activeViewKey = null;
}

function closeTab({ accountId, tabId }) {
  if (!accountId || !tabId) {
    return { closed: false };
  }

  const key = viewKey(accountId, tabId);
  destroyView(key);
  return { closed: true };
}

function closeCreator({ accountId }) {
  if (!accountId) {
    return { closed: false };
  }

  destroyCreatorViews(accountId);
  return { closed: true };
}

async function applyDomXTheme(theme) {
  for (const view of messageProViews.values()) {
    if (!isLiveBrowserView(view)) {
      continue;
    }

    view.setBackgroundColor(maloumChatBackgroundColor(theme));
    try {
      await refreshMaloumPageUI(view.webContents, theme, view.webContents.getURL(), null, {}, {
        fullBrowserAccess: false,
      });
      await injectOpenInTabButtons(view.webContents);
    } catch {
      // Ignore mid-navigation failures.
    }
  }
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

  win.on('resize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('messagepro:window-resized');
    }
  });

  win.on('closed', () => {
    destroyAllViews();
    if (messageProWindow === win) {
      messageProWindow = null;
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (isDev) {
    win.loadURL('http://localhost:5173/#/message-pro');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'), {
      hash: '/message-pro',
    });
  }

  return { opened: true, focused: false };
}

module.exports = {
  openMessageProWindow,
  showView,
  setBounds,
  hideActiveView,
  closeTab,
  closeCreator,
  applyDomXTheme,
  getMessageProWindow,
  HOME_TAB_ID,
};
