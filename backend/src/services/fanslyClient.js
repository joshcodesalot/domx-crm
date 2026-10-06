const { randomInt } = require('crypto');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const API_ORIGIN = 'https://apiv3.fansly.com';
const MEDIA_ORIGIN = 'https://mediav2.fansly.com';
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

const NOTIFICATION_TYPE_CODES = new Set(
  NOTIFICATION_FILTERS.flatMap((filter) =>
    String(filter.types || '')
      .split(',')
      .map((code) => code.trim())
      .filter((code) => /^\d+$/.test(code))
  )
);

function notificationUnreadCount(unack) {
  if (Array.isArray(unack)) {
    const hasTotals = unack.some(
      (row) => row && typeof row === 'object' && typeof row.total === 'number'
    );
    if (hasTotals) {
      return unack.reduce((sum, row) => {
        const total = Number(row && row.total);
        return sum + (Number.isFinite(total) ? total : 0);
      }, 0);
    }
    return unack.length;
  }
  if (Array.isArray(unack?.notifications)) return unack.notifications.length;
  if (typeof unack?.total === 'number') return unack.total;
  return 0;
}

function sanitizeNotificationType(type) {
  const raw = typeof type === 'string' ? type : '';
  const seen = new Set();
  const codes = [];
  for (const part of raw.split(',')) {
    const code = part.trim();
    if (!NOTIFICATION_TYPE_CODES.has(code) || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes.join(',');
}

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

class TwoFactorRequiredError extends Error {
  constructor(twofaToken, deviceId, { twofaType = null, email = null } = {}) {
    super('Two-factor authentication required');
    this.name = 'TwoFactorRequiredError';
    this.code = 'TWOFA_REQUIRED';
    this.twofaToken = twofaToken;
    this.deviceId = deviceId;
    this.twofaType = Number.isInteger(twofaType) ? twofaType : null;
    this.email = typeof email === 'string' && email.trim() ? email.trim() : null;
  }
}

function fanslyErrorText(parsed, status) {
  const err = parsed?.error;
  if (err && typeof err === 'object') {
    if (typeof err.details === 'string' && err.details.trim()) return err.details.trim();
    if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  }
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  return `Fansly request failed (${status})`;
}

function isInvalidTwofaCode(parsed, status, path) {
  if (path !== '/login/twofa' || status !== 400) return false;
  const err = parsed?.error;
  if (!err || typeof err !== 'object') return false;
  const details = typeof err.details === 'string' ? err.details : '';
  return err.code === 3 || /error verifying session/i.test(details);
}

function fanslyFailureError(parsed, status, path) {
  if (isInvalidTwofaCode(parsed, status, path)) {
    return new FanslyApiError('Invalid authentication code', 400, parsed);
  }
  const asText = fanslyErrorText(parsed, status);
  if (status === 401 || /password|invalid credentials|unauthorized/i.test(asText)) {
    if (path === '/login') return new WrongPasswordError('Password not correct');
  }
  return new FanslyApiError(asText, status || 502, parsed);
}

function classifyLoginBody(data) {
  const twofa = data?.twofa;
  const twofaToken = twofa?.token;
  if (typeof twofaToken === 'string' && twofaToken) {
    const twofaType = Number(twofa.type);
    const email = typeof twofa.email === 'string' ? twofa.email.trim() : '';
    return {
      kind: 'twofa',
      twofaToken,
      twofaType: Number.isInteger(twofaType) ? twofaType : null,
      email: email || null,
    };
  }
  const nested = data?.session;
  if (nested?.token && nested?.id && nested?.accountId) {
    return { kind: 'session', session: nested };
  }
  if (data?.token && data?.id && data?.accountId) {
    return { kind: 'session', session: data };
  }
  return { kind: 'missing' };
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

async function requestJson({ method = 'GET', path, query, body, session, origin = API_ORIGIN }) {
  const proxyUrl = resolveFanslyProxyUrl(session?.proxyUrl);
  const url = new URL(`${origin}${API_PREFIX}${path}`);
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
    throw fanslyFailureError(parsed, response.status, path);
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
  const avatar = account?.avatar;
  if (!avatar) return null;
  const variants = Array.isArray(avatar.variants) ? [...avatar.variants] : [];
  variants.sort((a, b) => (Number(a?.width) || 0) - (Number(b?.width) || 0));
  for (const variant of variants) {
    if (Number(variant?.type) === 3) continue;
    const url = httpLocation(variant);
    if (url) return url;
  }
  const urls = [];
  collectHttpLocations(avatar, urls);
  const small = urls.find((url) => /_(240|360)\./.test(url));
  return small || httpLocation(avatar) || urls[0] || null;
}

async function finishAuthenticatedSession({
  data,
  raw,
  preCookies,
  setCookies,
  resolvedDeviceId,
  resolvedProxy,
  identifier,
}) {
  const outcome = classifyLoginBody(data);
  if (outcome.kind === 'twofa') {
    throw new TwoFactorRequiredError(outcome.twofaToken, resolvedDeviceId, {
      twofaType: outcome.twofaType,
      email: outcome.email,
    });
  }
  if (outcome.kind !== 'session') {
    throw new FanslyApiError('Login response missing session', 502, raw);
  }

  const token = outcome.session.token;
  const sessionId = outcome.session.id;
  const accountId = outcome.session.accountId;
  const authed = {
    deviceId: resolvedDeviceId,
    token,
    sessionId: String(sessionId),
    proxyUrl: resolvedProxy,
    cookies: {
      ...(preCookies || {}),
      ...(setCookies || {}),
      'fansly-d': resolvedDeviceId,
      'f-d': resolvedDeviceId,
    },
  };

  const me = await getMe(authed);
  const account = me?.account || me || {};
  const fallbackName = identifier || account.username || '';

  return {
    token,
    sessionId: String(sessionId),
    deviceId: resolvedDeviceId,
    providerUserId: String(accountId),
    cookies: authed.cookies,
    displayName: account.displayName || account.username || fallbackName,
    username: account.username || fallbackName,
    avatarUrl: avatarUrlFromAccount(account),
    postLoginUrl: POST_LOGIN_URL,
    account,
  };
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

  return finishAuthenticatedSession({
    data: result.data,
    raw: result.raw,
    preCookies: session.cookies,
    setCookies: result.setCookies,
    resolvedDeviceId,
    resolvedProxy,
    identifier,
  });
}

async function verifyTwofa({ twofaToken, code, deviceId, proxyUrl }) {
  const token = typeof twofaToken === 'string' ? twofaToken.trim() : '';
  const otp = typeof code === 'string' ? code.trim() : '';
  if (!token || !otp) {
    throw new FanslyApiError('Authentication code is required', 400);
  }
  const resolvedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!resolvedDeviceId) {
    throw new FanslyApiError('Fansly session is missing a device id', 400);
  }
  const resolvedProxy = resolveFanslyProxyUrl(proxyUrl);
  const session = {
    deviceId: resolvedDeviceId,
    proxyUrl: resolvedProxy,
    cookies: {},
  };

  const result = await requestJson({
    method: 'POST',
    path: '/login/twofa',
    session,
    body: { token, code: otp },
  });

  return finishAuthenticatedSession({
    data: result.data,
    raw: result.raw,
    preCookies: session.cookies,
    setCookies: result.setCookies,
    resolvedDeviceId,
    resolvedProxy,
    identifier: '',
  });
}

async function getMe(session) {
  const result = await requestJson({ method: 'GET', path: '/account/me', session });
  return result.data;
}

function messagingGroupsQuery({
  sortOrder = 1,
  flags = 0,
  subscriptionTierId = '',
  listIds = '',
  search = '',
  limit = 20,
  offset = 0,
} = {}) {
  const sort = Number(sortOrder);
  const flag = Number(flags);
  const tier = subscriptionTierId == null ? '' : String(subscriptionTierId).trim();
  const lists = Array.isArray(listIds)
    ? listIds.map((id) => String(id).trim()).filter((id) => /^\d+$/.test(id))
    : String(listIds || '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^\d+$/.test(id));
  return {
    sortOrder: sort === 2 || sort === 3 ? sort : 1,
    flags: flag === 2 || flag === 4 || flag === 32 ? flag : 0,
    subscriptionTierId: /^\d+$/.test(tier) ? tier : '',
    listIds: lists.join(','),
    search: typeof search === 'string' ? search : '',
    limit,
    offset,
  };
}

function mapGroupChats(data) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  const accounts = Array.isArray(data?.aggregationData?.accounts) ? data.aggregationData.accounts : [];
  const byId = new Map(accounts.map((account) => [String(account.id), account]));
  return rows.map((row) => {
    const account = byId.get(String(row.partnerAccountId || ''));
    return {
      groupId: row.groupId,
      partnerAccountId: row.partnerAccountId || null,
      partnerUsername: row.partnerUsername || account?.username || 'Fan',
      partnerAvatarUrl: avatarUrlFromAccount(account),
      unreadCount: Number(row.unreadCount) || 0,
      lastMessageId: row.lastMessageId || null,
      flags: row.flags,
    };
  });
}

async function listGroups(session, options = {}) {
  const query = messagingGroupsQuery(options);
  const result = await requestJson({
    method: 'GET',
    path: '/messaging/groups',
    session,
    query,
  });
  return mapGroupChats(result.data);
}

async function getGroup(session, groupId) {
  const result = await requestJson({
    method: 'GET',
    path: `/group/${encodeURIComponent(groupId)}/`,
    session,
  });
  return result.data;
}

const ALBUM_TYPE_LABELS = {
  1000: 'Photos',
  5000: 'Videos',
  38000: 'All',
};

const PERMISSION_PURCHASE = 1;
const PERMISSION_FOLLOW = 2;
const PERMISSION_SUBSCRIPTION_TIER = 4;
const PERMISSION_SUBSCRIPTION_ANY = 8;

/** Message attachment content types. Vault media type is separate (1 image, 2 video). */
const MESSAGE_CONTENT_MEDIA = 1;
const MESSAGE_CONTENT_BUNDLE = 2;
const MESSAGE_CONTENT_STORY = 32001;
const VARIANT_HLS = 302;

const BROADCAST_FLAG_FOLLOWERS = 2;
const BROADCAST_FLAG_SUBSCRIBERS_RENEW = 4;
const BROADCAST_FLAG_SUBSCRIBERS_OFF = 8;
const BROADCAST_FLAG_EXPIRED = 16;
const BROADCAST_FLAG_EXCLUDE_CREATORS = 32;
const BROADCAST_FLAG_EXCLUDE_OFFLINE = 64;
const BROADCAST_INCLUDE_FLAGS =
  BROADCAST_FLAG_FOLLOWERS |
  BROADCAST_FLAG_SUBSCRIBERS_RENEW |
  BROADCAST_FLAG_SUBSCRIBERS_OFF |
  BROADCAST_FLAG_EXPIRED;
const BROADCAST_LIST_INCLUDE = 30000;
const BROADCAST_LIST_EXCLUDE = 30001;
const BROADCAST_MEDIA_CAP = 10;

function albumTitle(album) {
  const title = typeof album?.title === 'string' ? album.title.trim() : '';
  if (title) return title;
  return ALBUM_TYPE_LABELS[album?.type] || 'Album';
}

function httpLocation(node) {
  const locations = Array.isArray(node?.locations) ? node.locations : [];
  const hit = locations.find(
    (loc) => loc && typeof loc.location === 'string' && /^https?:\/\//i.test(loc.location)
  );
  return hit ? hit.location : null;
}

function previewUrlFromMedia(media) {
  if (!media) return null;
  const variants = Array.isArray(media.variants) ? [...media.variants] : [];
  variants.sort((a, b) => (Number(a?.width) || 0) - (Number(b?.width) || 0));
  for (const variant of variants) {
    if (variant?.type !== 1) continue;
    const url = httpLocation(variant);
    if (url) return url;
  }
  return httpLocation(media);
}

function hlsPlaylistUrl(media) {
  const variants = Array.isArray(media?.variants) ? media.variants : [];
  const hls = variants.find((variant) => Number(variant?.type) === VARIANT_HLS);
  return hls ? httpLocation(hls) : null;
}

function fanslyMediaView(media) {
  const kind = Number(media?.type) === 2 ? 'video' : 'image';
  const previewUrl = previewUrlFromMedia(media);
  const fullUrl = kind === 'image' && media ? httpLocation(media) : null;
  const playlistUrl = kind === 'video' ? hlsPlaylistUrl(media) : null;
  return {
    kind,
    previewUrl,
    previewLocked:
      Boolean(previewUrl) && fanslyPreviewLocksToIp(previewUrl) && isFanslyImagePreview(previewUrl),
    fullUrl,
    fullLocked: Boolean(fullUrl) && fanslyPreviewLocksToIp(fullUrl) && isFanslyImagePreview(fullUrl),
    playlistUrl,
  };
}

function decodeCloudFrontPolicy(policy) {
  const raw = typeof policy === 'string' ? policy.trim() : '';
  if (!raw) return null;
  const variants = [
    raw,
    raw.replace(/-/g, '+').replace(/_/g, '/'),
    raw.replace(/-/g, '+').replace(/~/g, '/').replace(/_/g, '='),
  ];
  for (const value of variants) {
    try {
      const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
      const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Try the next CloudFront alphabet.
    }
  }
  return null;
}

function statementLocksToIp(statement) {
  const source = statement?.Condition?.IpAddress?.['AWS:SourceIp'];
  if (Array.isArray(source)) {
    return source.some((item) => typeof item === 'string' && item.trim());
  }
  return typeof source === 'string' && source.trim().length > 0;
}

function fanslyPreviewLocksToIp(url) {
  if (!url || typeof url !== 'string') return false;
  let policy;
  try {
    policy = new URL(url).searchParams.get('Policy');
  } catch {
    return false;
  }
  if (!policy) return false;
  const json = decodeCloudFrontPolicy(policy);
  const statements = Array.isArray(json?.Statement) ? json.Statement : [];
  return statements.some(statementLocksToIp);
}

function isFanslyImagePreview(url) {
  if (!url || typeof url !== 'string') return false;
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.mp4') || path.endsWith('.mov') || path.endsWith('.webm')) return false;
  return /\.(jpe?g|png|webp|gif)$/.test(path);
}

function isAllowedFanslyCdnUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /^cdn\d+\.fansly\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function fanslyCdnPath(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function isFanslyPlaylistUrl(url) {
  return isAllowedFanslyCdnUrl(url) && fanslyCdnPath(url).endsWith('.m3u8');
}

function isFanslySegmentUrl(url) {
  return isAllowedFanslyCdnUrl(url) && fanslyCdnPath(url).endsWith('.ts');
}

function rewriteHlsPlaylist(body, playlistUrl, toProxyUrl) {
  const base = new URL(playlistUrl);
  const text = typeof body === 'string' ? body : '';
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.trim().startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
          const absolute = new URL(uri, base).href;
          return `URI="${toProxyUrl(absolute)}"`;
        });
      }
      const trimmed = line.trim();
      if (!trimmed) return line;
      const absolute = new URL(trimmed, base).href;
      const leading = line.match(/^\s*/)[0];
      return `${leading}${toProxyUrl(absolute)}`;
    })
    .join('\n');
}

