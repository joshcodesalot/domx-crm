const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator, getUserIdsWithCreatorAccess } = require('../services/creatorAccess');
const { decryptJson, decryptSecret, encryptJson, encryptSecret } = require('../services/crypto');
const { emitToUsers } = require('../services/userEventBus');
const fanslyClient = require('../services/fanslyClient');
const messagingDashboard = require('./messagingDashboard');
const fanslyMediaCache = require('../services/fanslyMediaCache');
const { loadFanslyCreator } = require('../services/platformCreatorSession');
const {
  InvalidProxyError,
  customProxyFromBody,
} = require('../services/proxyUrl');

const router = express.Router();

const fanslyFeedUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok =
      typeof file.mimetype === 'string' && /^(image|video)\//i.test(file.mimetype);
    if (!ok) {
      return cb(new Error('Only images and videos are allowed'));
    }
    return cb(null, true);
  },
});

const connectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many connect attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const CREATOR_RETURNING = `
  id, "displayName", username, platform, "connectionStatus",
  "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
  "loginEmail", "lastValidatedAt", "authRefreshState", "accessTokenExpiresAt",
  "marketingEnabled", "createdAt", "updatedAt",
  ("encryptedLoginPassword" IS NOT NULL) AS "hasSavedCredentials",
  ("encryptedProxy" IS NOT NULL) AS "hasCustomProxy"
`;

const fanSpendCache = new Map();
const FAN_SPEND_TTL_MS = 5 * 60 * 1000;
const FAN_SPEND_CONCURRENCY = 4;

