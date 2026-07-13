const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const MALOUM_LOGIN_URL = 'https://app.maloum.com/login';
const MALOUM_PROFILE_URL = 'https://app.maloum.com/profile';
const LOGIN_TIMEOUT_MS = 45000;
const PROFILE_LOAD_TIMEOUT_MS = 20000;
const INVALID_CREDENTIALS_MESSAGE = 'The email and/or password are incorrect.';
const INVALID_CREDENTIALS_PATTERN = /email and\/or password are incorrect/i;

const PROFILE_IMAGE_SELECTOR =
  '#root > div > div > div > div.mx-auto.flex.w-full.max-w-\\[544px\\].flex-col.xs\\:px-0.px-4 > div.relative.z-10.-mt-10.mb-4.sm\\:-mt-14 > div.mb-1\\.5.flex > div > img';

const LOCATORS = {
  acceptAllButton: '#cmpwelcomebtnyes .cmpboxbtnyes',
  emailInput: 'input[name="usernameOrEmail"]',
  passwordInput: 'input[name="password"]',
  loginButton: 'button[type="submit"]',
};

class MaloumLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'MaloumLoginError';
  }
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

function isCreatorProfileUrl(url) {
  try {
    const parsed = new URL(url);
    return /\/creator\/[^/]+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function usernameFromCreatorUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\/creator\/([^/]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

async function acceptCookieConsent(page) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const acceptAllButton = page.locator(LOCATORS.acceptAllButton);
    const visible = await acceptAllButton.isVisible().catch(() => false);
    if (visible) {
      await acceptAllButton.click();
      await page.waitForTimeout(500);
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForLoginFormReady(page) {
  const emailInput = page.locator(LOCATORS.emailInput);
  await emailInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await emailInput.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });

  const enabled = await emailInput.isEnabled().catch(() => false);
  if (!enabled) {
    throw new MaloumLoginError(
      'Blocked',
      'Maloum login form is not ready. Please try again.'
    );
  }
}

async function findCredentialErrorText(page) {
  const selectors = [
    '[role="alert"]',
    '.error',
    '[class*="error"]',
    'form p',
    'form span',
  ];

  for (const selector of selectors) {
    const elements = page.locator(selector);
    const count = await elements.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const text = (await elements.nth(i).textContent().catch(() => null))?.trim();
      if (text && INVALID_CREDENTIALS_PATTERN.test(text)) {
        return INVALID_CREDENTIALS_MESSAGE;
      }
    }
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (INVALID_CREDENTIALS_PATTERN.test(bodyText)) {
    return INVALID_CREDENTIALS_MESSAGE;
  }

  return null;
}

async function waitForLoginOutcome(page) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (isPostLoginUrl(currentUrl)) {
      return { success: true };
    }

    const credentialError = await findCredentialErrorText(page);
    if (credentialError) {
      return { success: false, error: credentialError };
    }

    if (!currentUrl.includes('/login')) {
      return { success: true };
    }

    await page.waitForTimeout(250);
  }

  const credentialError = await findCredentialErrorText(page);
  if (credentialError) {
    return { success: false, error: credentialError };
  }

  if (page.url().includes('/login')) {
    return { success: false, error: INVALID_CREDENTIALS_MESSAGE };
  }

  return { success: false, error: 'Login timed out. Please try again.' };
}

async function scrapeProfileMetadata(page) {
  const profileImage = page.locator(PROFILE_IMAGE_SELECTOR);
  let avatarUrl = null;

  if ((await profileImage.count()) > 0) {
    avatarUrl = await profileImage.first().getAttribute('src').catch(() => null);
  }

  return page.evaluate(({ fallbackAvatarUrl }) => {
    const name =
      document.querySelector('h1.notranslate')?.textContent?.trim() ||
      document.querySelector('div.min-w-0 h1')?.textContent?.trim() ||
      null;

    const avatarUrl =
      fallbackAvatarUrl ||
      document.querySelector('img.rounded-full.object-cover')?.src ||
      document.querySelector('div.relative.w-fit img.rounded-full')?.src ||
      null;

    return { name, avatarUrl };
  }, { fallbackAvatarUrl: avatarUrl });
}

