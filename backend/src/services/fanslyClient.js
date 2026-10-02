const { randomInt } = require('crypto');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const API_ORIGIN = 'https://apiv3.fansly.com';
const API_PREFIX = '/api/v1';
const APP_ORIGIN = 'https://fansly.com';
const POST_LOGIN_URL = 'https://fansly.com/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

/** Static key from the Fansly web client (checkKey_ in the captured bundle). */
const CHECK_KEY = 'necvac-govry3-tybkYz';

const NOTIFICATION_FILTERS = [
  { id: 'all', label: 'All', types: '' },
  { id: 'alerts', label: 'Fansly Alerts', types: '24001,24002' },
  { id: 'likes', label: 'Likes', types: '1002,2002,5003' },
  { id: 'replies', label: 'Post Replies', types: '1004' },
  { id: 'quotes', label: 'Post Quotes', types: '1005' },
  { id: 'tips', label: 'Tips', types: '7001' },
  { id: 'followers', label: 'Followers', types: '3002,3003' },
  { id: 'purchases', label: 'Media Purchases', types: '2007,2008' },
  { id: 'subscribers', label: 'Subscribers', types: '15006,15016' },
  { id: 'expired', label: 'Expired Subscriptions', types: '15007' },
  { id: 'promotions', label: 'Promotions', types: '15011' },
  { id: 'locked', label: 'Locked Text Purchases', types: '32007' },
  { id: 'tickets', label: 'Stream Ticket Purchases', types: '45012' },
];

class WrongPasswordError extends Error {
  constructor(message = 'Password not correct') {
    super(message);
    this.name = 'WrongPasswordError';
    this.code = 'WRONG_PASSWORD';
  }
}

class FanslyApiError extends Error {
  constructor(message, status = 500, body = null) {
    super(message);
    this.name = 'FanslyApiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') {
    return null;
  }
  const trimmed = proxyUrl.trim();
  if (!trimmed) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed) || /^socks/i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function resolveFanslyProxyUrl(override) {
  const fromOverride = typeof override === 'string' ? override.trim() : '';
  const fromEnv =
    typeof process.env.FANSLY_PROXY_URL === 'string'
      ? process.env.FANSLY_PROXY_URL.trim()
      : '';
  const resolved = fromOverride || fromEnv;
  if (!resolved) {
    throw new FanslyApiError(
      'Fansly proxy is required. Set FANSLY_PROXY_URL in backend .env or provide proxyUrl.',
      400
    );
  }
  const normalized = normalizeProxyUrl(resolved);
  if (!normalized) {
    throw new FanslyApiError('Fansly proxy URL is invalid', 400);
  }
  return normalized;
}

function createDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    throw new FanslyApiError('Fansly proxy is required. Account not loaded.', 400);
  }
  return new ProxyAgent(normalized);
}

function proxyFailureError(err) {
  const detail = err?.cause?.message || err?.message || 'connection error';
  return new FanslyApiError(`Fansly proxy failed (${detail}). Account not loaded.`, 502);
}

function generateDeviceId() {
  const n = BigInt(Date.now()) * 100000n + BigInt(randomInt(0, 100000));
  return n.toString();
}

function imul32(a, b) {
  const mask = 65535;
  const ah = mask & a;
  const bh = mask & b;
  return (
    0 |
    (ah * bh +
      ((((mask & (a >>> 16)) * bh + ah * (mask & (b >>> 16))) << 16) >>> 0))
  );
}

/**
 * cyrb53 as implemented by the Fansly web client.
 * Hash input is `${CHECK_KEY}_${pathname}_${deviceId}`.
 */
