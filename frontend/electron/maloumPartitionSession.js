/**
 * Apply Maloum residential proxy + Cloudflare-bypass User-Agent to an Electron
 * session partition. cf_clearance is IP+UA bound — both must match login.
 *
 * Usage from creator session restore / Verify Session:
 *   await loadMaloumPartitionSession({ accountId, cookies, proxyUrl, userAgent });
 */

const { app, session: electronSession } = require('electron');

/** @type {Map<string, { username: string, password: string }>} */
const proxyAuthByPartition = new Map();
let proxyLoginHookInstalled = false;

function ensureProxyLoginHook() {
  if (proxyLoginHookInstalled) return;
  proxyLoginHookInstalled = true;

  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo?.isProxy) {
      return;
    }
    // Match any pending Maloum proxy auth (single-user desktop app).
    for (const creds of proxyAuthByPartition.values()) {
      if (creds?.username) {
        event.preventDefault();
        callback(creds.username, creds.password || '');
        return;
      }
    }
  });
}

function getPartitionSession(accountId) {
  return electronSession.fromPartition(`persist:creator-${accountId}`);
}

function parseProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
    return null;
  }
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`
    );
    return {
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
      username: parsed.username ? decodeURIComponent(parsed.username) : '',
      password: parsed.password ? decodeURIComponent(parsed.password) : '',
    };
  } catch {
    return null;
  }
}

/**
 * @param {Electron.Session} partitionSession
 * @param {string} accountId
 * @param {{ proxyUrl?: string | null, userAgent?: string | null }} opts
 */
async function configureMaloumPartition(
  partitionSession,
  accountId,
  { proxyUrl, userAgent } = {}
) {
  if (!partitionSession) {
    throw new Error('partitionSession is required');
  }

  ensureProxyLoginHook();

  if (userAgent && typeof userAgent === 'string' && userAgent.trim()) {
    partitionSession.setUserAgent(userAgent.trim());
  }

  const parsed = parseProxyUrl(proxyUrl);
  if (parsed) {
    proxyAuthByPartition.set(accountId, {
      username: parsed.username,
      password: parsed.password,
    });
    await partitionSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http=${parsed.host}:${parsed.port};https=${parsed.host}:${parsed.port}`,
      proxyBypassRules: '<local>',
    });
  } else {
    proxyAuthByPartition.delete(accountId);
    await partitionSession.setProxy({ mode: 'direct' });
  }
}

/**
 * @param {Electron.Session} partitionSession
 * @param {Array<object>} cookies
 */
async function importPlaywrightCookies(partitionSession, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { imported: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    cookies.map((cookie) =>
      partitionSession.cookies.set(playwrightCookieToElectron(cookie))
    )
  );

  let imported = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i += 1) {
    if (results[i].status === 'fulfilled') {
      imported += 1;
    } else {
      failed += 1;
      console.warn(
        '[maloumPartitionSession] cookie import failed:',
        cookies[i]?.name,
        results[i].reason?.message
      );
    }
  }

  return { imported, failed };
}

function playwrightCookieToElectron(cookie) {
  const sameSiteRaw = String(cookie.sameSite || 'Lax').toLowerCase();
  let sameSite = 'lax';
  if (sameSiteRaw === 'no_restriction' || sameSiteRaw === 'none') {
    sameSite = 'no_restriction';
  } else if (sameSiteRaw === 'strict') {
    sameSite = 'strict';
  }

  const domain = cookie.domain || '.maloum.com';
  const urlHost = domain.startsWith('.') ? domain.slice(1) : domain;
  const secure = cookie.secure !== false;
  const protocol = secure ? 'https' : 'http';

  const entry = {
    url: `${protocol}://${urlHost}${cookie.path || '/'}`,
    name: cookie.name,
    value: cookie.value,
    domain,
    path: cookie.path || '/',
    secure,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite,
  };

  if (typeof cookie.expires === 'number' && cookie.expires > 0) {
    entry.expirationDate = cookie.expires;
  }

  return entry;
}

/**
 * Full restore: proxy + UA, then cookies. Call before Verify Session navigation.
 */
async function loadMaloumPartitionSession({
  accountId,
  cookies = [],
  proxyUrl = null,
  userAgent = null,
}) {
  if (!accountId) {
    throw new Error('accountId is required');
  }

  const partitionSession = getPartitionSession(accountId);
  await partitionSession.clearStorageData({ storages: ['cookies'] });
  await configureMaloumPartition(partitionSession, accountId, {
    proxyUrl,
    userAgent,
  });
  const result = await importPlaywrightCookies(partitionSession, cookies);

  return {
    accountId,
    partitionId: `persist:creator-${accountId}`,
    userAgent: userAgent || partitionSession.getUserAgent(),
    proxyConfigured: Boolean(parseProxyUrl(proxyUrl)),
    ...result,
  };
}

module.exports = {
  getPartitionSession,
  configureMaloumPartition,
  importPlaywrightCookies,
  loadMaloumPartitionSession,
  playwrightCookieToElectron,
};
