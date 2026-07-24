const { randomUUID } = require('crypto');
const { ProxyAgent, fetch: undiciFetch } = require('undici');
const { buildSupabaseStorageValue } = require('./maloumAuthTokens');

const API_BASE = 'https://api.maloum.com';
const APP_ORIGIN = 'https://app.maloum.com';
const POST_LOGIN_URL = 'https://app.maloum.com/';
const STORAGE_KEY = 'sb-srswgacczfgjttwdpuia-auth-token';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const ALLOWED_MEDIA_HOSTS = new Set([
  'storage.googleapis.com',
  'maloum-prod-images.storage.googleapis.com',
]);

class WrongPasswordError extends Error {
  constructor(message = 'Password not correct') {
    super(message);
    this.name = 'WrongPasswordError';
    this.code = 'WRONG_PASSWORD';
  }
}

class MaloumApiError extends Error {
  constructor(message, status = 500, body = null) {
    super(message);
    this.name = 'MaloumApiError';
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

/**
 * Resolve Maloum proxy: explicit override, else MALOUM_PROXY_URL from env.
 * Always required — Maloum traffic must never go direct.
 */
function resolveMaloumProxyUrl(override) {
  const fromOverride = typeof override === 'string' ? override.trim() : '';
  const fromEnv =
    typeof process.env.MALOUM_PROXY_URL === 'string'
      ? process.env.MALOUM_PROXY_URL.trim()
      : '';
  const resolved = fromOverride || fromEnv;
  if (!resolved) {
    throw new MaloumApiError(
      'Maloum proxy is required. Set MALOUM_PROXY_URL in backend .env or provide proxyUrl.',
      400
    );
  }
  const normalized = normalizeProxyUrl(resolved);
  if (!normalized) {
    throw new MaloumApiError('Maloum proxy URL is invalid', 400);
  }
  return normalized;
}

function createDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    throw new MaloumApiError('Maloum proxy is required. Account not loaded.', 400);
  }
  return new ProxyAgent(normalized);
}

function proxyFailureError(err) {
  const detail = err?.cause?.message || err?.message || 'connection error';
  return new MaloumApiError(
    `Maloum proxy failed (${detail}). Account not loaded.`,
    502
  );
}

function baseHeaders({ accessToken, timezone, extra = {} } = {}) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    origin: APP_ORIGIN,
    referer: `${APP_ORIGIN}/`,
    ...extra,
  };

  if (timezone) {
    headers['x-timezone'] = timezone;
  }

  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }

  return headers;
}

function parseJsonSafe(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractSessionTokens(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const candidates = [
    parsed,
    parsed.session,
    parsed.data,
    parsed.data?.session,
    parsed.credentials,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const accessToken =
      candidate.access_token ||
      candidate.accessToken ||
      candidate.token;
    const refreshToken =
      candidate.refresh_token ||
      candidate.refreshToken;

    if (typeof accessToken === 'string' && typeof refreshToken === 'string') {
      let expiresAt = candidate.expires_at ?? candidate.expiresAt ?? null;
      const expiresIn = candidate.expires_in ?? candidate.expiresIn;
      if (
        (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) &&
        typeof expiresIn === 'number'
      ) {
        expiresAt = Math.floor(Date.now() / 1000 + expiresIn);
      }

      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: candidate.token_type || candidate.tokenType || 'bearer',
        expires_in:
          typeof expiresIn === 'number'
            ? expiresIn
            : typeof expiresAt === 'number'
              ? Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
              : undefined,
        expires_at: typeof expiresAt === 'number' ? expiresAt : undefined,
        user: candidate.user || parsed.user || null,
      };
    }
  }

  return null;
}

function buildSyntheticOrigins(session) {
  return [
    {
      origin: APP_ORIGIN,
      localStorage: [
        {
          name: STORAGE_KEY,
          value: buildSupabaseStorageValue(session),
        },
      ],
    },
  ];
}

function avatarFromUser(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }
  return (
    user.profilePictureThumbnail?.url ||
    user.profilePicture?.url ||
    user.avatarUrl ||
    user.avatar?.url ||
    null
  );
}