function rememberFanSpend(key, mills) {
  if (fanSpendCache.size > 1000) {
    const now = Date.now();
    for (const [cachedKey, cached] of fanSpendCache) {
      if (cached.expiresAt <= now) fanSpendCache.delete(cachedKey);
    }
  }
  fanSpendCache.set(key, { mills, expiresAt: Date.now() + FAN_SPEND_TTL_MS });
}

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function lifetimeGrossForFan(session, creatorId, fanId) {
  const key = `${creatorId}:${fanId}`;
  const cached = fanSpendCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.mills;
  try {
    const stats = await fanslyClient.getFanStats(session, fanId);
    const mills = Number(stats.lifetimeGrossMills) || 0;
    rememberFanSpend(key, mills);
    return mills;
  } catch (err) {
    console.warn('[fansly] fan spend failed:', err.message);
    rememberFanSpend(key, null);
    return null;
  }
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function toCreator(row) {
  return {
    id: row.id,
    displayName: row.displayName,
    username: row.username,
    platform: row.platform,
    connectionStatus: row.connectionStatus,
    postLoginUrl: row.postLoginUrl,
    avatarUrl: row.avatarUrl || null,
    avatarSource: row.avatarSource || null,
    staffCount: row.staffCount,
    accountId: row.accountId || null,
    partitionId: row.partitionId || null,
    loginEmail: row.loginEmail || null,
    hasSavedCredentials: Boolean(row.hasSavedCredentials || row.encryptedLoginPassword),
    hasCustomProxy: Boolean(row.hasCustomProxy),
    lastValidatedAt: row.lastValidatedAt || null,
    marketingEnabled: Boolean(row.marketingEnabled),
    authRefreshState: row.authRefreshState || 'active',
    accessTokenExpiresAt: row.accessTokenExpiresAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function readCustomProxy(body) {
  try {
    return { ok: true, ...customProxyFromBody(body) };
  } catch (err) {
    if (err instanceof InvalidProxyError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

function twofaChallengeResponse(res, err) {
  return res.json({
    status: 'twofa_required',
    twofaToken: err.twofaToken,
    deviceId: err.deviceId,
    ...(Number.isInteger(err.twofaType) ? { twofaType: err.twofaType } : {}),
    ...(typeof err.email === 'string' && err.email ? { email: err.email } : {}),
  });
}

function readTwofaCompletion(body) {
  const twofaToken = typeof body?.twofaToken === 'string' ? body.twofaToken.trim() : '';
  const twofaCode = typeof body?.twofaCode === 'string' ? body.twofaCode.trim() : '';
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
  return {
    active: Boolean(twofaToken && twofaCode),
    twofaToken,
    twofaCode,
    deviceId,
  };
}

function partnerAccountId(group, creatorId) {
  const users = Array.isArray(group?.users) ? group.users : [];
  const other = users.find(
    (user) => user && user.userId && String(user.userId) !== String(creatorId || '')
  );
  return other ? String(other.userId) : '';
}

function readOutgoingMedia(body) {
  if (!Array.isArray(body?.media) || body.media.length === 0) return [];
  const items = [];
  for (const item of body.media) {
    const mediaId = item?.mediaId == null ? '' : String(item.mediaId).trim();
    if (!/^\d+$/.test(mediaId)) {
      throw new fanslyClient.FanslyApiError('Media id is required', 400);
    }
    const mediaType = Number(item?.mediaType);
    items.push({
      mediaId,
      mediaType: Number.isInteger(mediaType) && mediaType > 0 ? mediaType : 1,
    });
    if (items.length >= 10) break;
  }
  return items;
}

function readLockedText(body) {
  const raw = body?.lockedText;
  if (!raw || typeof raw !== 'object') return null;
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content) return null;
  const sets = Array.isArray(raw.permissionSets) ? raw.permissionSets : [];
  const permissionSets = (sets.length > 0 ? sets : [{}]).slice(0, 5).map((set) => readMediaPermissions({ permissions: set }));
  return { content, permissionSets };
}

function readFeedPermissions(body) {
  if (typeof body?.permissions === 'string' && body.permissions.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(body.permissions);
    } catch {
      throw new fanslyClient.FanslyApiError('Permissions are invalid', 400);
    }
    return readMediaPermissions({ permissions: parsed });
  }
  return readMediaPermissions(body);
}

async function publishFanslyFeed(session, creator, { content, mediaId, permissions }) {
  const walls = await fanslyClient.listWalls(session, creator.providerUserId);
  const wallId = fanslyClient.pickPostsWall(walls);
  const created = await fanslyClient.createAccountMedia(
    session,
    fanslyClient.buildFeedAccountMediaBody({ mediaId, permissions })
  );
  const accountMediaId = created[0]?.id == null ? '' : String(created[0].id);
  if (!/^\d+$/.test(accountMediaId)) {
    throw new fanslyClient.FanslyApiError('Fansly did not return media', 502);
  }
  const post = await fanslyClient.createFeedPost(session, {
    content,
    accountMediaId,
    wallId,
  });
  const mapped = fanslyClient.toFeedPost(post, created);
  if (!mapped.createdAt) mapped.createdAt = Math.floor(Date.now() / 1000);
  return mapped;
}

function readBroadcastAudience(body) {
  let raw = body?.audience;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new fanslyClient.FanslyApiError('Audience is invalid', 400);
    }
  }
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new fanslyClient.FanslyApiError('Audience is invalid', 400);
  }
  const audience = raw && typeof raw === 'object' ? raw : {};
  const tier =
    audience.subscriptionTierId == null ? '' : String(audience.subscriptionTierId).trim();
  return {
    followers: Boolean(audience.followers),
    subscribers: audience.subscribers !== false,
    expiredSubscribers: Boolean(audience.expiredSubscribers),
    excludeCreators: audience.excludeCreators !== false,
    excludeOffline: Boolean(audience.excludeOffline),
    includeListIds: Array.isArray(audience.includeListIds) ? audience.includeListIds : [],
    excludeListIds: Array.isArray(audience.excludeListIds) ? audience.excludeListIds : [],
    subscriptionTierId: tier || null,
  };
}

function readBroadcastMediaIds(mediaIds) {
  if (mediaIds == null) return [];
  if (!Array.isArray(mediaIds)) {
    throw new fanslyClient.FanslyApiError('Media is invalid', 400);
  }
  const ids = [];
  const seen = new Set();
  for (const value of mediaIds) {
    const id = value == null ? '' : String(value).trim();
    if (!id) continue;
    if (!/^\d+$/.test(id)) {
      throw new fanslyClient.FanslyApiError('Media id is required', 400);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > fanslyClient.BROADCAST_MEDIA_CAP) {
    throw new fanslyClient.FanslyApiError('At most 10 media items are allowed', 400);
  }
  return ids;
}

async function sendFanslyBroadcast(session, creator, { content, mediaIds, audience }) {
  const ids = readBroadcastMediaIds(mediaIds);
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text && ids.length === 0) {
    throw new fanslyClient.FanslyApiError('Message text is required', 400);
  }
  const group = await fanslyClient.createBroadcastGroup(
    session,
    fanslyClient.buildBroadcastGroupBody({
      creatorId: creator.providerUserId,
      groupFlags: fanslyClient.broadcastGroupFlags(audience),
      includeListIds: audience.includeListIds,
      excludeListIds: audience.excludeListIds,
      subscriptionTierId: audience.subscriptionTierId,
    })
  );
  const attachments = await fanslyClient.attachUnlockedBroadcastMedia(session, ids);
  await fanslyClient.sendBroadcastMessage(
    session,
    fanslyClient.buildBroadcastMessageBody({
      groupId: group.id,
      content: text,
      attachments,
    })
  );
  return { ok: true, groupId: String(group.id) };
}

function readMediaPermissions(body) {
  const raw = body?.permissions && typeof body.permissions === 'object' ? body.permissions : {};
  const tier = raw.subscriptionTierId == null ? '' : String(raw.subscriptionTierId).trim();
  return {
    requirePurchase: Boolean(raw.requirePurchase),
    price: raw.price,
    requireSubscription: Boolean(raw.requireSubscription),
    subscriptionTierId: tier || null,
    requireFollow: Boolean(raw.requireFollow),
  };
}

function fanslyProxyMediaUrl(req, creatorId, mediaId, cdnUrl) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  const params = new URLSearchParams({
    mediaId: String(mediaId),
    url: cdnUrl,
  });
  if (typeof req.query.access_token === 'string' && req.query.access_token) {
    params.set('access_token', req.query.access_token);
  }
  return `${proto}://${host}/api/creators/${creatorId}/fansly/media?${params}`;
}

