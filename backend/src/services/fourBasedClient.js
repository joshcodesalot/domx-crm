const { randomUUID } = require('crypto');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const REST_BASE = 'https://rest.4based.com/api/1.0';
const MEDIA_BASE = 'https://media.4based.com';
const APP_VERSION = '10.3.0.17';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

class WrongPasswordError extends Error {
  constructor(message = 'Password not correct') {
    super(message);
    this.name = 'WrongPasswordError';
    this.code = 'WRONG_PASSWORD';
  }
}

class FourBasedApiError extends Error {
  constructor(message, status = 500, body = null) {
    super(message);
    this.name = 'FourBasedApiError';
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
 * Resolve 4based proxy: explicit override, else FOURBASED_PROXY_URL from env.
 * Always required — 4based traffic must never go direct.
 */
function resolveFourBasedProxyUrl(override) {
  const fromOverride = typeof override === 'string' ? override.trim() : '';
  const fromEnv =
    typeof process.env.FOURBASED_PROXY_URL === 'string'
      ? process.env.FOURBASED_PROXY_URL.trim()
      : '';
  const resolved = fromOverride || fromEnv;
  if (!resolved) {
    throw new FourBasedApiError(
      '4based proxy is required. Set FOURBASED_PROXY_URL in backend .env or provide proxyUrl.',
      400
    );
  }
  const normalized = normalizeProxyUrl(resolved);
  if (!normalized) {
    throw new FourBasedApiError('4based proxy URL is invalid', 400);
  }
  return normalized;
}

function createDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    throw new FourBasedApiError(
      '4based proxy is required. Account not loaded.',
      400
    );
  }
  return new ProxyAgent(normalized);
}

function proxyFailureError(err) {
  const detail = err?.cause?.message || err?.message || 'connection error';
  return new FourBasedApiError(
    `4based proxy failed (${detail}). Account not loaded.`,
    502
  );
}

function cookieHeaderFromMap(cookies) {
  if (!cookies || typeof cookies !== 'object') {
    return '';
  }
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function parseSetCookieHeaders(headers) {
  const cookies = {};
  const getSetCookie =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : null;

  const rawList = Array.isArray(getSetCookie)
    ? getSetCookie
    : (() => {
        const single = headers.get('set-cookie');
        return single ? [single] : [];
      })();

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'string') continue;
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

function baseHeaders({ cookies, token, resource, extra = {} } = {}) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'x-app-version': APP_VERSION,
    origin: 'https://4based.com',
    referer: 'https://4based.com/',
    ...extra,
  };

  const cookie = cookieHeaderFromMap(cookies);
  if (cookie) {
    headers.cookie = cookie;
  }
  if (token) {
    headers['x-auth-token'] = token;
  }
  if (resource) {
    headers['x-auth-resource'] = resource;
  }

  return headers;
}

function decodeMaybeBase64Json(text) {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Login success body is base64-encoded JSON
  }

  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function extractSessionFromCreator(creator) {
  const session = creator?.session || {};
  return {
    providerUserId: creator.providerUserId || session.providerUserId || null,
    token: creator.accessToken || session.token || null,
    resource: session.resource || null,
    cookies: session.cookies || {},
    proxyUrl: creator.proxyUrl || null,
  };
}

async function requestJson({
  method = 'GET',
  url,
  proxyUrl,
  cookies,
  token,
  resource,
  body,
  extraHeaders,
}) {
  const dispatcher = createDispatcher(proxyUrl);
  let response;
  try {
    response = await undiciFetch(url, {
      method,
      headers: baseHeaders({ cookies, token, resource, extra: extraHeaders }),
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher,
    });
  } catch (err) {
    throw proxyFailureError(err);
  }

  const text = await response.text();
  const parsed = decodeMaybeBase64Json(text);

  if (!response.ok) {
    const message =
      parsed?.message ||
      parsed?.error ||
      `4based request failed (${response.status})`;
    throw new FourBasedApiError(message, response.status, parsed);
  }

  return {
    status: response.status,
    data: parsed,
    setCookies: parseSetCookieHeaders(response.headers),
    headers: response.headers,
  };
}