async function waitForProfilePageReady(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: LOGIN_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: PROFILE_LOAD_TIMEOUT_MS }).catch(() => {});

  const deadline = Date.now() + PROFILE_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      throw new MaloumLoginError('Blocked', 'Redirected to login after profile check.');
    }

    const hasRoot = await page.locator('#root').count().catch(() => 0);
    if (hasRoot > 0) {
      return currentUrl;
    }

    await page.waitForTimeout(250);
  }

  if (page.url().includes('/login')) {
    throw new MaloumLoginError('Blocked', 'Redirected to login after profile check.');
  }

  throw new MaloumLoginError('Blocked', 'Profile page did not finish loading.');
}

async function extractProfileMetadata(page) {
  await page.goto(MALOUM_PROFILE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: LOGIN_TIMEOUT_MS,
  });

  const postLoginUrl = await waitForProfilePageReady(page);

  let slug = usernameFromCreatorUrl(postLoginUrl);
  if (!slug) {
    try {
      await page.waitForURL((url) => isCreatorProfileUrl(url.toString()), {
        timeout: 5000,
      }).catch(() => {});
      slug = usernameFromCreatorUrl(page.url());
    } catch {
      slug = null;
    }
  }

  const { name, avatarUrl } = await scrapeProfileMetadata(page);

  return {
    displayName: name || slug || 'Maloum Creator',
    username: slug ? `@${slug}` : null,
    avatarUrl,
    postLoginUrl: slug ? page.url() : postLoginUrl,
  };
}

async function validateMaloumLogin(email, password) {
  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';

  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    await page.goto(MALOUM_LOGIN_URL, {
      waitUntil: 'load',
      timeout: LOGIN_TIMEOUT_MS,
    });

    await acceptCookieConsent(page);
    await waitForLoginFormReady(page);

    const emailInput = page.locator(LOCATORS.emailInput);
    const passwordInput = page.locator(LOCATORS.passwordInput);
    const loginButton = page
      .locator(LOCATORS.loginButton)
      .filter({ hasText: 'Login' });

    await emailInput.fill(email);
    await passwordInput.fill(password);
    await loginButton.click();

    const loginOutcome = await waitForLoginOutcome(page);
    if (!loginOutcome.success) {
      if (loginOutcome.error === INVALID_CREDENTIALS_MESSAGE) {
        throw new MaloumLoginError('InvalidCredentials', INVALID_CREDENTIALS_MESSAGE);
      }
      if (/timed out/i.test(loginOutcome.error || '')) {
        throw new MaloumLoginError('Timeout', loginOutcome.error);
      }
      throw new MaloumLoginError(
        'InvalidCredentials',
        loginOutcome.error || INVALID_CREDENTIALS_MESSAGE
      );
    }

    const { displayName, username, avatarUrl, postLoginUrl } =
      await extractProfileMetadata(page);
    const storageState = await context.storageState();

    return {
      displayName,
      username,
      avatarUrl,
      postLoginUrl,
      cookies: storageState.cookies,
      origins: storageState.origins || [],
    };
  } catch (err) {
    if (err instanceof MaloumLoginError) {
      throw err;
    }

    const message = err.message || 'Maloum login failed';
    if (/timeout|timed out/i.test(message)) {
      throw new MaloumLoginError('Timeout', 'Login timed out. Please try again.');
    }

    throw new MaloumLoginError('Blocked', message);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  validateMaloumLogin,
  MaloumLoginError,
  isPostLoginUrl,
  isCreatorProfileUrl,
  LOCATORS,
  PROFILE_IMAGE_SELECTOR,
};
