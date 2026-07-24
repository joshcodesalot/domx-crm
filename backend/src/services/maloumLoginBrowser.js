const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const {
  MaloumApiError,
  WrongPasswordError,
  resolveMaloumProxyUrl,
  extractSessionTokens,
  parseJsonSafe,
  isCloudflareBlocked,
  MALOUM_CLIENT_TIMEZONE,
  MALOUM_ACCEPT_LANGUAGE,
  USER_AGENT,
  API_BASE,
  APP_ORIGIN,
} = require('./maloumClient');

chromium.use(StealthPlugin());

const LOGIN_PAGE_URL = `${APP_ORIGIN}/login`;
const LOGIN_API_URL = `${API_BASE}/user-management/login`;
const CF_WAIT_MS = 60_000;
const NAV_TIMEOUT_MS = 60_000;

function parseProxyForPlaywright(proxyUrl) {
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new MaloumApiError('Maloum proxy URL is invalid', 400);
  }

  const server = `${parsed.protocol}//${parsed.host}`;
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;

  const proxy = { server };
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  return proxy;
}

function browserExtraHeaders() {
  return {
    'accept-language': MALOUM_ACCEPT_LANGUAGE,
    'sec-ch-ua':
      '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

function loginRequestHeaders() {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    origin: APP_ORIGIN,
    referer: `${APP_ORIGIN}/`,
    'accept-language': MALOUM_ACCEPT_LANGUAGE,
    'x-timezone': MALOUM_CLIENT_TIMEZONE,
    'sec-ch-ua':
      '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  };
}

async function waitForCloudflareClear(page) {
  await page.waitForFunction(
    () => {
      const text = (document.body && document.body.innerText) || '';
      const title = document.title || '';
      const blocked =
        /just a moment/i.test(text) ||
        /checking your browser/i.test(text) ||
        /attention required/i.test(text) ||
        /cloudflare/i.test(title);
      return !blocked;
    },
    { timeout: CF_WAIT_MS }
  );
}

/**
 * Headless Playwright + stealth login through the US residential proxy.
 * Used when undici login is blocked by Cloudflare.
 * Returns the same session token object as extractSessionTokens().
 */
async function loginWithBrowser({ usernameOrEmail, password, proxyUrl }) {
  if (!usernameOrEmail || !password) {
    throw new MaloumApiError('Email/username and password are required', 400);
  }

  const resolvedProxy = resolveMaloumProxyUrl(proxyUrl);
  const proxy = parseProxyForPlaywright(resolvedProxy);
  const identifier = String(usernameOrEmail).trim();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: MALOUM_CLIENT_TIMEZONE,
      userAgent: USER_AGENT,
      extraHTTPHeaders: browserExtraHeaders(),
      viewport: { width: 1366, height: 768 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    await page.goto(LOGIN_PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    try {
      await waitForCloudflareClear(page);
    } catch (err) {
      const snippet = (await page.content().catch(() => '')).slice(0, 200);
      console.warn(
        '[maloumLoginBrowser] Cloudflare wait timed out:',
        err.message,
        snippet
      );
      throw new MaloumApiError(
        'Maloum blocked this request (Cloudflare/proxy). Rotate MALOUM_PROXY_URL and retry.',
        403
      );
    }

    const response = await context.request.post(LOGIN_API_URL, {
      headers: loginRequestHeaders(),
      data: {
        usernameOrEmail: identifier,
        password: String(password),
      },
      timeout: NAV_TIMEOUT_MS,
    });

    const status = response.status();
    const text = await response.text();
    const contentType = response.headers()['content-type'] || '';
    const parsed = parseJsonSafe(text);

    if (status === 401) {
      throw new WrongPasswordError('Password not correct');
    }

    if (isCloudflareBlocked(status, text, contentType) || !response.ok()) {
      console.warn(
        '[maloumLoginBrowser] login failed:',
        status,
        contentType,
        text.slice(0, 200)
      );
      if (isCloudflareBlocked(status, text, contentType)) {
        throw new MaloumApiError(
          'Maloum blocked this request (Cloudflare/proxy). Rotate MALOUM_PROXY_URL and retry.',
          403
        );
      }
      throw new MaloumApiError(
        parsed?.message || parsed?.error || `Login failed (${status})`,
        status,
        parsed
      );
    }

    const session = extractSessionTokens(parsed);
    if (!session?.access_token || !session?.refresh_token) {
      throw new MaloumApiError(
        'Login response missing access or refresh token',
        502,
        parsed
      );
    }

    return session;
  } catch (err) {
    if (err instanceof MaloumApiError || err instanceof WrongPasswordError) {
      throw err;
    }
    const detail = err?.message || 'browser login failed';
    console.warn('[maloumLoginBrowser] error:', detail);
    throw new MaloumApiError(
      `Maloum Cloudflare login bypass failed (${detail}). Check MALOUM_PROXY_URL and Chromium install.`,
      502
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  loginWithBrowser,
};