function cyrb53(value, seed = 0) {
  let h1 = 3735928559 ^ seed;
  let h2 = 1103547991 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = imul32(h1 ^ ch, 2654435761);
    h2 = imul32(h2 ^ ch, 1597334677);
  }
  h1 = imul32(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= imul32(h2 ^ (h2 >>> 13), 3266489909);
  h2 = imul32(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= imul32(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function clientCheck(pathname, deviceId) {
  const material = `${CHECK_KEY}_${pathname}_${deviceId}`;
  return cyrb53(material).toString(16);
}

function cookieHeader(cookies) {
  if (!cookies || typeof cookies !== 'object') return '';
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function applySetCookiePair(cookies, raw) {
  if (!raw || typeof raw !== 'string') return;
  const first = raw.split(';')[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (name) cookies[name] = value;
}

function parseSetCookieHeaders(headers) {
  const cookies = {};
  if (!headers) return cookies;
  let rawList = [];
  if (typeof headers.getSetCookie === 'function') {
    try {
      const fromGetter = headers.getSetCookie();
      if (Array.isArray(fromGetter) && fromGetter.length > 0) rawList = fromGetter;
    } catch {
      // ignore
    }
  }
  if (rawList.length === 0) {
    try {
      const single = headers.get('set-cookie');
      if (single) rawList = [single];
    } catch {
      // ignore
    }
  }
  for (const raw of rawList) applySetCookiePair(cookies, raw);
  return cookies;
}

function parseJsonSafe(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeMaybeBase64Json(text) {
  const direct = parseJsonSafe(text);
  if (direct) return direct;
  if (!text || typeof text !== 'string') return null;
  try {
    const decoded = Buffer.from(text.trim(), 'base64').toString('utf8');
    return parseJsonSafe(decoded);
  } catch {
    return null;
  }
}

function sessionCookies(session) {
  const cookies = { ...(session?.cookies || {}) };
  if (session?.deviceId) {
    cookies['fansly-d'] = session.deviceId;
    cookies['f-d'] = session.deviceId;
  }
  return cookies;
}

function requestHeaders(session, url) {
  const deviceId = session?.deviceId;
  if (!deviceId) {
    throw new FanslyApiError('Fansly session is missing a device id', 400);
  }
  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    origin: APP_ORIGIN,
    referer: `${APP_ORIGIN}/`,
    'accept-language': 'en-US,en;q=0.9',
    'fansly-client-id': deviceId,
    'fansly-client-ts': String(Date.now()),
    'fansly-client-check': clientCheck(url.pathname, deviceId),
  };
  if (session?.token) headers.authorization = session.token;
  if (session?.sessionId) headers['fansly-session-id'] = session.sessionId;
  const cookie = cookieHeader(sessionCookies(session));
  if (cookie) headers.cookie = cookie;
  return headers;
}

async function requestJson({ method = 'GET', path, query, body, session }) {
  const proxyUrl = resolveFanslyProxyUrl(session?.proxyUrl);
  const url = new URL(`${API_ORIGIN}${API_PREFIX}${path}`);
  url.searchParams.set('ngsw-bypass', 'true');
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const dispatcher = createDispatcher(proxyUrl);
  let response;
  try {
    response = await undiciFetch(url, {
      method,
      headers: requestHeaders(session, url),
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher,
    });
  } catch (err) {
    throw proxyFailureError(err);
  }

  const text = await response.text();
  const parsed = text ? decodeMaybeBase64Json(text) : null;
  const setCookies = parseSetCookieHeaders(response.headers);

  if (!response.ok || parsed?.success === false) {
    const message =
      parsed?.error?.message ||
      parsed?.error ||
      parsed?.message ||
      `Fansly request failed (${response.status})`;
    const asText = typeof message === 'string' ? message : `Fansly request failed (${response.status})`;
    if (
      response.status === 401 ||
      /password|invalid credentials|unauthorized/i.test(asText)
    ) {
      if (path === '/login') throw new WrongPasswordError('Password not correct');
    }
    throw new FanslyApiError(asText, response.status || 502, parsed);
  }

  return {
    status: response.status,
    data: parsed?.response !== undefined ? parsed.response : parsed,
    raw: parsed,
    setCookies,
  };
}

function collectHttpLocations(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.locations)) {
    for (const loc of node.locations) {
      if (loc && typeof loc.location === 'string' && /^https?:\/\//i.test(loc.location)) {
        out.push(loc.location);
      }
    }
  }
  if (Array.isArray(node.variants)) {
    for (const variant of node.variants) collectHttpLocations(variant, out);
  }
}

function avatarUrlFromAccount(account) {
  const urls = [];
  collectHttpLocations(account?.avatar, urls);
  const small = urls.find((url) => /_(240|360)\./.test(url));
  return small || urls[0] || null;
}

async function login({ username, password, proxyUrl, deviceId }) {
  const identifier = typeof username === 'string' ? username.trim() : '';
  if (!identifier || !password) {
    throw new FanslyApiError('Username and password are required', 400);
  }
  const resolvedDeviceId = deviceId || generateDeviceId();
  const resolvedProxy = resolveFanslyProxyUrl(proxyUrl);
  const session = {
    deviceId: resolvedDeviceId,
    proxyUrl: resolvedProxy,
    cookies: {},
  };

  const result = await requestJson({
    method: 'POST',
    path: '/login',
    session,
    body: {
      username: identifier,
      password: String(password),
      deviceId: resolvedDeviceId,
    },
  });

  const fanslySession = result.data?.session || {};
  const token = fanslySession.token;
  const sessionId = fanslySession.id;
  const accountId = fanslySession.accountId;
  if (!token || !sessionId || !accountId) {
    throw new FanslyApiError('Login response missing session', 502, result.raw);
  }

  const authed = {
    deviceId: resolvedDeviceId,
    token,
    sessionId: String(sessionId),
    proxyUrl: resolvedProxy,
    cookies: {
      ...session.cookies,
      ...result.setCookies,
      'fansly-d': resolvedDeviceId,
      'f-d': resolvedDeviceId,
    },
  };

  const me = await getMe(authed);
  const account = me?.account || me || {};

  return {
    token,
    sessionId: String(sessionId),
    deviceId: resolvedDeviceId,
    providerUserId: String(accountId),
    cookies: authed.cookies,
    displayName: account.displayName || account.username || identifier,
    username: account.username || identifier,
    avatarUrl: avatarUrlFromAccount(account),
    postLoginUrl: POST_LOGIN_URL,
    account,
  };
}

async function getMe(session) {
  const result = await requestJson({ method: 'GET', path: '/account/me', session });
  return result.data;
}

async function listGroups(session, { flags = 0, search = '', limit = 20, offset = 0 } = {}) {
  const result = await requestJson({
    method: 'GET',
    path: '/messaging/groups',
    session,
    query: {
      sortOrder: 1,
      flags,
      subscriptionTierId: '',
      listIds: '',
      search: search || '',
      limit,
      offset,
    },
  });
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  return rows.map((row) => ({
    groupId: row.groupId,
    partnerAccountId: row.partnerAccountId || null,
    partnerUsername: row.partnerUsername || 'Fan',
    unreadCount: Number(row.unreadCount) || 0,
    lastMessageId: row.lastMessageId || null,
    flags: row.flags,
  }));
}

async function getGroup(session, groupId) {
  const result = await requestJson({
    method: 'GET',
    path: `/group/${encodeURIComponent(groupId)}/`,
    session,
  });
  return result.data;
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    content: typeof row.content === 'string' ? row.content : '',
    groupId: row.groupId || null,
    senderId: row.senderId || null,
    createdAt: row.createdAt ?? null,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    totalTipAmount: Number(row.totalTipAmount) || 0,
    inReplyTo: row.inReplyTo || null,
    interactions: Array.isArray(row.interactions) ? row.interactions : [],
  };
}

async function listMessages(session, groupId, { limit = 25 } = {}) {
  const result = await requestJson({
    method: 'GET',
    path: '/message',
    session,
    query: { groupId, limit },
  });
  const rows = Array.isArray(result.data?.messages) ? result.data.messages : [];
  return rows.map(mapMessage).filter(Boolean);
}

async function sendMessage(session, { groupId, content }) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!groupId || !text) {
    throw new FanslyApiError('Message text is required', 400);
  }
  const result = await requestJson({
    method: 'POST',
    path: '/message',
    session,
    body: {
      type: 1,
      attachments: [],
      likes: [],
      content: text,
      groupId,
      scheduledFor: 0,
      inReplyTo: null,
      createdAt: Date.now() / 1000,
    },
  });
  return mapMessage(result.data);
}