function displayNameFromUser(user, fallback) {
  if (!user || typeof user !== 'object') {
    return fallback;
  }
  return (
    user.username ||
    user.displayName ||
    user.name ||
    user.email ||
    fallback
  );
}

async function requestJson({
  method = 'GET',
  path,
  proxyUrl,
  accessToken,
  body,
  timezone,
  contentType,
  rawBody,
}) {
  const dispatcher = createDispatcher(proxyUrl);
  const headers = baseHeaders({ accessToken, timezone });

  let requestBody;
  if (rawBody !== undefined) {
    requestBody = rawBody;
    if (contentType) {
      headers['content-type'] = contentType;
    } else {
      delete headers['content-type'];
    }
  } else if (body !== undefined) {
    requestBody = JSON.stringify(body);
  } else {
    delete headers['content-type'];
  }

  let response;
  try {
    response = await undiciFetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: requestBody,
      dispatcher,
    });
  } catch (err) {
    throw proxyFailureError(err);
  }

  const text = await response.text();
  const parsed = parseJsonSafe(text);

  if (!response.ok) {
    const message =
      parsed?.message ||
      parsed?.error ||
      `Maloum request failed (${response.status})`;
    throw new MaloumApiError(message, response.status, parsed);
  }

  return {
    status: response.status,
    data: parsed !== null ? parsed : text,
    text,
  };
}