function mapVaultAlbum(album) {
  return {
    id: album.id,
    title: albumTitle(album),
    type: album.type ?? null,
    itemCount: Number(album.itemCount) || 0,
  };
}

function mapVaultMedia(item, mediaById) {
  const media = mediaById.get(String(item.mediaId)) || null;
  const view = fanslyMediaView(media);
  return {
    id: item.id,
    mediaId: item.mediaId,
    mediaType: Number(item.mediaType) || Number(media?.type) || 1,
    filename: item.customFilename || media?.filename || '',
    ...view,
  };
}

async function fetchCdnMedia(session, url, { accept } = {}) {
  if (!isAllowedFanslyCdnUrl(url)) {
    throw new FanslyApiError('Invalid or disallowed media URL', 400);
  }
  const proxyUrl = resolveFanslyProxyUrl(session?.proxyUrl);
  const dispatcher = createDispatcher(proxyUrl);
  try {
    return await undiciFetch(url, {
      method: 'GET',
      headers: {
        accept: accept || 'image/avif,image/webp,image/*,*/*;q=0.8',
        'user-agent': USER_AGENT,
        origin: APP_ORIGIN,
        referer: `${APP_ORIGIN}/`,
      },
      dispatcher,
    });
  } catch (err) {
    throw proxyFailureError(err);
  }
}

