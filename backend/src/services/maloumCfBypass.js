/**
 * Maloum Cloudflare clearance via Unflare (cookie mint, not a request mirror).
 * @see https://github.com/iamyegor/Unflare
 */

const { fetch: undiciFetch } = require('undici');
const { parseHostPort, parseProxyParts } = require('./proxyUrl');

const {
  MaloumApiError,
  resolveMaloumProxyUrl,
  parseJsonSafe,
  APP_ORIGIN,
} = require('./maloumClient');

const DEFAULT_BYPASS_URL = 'http://127.0.0.1:5002';
const BYPASS_TIMEOUT_MS = 120_000;
const SCRAPE_TIMEOUT_MS = 60_000;
const PROXY_SWITCH_PAUSE_MS = 400;
const CACHE_SKEW_MS = 60_000;
const DEFAULT_TTL_MS = 25 * 60 * 1000;
const APP_CLEARANCE_URL = `${APP_ORIGIN}/login`;

let fetchImpl = undiciFetch;
let bypassQueue = Promise.resolve();
let lastBypassProxy = null;
const clearanceByHostPort = new Map();

function resetBypassQueueForTests({ fetch } = {}) {
  bypassQueue = Promise.resolve();
  lastBypassProxy = null;
  clearanceByHostPort.clear();
  fetchImpl = fetch || undiciFetch;
}

function enqueueBypass(task) {
  const run = bypassQueue.then(task, task);
  bypassQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Resolve Unflare base URL. Empty / 0 / false disables. Unset → localhost:5002.
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
    `Maloum Unflare unreachable at ${base} (${detail}). Is unflare running on :5002?`,
    503
  );
  unavailable.code = 'CF_BYPASS_UNAVAILABLE';
  return unavailable;
}

function unflareProxyFromUrl(proxyUrl) {
  const resolved = resolveMaloumProxyUrl(proxyUrl);
  const parts = parseProxyParts(resolved);
  if (!parts) {
    return null;
  }
  const hp = parseHostPort(parts.hostPort);
  if (!hp) {
    return null;
  }
  const proxy = {
    host: hp.host,
    port: Number(hp.port),
  };
  if (parts.username) {
    proxy.username = parts.username;
  }
  if (parts.password) {
    proxy.password = parts.password;
  }
  return { hostPort: parts.hostPort, proxy };
}

function cookieHeaderFromList(cookies) {
  if (!Array.isArray(cookies)) {
    return '';
  }
  return cookies
    .filter((row) => row && row.name && row.value != null)
    .map((row) => `${row.name}=${row.value}`)
    .join('; ');
}

function expiresAtFromCookies(cookies, now = Date.now()) {
  const clearance = (Array.isArray(cookies) ? cookies : []).find(
    (row) => row && row.name === 'cf_clearance'
  );
  const raw = clearance?.expires;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 1e10) {
    return raw - CACHE_SKEW_MS;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 1e9) {
    return raw * 1000 - CACHE_SKEW_MS;
  }
  return now + DEFAULT_TTL_MS;
}

function unflareCookiesToPlaywright(cookies) {
  if (!Array.isArray(cookies)) {
    return [];
  }
  return cookies
    .filter((row) => row && row.name && row.value != null)
    .map((row) => ({
      name: String(row.name),
      value: String(row.value),
      domain: row.domain || '.maloum.com',
      path: row.path || '/',
      httpOnly: row.httpOnly != null ? Boolean(row.httpOnly) : row.name === 'cf_clearance',
      secure: row.secure != null ? Boolean(row.secure) : true,
      sameSite: row.sameSite || 'None',
      expires:
        typeof row.expires === 'number' && Number.isFinite(row.expires)
          ? row.expires > 1e10
            ? Math.floor(row.expires / 1000)
            : row.expires
          : Math.floor(Date.now() / 1000) + 29 * 60,
    }));
}

function cachedClearance(hostPort, now = Date.now()) {
  const row = clearanceByHostPort.get(hostPort);
  if (!row) {
    return null;
  }
  if (row.expiresAt && row.expiresAt <= now) {
    clearanceByHostPort.delete(hostPort);
    return null;
  }
  return row;
}