function handleFanslyError(res, err, label) {
  if (err instanceof fanslyClient.TwoFactorRequiredError) {
    return twofaChallengeResponse(res, err);
  }
  if (err instanceof fanslyClient.WrongPasswordError) {
    return res.status(400).json({ error: 'Password not correct' });
  }
  if (err instanceof fanslyClient.FanslyApiError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({ error: err.message || 'Fansly request failed' });
  }
  console.error(label, err);
  return res.status(500).json({ error: 'Internal server error' });
}

function sessionPayloadFromLogin(loginResult, loginEmail) {
  return {
    cookies: loginResult.cookies,
    token: loginResult.token,
    sessionId: loginResult.sessionId,
    deviceId: loginResult.deviceId,
    providerUserId: loginResult.providerUserId,
    loginEmail,
    savedAt: new Date().toISOString(),
    platform: 'fansly',
  };
}

async function requireFansly(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid creator ID' });
    return null;
  }
  const allowed = await userCanAccessCreator(req.user, id);
  if (!allowed) {
    res.status(403).json({ error: 'You do not have access to this creator' });
    return null;
  }
  const loaded = await loadFanslyCreator(id);
  if (loaded.error) {
    res.status(loaded.error.status).json({ error: loaded.error.message });
    return null;
  }
  return loaded.creator;
}

function fanslySession(creator) {
  return fanslyClient.sessionFromCreator(creator);
}

async function emitSessionUpdated(creatorId, accountId, savedAt) {
  const accessUserIds = await getUserIdsWithCreatorAccess(creatorId);
  if (!accessUserIds.length) return;
  emitToUsers(accessUserIds, {
    type: 'creator:session-updated',
    creatorId,
    accountId: accountId || null,
    sessionUpdatedAt: savedAt || null,
  });
}

async function saveLoginResult(creatorId, loginResult, loginEmail, { password, encryptedProxy, proxyProvided }) {
  const sessionPayload = sessionPayloadFromLogin(loginResult, loginEmail);
  const encryptedSession = encryptJson(sessionPayload);
  const encryptedAccessToken = encryptSecret(loginResult.token);
  const encryptedLoginPassword =
    typeof password === 'string' && password.length ? encryptSecret(password) : null;

  const updated = await pool.query(
    `UPDATE creators SET
       "encryptedSession" = $1,
       "encryptedAccessToken" = $2,
       "encryptedProxy" = CASE WHEN $3::boolean THEN $4 ELSE "encryptedProxy" END,
       "providerUserId" = $5,
       "loginEmail" = $6,
       "encryptedLoginPassword" = COALESCE($7, "encryptedLoginPassword"),
       username = COALESCE($8, username),
       "avatarUrl" = COALESCE($9, "avatarUrl"),
       "postLoginUrl" = $10,
       "connectionStatus" = 'connected',
       "lastValidatedAt" = NOW(),
       "authRefreshState" = 'active',
       "updatedAt" = NOW()
     WHERE id = $11
     RETURNING ${CREATOR_RETURNING}`,
    [
      encryptedSession,
      encryptedAccessToken,
      Boolean(proxyProvided),
      encryptedProxy,
      loginResult.providerUserId,
      loginEmail,
      encryptedLoginPassword,
      loginResult.username,
      loginResult.avatarUrl,
      loginResult.postLoginUrl,
      creatorId,
    ]
  );

  await emitSessionUpdated(creatorId, updated.rows[0]?.accountId, sessionPayload.savedAt);
  return updated.rows[0];
}