function dollarsToMills(price) {
  const amount = Number(price);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new FanslyApiError('Purchase price is required', 400);
  }
  return Math.round(amount * 1000);
}

function buildAccountMediaBody({ mediaId, fanId, creatorId, permissions } = {}) {
  const id = mediaId == null ? '' : String(mediaId).trim();
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Media id is required', 400);
  }
  const perms = permissions && typeof permissions === 'object' ? permissions : {};
  const requirePurchase = Boolean(perms.requirePurchase);
  const requireFollow = Boolean(perms.requireFollow);
  const requireSubscription = Boolean(perms.requireSubscription);
  const tierId = perms.subscriptionTierId == null ? '' : String(perms.subscriptionTierId).trim();
  const namedTier = requireSubscription && tierId.length > 0;
  const anyTier = requireSubscription && !namedTier;

  const metadata = {};
  let flags = 0;
  let priceMills = 0;
  if (requirePurchase) {
    priceMills = dollarsToMills(perms.price);
    flags |= PERMISSION_PURCHASE;
    metadata['1'] = JSON.stringify({ price: priceMills });
  }
  if (requireFollow) flags |= PERMISSION_FOLLOW;
  if (namedTier) {
    flags |= PERMISSION_SUBSCRIPTION_TIER;
    metadata['4'] = JSON.stringify({ subscriptionTierId: tierId });
  }

  const whitelist = [];
  if (fanId) whitelist.push({ accountId: String(fanId), permissionFlags: 0 });
  if (creatorId) whitelist.push({ accountId: String(creatorId), permissionFlags: 0 });

  const permissionFlags = [];
  if (flags) {
    const entry = { type: 0, flags };
    if (requirePurchase) entry.price = priceMills;
    entry.metadata = Object.keys(metadata).length ? JSON.stringify(metadata) : '';
    permissionFlags.push(entry);
  }

  return [
    {
      mediaId: id,
      previewId: null,
      permissionFlags: anyTier ? PERMISSION_SUBSCRIPTION_ANY : 0,
      price: 0,
      whitelist,
      permissions: { permissionFlags },
      tags: [],
    },
  ];
}

function buildFeedAccountMediaBody({ mediaId, permissions } = {}) {
  return buildAccountMediaBody({ mediaId, permissions });
}

function buildFeedPostBody({ content, accountMediaId, wallId } = {}) {
  const text = typeof content === 'string' ? content.trim() : '';
  const media = accountMediaId == null ? '' : String(accountMediaId).trim();
  const wall = wallId == null ? '' : String(wallId).trim();
  if (!/^\d+$/.test(media)) {
    throw new FanslyApiError('Account media id is required', 400);
  }
  if (!/^\d+$/.test(wall)) {
    throw new FanslyApiError('Wall id is required', 400);
  }
  return {
    content: text,
    fypFlags: 0,
    inReplyTo: null,
    quotedPostId: null,
    attachments: [{ contentId: media, contentType: MESSAGE_CONTENT_MEDIA, pos: 0 }],
    scheduledFor: 0,
    expiresAt: 0,
    postReplyPermissionFlags: [],
    pinned: 0,
    wallIds: [wall],
    pinWallIds: [],
  };
}

function wallRows(data, accountId) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.walls)) return data.walls;
  const id = accountId == null ? '' : String(accountId);
  if (id && Array.isArray(data[id])) return data[id];
  if (data.walls && typeof data.walls === 'object' && id && Array.isArray(data.walls[id])) {
    return data.walls[id];
  }
  return [];
}