function storeClearance(hostPort, parsed) {
  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const userAgent =
    (typeof parsed?.headers?.['user-agent'] === 'string' &&
      parsed.headers['user-agent'].trim()) ||
    (typeof parsed?.headers?.['User-Agent'] === 'string' &&
      parsed.headers['User-Agent'].trim()) ||
    (typeof parsed?.user_agent === 'string' && parsed.user_agent.trim()) ||
    null;
  const cookieHeader = cookieHeaderFromList(cookies);
  const row = {
    cookieHeader,
    userAgent,
    cookies: unflareCookiesToPlaywright(cookies),
    expiresAt: expiresAtFromCookies(cookies),
  };
  clearanceByHostPort.set(hostPort, row);
  return row;
}

async function scrapeClearance(proxyUrl) {
  const base = resolveCfBypassBaseUrl();
  if (!base) {
    throw bypassUnavailableError('(disabled)', new Error('Unflare disabled'));
  }

  const parsedProxy = unflareProxyFromUrl(proxyUrl);
  if (!parsedProxy) {
    throw new MaloumApiError('Maloum proxy URL is invalid', 400);
  }

  if (lastBypassProxy && lastBypassProxy !== parsedProxy.hostPort) {
    await new Promise((resolve) => setTimeout(resolve, PROXY_SWITCH_PAUSE_MS));
  }
  lastBypassProxy = parsedProxy.hostPort;

  let response;
  try {
    response = await fetchImpl(`${base}/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: APP_CLEARANCE_URL,
        timeout: SCRAPE_TIMEOUT_MS,
        method: 'GET',
        proxy: parsedProxy.proxy,
      }),
      signal: AbortSignal.timeout(BYPASS_TIMEOUT_MS),
    });
  } catch (err) {
    if (isBypassUnavailable(err)) {
      throw bypassUnavailableError(base, err);
    }
    throw new MaloumApiError(
      `Maloum Unflare request failed (${err?.message || 'error'})`,
      502
    );
  }

  const text = await response.text();
  const parsed = parseJsonSafe(text);
  if (!response.ok || parsed?.code === 'error' || !parsed) {
    const message =
      parsed?.message ||
      `Unflare scrape failed (${response.status})`;
    throw new MaloumApiError(message, response.status >= 400 ? response.status : 502);
  }

  const stored = storeClearance(parsedProxy.hostPort, parsed);
  console.log(
    `[maloumCfBypass] minted ${stored.cookies.length} clearance cookie(s) for ${parsedProxy.hostPort}`
  );
  return stored;
}

/**
 * Return cached Unflare clearance for this proxy, or mint one.
 * Serialized so one Chromium is not multiplexed across IPs.
 */
function ensureClearance(proxyUrl, { force = false } = {}) {
  const parsedProxy = unflareProxyFromUrl(proxyUrl);
  if (!parsedProxy) {
    return Promise.reject(new MaloumApiError('Maloum proxy URL is invalid', 400));
  }
  if (!force) {
    const hit = cachedClearance(parsedProxy.hostPort);
    if (hit) {
      return Promise.resolve(hit);
    }
  }
  if (!resolveCfBypassBaseUrl()) {
    return Promise.resolve(null);
  }
  return enqueueBypass(() => {
    if (!force) {
      const hit = cachedClearance(parsedProxy.hostPort);
      if (hit) {
        return hit;
      }
    }
    return scrapeClearance(proxyUrl);
  });
}

/**
 * Fetch Cloudflare clearance cookies for Electron after login.
 * Soft-fails to empty cookies if Unflare is down.
 */
async function fetchAppClearanceCookies(proxyUrl) {
  if (!resolveCfBypassBaseUrl()) {
    return { cookies: [], userAgent: null };
  }
  try {
    const row = await ensureClearance(proxyUrl);
    if (!row) {
      return { cookies: [], userAgent: null };
    }
    return { cookies: row.cookies, userAgent: row.userAgent };
  } catch (err) {
    console.warn(
      '[maloumCfBypass] clearance cookie fetch failed:',
      err?.message || err
    );
    return { cookies: [], userAgent: null };
  }
}

module.exports = {
  resolveCfBypassBaseUrl,
  ensureClearance,
  fetchAppClearanceCookies,
  unflareProxyFromUrl,
  resetBypassQueueForTests,
  DEFAULT_BYPASS_URL,
  PROXY_SWITCH_PAUSE_MS,
};