function authContext(creator) {
  if (!creator || typeof creator !== 'object') {
    throw new MaloumApiError('Creator is missing Maloum auth session', 400);
  }
  const accessToken = creator.accessToken || creator.session?.accessToken || null;
  const proxyUrl = creator.proxyUrl || null;
  if (!accessToken) {
    throw new MaloumApiError('Creator is missing Maloum auth session', 400);
  }
  if (!proxyUrl) {
    throw new MaloumApiError(
      'Maloum proxy is required. Set MALOUM_PROXY_URL or reconnect with a proxy.',
      400
    );
  }
  return {
    accessToken,
    proxyUrl: resolveMaloumProxyUrl(proxyUrl),
    timezone: creator.timezone || 'UTC',
    providerUserId: creator.providerUserId || null,
  };
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function listChats(creator, { limit = 15, next } = {}) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  const result = await requestJson({
    method: 'GET',
    path: `/chats${buildQuery({ limit, next })}`,
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

async function getChat(creator, chatId) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  if (!chatId) {
    throw new MaloumApiError('chatId is required', 400);
  }
  const result = await requestJson({
    method: 'GET',
    path: `/chats/${encodeURIComponent(chatId)}`,
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

async function getMessages(creator, chatId, { limit = 15, next } = {}) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  if (!chatId) {
    throw new MaloumApiError('chatId is required', 400);
  }
  const result = await requestJson({
    method: 'GET',
    path: `/chats/${encodeURIComponent(chatId)}/messages${buildQuery({ limit, next })}`,
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

async function markRead(creator, chatId) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  if (!chatId) {
    throw new MaloumApiError('chatId is required', 400);
  }
  const result = await requestJson({
    method: 'POST',
    path: `/chats/${encodeURIComponent(chatId)}/messages/read`,
    proxyUrl,
    accessToken,
    timezone,
    contentType: 'application/x-www-form-urlencoded',
    rawBody: '',
  });
  return result.data;
}

async function getUnreadCount(creator) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  const result = await requestJson({
    method: 'GET',
    path: '/chats/unread-count',
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

async function listNotifications(creator, { limit = 15, next } = {}) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  const result = await requestJson({
    method: 'GET',
    path: `/notifications${buildQuery({ limit, next })}`,
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

function normalizeListData(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function countUnreadChatsFromList(payload) {
  return normalizeListData(payload).filter((chat) => chat?.unreadMessages === true).length;
}

function countUnreadNotificationsFromList(payload) {
  return normalizeListData(payload).filter((entry) => entry?.isRead === false).length;
}

async function sendMessage(creator, chatId, { content, optimisticMessageId } = {}) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  if (!chatId) {
    throw new MaloumApiError('chatId is required', 400);
  }
  if (!content || typeof content !== 'object') {
    throw new MaloumApiError('content is required', 400);
  }
  const result = await requestJson({
    method: 'POST',
    path: `/chats/${encodeURIComponent(chatId)}/messages`,
    proxyUrl,
    accessToken,
    timezone,
    body: {
      content,
      optimisticMessageId: optimisticMessageId || randomUUID(),
    },
  });
  return result.data;
}

async function sendText(creator, chatId, { text, optimisticMessageId } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new MaloumApiError('text is required', 400);
  }
  return sendMessage(creator, chatId, {
    content: { type: 'text', text },
    optimisticMessageId,
  });
}

async function sendMedia(creator, chatId, {
  media,
  text = '',
  priceNet = 0,
  optimisticMessageId,
} = {}) {
  if (!Array.isArray(media) || media.length === 0) {
    throw new MaloumApiError('media is required', 400);
  }
  const normalizedMedia = media.map((item) => ({
    mediaId: item.mediaId || item.uploadId,
    type: item.type || 'picture',
    width: item.width,
    height: item.height,
  }));
  for (const item of normalizedMedia) {
    if (!item.mediaId) {
      throw new MaloumApiError('mediaId is required for each media item', 400);
    }
  }

  const net = Number(priceNet) || 0;
  if (net > 0) {
    return sendMessage(creator, chatId, {
      content: {
        type: 'chat_product',
        media: normalizedMedia,
        priceNet: net,
        text: typeof text === 'string' ? text : '',
      },
      optimisticMessageId,
    });
  }

  return sendMessage(creator, chatId, {
    content: {
      type: 'media',
      media: normalizedMedia.map((item) => ({
        uploadId: item.mediaId,
        type: item.type,
        width: item.width,
        height: item.height,
      })),
      text: typeof text === 'string' ? text : '',
    },
    optimisticMessageId,
  });
}

async function sendPpv(creator, chatId, {
  media,
  text = '',
  priceNet,
  optimisticMessageId,
} = {}) {
  const net = Number(priceNet);
  if (!Number.isFinite(net) || net <= 0) {
    throw new MaloumApiError('priceNet must be greater than 0 for PPV', 400);
  }
  return sendMedia(creator, chatId, {
    media,
    text,
    priceNet: net,
    optimisticMessageId,
  });
}

async function listVaultFolders(creator, { query = '', limit = 15, next } = {}) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  const result = await requestJson({
    method: 'GET',
    path: `/vault/folders${buildQuery({ query, limit, next })}`,
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

async function getVaultFolder(creator, folderId) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  if (!folderId) {
    throw new MaloumApiError('folderId is required', 400);
  }
  const result = await requestJson({
    method: 'GET',
    path: `/vault/folders/${encodeURIComponent(folderId)}`,
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

async function listVaultMedia(creator, folderId, { fanId, limit = 50, next } = {}) {
  const { accessToken, proxyUrl, timezone } = authContext(creator);
  if (!folderId) {
    throw new MaloumApiError('folderId is required', 400);
  }
  const result = await requestJson({
    method: 'GET',
    path: `/vault/folders/${encodeURIComponent(folderId)}/media${buildQuery({
      fanId,
      limit,
      next,
    })}`,
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

function isAllowedMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (ALLOWED_MEDIA_HOSTS.has(parsed.hostname)) return true;
    if (
      parsed.hostname.endsWith('.storage.googleapis.com') ||
      parsed.hostname === 'storage.googleapis.com'
    ) {
      return parsed.pathname.includes('/maloum-prod-images/') ||
        parsed.pathname.includes('/maloum-');
    }
    if (parsed.hostname.includes('b-cdn.net') || parsed.hostname.includes('mediadelivery.net')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchMedia(creator, { url } = {}) {
  const { proxyUrl } = authContext(creator);
  if (!isAllowedMediaUrl(url)) {
    throw new MaloumApiError('Invalid or disallowed media URL', 400);
  }

  const dispatcher = createDispatcher(proxyUrl);
  let response;
  try {
    response = await undiciFetch(url, {
      method: 'GET',
      headers: {
        accept: '*/*',
        'user-agent': USER_AGENT,
        origin: APP_ORIGIN,
        referer: `${APP_ORIGIN}/`,
      },
      dispatcher,
    });
  } catch (err) {
    throw proxyFailureError(err);
  }

  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    ok: response.status >= 200 && response.status < 300,
  };
}

async function fetchCurrentUser({ accessToken, proxyUrl, timezone }) {
  const result = await requestJson({
    method: 'GET',
    path: '/users/current',
    proxyUrl,
    accessToken,
    timezone,
  });
  return result.data;
}

/**
 * Server-side Maloum login via api.maloum.com through the required proxy.
 */
async function login({
  usernameOrEmail,
  password,
  proxyUrl,
  timezone = 'UTC',
}) {
  if (!usernameOrEmail || !password) {
    throw new MaloumApiError('Email/username and password are required', 400);
  }

  const resolvedProxy = resolveMaloumProxyUrl(proxyUrl);
  const dispatcher = createDispatcher(resolvedProxy);
  const identifier = String(usernameOrEmail).trim();

  let response;
  try {
    response = await undiciFetch(`${API_BASE}/user-management/login`, {
      method: 'POST',
      headers: baseHeaders({ timezone }),
      body: JSON.stringify({
        usernameOrEmail: identifier,
        password: String(password),
      }),
      dispatcher,
    });
  } catch (err) {
    throw proxyFailureError(err);
  }

  const text = await response.text();
  const parsed = parseJsonSafe(text);

  if (response.status === 401) {
    throw new WrongPasswordError('Password not correct');
  }

  if (!response.ok) {
    throw new MaloumApiError(
      parsed?.message || `Login failed (${response.status})`,
      response.status,
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

  let currentUser = null;
  try {
    currentUser = await fetchCurrentUser({
      accessToken: session.access_token,
      proxyUrl: resolvedProxy,
      timezone,
    });
  } catch (err) {
    if (err instanceof MaloumApiError && err.status === 401) {
      throw new MaloumApiError(
        'Login succeeded but session token was rejected by Maloum',
        502,
        err.body
      );
    }
    throw err;
  }

  if (!session.user && currentUser) {
    session.user = {
      id: currentUser._id,
      email: currentUser.email,
      user_metadata: {
        username: currentUser.username,
      },
    };
  }

  const origins = buildSyntheticOrigins(session);
  const providerUserId =
    currentUser?._id ||
    session.user?.app_metadata?.userId ||
    session.user?.id ||
    null;
  const username = currentUser?.username || session.user?.user_metadata?.username || null;
  const displayName = displayNameFromUser(currentUser, username || identifier);
  const avatarUrl = avatarFromUser(currentUser);

  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: typeof session.expires_at === 'number' ? session.expires_at : null,
    expiresIn: session.expires_in,
    session,
    cookies: [],
    origins,
    providerUserId,
    displayName,
    username,
    avatarUrl,
    email: currentUser?.email || null,
    postLoginUrl: POST_LOGIN_URL,
  };
}

module.exports = {
  WrongPasswordError,
  MaloumApiError,
  resolveMaloumProxyUrl,
  authContext,
  login,
  fetchCurrentUser,
  avatarFromUser,
  buildSyntheticOrigins,
  listChats,
  getChat,
  getMessages,
  markRead,
  getUnreadCount,
  listNotifications,
  countUnreadChatsFromList,
  countUnreadNotificationsFromList,
  normalizeListData,
  sendMessage,
  sendText,
  sendMedia,
  sendPpv,
  listVaultFolders,
  getVaultFolder,
  listVaultMedia,
  fetchMedia,
  isAllowedMediaUrl,
  API_BASE,
  APP_ORIGIN,
  STORAGE_KEY,
};