async function ackMessages(session, messageIds) {
  const ids = (Array.isArray(messageIds) ? messageIds : []).filter(Boolean).map(String);
  if (ids.length === 0) return { ok: true };
  await requestJson({
    method: 'POST',
    path: '/message/ack',
    session,
    body: { messageIds: ids, type: 2 },
  });
  return { ok: true };
}

async function listNotifications(session, { before = 0, after = 0, type = '' } = {}) {
  const result = await requestJson({
    method: 'GET',
    path: '/notifications',
    session,
    query: { before, after, type: type || '' },
  });
  return result.data || {};
}

async function getAccounts(session, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (list.length === 0) return [];
  const result = await requestJson({
    method: 'GET',
    path: '/account',
    session,
    query: { ids: list.join(',') },
  });
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.data?.accounts)) return result.data.accounts;
  return [];
}

async function getMessagesByIds(session, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (list.length === 0) return [];
  const result = await requestJson({
    method: 'GET',
    path: '/messages',
    session,
    query: { ids: list.join(',') },
  });
  const rows = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.data?.messages)
      ? result.data.messages
      : [];
  return rows.map(mapMessage).filter(Boolean);
}

async function getBadges(session) {
  const [unreadResult, unackResult] = await Promise.all([
    requestJson({
      method: 'GET',
      path: '/message/unread',
      session,
      query: { limit: 100, offset: 0, before: 0 },
    }),
    requestJson({ method: 'GET', path: '/notifications/unack', session }),
  ]);

  const interactions = Array.isArray(unreadResult.data?.messageInteractions)
    ? unreadResult.data.messageInteractions
    : [];
  const unreadFromRows = interactions.filter(
    (row) => row && row.readAt == null && row.validMessage !== false
  ).length;
  const total = Number(unreadResult.data?.total);
  const messages = Number.isFinite(total) && total > unreadFromRows ? total : unreadFromRows;

  const unack = unackResult.data;
  let notifications = 0;
  if (Array.isArray(unack)) notifications = unack.length;
  else if (Array.isArray(unack?.notifications)) notifications = unack.notifications.length;
  else if (typeof unack?.total === 'number') notifications = unack.total;

  return { messages, notifications };
}

function sessionFromCreator(creator) {
  const session = creator?.session || {};
  return {
    deviceId: session.deviceId || creator.deviceId || null,
    token: creator.accessToken || session.token || null,
    sessionId: session.sessionId || null,
    cookies: session.cookies || {},
    proxyUrl: creator.proxyUrl || null,
  };
}

module.exports = {
  CHECK_KEY,
  NOTIFICATION_FILTERS,
  WrongPasswordError,
  FanslyApiError,
  resolveFanslyProxyUrl,
  generateDeviceId,
  clientCheck,
  login,
  getMe,
  listGroups,
  getGroup,
  listMessages,
  sendMessage,
  ackMessages,
  listNotifications,
  getAccounts,
  getMessagesByIds,
  getBadges,
  sessionFromCreator,
  avatarUrlFromAccount,
};
