const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator, getUserIdsWithCreatorAccess } = require('../services/creatorAccess');
const { decryptJson, decryptSecret, encryptJson, encryptSecret } = require('../services/crypto');
const { emitToUsers } = require('../services/userEventBus');
const fanslyClient = require('../services/fanslyClient');
const { loadFanslyCreator } = require('../services/platformCreatorSession');
const {
  InvalidProxyError,
  customProxyFromBody,
} = require('../services/proxyUrl');

const router = express.Router();

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

function handleFanslyError(res, err, label) {
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
      const loginResult = await fanslyClient.login({
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
      const loginResult = await fanslyClient.login({
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
      const flags = Number(req.query.flags) === 32 ? 32 : 0;
      const limit = Math.min(Math.max(Number(req.query.limit) || (flags === 32 ? 10 : 20), 1), 50);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const session = fanslySession(creator);
      const chats = await fanslyClient.listGroups(session, { flags, limit, offset });
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
      res.json({
        chats: chats.map((chat) => ({
          ...chat,
          lastMessage: byId.get(chat.lastMessageId) || null,
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
      const content = req.body?.content;
      const message = await fanslyClient.sendMessage(fanslySession(creator), {
        groupId: req.params.groupId,
        content,
      });
      res.json({ message });
    } catch (err) {
      return handleFanslyError(res, err, 'Send Fansly message error:');
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
      const type = typeof req.query.type === 'string' ? req.query.type : '';
      const before = req.query.before || 0;
      const payload = await fanslyClient.listNotifications(fanslySession(creator), {
        before,
        after: 0,
        type,
      });
      res.json({
        filters: fanslyClient.NOTIFICATION_FILTERS,
        ...payload,
      });
    } catch (err) {
      return handleFanslyError(res, err, 'List Fansly notifications error:');
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

module.exports = router;
