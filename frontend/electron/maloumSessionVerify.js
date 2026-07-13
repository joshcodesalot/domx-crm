const { refreshMaloumChatUI } = require('./maloumChatUi');

const MALOUM_PROFILE_URL = 'https://app.maloum.com/profile';
const MALOUM_CHAT_URL = 'https://app.maloum.com/chat';

const PROFILE_IMAGE_SELECTOR =
  '#root > div > div > div > div.mx-auto.flex.w-full.max-w-\\[544px\\].flex-col.xs\\:px-0.px-4 > div.relative.z-10.-mt-10.mb-4.sm\\:-mt-14 > div.mb-1\\.5.flex > div > img';

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

async function waitForNetworkIdle(webContents, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (webContents.isDestroyed()) {
      return;
    }
    if (!webContents.isLoading()) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!webContents.isLoading()) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function navigateToUrl(webContents, url, timeoutMs = 30000) {
  await safeLoadURL(webContents, url);
  await waitUntilNavigated(
    webContents,
    timeoutMs,
    (current) => current.includes('maloum.com')
  );
  await waitForNetworkIdle(webContents, 15000).catch(() => {});
}

async function extractProfileImageUrl(webContents) {
  if (webContents.isDestroyed()) {
    return null;
  }

  return webContents.executeJavaScript(`
    (function() {
      const primary = document.querySelector(${JSON.stringify(PROFILE_IMAGE_SELECTOR)});
      if (primary && primary.src) {
        return primary.src;
      }
      const fallback =
        document.querySelector('img.rounded-full.object-cover') ||
        document.querySelector('div.relative.w-fit img.rounded-full');
      return fallback?.src || null;
    })()
  `);
}

async function getProfilePageState(webContents) {
  if (webContents.isDestroyed()) {
    return { onLogin: true, hasRoot: false };
  }

  return webContents.executeJavaScript(`
    (function() {
      const path = window.location.pathname || '';
      return {
        onLogin: path.includes('/login'),
        hasRoot: Boolean(document.querySelector('#root')),
        path,
      };
    })()
  `);
}

async function waitForMaloumChatRoot(webContents, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (webContents.isDestroyed()) {
      return false;
    }

    const pageState = await getProfilePageState(webContents);
    if (pageState.hasRoot && !pageState.onLogin) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

async function waitForProfileImageUrl(webContents, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (webContents.isDestroyed()) {
      return null;
    }

    const profileImageUrl = await extractProfileImageUrl(webContents);
    if (profileImageUrl) {
      return profileImageUrl;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return extractProfileImageUrl(webContents);
}

/**
 * Verify a Maloum creator session via /profile, then return to /chat with DomX UI applied.
 */
async function verifyMaloumSession(webContents, accountId, options = {}) {
  const { currentDomXTheme = 'light', beforeNavigate } = options;

  try {
    if (typeof beforeNavigate === 'function') {
      await beforeNavigate(webContents, accountId);
    }

    await navigateToUrl(webContents, MALOUM_PROFILE_URL, 30000);

    const profileUrl = webContents.getURL();
    if (profileUrl.includes('/login')) {
      return {
        verified: false,
        reason: 'Redirected to login',
        profileImageUrl: null,
      };
    }

    const profileState = await getProfilePageState(webContents);
    if (profileState.onLogin) {
      return {
        verified: false,
        reason: 'Redirected to login',
        profileImageUrl: null,
      };
    }

    if (!profileState.hasRoot) {
      return {
        verified: false,
        reason: 'Profile page did not load',
        profileImageUrl: null,
      };
    }

    const profileImageUrl = await waitForProfileImageUrl(webContents);

    await navigateToUrl(webContents, MALOUM_CHAT_URL, 30000);

    const chatUrl = webContents.getURL();
    if (chatUrl.includes('/login')) {
      return {
        verified: false,
        reason: 'Redirected to login after profile check',
        profileImageUrl: null,
      };
    }

    const chatReady = await waitForMaloumChatRoot(webContents);
    if (!chatReady) {
      return {
        verified: false,
        reason: 'Maloum chat page did not finish loading',
        profileImageUrl: null,
      };
    }

    await refreshMaloumChatUI(webContents, currentDomXTheme);

    return {
      verified: true,
      reason: 'Profile page loaded',
      profileImageUrl: profileImageUrl || null,
    };
  } catch (error) {
    console.warn('Maloum session verification failed:', error);
    return {
      verified: false,
      reason: error.message || 'Verification failed',
      profileImageUrl: null,
    };
  }
}

module.exports = {
  MALOUM_PROFILE_URL,
  MALOUM_CHAT_URL,
  PROFILE_IMAGE_SELECTOR,
  verifyMaloumSession,
};