function pickPostsWall(walls) {
  const rows = (Array.isArray(walls) ? walls : []).filter((row) =>
    /^\d+$/.test(row?.id == null ? '' : String(row.id))
  );
  const named = rows.find((row) => String(row.name || '').trim().toLowerCase() === 'posts');
  if (named) return String(named.id);
  const sorted = [...rows].sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));
  if (sorted[0]) return String(sorted[0].id);
  throw new FanslyApiError('Fansly Posts wall was not found', 502);
}

function buildAccountMediaBundleBody({ mediaIds, fanId, creatorId, permissions } = {}) {
  const ids = Array.isArray(mediaIds) ? mediaIds : [];
  if (ids.length < 2) {
    throw new FanslyApiError('At least two media ids are required', 400);
  }
  const models = ids.map((mediaId) => {
    const [item] = buildAccountMediaBody({ mediaId, fanId, creatorId, permissions });
    return {
      mediaId: item.mediaId,
      previewId: null,
      permissionFlags: item.permissionFlags,
      price: item.price,
      whitelist: item.whitelist,
    };
  });
  const [sample] = buildAccountMediaBody({
    mediaId: models[0].mediaId,
    fanId,
    creatorId,
    permissions,
  });
  return {
    previewId: null,
    permissionFlags: sample.permissionFlags,
    price: 0,
    accountMediaModels: models,
    whitelist: sample.whitelist,
    permissions: sample.permissions,
    tags: [],
  };
}

function buildLockedTextBody({ content, permissions } = {}) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    throw new FanslyApiError('Locked text is required', 400);
  }
  const [sample] = buildAccountMediaBody({
    mediaId: '1',
    fanId: '1',
    creatorId: '1',
    permissions,
  });
  return {
    title: '',
    description: '',
    content: text,
    permissions: { permissionFlags: sample.permissions.permissionFlags },
  };
}

function buildDeleteMessageBody(messageId) {
  const id = messageId == null ? '' : String(messageId).trim();
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Message id is required', 400);
  }
  return { messageId: id };
}

function broadcastGroupFlags(audience = {}) {
  const raw = audience && typeof audience === 'object' ? audience : {};
  const subscribers = raw.subscribers !== false;
  const excludeCreators = raw.excludeCreators !== false;
  let flags = 0;
  if (raw.followers) flags |= BROADCAST_FLAG_FOLLOWERS;
  if (subscribers) flags |= BROADCAST_FLAG_SUBSCRIBERS_RENEW | BROADCAST_FLAG_SUBSCRIBERS_OFF;
  if (raw.expiredSubscribers) flags |= BROADCAST_FLAG_EXPIRED;
  if (excludeCreators) flags |= BROADCAST_FLAG_EXCLUDE_CREATORS;
  if (raw.excludeOffline) flags |= BROADCAST_FLAG_EXCLUDE_OFFLINE;
  return flags;
}

function requireSnowflakeList(values, label) {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    throw new FanslyApiError(`${label} are invalid`, 400);
  }
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const id = value == null ? '' : String(value).trim();
    if (!id) continue;
    if (!/^\d+$/.test(id)) {
      throw new FanslyApiError(`${label} are invalid`, 400);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function buildBroadcastGroupBody({
  creatorId,
  groupFlags,
  includeListIds,
  excludeListIds,
  excludeUserIds,
  subscriptionTierId,
} = {}) {
  const creator = requireSnowflake(creatorId, 'Creator id');
  const flags = Number(groupFlags);
  if (!Number.isInteger(flags) || flags < 0 || flags > 126) {
    throw new FanslyApiError('Audience is required', 400);
  }
  const includeLists = requireSnowflakeList(includeListIds, 'Include lists');
  const excludeLists = requireSnowflakeList(excludeListIds, 'Exclude lists');
  const overlap = includeLists.find((id) => excludeLists.includes(id));
  if (overlap) {
    throw new FanslyApiError('A list cannot be included and excluded', 400);
  }
  if ((flags & BROADCAST_INCLUDE_FLAGS) === 0 && includeLists.length === 0) {
    throw new FanslyApiError('Select at least one audience', 400);
  }
  const excludeUsers = requireSnowflakeList(excludeUserIds, 'Excluded users').filter(
    (id) => id !== creator
  );
  const tier = subscriptionTierId == null ? '' : String(subscriptionTierId).trim();
  if (tier && !/^\d+$/.test(tier)) {
    throw new FanslyApiError('Subscription tier is invalid', 400);
  }
  const users = [{ userId: creator, permissionFlags: 65535 }];
  for (const userId of excludeUsers) {
    users.push({ userId, permissionFlags: 0 });
  }
  return {
    users,
    recipients: [
      ...includeLists.map((recipientId) => ({ recipientId, type: BROADCAST_LIST_INCLUDE })),
      ...excludeLists.map((recipientId) => ({ recipientId, type: BROADCAST_LIST_EXCLUDE })),
    ],
    lastMessage: null,
    userSettings: null,
    type: 3,
    groupFlags: flags,
    groupFlagsMetadata: tier
      ? JSON.stringify({ 4: JSON.stringify({ subscriptionTierId: tier }) })
      : '',
  };
}

function buildBroadcastMessageBody({ groupId, content, attachments, createdAt } = {}) {
  const group = requireSnowflake(groupId, 'Group id');
  const text = typeof content === 'string' ? content.trim() : '';
  const files = messageAttachments(attachments);
  if (!text && files.length === 0) {
    throw new FanslyApiError('Message text is required', 400);
  }
  const stamp = Number(createdAt);
  return {
    type: 1,
    attachments: files,
    likes: [],
    content: text,
    groupId: group,
    scheduledFor: 0,
    inReplyTo: null,
    createdAt: Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now() / 1000,
  };
}

function mapBroadcastStats(row) {
  const stats = row?.stats && typeof row.stats === 'object' ? row.stats : {};
  return {
    total: Number(stats.total) || 0,
    delivered: Number(stats.delivered) || 0,
    read: Number(stats.read) || 0,
  };
}

function mapBroadcastMessages(data) {
  const rows = Array.isArray(data?.messages) ? data.messages : [];
  const accountMediaById = indexById(data?.accountMedia);
  const bundlesById = indexById(data?.accountMediaBundles);
  return rows
    .map((row) => {
      const message = mapMessage(row);
      if (!message || !/^\d+$/.test(String(message.id || ''))) return null;
      return {
        id: String(message.id),
        content: message.content,
        createdAt: unixSeconds(message.createdAt),
        deletedAt: unixSeconds(row?.deletedAt),
        stats: mapBroadcastStats(row),
        media: mediaForMessage(message, accountMediaById, bundlesById),
      };
    })
    .filter(Boolean);
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
    deletedAt: row.deletedAt ?? null,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    totalTipAmount: Number(row.totalTipAmount) || 0,
    inReplyTo: row.inReplyTo || null,
    interactions: Array.isArray(row.interactions) ? row.interactions : [],
  };
}