router.post(
  '/:id/fansly/reconnect',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    const { email, password } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!password || typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const customProxy = readCustomProxy(req.body);
    if (!customProxy.ok) {
      return res.status(400).json({ error: customProxy.error });
    }

    try {
      const result = await pool.query(
        `SELECT id, platform, "accountId", "encryptedSession", "encryptedProxy"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (result.rows[0].platform !== 'fansly') {
        return res.status(400).json({ error: 'Creator is not a Fansly account' });
      }

      let deviceId = null;
      try {
        const existing = result.rows[0].encryptedSession
          ? decryptJson(result.rows[0].encryptedSession)
          : null;
        deviceId = existing?.deviceId || null;
      } catch {
        deviceId = null;
      }

      const storedProxy = result.rows[0].encryptedProxy
        ? decryptSecret(result.rows[0].encryptedProxy)
        : null;
      const resolvedProxy = fanslyClient.resolveFanslyProxyUrl(
        customProxy.provided ? customProxy.proxyUrl : storedProxy
      );
      const twofa = readTwofaCompletion(req.body);
      const loginResult = twofa.active
        ? await fanslyClient.verifyTwofa({
            twofaToken: twofa.twofaToken,
            code: twofa.twofaCode,
            deviceId: twofa.deviceId || deviceId,
            proxyUrl: resolvedProxy,
          })
        : await fanslyClient.login({
            username: email.trim(),
            password,
            proxyUrl: resolvedProxy,
            deviceId,
          });
      const encryptedProxy = customProxy.provided ? encryptSecret(resolvedProxy) : null;
      const row = await saveLoginResult(id, loginResult, email.trim(), {
        password,
        encryptedProxy,
        proxyProvided: customProxy.provided,
      });
      return res.json({ creator: toCreator(row) });
    } catch (err) {
      return handleFanslyError(res, err, 'Reconnect Fansly creator error:');
    }
  }
);

router.post(
  '/:id/fansly/reconnect-saved',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const result = await pool.query(
        `SELECT id, platform, "accountId", "loginEmail", "encryptedLoginPassword",
                "encryptedProxy", "encryptedSession"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      const row = result.rows[0];
      if (row.platform !== 'fansly') {
        return res.status(400).json({ error: 'Creator is not a Fansly account' });
      }
      if (!row.loginEmail || !row.encryptedLoginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }
      const loginPassword = decryptSecret(row.encryptedLoginPassword);
      if (!loginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      let deviceId = null;
      try {
        const existing = row.encryptedSession ? decryptJson(row.encryptedSession) : null;
        deviceId = existing?.deviceId || null;
      } catch {
        deviceId = null;
      }

      const storedProxy = row.encryptedProxy ? decryptSecret(row.encryptedProxy) : null;
      const resolvedProxy = fanslyClient.resolveFanslyProxyUrl(storedProxy);
      const twofa = readTwofaCompletion(req.body);
      const loginResult = twofa.active
        ? await fanslyClient.verifyTwofa({
            twofaToken: twofa.twofaToken,
            code: twofa.twofaCode,
            deviceId: twofa.deviceId || deviceId,
            proxyUrl: resolvedProxy,
          })
        : await fanslyClient.login({
            username: row.loginEmail.trim(),
            password: loginPassword,
            proxyUrl: resolvedProxy,
            deviceId,
          });
      const updated = await saveLoginResult(id, loginResult, row.loginEmail.trim(), {
        password: null,
        encryptedProxy: null,
        proxyProvided: false,
      });
      return res.json({ creator: toCreator(updated) });
    } catch (err) {
      return handleFanslyError(res, err, 'Reconnect-saved Fansly creator error:');
    }
  }
);

router.get(
  '/:id/fansly/chats',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const flags = Number(req.query.flags);
      const sortOrder = Number(req.query.sortOrder);
      const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
      const subscriptionTierId =
        typeof req.query.subscriptionTierId === 'string' ? req.query.subscriptionTierId.trim() : '';
      const listIds = typeof req.query.listIds === 'string' ? req.query.listIds.trim() : '';
      const resolvedFlags = flags === 2 || flags === 4 || flags === 32 ? flags : 0;
      const limit = Math.min(
        Math.max(Number(req.query.limit) || (resolvedFlags === 32 ? 10 : 20), 1),
        50
      );
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const session = fanslySession(creator);
      const chats = await fanslyClient.listGroups(session, {
        flags: resolvedFlags,
        sortOrder: sortOrder === 2 || sortOrder === 3 ? sortOrder : 1,
        search,
        subscriptionTierId,
        listIds,
        limit,
        offset,
      });
      const previewIds = chats.map((chat) => chat.lastMessageId).filter(Boolean);
      let previews = [];
      if (previewIds.length > 0) {
        try {
          previews = await fanslyClient.getMessagesByIds(session, previewIds);
        } catch (err) {
          console.warn('[fansly] inbox preview failed:', err.message);
        }
      }
      const byId = new Map(previews.map((message) => [message.id, message]));
      const spend = await mapWithLimit(chats, FAN_SPEND_CONCURRENCY, (chat) =>
        chat.partnerAccountId
          ? lifetimeGrossForFan(session, creator.id, chat.partnerAccountId)
          : null
      );
      res.json({
        chats: chats.map((chat, index) => ({
          ...chat,
          lastMessage: byId.get(chat.lastMessageId) || null,
          lifetimeGrossMills: spend[index],
        })),
        providerUserId: creator.providerUserId,
      });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly chats error:');
    }
  }
);

router.get(
  '/:id/fansly/chats/:groupId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const group = await fanslyClient.getGroup(fanslySession(creator), req.params.groupId);
      res.json({ group, providerUserId: creator.providerUserId });
    } catch (err) {
      return handleFanslyError(res, err, 'Get Fansly chat error:');
    }
  }
);

