const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { prepareFeedPhoto } = require('../services/imageOrient');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { decryptJson, decryptSecret } = require('../services/crypto');
const {
  userCanAccessCreator,
  getUserIdsWithCreatorAccess,
} = require('../services/creatorAccess');
const {
  buildEncryptedTokenFields,
  decryptAccessToken,
} = require('../services/maloumAuthTokens');
const maloumClient = require('../services/maloumClient');
const {
  scheduleHistoryArchive,
  scheduleSentArchive,
} = require('../services/fanChatArchive');
const maloumPollCache = require('../services/maloumPollCache');
const { applyModeration } = require('../services/contentModeration');
const { upsertMessageUnsend } = require('../services/messageUnsend');
const messagingDashboard = require('./messagingDashboard');
const {
  scheduleThrottledReconcile,
} = require('../services/salePayoutReconciler');
const massMessageUnsendAllRunner = require('../services/massMessageUnsendAllRunner');
const {
  isLocked: isMassMessageLocked,
  isChatCopyLocked,
  LOCKED_MESSAGE,
} = require('../services/massMessageLocks');
const maloumMediaCache = require('../services/maloumMediaCache');
const { randomUUID } = require('crypto');
const fanCrmActivity = require('../services/fanCrmActivity');
const {
  isValidUuid,
  readCustomProxy,
  toCreator,
  connectLimiter,
  encryptCustomProxy,
  decryptStoredProxy,
  encryptOptionalLoginPassword,
  buildEncryptedSessionPayload,
  CREATOR_SELECT_COLUMNS,
  emitCreatorSessionUpdated,
  tryCacheMaloumAvatar,
  persistCachedMaloumAvatar,
  isBackendStoredAvatarUrl,
  maloumClientHttpStatus,
  maloumClientHttpMessage,
} = require('./creators');

const router = express.Router();

const BADGE_SIDE_EFFECT_MIN_MS = 60_000;
const lastBadgeSideEffectAt = new Map();

function scheduleBadgeSideEffects(creatorId, work) {
  if (!creatorId) return;
  const last = lastBadgeSideEffectAt.get(creatorId) || 0;
  if (Date.now() - last < BADGE_SIDE_EFFECT_MIN_MS) return;
  lastBadgeSideEffectAt.set(creatorId, Date.now());
  setImmediate(() => {
    Promise.resolve()
      .then(work)
      .catch((err) => {
        console.warn(
          'Badge side effects failed:',
          creatorId,
          err.message || err
        );
      });
  });
}

const maloumPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok =
      typeof file.mimetype === 'string' &&
      /^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.mimetype);
    if (!ok) {
      return cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
    }
    return cb(null, true);
  },
});

async function clearScheduleTargetingIfAccountChanged(
  creatorId,
  previousProviderUserId,
  nextProviderUserId
) {
  const prev = String(previousProviderUserId || '').trim();
  const next = String(nextProviderUserId || '').trim();
  if (!next || prev === next) return;
  await pool.query(
    `UPDATE creator_schedule_settings
     SET "includeListIds" = '[]'::jsonb,
         "excludeListIds" = '[]'::jsonb,
         "categoryIds" = '[]'::jsonb,
         "updatedAt" = NOW()
     WHERE "creatorId" = $1`,
    [creatorId]
  );
}