async function login({ identifier, password, proxyUrl, locale = 'en' }) {
  if (!identifier || !password) {
    throw new FourBasedApiError('Email and password are required', 400);
  }

  const resolvedProxy = resolveFourBasedProxyUrl(proxyUrl);
  const dispatcher = createDispatcher(resolvedProxy);
  let response;
  try {
    response = await undiciFetch(`${REST_BASE}/auth/login`, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify({
        identifier: String(identifier).trim(),
        password: String(password),
        locale,
      }),
      dispatcher,
    });
  } catch (err) {
    throw proxyFailureError(err);
  }

  const text = await response.text();
  const parsed = decodeMaybeBase64Json(text);
  const setCookies = parseSetCookieHeaders(response.headers);

  if (response.status === 400) {
    const passwordError =
      parsed?.errors?.password?.passwordnotcorrect ||
      parsed?.message === 'password not correct';
    if (passwordError) {
      throw new WrongPasswordError('Password not correct');
    }
  }

  if (!response.ok) {
    throw new FourBasedApiError(
      parsed?.message || `Login failed (${response.status})`,
      response.status,
      parsed
    );
  }

  const credentials = parsed?.credentials || {};
  const user = parsed?.user || {};
  const token = credentials.token;
  const resource = credentials.resource;

  if (!token || !resource || !user?._id) {
    throw new FourBasedApiError('Login response missing credentials or user', 502, parsed);
  }

  const cookies = {
    ...setCookies,
    resource: setCookies.resource || resource,
  };

  return {
    token,
    resource,
    user,
    cookies,
    providerUserId: user._id,
    displayName: user.name || user.identifier || identifier,
    username: user.name || null,
    avatarUrl:
      user.avatar?.preview?.['200x200'] ||
      user.avatar?.preview?.['100x100'] ||
      user.avatar?.preview?.['80x80'] ||
      null,
    postLoginUrl: 'https://4based.com/chat',
  };
}

function authContext(creator) {
  const session = extractSessionFromCreator(creator);
  if (!session.providerUserId || !session.token) {
    throw new FourBasedApiError('Creator is missing 4based auth session', 400);
  }
  return session;
}

const BUILTIN_CHAT_FILTERS = new Set([
  'online',
  'unread',
  'read',
  'follower',
  'subscribers',
]);

async function listChats(
  creator,
  { limit = 30, offset = 0, listName, userListId } = {}
) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const builtin =
    typeof listName === 'string' && BUILTIN_CHAT_FILTERS.has(listName.trim())
      ? listName.trim()
      : null;
  const listId =
    typeof userListId === 'string' && userListId.trim()
      ? userListId.trim()
      : null;

  let url;
  if (builtin || listId) {
    const sort = encodeURIComponent(JSON.stringify({ chat_updated_at: 'desc' }));
    url =
      `${REST_BASE}/user/${providerUserId}/chatsByList` +
      `?with_users=true&deleted_user_id=${providerUserId}` +
      `&with_last_message=true&without_empty_chats=true` +
      `&limit=${safeLimit}&offset=${safeOffset}&sort=${sort}`;
    if (listId) {
      url += `&list_names=&user_list_ids=${encodeURIComponent(listId)}`;
    } else {
      url += `&list_names=${encodeURIComponent(builtin)}`;
    }
  } else {
    const sort = encodeURIComponent(JSON.stringify({ updated_at: 'desc' }));
    url =
      `${REST_BASE}/user/${providerUserId}/chat` +
      `?with_users=true&deleted_user_id=${providerUserId}` +
      `&with_last_message=true&without_empty_chats=true` +
      `&limit=${safeLimit}&offset=${safeOffset}&sort=${sort}&list_names=`;
  }

  const result = await requestJson({
    url,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function pinChat(creator, chatId, isPinned) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    method: 'POST',
    url: `${REST_BASE}/user/${providerUserId}/chat/${chatId}/pin`,
    proxyUrl,
    cookies,
    token,
    resource,
    body: { is_pinned: Boolean(isPinned) },
  });
  return result.data;
}

async function listUserLists(creator, { limit = 20, offset = 0 } = {}) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const sort = encodeURIComponent(JSON.stringify({ position: 'asc' }));
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const result = await requestJson({
    url:
      `${REST_BASE}/user/${providerUserId}/user-lists` +
      `?offset=${safeOffset}&limit=${safeLimit}&sort=${sort}`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  const data = result.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return data?.items || [];
}

async function getUserListsForFan(creator, fanId) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    url: `${REST_BASE}/user/${providerUserId}/user-lists/contains-user/${fanId}`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  const payload = result.data?.data || result.data || {};
  const ids = Array.isArray(payload.user_list_ids) ? payload.user_list_ids : [];
  return { userId: payload.user_id || fanId, userListIds: ids };
}