function indexById(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && row.id != null) map.set(String(row.id), row);
  }
  return map;
}

function purchasePriceDollars(node) {
  const rows = Array.isArray(node?.permissions?.permissionFlags) ? node.permissions.permissionFlags : [];
  for (const row of rows) {
    const mills = Number(row?.price);
    if (Number.isFinite(mills) && mills > 0) return mills / 1000;
  }
  return null;
}

function viewFromAccountMedia(row, price) {
  if (!row?.media) return null;
  const view = fanslyMediaView(row.media);
  const mediaId = row.media.id == null ? '' : String(row.media.id);
  if (!mediaId) return null;
  return {
    mediaId,
    ...view,
    price: price == null ? purchasePriceDollars(row) : price,
  };
}

function lockedTextForMessage(message, storiesById) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const items = [];
  for (const attachment of attachments) {
    if (Number(attachment?.contentType) !== MESSAGE_CONTENT_STORY) continue;
    const contentId = attachment?.contentId == null ? '' : String(attachment.contentId);
    const story = storiesById.get(contentId);
    items.push({
      id: story?.id == null ? contentId : String(story.id),
      content: typeof story?.content === 'string' ? story.content : '',
      price: purchasePriceDollars(story),
    });
  }
  return items;
}

function mediaForMessage(message, accountMediaById, bundlesById) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const items = [];
  for (const attachment of attachments) {
    const contentId = attachment?.contentId == null ? '' : String(attachment.contentId);
    const contentType = Number(attachment?.contentType);
    if (contentType === MESSAGE_CONTENT_BUNDLE) {
      const bundle = bundlesById.get(contentId);
      if (!bundle) continue;
      const price = purchasePriceDollars(bundle);
      const ids = Array.isArray(bundle.accountMediaIds) ? bundle.accountMediaIds : [];
      for (const id of ids) {
        const view = viewFromAccountMedia(accountMediaById.get(String(id)), price);
        if (view) items.push(view);
      }
      continue;
    }
    const view = viewFromAccountMedia(accountMediaById.get(contentId), null);
    if (view) items.push(view);
  }
  return items;
}

function mapMessageThread(data) {
  const rows = Array.isArray(data?.messages) ? data.messages : [];
  const accountMediaById = indexById(data?.accountMedia);
  const bundlesById = indexById(data?.accountMediaBundles);
  const storiesById = indexById(data?.stories);
  return rows
    .map((row) => {
      const message = mapMessage(row);
      if (!message) return null;
      return {
        ...message,
        media: mediaForMessage(message, accountMediaById, bundlesById),
        lockedText: lockedTextForMessage(message, storiesById),
      };
    })
    .filter(Boolean);
}

function hydrateMessageMedia(message, { accountMedia, accountMediaBundles, stories } = {}) {
  if (!message) return message;
  return {
    ...message,
    media: mediaForMessage(message, indexById(accountMedia), indexById(accountMediaBundles)),
    lockedText: lockedTextForMessage(message, indexById(stories)),
  };
}

async function listMessages(session, groupId, { limit = 25 } = {}) {
  const result = await requestJson({
    method: 'GET',
    path: '/message',
    session,
    query: { groupId, limit },
  });
  return mapMessageThread(result.data || {});
}

function messageAttachments(attachments) {
  const rows = Array.isArray(attachments) ? attachments : [];
  return rows
    .map((row, index) => {
      const contentId = row?.contentId == null ? '' : String(row.contentId).trim();
      if (!/^\d+$/.test(contentId)) return null;
      const contentType = Number(row.contentType);
      return {
        messageId: null,
        pos: index,
        contentId,
        contentType: Number.isInteger(contentType) && contentType > 0 ? contentType : 1,
      };
    })
    .filter(Boolean)
    .map((row, index) => ({ ...row, pos: index }));
}

async function sendMessage(session, { groupId, content, attachments } = {}) {
  const text = typeof content === 'string' ? content.trim() : '';
  const files = messageAttachments(attachments);
  if (!groupId || (!text && files.length === 0)) {
    throw new FanslyApiError('Message text is required', 400);
  }
  const result = await requestJson({
    method: 'POST',
    path: '/message',
    session,
    body: {
      type: 1,
      attachments: files,
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

async function deleteMessage(session, messageId) {
  const result = await requestJson({
    method: 'POST',
    path: '/message/delete',
    session,
    body: buildDeleteMessageBody(messageId),
  });
  return mapMessage(result.data);
}

function broadcastCursor(before) {
  if (before == null || before === '' || before === 0 || before === '0') return '0';
  const id = String(before).trim();
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Cursor is invalid', 400);
  }
  return id;
}

async function listBroadcastMessages(session, { deleted = false, before = 0, limit = 24 } = {}) {
  const page = Math.min(Math.max(Number(limit) || 24, 1), 50);
  const result = await requestJson({
    method: 'GET',
    path: deleted ? '/message/broadcast/stats/deleted' : '/message/broadcast/stats',
    session,
    query: { before: broadcastCursor(before), limit: page },
  });
  const messages = mapBroadcastMessages(result.data || {});
  const last = messages[messages.length - 1];
  return {
    messages,
    before: last ? last.id : null,
    hasMore: messages.length >= page,
  };
}

async function createBroadcastGroup(session, body) {
  const result = await requestJson({
    method: 'POST',
    path: '/group',
    session,
    body,
  });
  const id = result.data?.id == null ? '' : String(result.data.id);
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Fansly did not return a broadcast group', 502);
  }
  return result.data;
}

async function sendBroadcastMessage(session, body) {
  const result = await requestJson({
    method: 'POST',
    path: '/message/broadcast',
    session,
    body,
  });
  return result.data;
}

async function attachUnlockedBroadcastMedia(session, mediaIds) {
  const ids = requireSnowflakeList(mediaIds, 'Media');
  if (ids.length > BROADCAST_MEDIA_CAP) {
    throw new FanslyApiError('At most 10 media items are allowed', 400);
  }
  if (ids.length === 0) return [];
  if (ids.length === 1) {
    const created = await createAccountMedia(
      session,
      buildAccountMediaBody({ mediaId: ids[0], permissions: {} })
    );
    const contentId = created[0]?.id == null ? '' : String(created[0].id);
    if (!/^\d+$/.test(contentId)) {
      throw new FanslyApiError('Fansly did not return media', 502);
    }
    return [{ contentId, contentType: MESSAGE_CONTENT_MEDIA }];
  }
  const bundle = await createAccountMediaBundle(
    session,
    buildAccountMediaBundleBody({ mediaIds: ids, permissions: {} })
  );
  return [{ contentId: bundle.id, contentType: MESSAGE_CONTENT_BUNDLE }];
}

async function listVaultAlbums(session) {
  const result = await requestJson({ method: 'GET', path: '/vault/albumsnew', session });
  const albums = Array.isArray(result.data?.albums) ? result.data.albums : [];
  return albums.map(mapVaultAlbum);
}

async function listVaultMedia(session, { albumId, before = 0, after = 0 } = {}) {
  const id = albumId == null ? '' : String(albumId).trim();
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Album id is required', 400);
  }
  const result = await requestJson({
    method: 'GET',
    path: '/media/vaultnew',
    session,
    query: { albumId: id, mediaType: '', search: '', before, after },
  });
  const albumMedia = Array.isArray(result.data?.albumMedia) ? result.data.albumMedia : [];
  const media = Array.isArray(result.data?.media) ? result.data.media : [];
  const mediaById = new Map(media.map((row) => [String(row.id), row]));
  return albumMedia.map((item) => mapVaultMedia(item, mediaById));
}

function subscriptionTierRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.subscriptionTiers)) return data.subscriptionTiers;
  if (Array.isArray(data?.tiers)) return data.tiers;
  return [];
}

function listRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.lists)) return data.lists;
  return [];
}

function mapListRows(data) {
  return listRows(data)
    .map((row) => ({
      id: row?.id == null ? '' : String(row.id),
      label: typeof row?.label === 'string' && row.label.trim() ? row.label.trim() : 'List',
    }))
    .filter((row) => /^\d+$/.test(row.id));
}

async function listCreatorLists(session) {
  const result = await requestJson({ method: 'GET', path: '/lists', session });
  return mapListRows(result.data);
}

async function listAccountLists(session, fanId) {
  const id = fanId == null ? '' : String(fanId).trim();
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Fan id is required', 400);
  }
  const result = await requestJson({
    method: 'GET',
    path: '/lists/account',
    session,
    query: { itemId: id },
  });
  return mapListRows(result.data);
}

function buildListCommands({ action, fanId, listId } = {}) {
  const fan = fanId == null ? '' : String(fanId).trim();
  const list = listId == null ? '' : String(listId).trim();
  if (!/^\d+$/.test(fan) || !/^\d+$/.test(list)) {
    throw new FanslyApiError('Fan id and list id are required', 400);
  }
  if (action === 'add') {
    return { listCommands: [{ type: 1, listItem: { id: fan, listId: list } }] };
  }
  if (action === 'remove') {
    return { listCommands: [{ type: 2, listId: list, itemIds: [fan] }] };
  }
  throw new FanslyApiError('List action is required', 400);
}

async function applyListCommands(session, body) {
  const result = await requestJson({
    method: 'POST',
    path: '/lists/commands',
    session,
    body,
  });
  return result.data;
}

async function listSubscriptionTiers(session) {
  const result = await requestJson({ method: 'GET', path: '/subscriptions/tiers', session });
  return subscriptionTierRows(result.data)
    .map((row) => ({
      id: row?.id == null ? '' : String(row.id),
      name: typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : 'Tier',
    }))
    .filter((row) => row.id);
}

async function createAccountMedia(session, body) {
  const result = await requestJson({
    method: 'POST',
    path: '/account/media',
    session,
    body,
  });
  const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
  return rows;
}

const UPLOAD_PART_BYTES = 20 * 1024 * 1024;
const UPLOAD_READY_STATUS = 6;
const UPLOAD_POLL_ATTEMPTS = 90;
const UPLOAD_POLL_MS = 1000;
const UPLOAD_FORM_INPUTS = [
  { type: 1001, value: 'false' },
  { type: 1002, value: 'false' },
  { type: 1003, value: '' },
  { type: 1004, value: '' },
  { type: 1005, value: '""' },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireSnowflake(value, label) {
  const id = value == null ? '' : String(value).trim();
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError(`${label} is required`, 400);
  }
  return id;
}

function uploadMediaType(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 1;
  if (mime.startsWith('video/')) return 2;
  throw new FanslyApiError('Only images and videos can be posted', 400);
}

function isAllowedFanslyUploadUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      /^fansly-upload-[a-z0-9-]+\.s3\.amazonaws\.com$/i.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function unixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

function permissionSummary(node) {
  if (!node) return null;
  const rows = Array.isArray(node?.permissions?.permissionFlags) ? node.permissions.permissionFlags : [];
  const flags = rows.reduce((acc, row) => acc | (Number(row?.flags) || 0), 0);
  const anyTier = Number(node.permissionFlags) === PERMISSION_SUBSCRIPTION_ANY;
  const parts = [];
  const price = purchasePriceDollars(node);
  if (price) parts.push(`$${price}`);
  if (flags & PERMISSION_FOLLOW) parts.push('Followers');
  if ((flags & PERMISSION_SUBSCRIPTION_TIER) || anyTier) parts.push('Subscribers');
  if (parts.length === 0) return 'Free';
  return parts.join(' · ');
}

function mapFeedPost(post, accountMediaById) {
  const id = post?.id == null ? '' : String(post.id);
  const attachments = Array.isArray(post?.attachments) ? post.attachments : [];
  const mediaAttachment = attachments.find(
    (row) => Number(row?.contentType) === MESSAGE_CONTENT_MEDIA
  );
  const contentId = mediaAttachment?.contentId == null ? '' : String(mediaAttachment.contentId);
  const accountMedia = contentId ? accountMediaById.get(contentId) || null : null;
  const view = accountMedia?.media ? fanslyMediaView(accountMedia.media) : null;
  const mediaId = accountMedia?.media?.id == null ? '' : String(accountMedia.media.id);
  return {
    id,
    content: typeof post?.content === 'string' ? post.content : '',
    createdAt: unixSeconds(post?.createdAt),
    accessLabel: permissionSummary(accountMedia),
    media:
      view && mediaId
        ? {
            mediaId,
            ...view,
            price: purchasePriceDollars(accountMedia),
          }
        : null,
  };
}

function timelinePosts(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.posts)) return data.posts;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function timelineAccountMedia(data) {
  if (Array.isArray(data?.accountMedia)) return data.accountMedia;
  if (Array.isArray(data?.aggregationData?.accountMedia)) return data.aggregationData.accountMedia;
  return [];
}

function snowflakeBefore(id, before) {
  if (!before || before === '0') return true;
  if (id.length !== before.length) return id.length < before.length;
  return id < before;
}