router.post(
  '/:id/maloum/reconnect',
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
      return res.status(400).json({ error: 'Email is required' });
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
        `SELECT id, platform, "accountId", "displayName", "avatarUrl", "avatarSource",
                "encryptedProxy", "providerUserId"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (result.rows[0].platform !== 'maloum') {
        return res.status(400).json({ error: 'Creator is not a Maloum account' });
      }

      const storedProxy = decryptStoredProxy(result.rows[0].encryptedProxy);
      let resolvedProxy;
      try {
        resolvedProxy = maloumClient.resolveMaloumProxyUrl(
          customProxy.provided ? customProxy.proxyUrl : storedProxy
        );
      } catch (err) {
        if (err instanceof maloumClient.MaloumApiError) {
          return res.status(err.status || 400).json({ error: err.message });
        }
        throw err;
      }

      let loginResult;
      try {
        loginResult = await maloumClient.login({
          usernameOrEmail: email.trim(),
          password,
          proxyUrl: resolvedProxy,
        });
      } catch (err) {
        if (err instanceof maloumClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
          return res.status(400).json({ error: 'Password not correct' });
        }
        if (err instanceof maloumClient.MaloumApiError) {
          return res
            .status(maloumClientHttpStatus(err))
            .json({ error: maloumClientHttpMessage(err, 'Maloum login failed') });
        }
        throw err;
      }

      const loginEmail = email.trim();
      const { encryptedSession, savedAt: sessionSavedAt } = buildEncryptedSessionPayload({
        cookies: loginResult.cookies,
        origins: loginResult.origins,
        loginEmail,
        userAgent: loginResult.userAgent || null,
      });
      const tokenFields = buildEncryptedTokenFields({
        accessToken: loginResult.accessToken,
        refreshToken: loginResult.refreshToken,
        expiresAt: loginResult.expiresAt,
      });
      const encryptedProxy = encryptCustomProxy(customProxy.provided, resolvedProxy);
      const encryptedLoginPassword = encryptOptionalLoginPassword(password);

      const creator = result.rows[0];
      let nextAvatarUrl =
        creator.avatarSource === 'manual' || isBackendStoredAvatarUrl(creator.avatarUrl)
          ? creator.avatarUrl
          : loginResult.avatarUrl || creator.avatarUrl;
      let nextAvatarSource = creator.avatarSource || null;

      if (creator.avatarSource !== 'manual' && loginResult.avatarUrl) {
        const cachedPath = await tryCacheMaloumAvatar(
          id,
          loginResult.avatarUrl,
          resolvedProxy
        );
        if (cachedPath) {
          nextAvatarUrl = cachedPath;
          nextAvatarSource = 'maloum';
        }
      }

      const updated = await pool.query(
        `UPDATE creators SET
           "encryptedSession" = $1,
           "encryptedAccessToken" = $2,
           "encryptedRefreshToken" = $3,
           "accessTokenExpiresAt" = $4,
           "encryptedProxy" = CASE WHEN $5::boolean THEN $6 ELSE "encryptedProxy" END,
           "providerUserId" = $7,
           "loginEmail" = $8,
           "encryptedLoginPassword" = COALESCE($9, "encryptedLoginPassword"),
           username = COALESCE($10, username),
           "avatarUrl" = COALESCE($11, "avatarUrl"),
           "avatarSource" = COALESCE($12, "avatarSource"),
           "postLoginUrl" = $13,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "tokenRefreshFailureCount" = 0,
           "updatedAt" = NOW()
         WHERE id = $14
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        [
          encryptedSession,
          tokenFields?.encryptedAccessToken ?? null,
          tokenFields?.encryptedRefreshToken ?? null,
          tokenFields?.accessTokenExpiresAt ?? null,
          customProxy.provided,
          encryptedProxy,
          loginResult.providerUserId,
          loginEmail,
          encryptedLoginPassword ?? null,
          loginResult.username,
          nextAvatarUrl,
          nextAvatarSource,
          loginResult.postLoginUrl,
          id,
        ]
      );

      await clearScheduleTargetingIfAccountChanged(
        id,
        creator.providerUserId,
        loginResult.providerUserId
      );

      const accessUserIds = await getUserIdsWithCreatorAccess(id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: id,
        accountId: updated.rows[0].accountId,
        sessionUpdatedAt: sessionSavedAt,
      });

      res.json({
        creator: toCreator(updated.rows[0]),
        cookies: loginResult.cookies,
        origins: loginResult.origins,
        sessionUpdatedAt: sessionSavedAt,
      });
    } catch (err) {
      console.error('Reconnect Maloum creator error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/reconnect-saved',
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
        `SELECT id, platform, "accountId", "displayName", "avatarUrl", "avatarSource",
                "loginEmail", "encryptedLoginPassword", "encryptedProxy", "providerUserId"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      const creator = result.rows[0];
      if (creator.platform !== 'maloum') {
        return res.status(400).json({ error: 'Creator is not a Maloum account' });
      }
      if (!creator.loginEmail || !creator.encryptedLoginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      const loginPassword = decryptSecret(creator.encryptedLoginPassword);
      if (!loginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      const storedProxy = creator.encryptedProxy
        ? decryptSecret(creator.encryptedProxy)
        : null;
      let resolvedProxy;
      try {
        resolvedProxy = maloumClient.resolveMaloumProxyUrl(storedProxy);
      } catch (err) {
        if (err instanceof maloumClient.MaloumApiError) {
          return res.status(err.status || 400).json({ error: err.message });
        }
        throw err;
      }

      let loginResult;
      try {
        loginResult = await maloumClient.login({
          usernameOrEmail: creator.loginEmail.trim(),
          password: loginPassword,
          proxyUrl: resolvedProxy,
        });
      } catch (err) {
        if (err instanceof maloumClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
          return res.status(400).json({ error: 'Password not correct' });
        }
        if (err instanceof maloumClient.MaloumApiError) {
          return res
            .status(maloumClientHttpStatus(err))
            .json({ error: maloumClientHttpMessage(err, 'Maloum login failed') });
        }
        throw err;
      }

      const loginEmail = creator.loginEmail.trim();
      const { encryptedSession, savedAt: sessionSavedAt } = buildEncryptedSessionPayload({
        cookies: loginResult.cookies,
        origins: loginResult.origins,
        loginEmail,
        userAgent: loginResult.userAgent || null,
      });
      const tokenFields = buildEncryptedTokenFields({
        accessToken: loginResult.accessToken,
        refreshToken: loginResult.refreshToken,
        expiresAt: loginResult.expiresAt,
      });

      let nextAvatarUrl =
        creator.avatarSource === 'manual' || isBackendStoredAvatarUrl(creator.avatarUrl)
          ? creator.avatarUrl
          : loginResult.avatarUrl || creator.avatarUrl;
      let nextAvatarSource = creator.avatarSource || null;

      if (creator.avatarSource !== 'manual' && loginResult.avatarUrl) {
        const cachedPath = await tryCacheMaloumAvatar(
          id,
          loginResult.avatarUrl,
          resolvedProxy
        );
        if (cachedPath) {
          nextAvatarUrl = cachedPath;
          nextAvatarSource = 'maloum';
        }
      }

      const updated = await pool.query(
        `UPDATE creators SET
           "encryptedSession" = $1,
           "encryptedAccessToken" = $2,
           "encryptedRefreshToken" = $3,
           "accessTokenExpiresAt" = $4,
           "providerUserId" = $5,
           "loginEmail" = $6,
           username = COALESCE($7, username),
           "avatarUrl" = COALESCE($8, "avatarUrl"),
           "avatarSource" = COALESCE($9, "avatarSource"),
           "postLoginUrl" = $10,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "tokenRefreshFailureCount" = 0,
           "updatedAt" = NOW()
         WHERE id = $11
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        [
          encryptedSession,
          tokenFields?.encryptedAccessToken ?? null,
          tokenFields?.encryptedRefreshToken ?? null,
          tokenFields?.accessTokenExpiresAt ?? null,
          loginResult.providerUserId,
          loginEmail,
          loginResult.username,
          nextAvatarUrl,
          nextAvatarSource,
          loginResult.postLoginUrl,
          id,
        ]
      );

      await clearScheduleTargetingIfAccountChanged(
        id,
        creator.providerUserId,
        loginResult.providerUserId
      );

      const accessUserIds = await getUserIdsWithCreatorAccess(id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: id,
        accountId: updated.rows[0].accountId,
        sessionUpdatedAt: sessionSavedAt,
      });

      res.json({
        creator: toCreator(updated.rows[0]),
        cookies: loginResult.cookies,
        origins: loginResult.origins,
        sessionUpdatedAt: sessionSavedAt,
      });
    } catch (err) {
      console.error('Reconnect-saved Maloum creator error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * API-side Maloum session verify (CF bypass + Bearer). Marks lastValidatedAt.
 * Prefer this over Electron BrowserView when chatter is API-based.
 */
router.post(
  '/:id/maloum/verify-session',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      try {
        await maloumClient.fetchCurrentUser({
          accessToken: loaded.creator.accessToken,
          proxyUrl: loaded.creator.proxyUrl,
          timezone: loaded.creator.timezone,
        });
      } catch (err) {
        return handleMaloumError(res, err, 'Verify Maloum session error:');
      }

      const updated = await pool.query(
        `UPDATE creators
         SET "connectionStatus" = 'connected',
             "lastValidatedAt" = NOW(),
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING id, "displayName", username, platform, "connectionStatus",
                   "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
                   "loginEmail", "lastValidatedAt", "createdAt", "updatedAt"`,
        [id]
      );

      res.json({
        ok: true,
        creator: toCreator(updated.rows[0]),
      });
    } catch (err) {
      console.error('Verify Maloum session error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/refresh-avatar',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const existing = await pool.query(
        `SELECT id, platform, "avatarUrl", "avatarSource"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (existing.rows[0].platform !== 'maloum') {
        return res.status(400).json({ error: 'Creator is not a Maloum account' });
      }
      if (existing.rows[0].avatarSource === 'manual') {
        return res.json({
          creator: toCreator(
            (
              await pool.query(
                `SELECT id, "displayName", username, platform, "connectionStatus",
                        "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId",
                        "partitionId", "loginEmail", "lastValidatedAt", "authRefreshState",
                        "accessTokenExpiresAt", "createdAt", "updatedAt"
                 FROM creators WHERE id = $1`,
                [id]
              )
            ).rows[0]
          ),
          skipped: true,
          reason: 'Manual avatar is protected',
        });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const currentUser = await maloumClient.fetchCurrentUser({
        accessToken: loaded.creator.accessToken,
        proxyUrl: loaded.creator.proxyUrl,
        timezone: loaded.creator.timezone || 'UTC',
      });
      const remoteAvatarUrl = maloumClient.avatarFromUser(currentUser);
      if (!remoteAvatarUrl) {
        return res.status(404).json({ error: 'Maloum profile has no avatar' });
      }

      const cachedPath = await tryCacheMaloumAvatar(
        id,
        remoteAvatarUrl,
        loaded.creator.proxyUrl
      );
      if (!cachedPath) {
        return res.status(502).json({ error: 'Failed to download Maloum avatar' });
      }

      const updated = await persistCachedMaloumAvatar(id, cachedPath);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to save avatar' });
      }

      res.json({ creator: toCreator(updated) });
    } catch (err) {
      return handleMaloumError(res, err, 'Refresh Maloum avatar error:');
    }
  }
);

async function loadMaloumCreator(creatorId) {
  const result = await pool.query(
    `SELECT id, platform, "displayName", "providerUserId", "encryptedSession",
            "encryptedAccessToken", "encryptedProxy", "connectionStatus", "accountId"
     FROM creators
     WHERE id = $1`,
    [creatorId]
  );

  if (result.rows.length === 0) {
    return { error: { status: 404, message: 'Creator not found' } };
  }

  const row = result.rows[0];
  if (row.platform !== 'maloum') {
    return { error: { status: 400, message: 'Creator is not a Maloum account' } };
  }

  let session = {};
  try {
    if (row.encryptedSession) {
      session = decryptJson(row.encryptedSession) || {};
    }
  } catch (err) {
    return { error: { status: 500, message: 'Failed to decrypt Maloum session' } };
  }

  const accessToken =
    decryptAccessToken(row.encryptedAccessToken) ||
    decryptSecret(row.encryptedAccessToken) ||
    null;
  let proxyUrl = decryptSecret(row.encryptedProxy) || null;
  if (!proxyUrl) {
    try {
      proxyUrl = maloumClient.resolveMaloumProxyUrl(null);
    } catch {
      proxyUrl = null;
    }
  }
  const providerUserId = row.providerUserId || null;

  if (!accessToken) {
    return {
      error: {
        status: 400,
        message: 'Maloum account is missing auth credentials. Please reconnect.',
      },
    };
  }

  if (!proxyUrl) {
    return {
      error: {
        status: 400,
        message:
          'Maloum proxy is required. Set MALOUM_PROXY_URL in backend .env or reconnect with a proxy.',
      },
    };
  }

  return {
    creator: {
      id: row.id,
      displayName: row.displayName,
      accountId: row.accountId,
      providerUserId,
      accessToken,
      proxyUrl,
      timezone: 'UTC',
      session: {
        ...session,
        providerUserId,
        accessToken,
      },
    },
  };
}

function handleMaloumError(res, err, label) {
  if (err instanceof maloumClient.WrongPasswordError) {
    return res.status(400).json({ error: 'Password not correct' });
  }
  if (err instanceof maloumClient.MaloumApiError) {
    return res
      .status(maloumClientHttpStatus(err))
      .json({ error: maloumClientHttpMessage(err) });
  }
  console.error(label, err);
  return res.status(500).json({ error: 'Internal server error' });
}

function toMaloumCount(value) {
  return typeof value === 'number' ? value : Number(value) || 0;
}

function maloumSessionError(loaded) {
  if (!loaded?.error) return null;
  const err = new Error(loaded.error.message);
  err.status = loaded.error.status;
  err.code = 'MALOUM_SESSION';
  return err;
}

function handlePollCacheError(res, err, label) {
  if (err && err.code === 'MALOUM_SESSION') {
    return res.status(err.status).json({ error: err.message });
  }
  return handleMaloumError(res, err, label);
}

async function loadMaloumCreatorOrThrow(id) {
  const loaded = await loadMaloumCreator(id);
  const sessionErr = maloumSessionError(loaded);
  if (sessionErr) throw sessionErr;
  return loaded;
}

function invalidateMaloumMessagePollCache(creatorId, chatId) {
  if (!creatorId) return;
  maloumPollCache.invalidatePrefix(`chats:${creatorId}:`);
  maloumPollCache.invalidatePrefix(`badges:${creatorId}`);
  maloumPollCache.invalidatePrefix(`unread:${creatorId}`);
  if (chatId) {
    maloumPollCache.invalidatePrefix(`msgs:${creatorId}:${chatId}:`);
  }
}

router.get(
  '/:id/maloum/chats',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 100);
      const next = typeof req.query.next === 'string' ? req.query.next : undefined;
      const listIdsRaw =
        typeof req.query.listIds === 'string' ? req.query.listIds.trim() : '';
      const listIds = listIdsRaw || undefined;
      const filterRaw =
        typeof req.query.filter === 'string' ? req.query.filter.trim() : '';
      const lastMessageSenderRaw =
        typeof req.query.lastMessageSender === 'string'
          ? req.query.lastMessageSender.trim()
          : '';
      if (filterRaw && filterRaw !== 'unread') {
        return res.status(400).json({
          error: 'Invalid filter. Use unread.',
        });
      }
      if (
        lastMessageSenderRaw &&
        lastMessageSenderRaw !== 'sentByMe' &&
        lastMessageSenderRaw !== 'sentByOther'
      ) {
        return res.status(400).json({
          error: 'Invalid lastMessageSender. Use sentByMe or sentByOther.',
        });
      }
      const filter = listIds ? undefined : filterRaw || undefined;
      const lastMessageSender = listIds
        ? undefined
        : lastMessageSenderRaw || undefined;
      const chatsKey = `chats:${id}:${limit}:${next || ''}:${filter || ''}:${lastMessageSender || ''}:${listIds || ''}`;
      const payload = await maloumPollCache.getOrLoad(chatsKey, async () => {
        const loaded = await loadMaloumCreatorOrThrow(id);
        const chats = await maloumClient.listChats(loaded.creator, {
          limit,
          next,
          filter,
          lastMessageSender,
          listIds,
        });
        return {
          next: chats?.next ?? null,
          chats: Array.isArray(chats?.data) ? chats.data : Array.isArray(chats) ? chats : [],
          providerUserId: loaded.creator.providerUserId,
        };
      });
      res.json(payload);
    } catch (err) {
      return handlePollCacheError(res, err, 'List Maloum chats error:');
    }
  }
);

router.get(
  '/:id/maloum/chats/unread-count',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const badgesCached = maloumPollCache.peek(`badges:${id}`);
      if (badgesCached && typeof badgesCached.messages === 'number') {
        return res.json({ unread: badgesCached.messages });
      }

      const payload = await maloumPollCache.getOrLoad(`unread:${id}`, async () => {
        const loaded = await loadMaloumCreatorOrThrow(id);
        const unread = await maloumClient.getUnreadCount(loaded.creator);
        return { unread: toMaloumCount(unread) };
      });
      res.json(payload);
    } catch (err) {
      return handlePollCacheError(res, err, 'Get Maloum unread count error:');
    }
  }
);

router.get(
  '/:id/maloum/badges',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const payload = await maloumPollCache.getOrLoad(`badges:${id}`, async () => {
        const loaded = await loadMaloumCreatorOrThrow(id);
        const unreadCached = maloumPollCache.peek(`unread:${id}`);
        const [messagesUnread, notificationsUnread] = await Promise.all([
          unreadCached && typeof unreadCached.unread === 'number'
            ? unreadCached.unread
            : maloumClient.getUnreadCount(loaded.creator),
          maloumClient.getNotificationsUnreadCount(loaded.creator),
        ]);

        const messages = toMaloumCount(messagesUnread);
        const notifications = toMaloumCount(notificationsUnread);
        maloumPollCache.set(`unread:${id}`, { unread: messages });

        const creator = loaded.creator;
        scheduleBadgeSideEffects(id, async () => {
          const notificationsList = await maloumClient.listRecentNotifications(creator, {
            pages: 1,
            limit: 15,
          });
          try {
            await messagingDashboard.processMaloumSaleAndTipNotifications(
              id,
              notificationsList
            );
          } catch (err) {
            console.warn('Maloum sale/tip sync failed:', err.message);
          }
          scheduleThrottledReconcile(id);
        });

        return { messages, notifications };
      });
      res.json(payload);
    } catch (err) {
      return handlePollCacheError(res, err, 'Get Maloum badges error:');
    }
  }
);

router.get(
  '/:id/maloum/notifications',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 100);
      const next = typeof req.query.next === 'string' ? req.query.next : undefined;
      const payload = await maloumClient.listNotifications(loaded.creator, { limit, next });
      const notifications = maloumClient.normalizeListData(payload);

      try {
        await messagingDashboard.processMaloumSaleAndTipNotifications(id, notifications);
      } catch (err) {
        console.warn('Maloum sale/tip sync failed:', err.message);
      }

      scheduleThrottledReconcile(id);

      res.json({
        next: payload?.next ?? null,
        notifications,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum notifications error:');
    }
  }
);

router.post(
  '/:id/maloum/notifications/read-all',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      await maloumClient.markNotificationsReadAll(loaded.creator);
      res.json({ ok: true });
    } catch (err) {
      return handleMaloumError(res, err, 'Mark Maloum notifications read error:');
    }
  }
);

router.get(
  '/:id/maloum/chats/:chatId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const chat = await maloumClient.getChat(loaded.creator, chatId);
      try {
        await maloumClient.markRead(loaded.creator, chatId);
      } catch (err) {
        console.warn('Maloum markRead failed:', err.message);
      }

      res.json({ chat, providerUserId: loaded.creator.providerUserId });
    } catch (err) {
      return handleMaloumError(res, err, 'Get Maloum chat error:');
    }
  }
);

router.get(
  '/:id/maloum/chats/:chatId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 100);
      const next = typeof req.query.next === 'string' ? req.query.next : undefined;
      const messagesKey = `msgs:${id}:${chatId}:${limit}:${next || ''}`;
      const payload = await maloumPollCache.getOrLoad(messagesKey, async () => {
        const loaded = await loadMaloumCreatorOrThrow(id);
        const messages = await maloumClient.getMessages(loaded.creator, chatId, {
          limit,
          next,
        });
        return {
          next: messages?.next ?? null,
          messages: Array.isArray(messages?.data)
            ? messages.data
            : Array.isArray(messages)
              ? messages
              : [],
          providerUserId: loaded.creator.providerUserId,
        };
      });
      scheduleHistoryArchive({
        creatorId: id,
        platform: 'maloum',
        platformChatId: chatId,
        providerUserId: payload.providerUserId,
        rawMessages: payload.messages,
      });
      res.json(payload);
    } catch (err) {
      return handlePollCacheError(res, err, 'Get Maloum messages error:');
    }
  }
);

router.post(
  '/:id/maloum/chats/:chatId/messages/:messageId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId, messageId } = req.params;
    const { deleteTextOnly, originalText, messageSentAt, mediaIds } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }
    if (!messageId) {
      return res.status(400).json({ error: 'messageId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }
      if (
        await isChatCopyLocked(id, 'maloum', {
          text: originalText,
          mediaIds,
        })
      ) {
        return res.status(409).json({ error: LOCKED_MESSAGE });
      }

      await maloumClient.deleteMessage(loaded.creator, chatId, messageId, {
        deleteTextOnly: Boolean(deleteTextOnly),
      });
      invalidateMaloumMessagePollCache(id, chatId);

      let unsend = null;
      try {
        unsend = await upsertMessageUnsend({
          creatorId: id,
          platform: 'maloum',
          chatId,
          platformMessageId: messageId,
          originalText,
          messageSentAt,
          user: req.user,
        });
      } catch (auditErr) {
        console.error('Persist Maloum message unsend error:', auditErr);
      }

      return res.json({ ok: true, unsend });
    } catch (err) {
      return handleMaloumError(res, err, 'Delete Maloum message error:');
    }
  }
);

router.post(
  '/:id/maloum/chats/:chatId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    const {
      message,
      text,
      media,
      priceNet,
      optimisticMessageId,
      fanId,
      fanUsername,
      englishText,
    } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const bodyText =
        typeof text === 'string' ? text : typeof message === 'string' ? message : '';
      const englishDraft = typeof englishText === 'string' ? englishText : '';
      const resolvedOptimisticId =
        typeof optimisticMessageId === 'string' && optimisticMessageId.trim()
          ? optimisticMessageId.trim()
          : randomUUID();

      if (bodyText.trim() || englishDraft.trim()) {
        const moderation = await applyModeration({
          germanText: bodyText,
          englishText: englishDraft,
          userId: req.user.id,
          creatorId: id,
          platform: 'maloum',
          chatId,
          fanId: typeof fanId === 'string' ? fanId : null,
          fanUsername: typeof fanUsername === 'string' ? fanUsername : null,
          creatorName: loaded.creator?.displayName || null,
          chatterName: req.user.name || null,
        });
        if (moderation.blocked) {
          return res.status(403).json({
            error: moderation.message,
            code: 'CONTENT_BLOCKED',
            matchedKeyword: moderation.matchedKeyword,
            matchedStage: moderation.matchedStage,
          });
        }
      }

      if (Array.isArray(media) && media.length > 0) {
        const net = Number(priceNet) || 0;
        const messageId = await maloumClient.sendMedia(loaded.creator, chatId, {
          media,
          text: bodyText,
          priceNet: net,
          optimisticMessageId: resolvedOptimisticId,
        });
        invalidateMaloumMessagePollCache(id, chatId);
        scheduleSentArchive({
          creatorId: id,
          platform: 'maloum',
          platformChatId: chatId,
          platformFanId: fanId,
          fanUsername,
          providerUserId: loaded.creator.providerUserId,
          rawMessage: {
            _id: messageId,
            senderId: loaded.creator.providerUserId,
            sentAt: new Date().toISOString(),
            content: { text: bodyText, media, priceNet: net > 0 ? net : undefined },
          },
          englishDraft,
          chatter: req.user,
          priceNet: net > 0 ? net : null,
          currency: 'EUR',
        });
        return res.status(201).json({
          messageId,
          message: { _id: messageId },
          optimisticMessageId: resolvedOptimisticId,
        });
      }

      if (!bodyText.trim()) {
        return res.status(400).json({ error: 'Message text is required' });
      }

      const messageId = await maloumClient.sendText(loaded.creator, chatId, {
        text: bodyText,
        optimisticMessageId: resolvedOptimisticId,
      });
      invalidateMaloumMessagePollCache(id, chatId);
      scheduleSentArchive({
        creatorId: id,
        platform: 'maloum',
        platformChatId: chatId,
        platformFanId: fanId,
        fanUsername,
        providerUserId: loaded.creator.providerUserId,
        rawMessage: {
          _id: messageId,
          senderId: loaded.creator.providerUserId,
          sentAt: new Date().toISOString(),
          content: { text: bodyText },
        },
        englishDraft,
        chatter: req.user,
      });
      return res.status(201).json({
        messageId,
        message: { _id: messageId },
        optimisticMessageId: resolvedOptimisticId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Send Maloum message error:');
    }
  }
);

router.get(
  '/:id/maloum/broadcasts',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 100);
      const filter =
        typeof req.query.filter === 'string' && req.query.filter.trim()
          ? req.query.filter.trim()
          : 'ALL';
      const next =
        typeof req.query.next === 'string' && req.query.next.trim()
          ? req.query.next.trim()
          : undefined;
      const broadcasts = await maloumClient.listSentBroadcasts(loaded.creator, {
        limit,
        filter,
        next,
      });
      res.json({
        next: broadcasts?.next ?? null,
        broadcasts: Array.isArray(broadcasts?.data)
          ? broadcasts.data
          : Array.isArray(broadcasts)
            ? broadcasts
            : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum broadcasts error:');
    }
  }
);

router.post(
  '/:id/maloum/broadcasts',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const {
      includeFromLists,
      excludeFromLists,
      text,
      message,
      media,
      priceNet,
      price,
    } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const bodyText =
        typeof text === 'string' ? text : typeof message === 'string' ? message : '';
      const resolvedPrice =
        priceNet !== undefined && priceNet !== null ? Number(priceNet) : Number(price) || 0;

      await maloumClient.sendBroadcast(loaded.creator, {
        includeFromLists,
        excludeFromLists,
        text: bodyText,
        media: Array.isArray(media) ? media : [],
        price: Number.isFinite(resolvedPrice) ? resolvedPrice : 0,
      });

      return res.status(201).json({ ok: true });
    } catch (err) {
      return handleMaloumError(res, err, 'Send Maloum broadcast error:');
    }
  }
);

router.post(
  '/:id/maloum/broadcasts/unsend-all',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }
      const started = massMessageUnsendAllRunner.startUnsendAll('maloum', id);
      if (started.error) {
        return res.status(started.error.status).json({ error: started.error.message });
      }
      res.json({ progress: started });
    } catch (err) {
      return handleMaloumError(res, err, 'Start Maloum unsend-all error:');
    }
  }
);

router.get(
  '/:id/maloum/broadcasts/unsend-all',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      res.json({ progress: massMessageUnsendAllRunner.snapshot('maloum', id) });
    } catch (err) {
      console.error('Get Maloum unsend-all error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/broadcasts/unsend-all/stop',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const progress = massMessageUnsendAllRunner.stopUnsendAll('maloum', id);
      res.json({ progress });
    } catch (err) {
      console.error('Stop Maloum unsend-all error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/broadcasts/:broadcastId/revoke',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, broadcastId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!broadcastId) {
      return res.status(400).json({ error: 'broadcastId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }
      if (await isMassMessageLocked(id, 'maloum', broadcastId)) {
        return res.status(409).json({ error: LOCKED_MESSAGE });
      }

      await maloumClient.revokeBroadcast(loaded.creator, broadcastId);
      return res.json({ ok: true });
    } catch (err) {
      return handleMaloumError(res, err, 'Revoke Maloum broadcast error:');
    }
  }
);

router.get(
  '/:id/maloum/chat-lists',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 25, 100);
      const next =
        typeof req.query.next === 'string' && req.query.next.trim()
          ? req.query.next.trim()
          : undefined;
      const lists = await maloumClient.listChatLists(loaded.creator, {
        limit,
        next,
      });
      res.json({
        next: lists?.next ?? null,
        lists: Array.isArray(lists?.data)
          ? lists.data
          : Array.isArray(lists)
            ? lists
            : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum chat lists error:');
    }
  }
);

router.post(
  '/:id/maloum/chat-lists',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const { name, tag } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const list = await maloumClient.createChatList(loaded.creator, name, {
        tag: typeof tag === 'string' ? tag : undefined,
      });
      return res.status(201).json({
        list,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Create Maloum chat list error:');
    }
  }
);

router.delete(
  '/:id/maloum/chat-lists/:listId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, listId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!listId || !String(listId).trim()) {
      return res.status(400).json({ error: 'listId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      await maloumClient.deleteChatList(loaded.creator, String(listId).trim());
      return res.json({ ok: true });
    } catch (err) {
      return handleMaloumError(res, err, 'Delete Maloum chat list error:');
    }
  }
);

router.get(
  '/:id/maloum/top-creators',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 50);
      const nextRaw = req.query.next;
      const next =
        nextRaw !== undefined && nextRaw !== null && String(nextRaw).trim() !== ''
          ? Number(nextRaw)
          : undefined;
      const result = await maloumClient.listTopCreators(loaded.creator, {
        limit,
        next: Number.isFinite(next) ? next : undefined,
      });
      res.json({
        next: result?.next ?? null,
        creators: Array.isArray(result?.data)
          ? result.data
          : Array.isArray(result)
            ? result
            : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum top creators error:');
    }
  }
);

router.get(
  '/:id/maloum/users/:username/profile',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, username } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!username || !String(username).trim()) {
      return res.status(400).json({ error: 'username is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const profile = await maloumClient.getUserProfile(
        loaded.creator,
        String(username).trim()
      );
      res.json({
        profile,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Get Maloum user profile error:');
    }
  }
);

router.get(
  '/:id/maloum/posts/user/:username',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, username } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!username || !String(username).trim()) {
      return res.status(400).json({ error: 'username is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 50);
      const next =
        typeof req.query.next === 'string' && req.query.next.trim()
          ? req.query.next.trim()
          : undefined;
      const result = await maloumClient.listUserPosts(
        loaded.creator,
        String(username).trim(),
        { limit, next }
      );
      res.json({
        next: result?.next ?? null,
        posts: Array.isArray(result?.data)
          ? result.data
          : Array.isArray(result)
            ? result
            : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum user posts error:');
    }
  }
);

router.get(
  '/:id/maloum/posts/me',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 50);
      const next =
        typeof req.query.next === 'string' && req.query.next.trim()
          ? req.query.next.trim()
          : undefined;
      const result = await maloumClient.listMyPosts(loaded.creator, { limit, next });
      res.json({
        next: result?.next ?? null,
        posts: Array.isArray(result?.data)
          ? result.data
          : Array.isArray(result)
            ? result
            : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum my posts error:');
    }
  }
);

router.get(
  '/:id/maloum/categories',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const result = await maloumClient.listCategories(loaded.creator);
      const categories = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : [];
      res.json({
        categories,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum categories error:');
    }
  }
);

router.post(
  '/:id/maloum/posts',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const { caption, categories, public: isPublic, mediaIds } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const deadline = Date.now() + 90_000;
      let post;
      for (;;) {
        try {
          post = await maloumClient.createPost(loaded.creator, {
            caption,
            categories,
            public: isPublic,
            mediaIds,
          });
          break;
        } catch (err) {
          if (
            !maloumClient.isUploadNotApprovedError(err) ||
            Date.now() >= deadline
          ) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      return res.status(201).json({
        post,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Create Maloum post error:');
    }
  }
);

router.delete(
  '/:id/maloum/posts/:postId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, postId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!postId) {
      return res.status(400).json({ error: 'postId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      await maloumClient.deletePost(loaded.creator, postId);
      return res.json({ ok: true });
    } catch (err) {
      return handleMaloumError(res, err, 'Delete Maloum post error:');
    }
  }
);

router.post(
  '/:id/maloum/uploads/photo',
  authenticate,
  requirePermission('mass_messages.send'),
  (req, res, next) => {
    maloumPhotoUpload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      return next();
    });
  },
  async (req, res) => {
    const { id } = req.params;
    const folderId =
      typeof req.body?.folderId === 'string' ? req.body.folderId.trim() : '';
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!folderId) {
      return res.status(400).json({ error: 'folderId is required' });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'file is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const prepared = await prepareFeedPhoto(req.file.buffer, {
        mimeType: req.file.mimetype || 'image/jpeg',
      });
      const width = Number(prepared.width);
      const height = Number(prepared.height);
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        return res.status(400).json({ error: 'Invalid image dimensions' });
      }

      const uploadMeta = await maloumClient.generateUploadUrl(loaded.creator, {
        width,
        height,
        folderId,
      });
      const uploadId =
        uploadMeta?.id ||
        uploadMeta?.uploadId ||
        uploadMeta?._id ||
        null;
      const uploadUrl = uploadMeta?.uploadUrl || uploadMeta?.url || null;
      if (!uploadId || !uploadUrl) {
        return res.status(502).json({ error: 'Maloum did not return an upload URL' });
      }

      const { proxyUrl } = maloumClient.authContext(loaded.creator);
      await maloumClient.uploadToSignedUrl(
        proxyUrl,
        uploadUrl,
        prepared.buffer,
        prepared.mimeType || 'image/jpeg'
      );

      await maloumClient.waitForUploadApproved(loaded.creator, String(uploadId), {
        folderId,
      });

      return res.status(201).json({
        uploadId: String(uploadId),
        width,
        height,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Upload Maloum photo error:');
    }
  }
);

router.get(
  '/:id/maloum/posts/:postId/comments',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, postId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!postId) {
      return res.status(400).json({ error: 'postId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 50);
      const next =
        typeof req.query.next === 'string' && req.query.next.trim()
          ? req.query.next.trim()
          : undefined;
      const result = await maloumClient.listPostComments(loaded.creator, postId, {
        limit,
        next,
      });
      res.json({
        next: result?.next ?? null,
        comments: Array.isArray(result?.data)
          ? result.data
          : Array.isArray(result)
            ? result
            : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum post comments error:');
    }
  }
);

router.post(
  '/:id/maloum/chats',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const { member2 } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!member2 || !String(member2).trim()) {
      return res.status(400).json({ error: 'member2 is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const chat = await maloumClient.createChat(
        loaded.creator,
        String(member2).trim()
      );
      return res.status(201).json({
        chat,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Create Maloum chat error:');
    }
  }
);

router.get(
  '/:id/maloum/chat-lists/members/:memberId/assigned',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, memberId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!memberId) {
      return res.status(400).json({ error: 'memberId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const lists = await maloumClient.getMemberChatLists(loaded.creator, memberId);
      res.json({
        lists: Array.isArray(lists) ? lists : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Get Maloum member chat lists error:');
    }
  }
);

router.post(
  '/:id/maloum/chat-lists/members/:memberId/assigned',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, memberId } = req.params;
    const { chatListIds } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!memberId) {
      return res.status(400).json({ error: 'memberId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      let beforeLists = null;
      try {
        beforeLists = fanCrmActivity.normalizeListEntries(
          await maloumClient.getMemberChatLists(loaded.creator, memberId)
        );
      } catch (err) {
        console.error('fan crm activity: Maloum list membership read failed:', err);
      }

      await maloumClient.setMemberChatLists(
        loaded.creator,
        memberId,
        Array.isArray(chatListIds) ? chatListIds : []
      );
      const lists = await maloumClient.getMemberChatLists(loaded.creator, memberId);
      if (beforeLists) {
        let changes = fanCrmActivity.membershipChanges(
          beforeLists,
          fanCrmActivity.normalizeListEntries(lists)
        );
        const needsName = [...changes.added, ...changes.removed].some((item) => !item.name);
        if (needsName) {
          try {
            const catalog = fanCrmActivity.normalizeListEntries(
              await maloumClient.listAllChatLists(loaded.creator)
            );
            const names = new Map(catalog.map((item) => [item.id, item.name]));
            const fill = (item) => ({ ...item, name: item.name || names.get(item.id) || '' });
            changes = {
              added: changes.added.map(fill),
              removed: changes.removed.map(fill),
            };
          } catch (err) {
            console.error('fan crm activity: Maloum list name lookup failed:', err);
          }
        }
        await fanCrmActivity.recordFanCrmEvents(
          fanCrmActivity.listChangeEvents(
            {
              ...fanCrmActivity.actorFrom(req.user),
              creatorId: id,
              platform: 'maloum',
              fanId: String(memberId),
            },
            changes.added,
            changes.removed
          )
        );
      }
      res.json({
        ok: true,
        lists: Array.isArray(lists) ? lists : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Set Maloum member chat lists error:');
    }
  }
);

router.patch(
  '/:id/maloum/chats/:chatId/faninfo/nickname',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    const { nickname } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }
    if (typeof nickname !== 'string') {
      return res.status(400).json({ error: 'nickname must be a string' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      let beforeChat = null;
      try {
        beforeChat = await maloumClient.getChat(loaded.creator, chatId);
      } catch (err) {
        console.error('fan crm activity: Maloum chat read failed:', err);
      }

      await maloumClient.updateFanNickname(loaded.creator, chatId, nickname);
      const chat = await maloumClient.getChat(loaded.creator, chatId);
      const beforeFan = fanCrmActivity.extractMaloumFan(beforeChat);
      const afterFan = fanCrmActivity.extractMaloumFan(chat);
      const previous = beforeChat ? beforeFan.nickname : '';
      const next = nickname;
      if (!beforeChat || previous !== next) {
        await fanCrmActivity.recordFanCrmEvents([
          {
            ...fanCrmActivity.actorFrom(req.user),
            creatorId: id,
            platform: 'maloum',
            fanId: afterFan.fanId || beforeFan.fanId,
            fanLabel: afterFan.fanLabel || beforeFan.fanLabel,
            chatId,
            action: 'rename',
            previousValue: previous,
            nextValue: next,
          },
        ]);
      }
      res.json({ ok: true, chat, providerUserId: loaded.creator.providerUserId });
    } catch (err) {
      return handleMaloumError(res, err, 'Update Maloum fan nickname error:');
    }
  }
);

router.patch(
  '/:id/maloum/chats/:chatId/faninfo/notes',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    const { notes } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }
    if (typeof notes !== 'string') {
      return res.status(400).json({ error: 'notes must be a string' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      let beforeChat = null;
      try {
        beforeChat = await maloumClient.getChat(loaded.creator, chatId);
      } catch (err) {
        console.error('fan crm activity: Maloum chat read failed:', err);
      }

      await maloumClient.updateFanNotes(loaded.creator, chatId, notes);
      const chat = await maloumClient.getChat(loaded.creator, chatId);
      const beforeFan = fanCrmActivity.extractMaloumFan(beforeChat);
      const afterFan = fanCrmActivity.extractMaloumFan(chat);
      const previous = beforeChat ? beforeFan.notes : '';
      const next = notes;
      const action = beforeChat
        ? fanCrmActivity.noteAction(previous, next)
        : next.trim()
          ? 'note_add'
          : 'note_remove';
      if (action) {
        await fanCrmActivity.recordFanCrmEvents([
          {
            ...fanCrmActivity.actorFrom(req.user),
            creatorId: id,
            platform: 'maloum',
            fanId: afterFan.fanId || beforeFan.fanId,
            fanLabel: afterFan.fanLabel || beforeFan.fanLabel,
            chatId,
            action,
            previousValue: previous,
            nextValue: next,
          },
        ]);
      }
      res.json({ ok: true, chat, providerUserId: loaded.creator.providerUserId });
    } catch (err) {
      return handleMaloumError(res, err, 'Update Maloum fan notes error:');
    }
  }
);

router.get(
  '/:id/maloum/vault/folders',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 100);
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const next =
        req.query.next !== undefined && req.query.next !== null && req.query.next !== ''
          ? Number(req.query.next)
          : undefined;
      const folders = await maloumClient.listVaultFolders(loaded.creator, {
        query,
        limit,
        next: Number.isFinite(next) ? next : undefined,
      });
      res.json({
        next: folders?.next ?? null,
        folders: Array.isArray(folders?.data)
          ? folders.data
          : Array.isArray(folders)
            ? folders
            : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum vault folders error:');
    }
  }
);

router.get(
  '/:id/maloum/vault/folders/:folderId/media',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, folderId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!folderId) {
      return res.status(400).json({ error: 'folderId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const fanId = typeof req.query.fanId === 'string' ? req.query.fanId : undefined;
      const next =
        req.query.next !== undefined && req.query.next !== null && req.query.next !== ''
          ? Number(req.query.next)
          : undefined;
      const media = await maloumClient.listVaultMedia(loaded.creator, folderId, {
        fanId,
        limit,
        next: Number.isFinite(next) ? next : undefined,
      });
      res.json({
        next: media?.next ?? null,
        items: Array.isArray(media?.data) ? media.data : Array.isArray(media) ? media : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum vault media error:');
    }
  }
);

function collectMediaIdsFromJson(mediaJson, into) {
  if (!mediaJson) return;
  const items = Array.isArray(mediaJson)
    ? mediaJson
    : typeof mediaJson === 'object' && Array.isArray(mediaJson.items)
      ? mediaJson.items
      : null;
  if (!items) return;
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const mediaId =
      (typeof entry.mediaId === 'string' && entry.mediaId.trim()) ||
      (typeof entry.uploadId === 'string' && entry.uploadId.trim()) ||
      '';
    if (mediaId) into.add(mediaId);
  }
}

router.get(
  '/:id/maloum/vault-sent',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const fanId =
      typeof req.query.fanId === 'string' && req.query.fanId.trim()
        ? req.query.fanId.trim()
        : null;
    const chatId =
      typeof req.query.chatId === 'string' && req.query.chatId.trim()
        ? req.query.chatId.trim()
        : null;

    if (!fanId && !chatId) {
      return res.status(400).json({ error: 'fanId or chatId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const uploadIds = new Set();

      if (fanId) {
        const storeResult = await pool.query(
          `SELECT "uploadId"
           FROM maloum_vault_sent
           WHERE "creatorId" = $1 AND "fanId" = $2`,
          [id, fanId]
        );
        for (const row of storeResult.rows) {
          if (row.uploadId) uploadIds.add(String(row.uploadId));
        }
      } else if (chatId) {
        const storeResult = await pool.query(
          `SELECT "uploadId"
           FROM maloum_vault_sent
           WHERE "creatorId" = $1 AND "chatId" = $2`,
          [id, chatId]
        );
        for (const row of storeResult.rows) {
          if (row.uploadId) uploadIds.add(String(row.uploadId));
        }
      }

      const dashConditions = ['"creatorId" = $1', '"mediaCount" > 0'];
      const dashValues = [id];
      let paramIndex = 2;
      dashConditions.push(`"contentType" IN ('media', 'chat_product')`);

      if (fanId && chatId) {
        dashConditions.push(
          `("chatId" = $${paramIndex} OR "fanId" = $${paramIndex + 1})`
        );
        dashValues.push(chatId, fanId);
        paramIndex += 2;
      } else if (chatId) {
        dashConditions.push(`"chatId" = $${paramIndex}`);
        dashValues.push(chatId);
        paramIndex += 1;
      } else {
        dashConditions.push(`"fanId" = $${paramIndex}`);
        dashValues.push(fanId);
        paramIndex += 1;
      }

      const dashResult = await pool.query(
        `SELECT "mediaJson"
         FROM messaging_dashboard_entries
         WHERE ${dashConditions.join(' AND ')}
         ORDER BY "sentAt" DESC
         LIMIT 500`,
        dashValues
      );
      for (const row of dashResult.rows) {
        collectMediaIdsFromJson(row.mediaJson, uploadIds);
      }

      return res.json({ uploadIds: [...uploadIds] });
    } catch (err) {
      console.error('List Maloum vault sent error:', err);
      return res.status(500).json({ error: 'Failed to load vault sent media' });
    }
  }
);

router.post(
  '/:id/maloum/vault-sent',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const fanId =
      typeof req.body?.fanId === 'string' && req.body.fanId.trim()
        ? req.body.fanId.trim()
        : null;
    const chatId =
      typeof req.body?.chatId === 'string' && req.body.chatId.trim()
        ? req.body.chatId.trim()
        : null;
    const rawUploadIds = Array.isArray(req.body?.uploadIds) ? req.body.uploadIds : [];
    const uploadIds = [
      ...new Set(
        rawUploadIds
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0 && value.length <= 256)
      ),
    ].slice(0, 100);

    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }
    if (uploadIds.length === 0) {
      return res.status(400).json({ error: 'uploadIds is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const creatorCheck = await pool.query('SELECT id FROM creators WHERE id = $1', [id]);
      if (creatorCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const sentByUserId = req.user?.id || null;
      for (const uploadId of uploadIds) {
        await pool.query(
          `INSERT INTO maloum_vault_sent (
             "creatorId", "fanId", "chatId", "uploadId", "sentByUserId", "sentAt"
           ) VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT ("creatorId", "fanId", "uploadId") DO UPDATE SET
             "chatId" = COALESCE(EXCLUDED."chatId", maloum_vault_sent."chatId"),
             "sentByUserId" = COALESCE(EXCLUDED."sentByUserId", maloum_vault_sent."sentByUserId"),
             "sentAt" = maloum_vault_sent."sentAt"`,
          [id, fanId, chatId, uploadId, sentByUserId]
        );
      }

      return res.json({ ok: true, uploadIds });
    } catch (err) {
      console.error('Record Maloum vault sent error:', err);
      return res.status(500).json({ error: 'Failed to record vault sent media' });
    }
  }
);

router.get(
  '/:id/maloum/media',
  async (req, res, next) => {
    if (!req.headers.authorization && typeof req.query.access_token === 'string') {
      req.headers.authorization = `Bearer ${req.query.access_token}`;
    }
    return authenticate(req, res, next);
  },
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    const uploadId = typeof req.query.uploadId === 'string' ? req.query.uploadId : '';
    const variant =
      req.query.variant === 'full' ? 'full' : 'thumbnail';
    const mediaUrl = typeof req.query.url === 'string' ? req.query.url : '';

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!uploadId && !mediaUrl) {
      return res.status(400).json({ error: 'uploadId or url is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const canUseDiskCache =
        Boolean(uploadId) &&
        maloumMediaCache.isCacheableVariant(variant) &&
        (!mediaUrl || maloumMediaCache.isCacheableUrl(mediaUrl));

      if (canUseDiskCache) {
        const cached = await maloumMediaCache.readCache(id, uploadId, variant);
        if (cached) {
          res.setHeader('Content-Type', cached.contentType);
          res.setHeader('Content-Length', String(cached.buffer.length));
          res.setHeader(
            'Cache-Control',
            'private, max-age=86400, stale-while-revalidate=604800'
          );
          res.setHeader('X-DomX-Media-Cache', 'HIT');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          if (cached.etag) {
            res.setHeader('ETag', cached.etag);
          }
          return res.status(200).end(cached.buffer);
        }
      }

      if (!mediaUrl) {
        return res.status(400).json({
          error: 'url is required when media is not cached',
        });
      }

      if (!maloumClient.isAllowedMediaUrl(mediaUrl)) {
        return res.status(400).json({ error: 'Invalid or disallowed media URL' });
      }

      const upstream = await maloumClient.fetchMedia(loaded.creator, { url: mediaUrl });
      if (!upstream.ok) {
        return res.status(upstream.status || 502).json({ error: 'Failed to fetch media' });
      }

      const contentType =
        upstream.headers.get('content-type') || 'application/octet-stream';
      const etag = upstream.headers.get('etag') || null;

      if (canUseDiskCache) {
        res.setHeader(
          'Cache-Control',
          'private, max-age=86400, stale-while-revalidate=604800'
        );
        res.setHeader('X-DomX-Media-Cache', 'MISS');
      } else {
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-DomX-Media-Cache', 'BYPASS');
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (etag) {
        res.setHeader('ETag', etag);
      }
      res.status(upstream.status);

      if (!upstream.body) {
        return res.end();
      }

      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(upstream.body);

      if (canUseDiskCache && upstream.status === 200) {
        const chunks = [];
        nodeStream.on('data', (chunk) => {
          chunks.push(chunk);
          if (!res.writableEnded) res.write(chunk);
        });
        nodeStream.on('error', (err) => {
          console.warn('Maloum media stream error:', err.message);
          if (!res.headersSent) {
            res.status(502).end();
          } else {
            res.destroy(err);
          }
        });
        nodeStream.on('end', () => {
          if (!res.writableEnded) res.end();
          const buffer = Buffer.concat(chunks);
          void maloumMediaCache.writeCache(id, uploadId, variant, {
            buffer,
            contentType,
            etag,
            url: mediaUrl,
          });
        });
        return;
      }

      nodeStream.on('error', (err) => {
        console.warn('Maloum media stream error:', err.message);
        if (!res.headersSent) {
          res.status(502).end();
        } else {
          res.destroy(err);
        }
      });
      nodeStream.pipe(res);
    } catch (err) {
      return handleMaloumError(res, err, 'Proxy Maloum media error:');
    }
  }
);

module.exports = router;