router.get(
  '/:id/fansly/chats/:groupId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const session = fanslySession(creator);
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
      const messages = await fanslyClient.listMessages(session, req.params.groupId, { limit });
      const unreadIds = messages
        .filter((message) => {
          if (!message.senderId || message.senderId === creator.providerUserId) return false;
          const mine = (message.interactions || []).find(
            (row) => String(row.userId) === String(creator.providerUserId)
          );
          return !mine || !mine.readAt;
        })
        .map((message) => message.id);
      if (unreadIds.length > 0) {
        try {
          await fanslyClient.ackMessages(session, unreadIds);
        } catch (err) {
          console.warn('[fansly] ack on open failed:', err.message);
        }
      }
      res.json({ messages, providerUserId: creator.providerUserId });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly messages error:');
    }
  }
);

router.post(
  '/:id/fansly/chats/:groupId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const session = fanslySession(creator);
      const media = readOutgoingMedia(req.body);
      const lockedText = readLockedText(req.body);
      const attachments = [];
      let sentMedia;
      if (lockedText) {
        const stories = [];
        for (const permissions of lockedText.permissionSets) {
          const created = await fanslyClient.createStory(
            session,
            fanslyClient.buildLockedTextBody({
              content: lockedText.content,
              permissions,
            })
          );
          attachments.push({
            contentId: created.id,
            contentType: fanslyClient.MESSAGE_CONTENT_STORY,
          });
          stories.push(created.story);
        }
        sentMedia = { stories };
      } else if (media.length > 0) {
        const group = await fanslyClient.getGroup(session, req.params.groupId);
        const fanId = partnerAccountId(group, creator.providerUserId);
        if (!fanId) {
          return res.status(400).json({ error: 'Chat partner is required' });
        }
        const permissions = readMediaPermissions(req.body);
        const createdAccountMedia = [];
        const createdBundles = [];
        if (media.length === 1) {
          const created = await fanslyClient.createAccountMedia(
            session,
            fanslyClient.buildAccountMediaBody({
              mediaId: media[0].mediaId,
              fanId,
              creatorId: creator.providerUserId,
              permissions,
            })
          );
          const contentId = created[0]?.id == null ? '' : String(created[0].id);
          if (!/^\d+$/.test(contentId)) {
            throw new fanslyClient.FanslyApiError('Fansly did not return media', 502);
          }
          attachments.push({ contentId, contentType: fanslyClient.MESSAGE_CONTENT_MEDIA });
          createdAccountMedia.push(...created);
        } else {
          const bundle = await fanslyClient.createAccountMediaBundle(
            session,
            fanslyClient.buildAccountMediaBundleBody({
              mediaIds: media.map((item) => item.mediaId),
              fanId,
              creatorId: creator.providerUserId,
              permissions,
            })
          );
          attachments.push({
            contentId: bundle.id,
            contentType: fanslyClient.MESSAGE_CONTENT_BUNDLE,
          });
          createdAccountMedia.push(...bundle.accountMedia);
          createdBundles.push(...bundle.accountMediaBundles);
        }
        sentMedia = { accountMedia: createdAccountMedia, accountMediaBundles: createdBundles };
      }
      const message = fanslyClient.hydrateMessageMedia(
        await fanslyClient.sendMessage(session, {
          groupId: req.params.groupId,
          content: lockedText ? '' : req.body?.content,
          attachments,
        }),
        sentMedia
      );
      res.json({ message });
    } catch (err) {
      return handleFanslyError(res, err, 'Send Fansly message error:');
    }
  }
);

router.post(
  '/:id/fansly/chats/:groupId/messages/:messageId/delete',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const message = await fanslyClient.deleteMessage(
        fanslySession(creator),
        req.params.messageId
      );
      res.json({ message });
    } catch (err) {
      return handleFanslyError(res, err, 'Delete Fansly message error:');
    }
  }
);

router.get(
  '/:id/fansly/vault/albums',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const albums = await fanslyClient.listVaultAlbums(fanslySession(creator));
      res.json({ albums });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly vault albums error:');
    }
  }
);

router.get(
  '/:id/fansly/vault/media',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const media = await fanslyClient.listVaultMedia(fanslySession(creator), {
        albumId: req.query.albumId,
      });
      res.json({ media });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly vault media error:');
    }
  }
);