async function listWalls(session, accountId) {
  const id = requireSnowflake(accountId, 'Account id');
  const result = await requestJson({
    method: 'GET',
    path: '/wall',
    session,
    query: { accountIds: id },
  });
  return wallRows(result.data, id);
}

async function createFeedPost(session, { content, accountMediaId, wallId } = {}) {
  const result = await requestJson({
    method: 'POST',
    path: '/post',
    session,
    body: buildFeedPostBody({ content, accountMediaId, wallId }),
  });
  return result.data;
}

async function listWallPosts(session, { accountId, wallId, before = 0 } = {}) {
  const account = requireSnowflake(accountId, 'Account id');
  const wall = requireSnowflake(wallId, 'Wall id');
  const cursor = before == null || before === '' ? '0' : String(before);
  const result = await requestJson({
    method: 'GET',
    path: `/timelinenew/${encodeURIComponent(account)}`,
    session,
    query: { before: cursor, after: 0, wallId: wall, contentSearch: '' },
  });
  const data = result.data || {};
  const mediaById = indexById(timelineAccountMedia(data));
  const rawPosts = timelinePosts(data);
  const posts = rawPosts
    .map((row) => mapFeedPost(row, mediaById))
    .filter((row) => /^\d+$/.test(row.id) && snowflakeBefore(row.id, cursor));
  const last = posts[posts.length - 1];
  return {
    posts,
    before: last ? last.id : null,
    hasMore: posts.length > 0 && rawPosts.length >= 15, // Fansly returns 15 posts per timeline page
  };
}

async function deletePost(session, postId) {
  const id = requireSnowflake(postId, 'Post id');
  await requestJson({
    method: 'POST',
    path: `/post/${encodeURIComponent(id)}/delete`,
    session,
  });
  return { ok: true };
}

async function putUploadPart(session, uploadUrl, chunk) {
  if (!isAllowedFanslyUploadUrl(uploadUrl)) {
    throw new FanslyApiError('Invalid upload URL', 502);
  }
  const proxyUrl = resolveFanslyProxyUrl(session?.proxyUrl);
  const dispatcher = createDispatcher(proxyUrl);
  let response;
  try {
    response = await undiciFetch(uploadUrl, {
      method: 'PUT',
      body: chunk,
      dispatcher,
    });
  } catch (err) {
    throw proxyFailureError(err);
  }
  if (!response.ok) {
    throw new FanslyApiError('Fansly upload part failed', response.status || 502);
  }
  const etag = response.headers.get('etag');
  if (!etag) {
    throw new FanslyApiError('Fansly upload part is missing an ETag', 502);
  }
  return etag;
}

async function pollUploadedMedia(session, uploadId) {
  for (let attempt = 0; attempt < UPLOAD_POLL_ATTEMPTS; attempt += 1) {
    const result = await requestJson({
      method: 'GET',
      origin: MEDIA_ORIGIN,
      path: `/media/upload/${encodeURIComponent(uploadId)}`,
      session,
    });
    const row = result.data || {};
    const mediaId = row.mediaId == null ? '' : String(row.mediaId);
    if (Number(row.status) === UPLOAD_READY_STATUS && /^\d+$/.test(mediaId)) {
      return mediaId;
    }
    await delay(UPLOAD_POLL_MS);
  }
  throw new FanslyApiError('Fansly upload timed out', 504);
}

async function uploadMedia(session, { buffer, fileName, mimeType } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!bytes.length) {
    throw new FanslyApiError('File is required', 400);
  }
  const name = typeof fileName === 'string' ? fileName.trim() : '';
  if (!name) {
    throw new FanslyApiError('File name is required', 400);
  }
  const type = uploadMediaType(mimeType);
  const created = await requestJson({
    method: 'POST',
    origin: MEDIA_ORIGIN,
    path: '/media/upload/create',
    session,
    body: {
      fileSize: bytes.length,
      mimeType,
      fileName: name,
      uploadFormData: { formInputs: UPLOAD_FORM_INPUTS },
    },
  });
  const upload = created.data || {};
  const uploadId = requireSnowflake(upload.id, 'Upload id');
  const partSize = Number(upload.partSize) > 0 ? Number(upload.partSize) : UPLOAD_PART_BYTES;
  const parts = (Array.isArray(upload.parts) ? upload.parts : [])
    .slice()
    .sort((a, b) => Number(a?.index) - Number(b?.index));
  const needed = Math.ceil(bytes.length / partSize);
  if (parts.length < needed) {
    throw new FanslyApiError('Fansly did not return upload parts', 502);
  }
  const completed = [];
  for (const part of parts.slice(0, needed)) {
    const index = Number(part.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new FanslyApiError('Fansly upload part is invalid', 502);
    }
    const start = index * partSize;
    const chunk = bytes.subarray(start, Math.min(start + partSize, bytes.length));
    if (!chunk.length) {
      throw new FanslyApiError('Fansly upload part is empty', 502);
    }
    const eTag = await putUploadPart(session, part.uploadUrl, chunk);
    completed.push({ index, eTag });
  }
  await requestJson({
    method: 'POST',
    origin: MEDIA_ORIGIN,
    path: '/media/upload/complete',
    session,
    body: {
      id: uploadId,
      type: Number(upload.type) || type,
      partSize,
      status: 0,
      parts: completed,
      waitForComplete: 0,
    },
  });
  return pollUploadedMedia(session, uploadId);
}

function toFeedPost(post, accountMediaRows) {
  return mapFeedPost(post, indexById(accountMediaRows));
}

async function createStory(session, body) {
  const result = await requestJson({
    method: 'POST',
    path: '/stories',
    session,
    body,
  });
  const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
  const id = rows[0]?.id == null ? '' : String(rows[0].id);
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Fansly did not return locked text', 502);
  }
  return { id, story: rows[0] };
}

async function createAccountMediaBundle(session, body) {
  const result = await requestJson({
    method: 'POST',
    path: '/account/media/bundle',
    session,
    body,
  });
  const accountMediaBundles = Array.isArray(result.data?.accountMediaBundles)
    ? result.data.accountMediaBundles
    : [];
  const accountMedia = Array.isArray(result.data?.accountMedia) ? result.data.accountMedia : [];
  const id = accountMediaBundles[0]?.id == null ? '' : String(accountMediaBundles[0].id);
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Fansly did not return media', 502);
  }
  return { id, accountMedia, accountMediaBundles };
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
    query: { before, after, type: sanitizeNotificationType(type) },
  });
  return result.data || {};
}

async function ackNotifications(session, { beforeAnd, type = '' } = {}) {
  const id = beforeAnd == null ? '' : String(beforeAnd).trim();
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Notification id is required', 400);
  }
  await requestJson({
    method: 'POST',
    path: '/notifications/ack',
    session,
    body: { beforeAnd: id, type: sanitizeNotificationType(type) },
  });
  return { ok: true };
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

  return { messages, notifications: notificationUnreadCount(unackResult.data) };
}