async function addUserToList(creator, listId, fanId) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    method: 'POST',
    url: `${REST_BASE}/user/${providerUserId}/user-lists/${listId}/add-users`,
    proxyUrl,
    cookies,
    token,
    resource,
    body: { id: listId, user_ids: [fanId] },
  });
  return result.data;
}

async function removeUserFromList(creator, listId, fanId) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    method: 'POST',
    url: `${REST_BASE}/user/${providerUserId}/user-lists/${listId}/remove-users`,
    proxyUrl,
    cookies,
    token,
    resource,
    body: { id: listId, user_ids: [fanId] },
  });
  return result.data;
}

async function getUnread(creator) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    url: `${REST_BASE}/user/${providerUserId}/chat/unread-messages`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

function sumUnreadMessages(unread) {
  if (!unread || typeof unread !== 'object' || Array.isArray(unread)) {
    return 0;
  }
  let total = 0;
  for (const value of Object.values(unread)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      total += n;
    }
  }
  return total;
}

async function getBadges(creator) {
  const { providerUserId } = authContext(creator);
  const [unread, profile] = await Promise.all([
    getUnread(creator),
    getUser(creator, providerUserId),
  ]);
  return {
    messages: sumUnreadMessages(unread),
    notifications: Number(profile?.activity_count) || 0,
  };
}

async function listActivities(creator, { offset = 0, limit = 20, types } = {}) {
  const { token, resource, cookies, proxyUrl } = authContext(creator);
  const sort = encodeURIComponent(JSON.stringify({ created_at: 'desc' }));
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  let url =
    `${REST_BASE}/activity?offset=${safeOffset}&limit=${safeLimit}&sort=${sort}`;
  if (typeof types === 'string' && types.trim()) {
    url += `&types=${encodeURIComponent(types.trim())}`;
  } else if (Array.isArray(types) && types.length > 0) {
    url += `&types=${encodeURIComponent(types.join(','))}`;
  }
  const result = await requestJson({
    url,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function resetActivities(creator) {
  const { token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    url: `${REST_BASE}/activity/reset`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function getChat(creator, chatId) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    url:
      `${REST_BASE}/user/${providerUserId}/chat/${chatId}` +
      `?with_last_message=true&with_users=true`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function getMessages(creator, chatId, { limit = 20, offset = 0 } = {}) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const sort = encodeURIComponent(JSON.stringify({ created_at: 'desc' }));
  const result = await requestJson({
    url:
      `${REST_BASE}/user/${providerUserId}/chat/${chatId}/message` +
      `?limit=${limit}&offset=${offset}&sort=${sort}` +
      `&with_file_stack=true&with_tip=true`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function markReceived(creator, chatId) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    method: 'PUT',
    url: `${REST_BASE}/user/${providerUserId}/chat/${chatId}/update-messages-status-received`,
    proxyUrl,
    cookies,
    token,
    resource,
    body: {},
  });
  return result.data;
}

async function getPivot(creator, fanId) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    url: `${REST_BASE}/user/${providerUserId}/pivot/${fanId}`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function updatePivot(creator, fanId, { alias, note } = {}) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const body = {};
  if (alias !== undefined) body.alias = alias == null ? '' : String(alias);
  if (note !== undefined) body.note = note == null ? '' : String(note);
  if (Object.keys(body).length === 0) {
    throw new FourBasedApiError('alias or note is required', 400);
  }
  const result = await requestJson({
    method: 'PUT',
    url: `${REST_BASE}/user/${providerUserId}/pivot/${fanId}`,
    proxyUrl,
    cookies,
    token,
    resource,
    body,
  });
  return result.data;
}

async function deletePivotField(creator, fanId, field) {
  const allowed = field === 'alias' || field === 'note';
  if (!allowed) {
    throw new FourBasedApiError('field must be alias or note', 400);
  }
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    method: 'DELETE',
    url: `${REST_BASE}/user/${providerUserId}/pivot/${fanId}/${field}`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function sendTyping(creator, chatId) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  try {
    await requestJson({
      method: 'POST',
      url: `${REST_BASE}/user/${providerUserId}/chat/${chatId}/typing`,
      proxyUrl,
      cookies,
      token,
      resource,
      body: {},
    });
  } catch {
    // Typing is best-effort
  }
}

async function sendText(creator, chatId, { message, localId } = {}) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  await sendTyping(creator, chatId);

  const result = await requestJson({
    method: 'POST',
    url: `${REST_BASE}/user/${providerUserId}/chat/${chatId}/message`,
    proxyUrl,
    cookies,
    token,
    resource,
    body: {
      message: typeof message === 'string' ? message : '',
      file_stack_id: null,
      sender_status: 'sent',
      local_id: localId || randomUUID(),
    },
  });
  return result.data;
}

async function sendMessage(creator, chatId, { message, fileStackId, localId } = {}) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  await sendTyping(creator, chatId);

  const result = await requestJson({
    method: 'POST',
    url: `${REST_BASE}/user/${providerUserId}/chat/${chatId}/message`,
    proxyUrl,
    cookies,
    token,
    resource,
    body: {
      message: typeof message === 'string' ? message : '',
      file_stack_id: fileStackId || null,
      sender_status: 'sent',
      local_id: localId || randomUUID(),
    },
  });
  return result.data;
}

async function deleteMessage(creator, chatId, messageId) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  if (!chatId) {
    throw new FourBasedApiError('chatId is required', 400);
  }
  if (!messageId) {
    throw new FourBasedApiError('messageId is required', 400);
  }
  const result = await requestJson({
    method: 'PUT',
    url:
      `${REST_BASE}/user/${providerUserId}/chat/${encodeURIComponent(chatId)}` +
      `/delete-message-for-users-in-chat`,
    proxyUrl,
    cookies,
    token,
    resource,
    body: { id: String(messageId) },
  });
  return result.data;
}