router.get(
  '/:id/fansly/media',
  async (req, res, next) => {
    if (!req.headers.authorization && typeof req.query.access_token === 'string') {
      req.headers.authorization = `Bearer ${req.query.access_token}`;
    }
    return authenticate(req, res, next);
  },
  requirePermission('creators.view'),
  async (req, res) => {
    const mediaId = req.query.mediaId == null ? '' : String(req.query.mediaId).trim();
    const mediaUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!/^\d+$/.test(mediaId)) {
      return res.status(400).json({ error: 'Media id is required' });
    }

    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;

      if (!mediaUrl) {
        return res.status(400).json({ error: 'url is required when media is not cached' });
      }

      const playlist = fanslyClient.isFanslyPlaylistUrl(mediaUrl);
      const segment = fanslyClient.isFanslySegmentUrl(mediaUrl);
      const lockedImage =
        fanslyClient.isAllowedFanslyCdnUrl(mediaUrl) &&
        fanslyClient.fanslyPreviewLocksToIp(mediaUrl) &&
        fanslyMediaCache.isCacheableUrl(mediaUrl);
      if (!playlist && !segment && !lockedImage) {
        return res.status(400).json({ error: 'Media URL is not an IP-locked Fansly thumbnail' });
      }

      if (lockedImage) {
        const cached = await fanslyMediaCache.readCache(creator.id, mediaId, mediaUrl);
        if (cached) {
          res.setHeader('Content-Type', cached.contentType);
          res.setHeader('Content-Length', String(cached.buffer.length));
          res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
          res.setHeader('X-DomX-Media-Cache', 'HIT');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          if (cached.etag) res.setHeader('ETag', cached.etag);
          return res.status(200).end(cached.buffer);
        }
      }

      const upstream = await fanslyClient.fetchCdnMedia(fanslySession(creator), mediaUrl, {
        accept: playlist || segment ? '*/*' : undefined,
      });
      if (!upstream.ok) {
        return res.status(upstream.status || 502).json({ error: 'Failed to fetch media' });
      }

      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      if (playlist) {
        const text = await upstream.text();
        const rewritten = fanslyClient.rewriteHlsPlaylist(text, mediaUrl, (cdnUrl) =>
          fanslyProxyMediaUrl(req, creator.id, mediaId, cdnUrl)
        );
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).send(rewritten);
      }

      const contentType =
        upstream.headers.get('content-type') ||
        (segment ? 'video/mp2t' : 'application/octet-stream');
      const etag = upstream.headers.get('etag') || null;
      res.setHeader('Content-Type', contentType);
      if (etag) res.setHeader('ETag', etag);
      res.setHeader(
        'Cache-Control',
        segment ? 'private, no-store' : 'private, max-age=86400, stale-while-revalidate=604800'
      );
      if (!segment) res.setHeader('X-DomX-Media-Cache', 'MISS');
      res.status(upstream.status);

      if (!upstream.body) return res.end();

      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(upstream.body);
      if (segment) {
        nodeStream.on('error', (err) => {
          console.warn('Fansly media stream error:', err.message);
          if (!res.headersSent) res.status(502).end();
          else res.destroy(err);
        });
        nodeStream.pipe(res);
        return;
      }

      const chunks = [];
      let total = 0;
      let overCap = false;
      nodeStream.on('data', (chunk) => {
        total += chunk.length;
        if (!overCap && total <= fanslyMediaCache.MAX_IMAGE_BYTES) chunks.push(chunk);
        else overCap = true;
        if (!res.writableEnded) res.write(chunk);
      });
      nodeStream.on('error', (err) => {
        console.warn('Fansly media stream error:', err.message);
        if (!res.headersSent) res.status(502).end();
        else res.destroy(err);
      });
      nodeStream.on('end', () => {
        if (!res.writableEnded) res.end();
        if (upstream.status === 200 && !overCap) {
          void fanslyMediaCache.writeCache(creator.id, mediaId, {
            buffer: Buffer.concat(chunks),
            contentType,
            etag,
            url: mediaUrl,
          });
        }
      });
    } catch (err) {
      return handleFanslyError(res, err, 'Fansly media error:');
    }
  }
);

router.get(
  '/:id/fansly/lists',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const lists = await fanslyClient.listCreatorLists(fanslySession(creator));
      res.json({ lists });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly lists error:');
    }
  }
);

router.get(
  '/:id/fansly/subscription-tiers',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const tiers = await fanslyClient.listSubscriptionTiers(fanslySession(creator));
      res.json({ tiers });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly subscription tiers error:');
    }
  }
);

router.post(
  '/:id/fansly/chats/:groupId/ack',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
      await fanslyClient.ackMessages(fanslySession(creator), messageIds);
      res.json({ ok: true });
    } catch (err) {
      return handleFanslyError(res, err, 'Ack Fansly messages error:');
    }
  }
);

router.get(
  '/:id/fansly/notifications',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const type = fanslyClient.sanitizeNotificationType(req.query.type);
      const before = req.query.before || 0;
      const payload = await fanslyClient.listNotifications(fanslySession(creator), {
        before,
        after: 0,
        type,
      });
      try {
        await messagingDashboard.processFanslyPurchaseNotifications(payload.notifications);
      } catch (err) {
        console.warn('[fansly] purchase log failed:', err.message);
      }
      res.json({
        filters: fanslyClient.NOTIFICATION_FILTERS,
        ...payload,
      });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly notifications error:');
    }
  }
);