const FAN_NOTE_CONTENT_TYPE = 12002;
const CUSTOM_USERNAME_TITLE = 'Custom Username';
const FAN_STATS_AFTER = 1559347200000;

function requireFanId(fanId) {
  const id = fanId == null ? '' : String(fanId).trim();
  if (!/^\d+$/.test(id)) {
    throw new FanslyApiError('Fan id is required', 400);
  }
  return id;
}

function noteRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.notes)) return data.notes;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function pickCustomUsername(notes) {
  const row = (Array.isArray(notes) ? notes : []).find(
    (item) => item && String(item.title || '') === CUSTOM_USERNAME_TITLE
  );
  if (!row) return { noteId: null, nickname: '' };
  return {
    noteId: row.id == null ? null : String(row.id),
    nickname: typeof row.note === 'string' ? row.note : '',
  };
}

function buildFanNicknameBody({ fanId, nickname, noteId } = {}) {
  const body = {
    contentType: FAN_NOTE_CONTENT_TYPE,
    contentId: requireFanId(fanId),
    title: CUSTOM_USERNAME_TITLE,
    note: typeof nickname === 'string' ? nickname.trim() : '',
  };
  const existing = noteId == null ? '' : String(noteId).trim();
  if (/^\d+$/.test(existing)) body.id = existing;
  return body;
}

function lifetimeGrossMills(stats) {
  const rows = Array.isArray(stats?.byProductType) ? stats.byProductType : [];
  return rows.reduce((sum, row) => {
    const gross = Number(row?.grossMills);
    return sum + (Number.isFinite(gross) ? gross : 0);
  }, 0);
}

function mapPurchase(row) {
  if (!row || row.transactionId == null) return null;
  return {
    id: String(row.transactionId),
    type: Number(row.transactionType ?? row.type) || 0,
    grossMills: Number(row.transactionAmount) || 0,
    netMills: Number(row.amount) || 0,
    status: Number(row.status) || 0,
    createdAt: row.createdAt ?? null,
  };
}

async function listFanNotes(session, fanId) {
  const id = requireFanId(fanId);
  try {
    const result = await requestJson({
      method: 'GET',
      path: '/notes',
      session,
      query: { contentIds: id, contentType: FAN_NOTE_CONTENT_TYPE },
    });
    return noteRows(result.data);
  } catch (err) {
    if (err instanceof FanslyApiError && err.status === 404) return [];
    throw err;
  }
}

async function saveFanNickname(session, { fanId, nickname, noteId } = {}) {
  const body = buildFanNicknameBody({ fanId, nickname, noteId });
  if (!body.note && !body.id) {
    return { noteId: null, nickname: '' };
  }
  const result = await requestJson({
    method: 'POST',
    path: '/notes/edit',
    session,
    body,
  });
  const saved = result.data && typeof result.data === 'object' ? result.data : {};
  return {
    noteId: saved.id == null ? body.id || null : String(saved.id),
    nickname: typeof saved.note === 'string' ? saved.note : body.note,
  };
}

async function getFanStats(session, fanId) {
  const id = requireFanId(fanId);
  const result = await requestJson({
    method: 'GET',
    path: '/account/stats/fans',
    session,
    query: {
      fanId: id,
      after: FAN_STATS_AFTER,
      before: Date.now(),
      granularity: 'month',
    },
  });
  const stats = result.data || {};
  const accounts = Array.isArray(stats.aggregationData?.accounts) ? stats.aggregationData.accounts : [];
  const account = accounts.find((row) => String(row?.id) === id) || accounts[0] || null;
  return {
    lifetimeGrossMills: lifetimeGrossMills(stats),
    username: account?.username || null,
    displayName: account?.displayName || null,
  };
}

async function listFanPurchases(session, fanId, { limit = 30 } = {}) {
  const id = requireFanId(fanId);
  const result = await requestJson({
    method: 'GET',
    path: '/account/wallets/earnings/transactions/accounts',
    session,
    query: {
      correlationAccountId: id,
      before: Date.now(),
      after: FAN_STATS_AFTER,
      cursor: 0,
      limit,
    },
  });
  const rows = Array.isArray(result.data?.data)
    ? result.data.data
    : Array.isArray(result.data)
      ? result.data
      : [];
  return {
    purchases: rows.map(mapPurchase).filter(Boolean),
    hasMore: Boolean(result.data?.hasMore),
  };
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
  TwoFactorRequiredError,
  classifyLoginBody,
  fanslyFailureError,
  resolveFanslyProxyUrl,
  generateDeviceId,
  clientCheck,
  login,
  verifyTwofa,
  getMe,
  listGroups,
  messagingGroupsQuery,
  mapGroupChats,
  getGroup,
  listMessages,
  sendMessage,
  deleteMessage,
  BROADCAST_MEDIA_CAP,
  broadcastGroupFlags,
  buildBroadcastGroupBody,
  buildBroadcastMessageBody,
  mapBroadcastMessages,
  listBroadcastMessages,
  createBroadcastGroup,
  sendBroadcastMessage,
  attachUnlockedBroadcastMedia,
  MESSAGE_CONTENT_MEDIA,
  MESSAGE_CONTENT_BUNDLE,
  MESSAGE_CONTENT_STORY,
  buildAccountMediaBody,
  buildFeedAccountMediaBody,
  buildFeedPostBody,
  pickPostsWall,
  buildAccountMediaBundleBody,
  buildLockedTextBody,
  buildDeleteMessageBody,
  mapMessageThread,
  hydrateMessageMedia,
  rewriteHlsPlaylist,
  isFanslyPlaylistUrl,
  isFanslySegmentUrl,
  listVaultAlbums,
  listVaultMedia,
  fanslyPreviewLocksToIp,
  isFanslyImagePreview,
  isAllowedFanslyCdnUrl,
  fetchCdnMedia,
  listSubscriptionTiers,
  listCreatorLists,
  listAccountLists,
  mapListRows,
  buildListCommands,
  applyListCommands,
  createAccountMedia,
  createFeedPost,
  listWalls,
  listWallPosts,
  deletePost,
  uploadMedia,
  toFeedPost,
  createAccountMediaBundle,
  createStory,
  ackMessages,
  listNotifications,
  ackNotifications,
  notificationUnreadCount,
  sanitizeNotificationType,
  getAccounts,
  getMessagesByIds,
  getBadges,
  pickCustomUsername,
  buildFanNicknameBody,
  lifetimeGrossMills,
  listFanNotes,
  saveFanNickname,
  getFanStats,
  listFanPurchases,
  sessionFromCreator,
  avatarUrlFromAccount,
};