async function getUser(creator, userId) {
  const { token, resource, cookies, proxyUrl } = authContext(creator);
  if (!userId) {
    throw new FourBasedApiError('userId is required', 400);
  }
  const result = await requestJson({
    url: `${REST_BASE}/user/${encodeURIComponent(userId)}`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function listVault(
  creator,
  {
    fanId,
    limit = 60,
    offset = 0,
    folder,
    fileType,
    sold,
    sent,
  } = {}
) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);
  if (!fanId) {
    throw new FourBasedApiError('fanId is required to list vault', 400);
  }
  const sort = encodeURIComponent(JSON.stringify({ created_at: 'desc' }));
  let url =
    `${REST_BASE}/user/${providerUserId}/vault` +
    `?offset=${offset}&limit=${limit}&sort=${sort}` +
    `&with_source=true&buyer_user_id=${encodeURIComponent(fanId)}`;
  if (typeof folder === 'string' && folder.trim()) {
    url += `&belongs_to_folders=${encodeURIComponent(folder.trim())}`;
  }
  if (fileType === 'image' || fileType === 'video') {
    url += `&file_type=${encodeURIComponent(fileType)}`;
  }
  if (sold === true || sold === false) {
    url += `&sold=${sold ? 'true' : 'false'}`;
  }
  if (sent === true || sent === false) {
    url += `&sent=${sent ? 'true' : 'false'}`;
  }
  const result = await requestJson({
    url,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function getCoinPackages(creator) {
  const { token, resource, cookies, proxyUrl } = authContext(creator);
  const result = await requestJson({
    url: `${REST_BASE}/coin-packages`,
    proxyUrl,
    cookies,
    token,
    resource,
  });
  return result.data;
}

async function createFileStackFromVault(creator, {
  vaultId,
  vaultGuid,
  vaults,
  description,
  priceCoins,
  guid,
} = {}) {
  const { providerUserId, token, resource, cookies, proxyUrl } = authContext(creator);

  let vaultEntries = [];
  if (Array.isArray(vaults) && vaults.length > 0) {
    vaultEntries = vaults
      .map((entry, index) => {
        const id = entry?.id || entry?.vaultId;
        if (!id) return null;
        return {
          id: String(id),
          guid: entry?.guid || entry?.vaultGuid || randomUUID(),
          position: Number.isFinite(entry?.position) ? Number(entry.position) : index,
          is_teaser: Boolean(entry?.is_teaser),
        };
      })
      .filter(Boolean);
  } else if (vaultId) {
    vaultEntries = [
      {
        id: String(vaultId),
        guid: vaultGuid || randomUUID(),
        position: 0,
        is_teaser: false,
      },
    ];
  }

  if (vaultEntries.length === 0) {
    throw new FourBasedApiError('At least one vault item is required', 400);
  }

  const result = await requestJson({
    method: 'POST',
    url: `${REST_BASE}/user/${providerUserId}/file-stack/`,
    proxyUrl,
    cookies,
    token,
    resource,
    body: {
      vaults_to_file_stack: {
        vaults: vaultEntries,
        description: description || '',
        price: Number(priceCoins) || 0,
        status: 'available',
        is_subscription_item: false,
        additional_categories: ['chat_message'],
        guid: guid || randomUUID(),
      },
    },
  });
  return result.data;
}

async function sendPpv(creator, chatId, {
  message,
  vaultId,
  vaultGuid,
  vaults,
  priceCoins,
  localId,
} = {}) {
  const fileStack = await createFileStackFromVault(creator, {
    vaultId,
    vaultGuid,
    vaults,
    description: message || '',
    priceCoins: Number(priceCoins) || 0,
  });

  const fileStackId = fileStack?._id;
  if (!fileStackId) {
    throw new FourBasedApiError('Failed to create file stack for PPV', 502, fileStack);
  }

  const sent = await sendMessage(creator, chatId, {
    message: message || '',
    fileStackId,
    localId: localId || randomUUID(),
  });

  return { message: sent, fileStack };
}

function sanitizeMediaPath(path, providerUserId) {
  if (!path || typeof path !== 'string') {
    return null;
  }
  let cleaned = path.trim();
  if (cleaned.startsWith('https://media.4based.com/')) {
    cleaned = cleaned.slice('https://media.4based.com/'.length);
  }
  if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }
  if (
    cleaned.includes('..') ||
    cleaned.includes('\\') ||
    cleaned.includes('://') ||
    cleaned.startsWith('//')
  ) {
    return null;
  }

  const allowedPrefix = `protected/${providerUserId}/`;
  if (!cleaned.startsWith(allowedPrefix) && !cleaned.startsWith('public/')) {
    return null;
  }

  return cleaned;
}

async function fetchMedia(creator, { path, rangeHeader } = {}) {
  const { providerUserId, cookies, proxyUrl } = authContext(creator);
  const safePath = sanitizeMediaPath(path, providerUserId);
  if (!safePath) {
    throw new FourBasedApiError('Invalid media path', 400);
  }

  const dispatcher = createDispatcher(proxyUrl);
  const headers = {
    accept: '*/*',
    'user-agent': USER_AGENT,
    origin: 'https://4based.com',
    referer: 'https://4based.com/',
    cookie: cookieHeaderFromMap(cookies),
  };
  if (rangeHeader) {
    headers.range = rangeHeader;
  }

  let response;
  try {
    response = await undiciFetch(`${MEDIA_BASE}/${safePath}`, {
      method: 'GET',
      headers,
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

function buildMediaPreviewPath(providerUserId, fileStackId, size = '500x500.jpg') {
  if (!providerUserId || !fileStackId) return null;
  return `protected/${providerUserId}/${fileStackId}/preview/${size}`;
}

module.exports = {
  WrongPasswordError,
  FourBasedApiError,
  normalizeProxyUrl,
  resolveFourBasedProxyUrl,
  login,
  listChats,
  pinChat,
  listUserLists,
  getUserListsForFan,
  addUserToList,
  removeUserFromList,
  getUnread,
  getBadges,
  listActivities,
  resetActivities,
  getChat,
  getMessages,
  markReceived,
  getPivot,
  updatePivot,
  deletePivotField,
  sendTyping,
  sendText,
  sendMessage,
  deleteMessage,
  getUser,
  listVault,
  getCoinPackages,
  createFileStackFromVault,
  sendPpv,
  fetchMedia,
  sanitizeMediaPath,
  buildMediaPreviewPath,
  extractSessionFromCreator,
  BUILTIN_CHAT_FILTERS,
};