router.post(
  '/:id/fansly/notifications/ack',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const beforeAnd = req.body?.beforeAnd;
      const id = beforeAnd == null ? '' : String(beforeAnd).trim();
      if (!/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Notification id is required' });
      }
      await fanslyClient.ackNotifications(fanslySession(creator), {
        beforeAnd: id,
        type: fanslyClient.sanitizeNotificationType(req.body?.type),
      });
      res.json({ ok: true });
    } catch (err) {
      return handleFanslyError(res, err, 'Ack Fansly notifications error:');
    }
  }
);

async function readFanslyFanNote(creatorId, fanId) {
  const result = await pool.query(
    `SELECT notes
     FROM fansly_fan_notes
     WHERE "creatorId" = $1 AND "fanAccountId" = $2`,
    [creatorId, fanId]
  );
  return result.rows[0]?.notes || '';
}

async function saveFanslyFanNote(creatorId, fanId, notes, userId) {
  const result = await pool.query(
    `INSERT INTO fansly_fan_notes ("creatorId", "fanAccountId", notes, "updatedBy", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT ("creatorId", "fanAccountId")
     DO UPDATE SET notes = EXCLUDED.notes, "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = NOW()
     RETURNING notes`,
    [creatorId, fanId, notes, userId || null]
  );
  return result.rows[0]?.notes || '';
}

function requireFanAccountId(req, res) {
  const fanId = req.params.fanId == null ? '' : String(req.params.fanId).trim();
  if (!/^\d+$/.test(fanId)) {
    res.status(400).json({ error: 'Fan id is required' });
    return '';
  }
  return fanId;
}

router.get(
  '/:id/fansly/fans/:fanId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const fanId = requireFanAccountId(req, res);
      if (!fanId) return;
      const session = fanslySession(creator);
      const [notes, stats, purchases, crmNotes] = await Promise.all([
        fanslyClient.listFanNotes(session, fanId),
        fanslyClient.getFanStats(session, fanId),
        fanslyClient.listFanPurchases(session, fanId),
        readFanslyFanNote(creator.id, fanId),
      ]);
      const nickname = fanslyClient.pickCustomUsername(notes);
      res.json({
        fanId,
        username: stats.username,
        displayName: stats.displayName,
        nickname: nickname.nickname,
        noteId: nickname.noteId,
        lifetimeGrossMills: stats.lifetimeGrossMills,
        purchases: purchases.purchases,
        hasMorePurchases: purchases.hasMore,
        notes: crmNotes,
      });
    } catch (err) {
      return handleFanslyError(res, err, 'Get Fansly fan error:');
    }
  }
);

router.get(
  '/:id/fansly/fans/:fanId/lists',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const fanId = requireFanAccountId(req, res);
      if (!fanId) return;
      const lists = await fanslyClient.listAccountLists(fanslySession(creator), fanId);
      res.json({ lists });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly fan lists error:');
    }
  }
);

router.post(
  '/:id/fansly/fans/:fanId/lists',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const fanId = requireFanAccountId(req, res);
      if (!fanId) return;
      const body = fanslyClient.buildListCommands({
        action: 'add',
        fanId,
        listId: req.body?.listId,
      });
      await fanslyClient.applyListCommands(fanslySession(creator), body);
      const lists = await fanslyClient.listAccountLists(fanslySession(creator), fanId);
      res.json({ lists });
    } catch (err) {
      return handleFanslyError(res, err, 'Add Fansly fan to list error:');
    }
  }
);

router.delete(
  '/:id/fansly/fans/:fanId/lists/:listId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const fanId = requireFanAccountId(req, res);
      if (!fanId) return;
      const body = fanslyClient.buildListCommands({
        action: 'remove',
        fanId,
        listId: req.params.listId,
      });
      await fanslyClient.applyListCommands(fanslySession(creator), body);
      const lists = await fanslyClient.listAccountLists(fanslySession(creator), fanId);
      res.json({ lists });
    } catch (err) {
      return handleFanslyError(res, err, 'Remove Fansly fan from list error:');
    }
  }
);

router.put(
  '/:id/fansly/fans/:fanId/nickname',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const fanId = requireFanAccountId(req, res);
      if (!fanId) return;
      const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname : '';
      const saved = await fanslyClient.saveFanNickname(fanslySession(creator), {
        fanId,
        nickname,
        noteId: req.body?.noteId,
      });
      res.json(saved);
    } catch (err) {
      return handleFanslyError(res, err, 'Save Fansly nickname error:');
    }
  }
);

router.put(
  '/:id/fansly/fans/:fanId/notes',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const fanId = requireFanAccountId(req, res);
      if (!fanId) return;
      if (typeof req.body?.notes !== 'string') {
        return res.status(400).json({ error: 'Notes are required' });
      }
      const notes = await saveFanslyFanNote(creator.id, fanId, req.body.notes, req.user?.id);
      res.json({ notes });
    } catch (err) {
      return handleFanslyError(res, err, 'Save Fansly fan notes error:');
    }
  }
);

