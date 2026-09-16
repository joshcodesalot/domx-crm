/**
 * Maloum API via CloudflareBypassForScraping mirror mode (same-host Docker).
 * @see https://github.com/sarperavci/CloudflareBypassForScraping
 */

const { fetch: undiciFetch } = require('undici');

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

const DEFAULT_BYPASS_URL = 'http://127.0.0.1:8000';
const BYPASS_TIMEOUT_MS = 120_000;

function defaultApiHeaders({ accessToken, timezone } = {}) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    origin: APP_ORIGIN,
    referer: `${APP_ORIGIN}/`,
    'accept-language': MALOUM_ACCEPT_LANGUAGE,
    'x-timezone': timezone || MALOUM_CLIENT_TIMEZONE,
  };
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

/**
 * Resolve bypass base URL. Empty / 0 / false disables. Unset → localhost:8000.
 */
function resolveCfBypassBaseUrl() {
  const raw = process.env.MALOUM_CF_BYPASS_URL;
  if (raw === undefined || raw === null) {
    return DEFAULT_BYPASS_URL;
  }
  const trimmed = String(raw).trim();
  if (!trimmed || /^(0|false|off|no)$/i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

function apiHostname() {
  try {
    return new URL(API_BASE).hostname;
  } catch {
    return 'api.maloum.com';
  }
}

function isBypassUnavailable(err) {
  const code = err?.code || err?.cause?.code;
  const msg = String(err?.cause?.message || err?.message || '').toLowerCase();
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed')
  );
}

function bypassUnavailableError(base, err) {
  const detail = err?.cause?.message || err?.message || 'unreachable';
  const unavailable = new MaloumApiError(
    `Maloum CF bypass unreachable at ${base} (${detail}). Is cloudflare-bypass running?`,
    503
  );
  unavailable.code = 'CF_BYPASS_UNAVAILABLE';
  return unavailable;
}

/**
 * Mirror any Maloum API request through the CF bypass service.
 * Returns { status, ok, text, contentType, parsed }.
 */
async function mirrorMaloumRequest({
  method = 'GET',
  path,
  proxyUrl,
  headers = {},
  body,
}) {
  const base = resolveCfBypassBaseUrl();
  if (!base) {
    throw bypassUnavailableError('(disabled)', new Error('CF bypass disabled'));
  }

  if (!path || typeof path !== 'string') {
    throw new MaloumApiError('Maloum CF bypass path is required', 400);
  }

  const resolvedProxy = resolveMaloumProxyUrl(proxyUrl);
  const pathPart = path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${pathPart}`;

  const mirrorHeaders = {
    ...headers,
    'x-hostname': apiHostname(),
    'x-proxy': resolvedProxy,
  };

  let response;
  try {
    response = await undiciFetch(url, {
      method,
      headers: mirrorHeaders,
      body,
      // Local loopback — do not route DomX→bypass through MALOUM_PROXY_URL
      signal: AbortSignal.timeout(BYPASS_TIMEOUT_MS),
    });
  } catch (err) {
    if (isBypassUnavailable(err)) {
      throw bypassUnavailableError(base, err);
    }
    throw new MaloumApiError(
      `Maloum CF bypass request failed (${err?.message || 'error'})`,
      502
    );
  }

  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const parsed = parseJsonSafe(text);
  const ok = response.status >= 200 && response.status < 300;

  return {
    status: response.status,
    ok,
    text,
    contentType,
    parsed,
  };
}

/**
 * Mirror POST /user-management/login through the CF bypass service.
 * Returns the same session token object as extractSessionTokens().
 */
async function loginViaCfBypass({ usernameOrEmail, password, proxyUrl }) {
  if (!usernameOrEmail || !password) {
    throw new MaloumApiError('Email/username and password are required', 400);
  }

  const identifier = String(usernameOrEmail).trim();
  const mirrored = await mirrorMaloumRequest({
    method: 'POST',
    path: '/user-management/login',
    proxyUrl,
    headers: defaultApiHeaders({ timezone: MALOUM_CLIENT_TIMEZONE }),
    body: JSON.stringify({
      usernameOrEmail: identifier,
      password: String(password),
    }),
  });

  if (mirrored.status === 401) {
    throw new WrongPasswordError('Password not correct');
  }

  if (isCloudflareBlocked(mirrored.status, mirrored.text, mirrored.contentType)) {
    console.warn(
      '[maloumCfBypass] still Cloudflare-blocked after mirror login:',
      mirrored.status,
      mirrored.contentType,
      mirrored.text.slice(0, 200)
    );
    throw new MaloumApiError(
      'Maloum blocked this request (Cloudflare/proxy). Rotate MALOUM_PROXY_URL and retry.',
      403
    );
  }

  if (!mirrored.ok) {
    console.warn(
      '[maloumCfBypass] login failed:',
      mirrored.status,
      mirrored.contentType,
      mirrored.text.slice(0, 200)
    );
    throw new MaloumApiError(
      mirrored.parsed?.message ||
        mirrored.parsed?.error ||
        `Login failed (${mirrored.status})`,
      mirrored.status,
      mirrored.parsed
    );
  }

  const session = extractSessionTokens(mirrored.parsed);
  if (!session?.access_token || !session?.refresh_token) {
    throw new MaloumApiError(
      'Login response missing access or refresh token',
      502,
      mirrored.parsed
    );
  }

  return session;
}

const APP_CLEARANCE_URL = `${APP_ORIGIN}/login`;

/**
 * Convert bypass /cookies map into Playwright-shaped cookie objects for Electron.
 */
function clearanceMapToPlaywrightCookies(cookieMap) {
  if (!cookieMap || typeof cookieMap !== 'object') {
    return [];
  }

  const cookies = [];
  for (const [name, value] of Object.entries(cookieMap)) {
    if (!name || value === undefined || value === null) continue;
    cookies.push({
      name: String(name),
      value: String(value),
      domain: '.maloum.com',
      path: '/',
      httpOnly: name === 'cf_clearance',
      secure: true,
      sameSite: 'None',
      expires: Math.floor(Date.now() / 1000) + 29 * 60,
    });
  }
  return cookies;
}

/**
 * Fetch Cloudflare clearance cookies for app.maloum.com through the bypass + proxy.
 * Returns { cookies, userAgent } or empty cookies on soft failure.
 */
async function fetchAppClearanceCookies(proxyUrl) {
  const base = resolveCfBypassBaseUrl();
  if (!base) {
    return { cookies: [], userAgent: null };
  }

  const resolvedProxy = resolveMaloumProxyUrl(proxyUrl);
  const url = new URL(`${base}/cookies`);
  url.searchParams.set('url', APP_CLEARANCE_URL);
  url.searchParams.set('proxy', resolvedProxy);

  let response;
  try {
    response = await undiciFetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(BYPASS_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      '[maloumCfBypass] clearance cookie fetch failed:',
      err?.cause?.message || err?.message || err
    );
    return { cookies: [], userAgent: null };
  }

  const text = await response.text();
  const parsed = parseJsonSafe(text);
  if (!response.ok || !parsed) {
    console.warn(
      '[maloumCfBypass] clearance cookie fetch bad response:',
      response.status,
      text.slice(0, 200)
    );
    return { cookies: [], userAgent: null };
  }

  const cookies = clearanceMapToPlaywrightCookies(parsed.cookies);
  const userAgent =
    typeof parsed.user_agent === 'string' && parsed.user_agent.trim()
      ? parsed.user_agent.trim()
      : null;

  console.log(
    `[maloumCfBypass] captured ${cookies.length} clearance cookie(s) for app.maloum.com`
  );

  return { cookies, userAgent };
}

module.exports = {
  resolveCfBypassBaseUrl,
  mirrorMaloumRequest,
  loginViaCfBypass,
  fetchAppClearanceCookies,
  DEFAULT_BYPASS_URL,
};