router.get(
  '/:id/fansly/unread',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const badges = await fanslyClient.getBadges(fanslySession(creator));
      res.json(badges);
    } catch (err) {
      return handleFanslyError(res, err, 'Fansly unread error:');
    }
  }
);

router.get(
  '/:id/fansly/feed',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const session = fanslySession(creator);
      const walls = await fanslyClient.listWalls(session, creator.providerUserId);
      const wallId = fanslyClient.pickPostsWall(walls);
      const before = typeof req.query.before === 'string' ? req.query.before : '0';
      const result = await fanslyClient.listWallPosts(session, {
        accountId: creator.providerUserId,
        wallId,
        before,
      });
      res.json({ ...result, wallId, providerUserId: creator.providerUserId });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly feed error:');
    }
  }
);

router.post(
  '/:id/fansly/feed',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const mediaId = req.body?.mediaId == null ? '' : String(req.body.mediaId).trim();
      if (!/^\d+$/.test(mediaId)) {
        return res.status(400).json({ error: 'mediaId is required' });
      }
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      const post = await publishFanslyFeed(fanslySession(creator), creator, {
        content,
        mediaId,
        permissions: readMediaPermissions(req.body),
      });
      res.status(201).json({ post, providerUserId: creator.providerUserId });
    } catch (err) {
      return handleFanslyError(res, err, 'Create Fansly feed post error:');
    }
  }
);

router.post(
  '/:id/fansly/feed/uploads',
  authenticate,
  requirePermission('mass_messages.send'),
  (req, res, next) => {
    fanslyFeedUpload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      return next();
    });
  },
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'file is required' });
      }
      const session = fanslySession(creator);
      const mediaId = await fanslyClient.uploadMedia(session, {
        buffer: req.file.buffer,
        fileName: req.file.originalname || 'upload',
        mimeType: req.file.mimetype || 'application/octet-stream',
      });
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      const post = await publishFanslyFeed(session, creator, {
        content,
        mediaId,
        permissions: readFeedPermissions(req.body),
      });
      res.status(201).json({ post, providerUserId: creator.providerUserId });
    } catch (err) {
      return handleFanslyError(res, err, 'Upload Fansly feed media error:');
    }
  }
);

router.get(
  '/:id/fansly/mass-messages',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const tab = typeof req.query.tab === 'string' ? req.query.tab : 'sent';
      if (tab !== 'sent' && tab !== 'deleted') {
        return res.status(400).json({ error: 'Tab is invalid' });
      }
      const before = typeof req.query.before === 'string' ? req.query.before : '0';
      const result = await fanslyClient.listBroadcastMessages(fanslySession(creator), {
        deleted: tab === 'deleted',
        before,
      });
      res.json({ ...result, providerUserId: creator.providerUserId });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly mass messages error:');
    }
  }
);

router.post(
  '/:id/fansly/mass-messages',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      const sent = await sendFanslyBroadcast(fanslySession(creator), creator, {
        content: req.body?.content,
        mediaIds: req.body?.mediaIds,
        audience: readBroadcastAudience(req.body),
      });
      res.status(201).json({ ...sent, providerUserId: creator.providerUserId });
    } catch (err) {
      return handleFanslyError(res, err, 'Send Fansly mass message error:');
    }
  }
);

router.post(
  '/:id/fansly/mass-messages/uploads',
  authenticate,
  requirePermission('mass_messages.send'),
  (req, res, next) => {
    fanslyFeedUpload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      return next();
    });
  },
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'file is required' });
      }
      const session = fanslySession(creator);
      const mediaId = await fanslyClient.uploadMedia(session, {
        buffer: req.file.buffer,
        fileName: req.file.originalname || 'upload',
        mimeType: req.file.mimetype || 'application/octet-stream',
      });
      const sent = await sendFanslyBroadcast(session, creator, {
        content: req.body?.content,
        mediaIds: [mediaId],
        audience: readBroadcastAudience(req.body),
      });
      res.status(201).json({ ...sent, providerUserId: creator.providerUserId });
    } catch (err) {
      return handleFanslyError(res, err, 'Upload Fansly mass message error:');
    }
  }
);

router.delete(
  '/:id/fansly/mass-messages/:messageId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      await fanslyClient.deleteMessage(fanslySession(creator), req.params.messageId);
      res.json({ ok: true });
    } catch (err) {
      return handleFanslyError(res, err, 'Delete Fansly mass message error:');
    }
  }
);

router.delete(
  '/:id/fansly/feed/:postId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireFansly(req, res);
      if (!creator) return;
      await fanslyClient.deletePost(fanslySession(creator), req.params.postId);
      res.json({ ok: true });
    } catch (err) {
      return handleFanslyError(res, err, 'Delete Fansly feed post error:');
    }
  }
);

module.exports = router;
