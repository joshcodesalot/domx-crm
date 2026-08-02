const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');

const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  hashToken,
  generateAccountToken,
} = require('../services/crypto');
const { saveCreatorAvatarFromBuffer, cacheCreatorAvatarFromUrl } = require('../services/creatorAvatar');
const {
  userSeesAllCreators,
  userCanAccessCreator,
  getUserIdsWithCreatorAccess,
} = require('../services/creatorAccess');
const {
  buildEncryptedTokenFields,
  buildTokenWriteFromOrigins,
  decryptAccessToken,
} = require('../services/maloumAuthTokens');
const { emitToUser, emitToUsers } = require('../services/userEventBus');
const fourBasedClient = require('../services/fourBasedClient');
const maloumClient = require('../services/maloumClient');
const messagingDashboard = require('./messagingDashboard');
const {
  connectCreatorById,
  disconnectCreator,
} = require('../services/fourBasedSocket');
const fourBasedMediaCache = require('../services/fourBasedMediaCache');
const maloumMediaCache = require('../services/maloumMediaCache');
const { randomUUID } = require('crypto');

const router = express.Router();

const VALID_PLATFORMS = ['maloum', '4based'];
const VALID_STATUSES = ['connected', 'error', 'pending'];
const PENDING_TTL_MINUTES = 15;

const connectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many connect attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many credential requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

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
    hasSavedCredentials: Boolean(row.encryptedLoginPassword),
    lastValidatedAt: row.lastValidatedAt || null,
    authRefreshState: row.authRefreshState || 'active',
    accessTokenExpiresAt: row.accessTokenExpiresAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isBackendStoredAvatarUrl(avatarUrl) {
  return typeof avatarUrl === 'string' && avatarUrl.startsWith('/uploads/avatars/');
}

/**
 * Best-effort: download Maloum thumbnail via proxy and store under /uploads/avatars.
 * Returns local path or null on failure.
 */
async function tryCacheMaloumAvatar(creatorId, imageUrl, proxyUrl) {
  if (!creatorId || !imageUrl || typeof imageUrl !== 'string') {
    return null;
  }
  if (isBackendStoredAvatarUrl(imageUrl)) {
    return imageUrl;
  }
  if (imageUrl.startsWith('/')) {
    return null;
  }

  try {
    const resolvedProxy = maloumClient.resolveMaloumProxyUrl(proxyUrl);
    return await cacheCreatorAvatarFromUrl(creatorId, imageUrl, {
      proxyUrl: resolvedProxy,
    });
  } catch (err) {
    console.warn('Maloum avatar cache failed:', err.message);
    return null;
  }
}

async function persistCachedMaloumAvatar(creatorId, localPath) {
  if (!localPath) {
    return null;
  }
  const result = await pool.query(
    `UPDATE creators
     SET "avatarUrl" = $2,
         "avatarSource" = 'maloum',
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "displayName", username, platform, "connectionStatus",
               "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
               "loginEmail", "lastValidatedAt", "authRefreshState", "accessTokenExpiresAt",
               "createdAt", "updatedAt"`,
    [creatorId, localPath]
  );
  return result.rows[0] || null;
}

function partitionIdFor(accountId) {
  return `persist:creator-${accountId}`;
}

function buildEncryptedSessionPayload({ cookies, origins, loginEmail, savedAt, userAgent }) {
  const stampedAt = savedAt || new Date().toISOString();
  return {
    encryptedSession: encryptJson({
      cookies,
      origins: origins || [],
      loginEmail,
      savedAt: stampedAt,
      ...(userAgent ? { userAgent } : {}),
    }),
    savedAt: stampedAt,
  };
}

function buildTokenPersistenceFromOrigins(origins) {
  const tokenWrite = buildTokenWriteFromOrigins(origins);
  if (!tokenWrite) {
    return null;
  }

  return {
    encryptedAccessToken: tokenWrite.encryptedAccessToken,
    encryptedRefreshToken: tokenWrite.encryptedRefreshToken,
    accessTokenExpiresAt: tokenWrite.accessTokenExpiresAt,
    authRefreshState: tokenWrite.authRefreshState,
    tokenRefreshFailureCount: tokenWrite.tokenRefreshFailureCount,
  };
}

function sessionUpdatedAtFrom(session, fallbackDate) {
  if (session?.savedAt && typeof session.savedAt === 'string') {
    return session.savedAt;
  }
  if (fallbackDate instanceof Date) {
    return fallbackDate.toISOString();
  }
  if (typeof fallbackDate === 'string' && fallbackDate) {
    return fallbackDate;
  }
  return null;
}

function emitCreatorSessionUpdated(userIds, { creatorId, accountId, sessionUpdatedAt }) {
  if (!userIds.length) {
    return;
  }

  emitToUsers(userIds, {
    type: 'creator:session-updated',
    creatorId,
    accountId: accountId || null,
    sessionUpdatedAt: sessionUpdatedAt || null,
  });
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function isClientMaloumSession(body) {
  return Array.isArray(body?.cookies) && body.cookies.length > 0;
}

function validateClientSessionPayload(body) {
  const { email, cookies, origins, displayName, postLoginUrl } = body;

  if (!email || typeof email !== 'string' || !email.trim()) {
    return 'Email is required';
  }

  if (!Array.isArray(cookies) || cookies.length === 0) {
    return 'Session cookies from the DomX desktop app are required';
  }

  const hasMaloumCookie = cookies.some((cookie) =>
    String(cookie?.domain || '').includes('maloum.com')
  );
  if (!hasMaloumCookie) {
    return 'Session cookies must include Maloum domain cookies';
  }

  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return 'Display name is required';
  }

  if (!postLoginUrl || typeof postLoginUrl !== 'string') {
    return 'Post-login URL is required';
  }

  if (origins !== undefined && !Array.isArray(origins)) {
    return 'Origins must be an array';
  }

  return null;
}

function validateRefreshSessionPayload(body) {
  const { cookies, origins } = body;

  if (!Array.isArray(cookies) || cookies.length === 0) {
    return 'Session cookies from the DomX desktop app are required';
  }

  const hasMaloumCookie = cookies.some((cookie) =>
    String(cookie?.domain || '').includes('maloum.com')
  );
  if (!hasMaloumCookie) {
    return 'Session cookies must include Maloum domain cookies';
  }

  if (origins !== undefined && !Array.isArray(origins)) {
    return 'Origins must be an array';
  }

  return null;
}

async function cleanupExpiredPending() {
  await pool.query(
    'DELETE FROM creator_connect_pending WHERE "expiresAt" < NOW()'
  );
}

const CREATOR_SELECT_COLUMNS = `
  id, "displayName", username, platform, "connectionStatus",
  "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
  "loginEmail", "encryptedLoginPassword", "lastValidatedAt", "authRefreshState",
  "accessTokenExpiresAt", "createdAt", "updatedAt"
`;

function encryptOptionalLoginPassword(password) {
  if (password === undefined || password === null) {
    return undefined;
  }
  if (typeof password !== 'string' || !password.length) {
    return null;
  }
  return encryptSecret(password);
}

function toCreatorStaff(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    roleName: row.roleName || row.role,
    assignedAt: row.assignedAt,
  };
}

router.get('/', authenticate, requirePermission('creators.view'), async (req, res) => {
  try {
    let result;

    if (userSeesAllCreators(req.user)) {
      result = await pool.query(
        `SELECT ${CREATOR_SELECT_COLUMNS}
         FROM creators
         ORDER BY "createdAt" ASC`
      );
    } else {
      result = await pool.query(
        `SELECT c.id, c."displayName", c.username, c.platform, c."connectionStatus",
                c."postLoginUrl", c."avatarUrl", c."avatarSource", c."staffCount", c."accountId",
                c."partitionId", c."loginEmail", c."encryptedLoginPassword", c."lastValidatedAt",
                c."authRefreshState", c."accessTokenExpiresAt", c."createdAt", c."updatedAt"
         FROM creators c
         INNER JOIN creator_staff_assignments a
           ON a."creatorId" = c.id AND a."userId" = $1
         ORDER BY c."createdAt" ASC`,
        [req.user.id]
      );
    }

    res.json({ creators: result.rows.map(toCreator) });
  } catch (err) {
    console.error('List creators error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/connect',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const {
      accountId,
      platform,
      email,
      cookies,
      origins,
      displayName,
      username,
      postLoginUrl,
      avatarUrl,
      password,
      proxyUrl,
    } = req.body;

    if (!accountId || !platform) {
      return res.status(400).json({
        error: 'Account ID and platform are required',
      });
    }

    if (!isValidUuid(accountId)) {
      return res.status(400).json({ error: 'Invalid account ID' });
    }

    if (!VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    // --- 4based API-based connect ---
    if (platform === '4based') {
      if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'Email is required' });
      }
      if (!password || typeof password !== 'string' || !password.length) {
        return res.status(400).json({ error: 'Password is required' });
      }

      let resolvedProxy;
      try {
        resolvedProxy = fourBasedClient.resolveFourBasedProxyUrl(proxyUrl);
      } catch (err) {
        if (err instanceof fourBasedClient.FourBasedApiError) {
          return res.status(err.status || 400).json({ error: err.message });
        }
        throw err;
      }

      try {
        await cleanupExpiredPending();

        const existingCreator = await pool.query(
          'SELECT id FROM creators WHERE "accountId" = $1',
          [accountId]
        );
        if (existingCreator.rows.length > 0) {
          return res.status(409).json({ error: 'Account ID is already in use' });
        }

        const existingPending = await pool.query(
          `SELECT "accountId" FROM creator_connect_pending
           WHERE "accountId" = $1 AND "createdBy" = $2 AND "expiresAt" > NOW()`,
          [accountId, req.user.id]
        );
        if (existingPending.rows.length > 0) {
          await pool.query(
            'DELETE FROM creator_connect_pending WHERE "accountId" = $1',
            [accountId]
          );
        }

        let loginResult;
        try {
          loginResult = await fourBasedClient.login({
            identifier: email.trim(),
            password,
            proxyUrl: resolvedProxy,
          });
        } catch (err) {
          if (err instanceof fourBasedClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
            return res.status(400).json({ error: 'Password not correct' });
          }
          if (err instanceof fourBasedClient.FourBasedApiError) {
            return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
              error: err.message || '4based login failed',
            });
          }
          throw err;
        }

        const accountToken = generateAccountToken();
        const accountTokenHash = hashToken(accountToken);
        const partitionId = partitionIdFor(accountId);
        const loginEmail = email.trim();
        const sessionPayload = {
          cookies: loginResult.cookies,
          token: loginResult.token,
          resource: loginResult.resource,
          providerUserId: loginResult.providerUserId,
          loginEmail,
          savedAt: new Date().toISOString(),
          platform: '4based',
        };
        const encryptedSession = encryptJson(sessionPayload);
        const encryptedAccessToken = encryptSecret(loginResult.token);
        const encryptedProxy = encryptSecret(resolvedProxy);
        const encryptedLoginPassword = encryptOptionalLoginPassword(password);
        const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000);
        const resolvedDisplayName =
          (typeof displayName === 'string' && displayName.trim()) ||
          loginResult.displayName;
        const resolvedUsername =
          (typeof username === 'string' && username.trim()) ||
          loginResult.username ||
          null;
        const resolvedAvatar =
          avatarUrl || loginResult.avatarUrl || null;
        const resolvedPostLoginUrl =
          (typeof postLoginUrl === 'string' && postLoginUrl.trim()) ||
          loginResult.postLoginUrl;

        await pool.query(
          `INSERT INTO creator_connect_pending (
             "accountId", "accountTokenHash", "partitionId", platform,
             "displayName", username, "postLoginUrl", "avatarUrl", "encryptedSession",
             "loginEmail", "encryptedLoginPassword", "encryptedAccessToken",
             "encryptedRefreshToken", "accessTokenExpiresAt",
             "providerUserId", "encryptedProxy",
             "createdBy", "expiresAt"
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            accountId,
            accountTokenHash,
            partitionId,
            platform,
            resolvedDisplayName,
            resolvedUsername,
            resolvedPostLoginUrl,
            resolvedAvatar,
            encryptedSession,
            loginEmail,
            encryptedLoginPassword ?? null,
            encryptedAccessToken,
            null,
            null,
            loginResult.providerUserId,
            encryptedProxy,
            req.user.id,
            expiresAt,
          ]
        );

        return res.status(201).json({
          accountToken,
          accountId,
          partitionId,
          displayName: resolvedDisplayName,
          username: resolvedUsername,
          postLoginUrl: resolvedPostLoginUrl,
          avatarUrl: resolvedAvatar,
          providerUserId: loginResult.providerUserId,
          cookies: [],
          origins: [],
        });
      } catch (err) {
        console.error('Connect 4based creator error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // --- Maloum API-based connect ---
    if (platform !== 'maloum') {
      return res.status(400).json({ error: 'Only Maloum and 4based are supported currently' });
    }

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!password || typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Password is required' });
    }

    let resolvedProxy;
    try {
      resolvedProxy = maloumClient.resolveMaloumProxyUrl(proxyUrl);
    } catch (err) {
      if (err instanceof maloumClient.MaloumApiError) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      throw err;
    }

    try {
      await cleanupExpiredPending();

      const existingCreator = await pool.query(
        'SELECT id FROM creators WHERE "accountId" = $1',
        [accountId]
      );
      if (existingCreator.rows.length > 0) {
        return res.status(409).json({ error: 'Account ID is already in use' });
      }

      const existingPending = await pool.query(
        `SELECT "accountId" FROM creator_connect_pending
         WHERE "accountId" = $1 AND "createdBy" = $2 AND "expiresAt" > NOW()`,
        [accountId, req.user.id]
      );
      if (existingPending.rows.length > 0) {
        await pool.query(
          'DELETE FROM creator_connect_pending WHERE "accountId" = $1',
          [accountId]
        );
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
          return res.status(maloumClientHttpStatus(err)).json({
            error: maloumClientHttpMessage(err, 'Maloum login failed'),
          });
        }
        throw err;
      }

      const accountToken = generateAccountToken();
      const accountTokenHash = hashToken(accountToken);
      const partitionId = partitionIdFor(accountId);
      const loginEmail = email.trim();
      const { encryptedSession } = buildEncryptedSessionPayload({
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
      const encryptedProxy = encryptSecret(resolvedProxy);
      const encryptedLoginPassword = encryptOptionalLoginPassword(password);
      const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000);
      const resolvedDisplayName =
        (typeof displayName === 'string' && displayName.trim()) ||
        loginResult.displayName;
      const resolvedUsername =
        (typeof username === 'string' && username.trim()) ||
        loginResult.username ||
        null;
      const resolvedAvatar = avatarUrl || loginResult.avatarUrl || null;
      const resolvedPostLoginUrl =
        (typeof postLoginUrl === 'string' && postLoginUrl.trim()) ||
        loginResult.postLoginUrl;

      await pool.query(
        `INSERT INTO creator_connect_pending (
           "accountId", "accountTokenHash", "partitionId", platform,
           "displayName", username, "postLoginUrl", "avatarUrl", "encryptedSession",
           "loginEmail", "encryptedLoginPassword", "encryptedAccessToken",
           "encryptedRefreshToken", "accessTokenExpiresAt",
           "providerUserId", "encryptedProxy",
           "createdBy", "expiresAt"
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          accountId,
          accountTokenHash,
          partitionId,
          platform,
          resolvedDisplayName,
          resolvedUsername,
          resolvedPostLoginUrl,
          resolvedAvatar,
          encryptedSession,
          loginEmail,
          encryptedLoginPassword ?? null,
          tokenFields?.encryptedAccessToken ?? null,
          tokenFields?.encryptedRefreshToken ?? null,
          tokenFields?.accessTokenExpiresAt ?? null,
          loginResult.providerUserId,
          encryptedProxy,
          req.user.id,
          expiresAt,
        ]
      );

      return res.status(201).json({
        accountToken,
        accountId,
        partitionId,
        displayName: resolvedDisplayName,
        username: resolvedUsername,
        postLoginUrl: resolvedPostLoginUrl,
        avatarUrl: resolvedAvatar,
        providerUserId: loginResult.providerUserId,
        cookies: loginResult.cookies,
        origins: loginResult.origins,
      });
    } catch (err) {
      console.error('Connect Maloum creator error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete(
  '/connect/:accountId',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { accountId } = req.params;

    if (!isValidUuid(accountId)) {
      return res.status(400).json({ error: 'Invalid account ID' });
    }

    try {
      const result = await pool.query(
        `DELETE FROM creator_connect_pending
         WHERE "accountId" = $1 AND "createdBy" = $2
         RETURNING "partitionId"`,
        [accountId, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Pending connect session not found' });
      }

      res.json({
        message: 'Pending connect session discarded',
        partitionId: result.rows[0].partitionId,
        accountId,
      });
    } catch (err) {
      console.error('Discard connect session error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/', authenticate, requirePermission('creators.manage'), async (req, res) => {
  const { displayName, username, platform, postLoginUrl, connectionStatus, accountId } =
    req.body;

  if (!displayName || !platform) {
    return res.status(400).json({ error: 'Display name and platform are required' });
  }

  if (!VALID_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  if (connectionStatus && !VALID_STATUSES.includes(connectionStatus)) {
    return res.status(400).json({ error: 'Invalid connection status' });
  }

  try {
    await cleanupExpiredPending();

    let pending = null;
    if (accountId) {
      if (!isValidUuid(accountId)) {
        return res.status(400).json({ error: 'Invalid account ID' });
      }

      const pendingResult = await pool.query(
        `SELECT *
         FROM creator_connect_pending
         WHERE "accountId" = $1
           AND "createdBy" = $2
           AND "expiresAt" > NOW()`,
        [accountId, req.user.id]
      );

      if (pendingResult.rows.length === 0) {
        return res.status(400).json({
          error: 'Connect session expired or not found. Please connect again.',
        });
      }

      pending = pendingResult.rows[0];
    }

    const result = await pool.query(
      `INSERT INTO creators (
         "displayName", username, platform, "postLoginUrl", "avatarUrl", "connectionStatus",
         "accountId", "accountTokenHash", "partitionId", "encryptedSession",
         "loginEmail", "encryptedLoginPassword", "encryptedAccessToken",
         "encryptedRefreshToken", "accessTokenExpiresAt", "authRefreshState",
         "tokenRefreshFailureCount", "lastValidatedAt",
         "providerUserId", "encryptedProxy"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id, "displayName", username, platform, "connectionStatus",
                 "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
                 "loginEmail", "lastValidatedAt", "authRefreshState", "accessTokenExpiresAt",
                 "providerUserId", "createdAt", "updatedAt"`,
      [
        displayName.trim(),
        username?.trim() || pending?.username || null,
        platform,
        postLoginUrl?.trim() || pending?.postLoginUrl || null,
        pending?.avatarUrl || null,
        connectionStatus || 'connected',
        pending?.accountId || null,
        pending?.accountTokenHash || null,
        pending?.partitionId || null,
        pending?.encryptedSession || null,
        pending?.loginEmail || null,
        pending?.encryptedLoginPassword || null,
        pending?.encryptedAccessToken || null,
        pending?.encryptedRefreshToken || null,
        pending?.accessTokenExpiresAt || null,
        pending?.encryptedRefreshToken ? 'active' : 'active',
        0,
        pending ? new Date() : null,
        pending?.providerUserId || null,
        pending?.encryptedProxy || null,
      ]
    );

    if (pending) {
      await pool.query(
        'DELETE FROM creator_connect_pending WHERE "accountId" = $1',
        [accountId]
      );
    }

    const saved = result.rows[0];
    if (
      saved.platform === 'maloum' &&
      pending?.avatarUrl &&
      !isBackendStoredAvatarUrl(pending.avatarUrl)
    ) {
      let pendingProxy = null;
      try {
        pendingProxy = pending.encryptedProxy
          ? decryptSecret(pending.encryptedProxy)
          : null;
      } catch {
        pendingProxy = null;
      }
      const cachedPath = await tryCacheMaloumAvatar(
        saved.id,
        pending.avatarUrl,
        pendingProxy
      );
      if (cachedPath) {
        const updated = await persistCachedMaloumAvatar(saved.id, cachedPath);
        if (updated) {
          Object.assign(saved, updated);
        }
      }
    }

    if (pending?.encryptedSession && saved.accountId) {
      let sessionSavedAt = null;
      try {
        const savedSession = decryptJson(pending.encryptedSession);
        sessionSavedAt = sessionUpdatedAtFrom(savedSession, saved.updatedAt);
      } catch {
        sessionSavedAt = sessionUpdatedAtFrom(null, saved.updatedAt);
      }

      const accessUserIds = await getUserIdsWithCreatorAccess(saved.id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: saved.id,
        accountId: saved.accountId,
        sessionUpdatedAt: sessionSavedAt,
      });
    }

    if (saved.platform === '4based') {
      void connectCreatorById(saved.id).catch((err) => {
        console.warn('[4based] Failed to open socket after create:', err.message);
      });
    }

    res.status(201).json({ creator: toCreator(saved) });
  } catch (err) {
    console.error('Create creator error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/:id/staff',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const creatorCheck = await pool.query('SELECT id FROM creators WHERE id = $1', [id]);
      if (creatorCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const result = await pool.query(
        `SELECT u.id, u.name, u.email, u.role, r.name AS "roleName", a."assignedAt"
         FROM creator_staff_assignments a
         INNER JOIN users u ON u.id = a."userId"
         LEFT JOIN roles r ON r.slug = u.role
         WHERE a."creatorId" = $1
         ORDER BY a."assignedAt" ASC`,
        [id]
      );

      res.json({ staff: result.rows.map(toCreatorStaff) });
    } catch (err) {
      console.error('List creator staff error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/staff',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    if (!userId || !isValidUuid(userId)) {
      return res.status(400).json({ error: 'Valid userId is required' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const creatorCheck = await client.query(
        'SELECT id, "displayName", "accountId" FROM creators WHERE id = $1',
        [id]
      );
      if (creatorCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Creator not found' });
      }

      const creator = creatorCheck.rows[0];

      const userCheck = await client.query(
        'SELECT id, status FROM users WHERE id = $1',
        [userId]
      );
      if (userCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Staff member not found' });
      }

      if (userCheck.rows[0].status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Only active staff can be assigned' });
      }

      const existing = await client.query(
        `SELECT id FROM creator_staff_assignments
         WHERE "creatorId" = $1 AND "userId" = $2`,
        [id, userId]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Staff member is already assigned to this creator' });
      }

      await client.query(
        `INSERT INTO creator_staff_assignments ("creatorId", "userId", "assignedBy")
         VALUES ($1, $2, $3)`,
        [id, userId, req.user.id]
      );

      await client.query(
        `UPDATE creators
         SET "staffCount" = "staffCount" + 1, "updatedAt" = NOW()
         WHERE id = $1`,
        [id]
      );

      await client.query('COMMIT');

      emitToUser(userId, {
        type: 'creator:access-granted',
        creatorId: creator.id,
        accountId: creator.accountId || null,
        displayName: creator.displayName,
      });

      res.status(201).json({ message: 'Staff assigned' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Assign creator staff error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

router.delete(
  '/:id/staff/:userId',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id, userId } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    if (!isValidUuid(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const creatorResult = await client.query(
        `SELECT id, "displayName", "accountId"
         FROM creators
         WHERE id = $1`,
        [id]
      );

      if (creatorResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Creator not found' });
      }

      const creator = creatorResult.rows[0];

      const deleted = await client.query(
        `DELETE FROM creator_staff_assignments
         WHERE "creatorId" = $1 AND "userId" = $2
         RETURNING id`,
        [id, userId]
      );

      if (deleted.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Assignment not found' });
      }

      await client.query(
        `UPDATE creators
         SET "staffCount" = GREATEST("staffCount" - 1, 0), "updatedAt" = NOW()
         WHERE id = $1`,
        [id]
      );

      await client.query('COMMIT');

      emitToUser(userId, {
        type: 'creator:access-revoked',
        creatorId: creator.id,
        accountId: creator.accountId || null,
        displayName: creator.displayName,
      });

      res.json({ message: 'Staff unassigned' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Unassign creator staff error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

router.put(
  '/:id/session',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    const {
      email,
      cookies,
      origins,
      displayName,
      username,
      postLoginUrl,
      avatarUrl,
      password,
      savePassword,
    } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const sessionError = validateClientSessionPayload(req.body);
    if (sessionError) {
      return res.status(400).json({ error: sessionError });
    }

    try {
      const existing = await pool.query(
        `SELECT id, "accountId", "partitionId", platform, "avatarUrl", "avatarSource"
         FROM creators
         WHERE id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const creator = existing.rows[0];
      if (!creator.accountId) {
        return res.status(400).json({ error: 'Creator has no account partition to reconnect' });
      }

      if (creator.platform !== 'maloum') {
        return res.status(400).json({ error: 'Only Maloum reconnection is supported currently' });
      }

      const loginEmail = email.trim();
      const { encryptedSession, savedAt: sessionSavedAt } = buildEncryptedSessionPayload({
        cookies,
        origins,
        loginEmail,
      });
      const tokenPersistence = buildTokenPersistenceFromOrigins(origins);

      const nextAvatarUrl =
        creator.avatarSource === 'manual' ||
        isBackendStoredAvatarUrl(creator.avatarUrl)
          ? creator.avatarUrl
          : avatarUrl || creator.avatarUrl;

      const params = [
        id,
        encryptedSession,
        loginEmail,
        displayName?.trim() || null,
        username || null,
        postLoginUrl || null,
        nextAvatarUrl || null,
      ];

      let passwordSetClause = '';
      if (password !== undefined) {
        passwordSetClause = `"encryptedLoginPassword" = $8,`;
        params.push(encryptOptionalLoginPassword(password));
      } else if (savePassword === false) {
        passwordSetClause = `"encryptedLoginPassword" = NULL,`;
      }

      const tokenStartIndex = params.length + 1;
      params.push(
        tokenPersistence?.encryptedAccessToken ?? null,
        tokenPersistence?.encryptedRefreshToken ?? null,
        tokenPersistence?.accessTokenExpiresAt ?? null
      );

      const result = await pool.query(
        `UPDATE creators
         SET "encryptedSession" = $2,
             "loginEmail" = $3,
             "displayName" = COALESCE($4, "displayName"),
             username = COALESCE($5, username),
             "postLoginUrl" = COALESCE($6, "postLoginUrl"),
             "avatarUrl" = COALESCE($7, "avatarUrl"),
             ${passwordSetClause}
             "encryptedAccessToken" = COALESCE($${tokenStartIndex}, "encryptedAccessToken"),
             "encryptedRefreshToken" = COALESCE($${tokenStartIndex + 1}, "encryptedRefreshToken"),
             "accessTokenExpiresAt" = COALESCE($${tokenStartIndex + 2}, "accessTokenExpiresAt"),
             "authRefreshState" = 'active',
             "tokenRefreshFailureCount" = 0,
             "connectionStatus" = 'connected',
             "lastValidatedAt" = NOW(),
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        params
      );

      const accessUserIds = await getUserIdsWithCreatorAccess(id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: id,
        accountId: creator.accountId,
        sessionUpdatedAt: sessionSavedAt,
      });

      res.json({
        creator: toCreator(result.rows[0]),
        accountId: creator.accountId,
        partitionId: creator.partitionId,
        cookies,
        origins: origins || [],
        sessionUpdatedAt: sessionSavedAt,
      });
    } catch (err) {
      console.error('Update creator session error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/:id/credentials',
  authenticate,
  requirePermission('creators.view'),
  credentialsLimiter,
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

      const result = await pool.query(
        `SELECT id, "loginEmail", "encryptedLoginPassword"
         FROM creators
         WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const creator = result.rows[0];
      if (!creator.encryptedLoginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      const loginPassword = decryptSecret(creator.encryptedLoginPassword);
      if (!loginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      res.json({
        loginEmail: creator.loginEmail || null,
        loginPassword,
      });
    } catch (err) {
      console.error('Get creator credentials error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put(
  '/:id/session/refresh',
  authenticate,
  requirePermission('creators.view'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    const { cookies, origins } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const sessionError = validateRefreshSessionPayload(req.body);
    if (sessionError) {
      return res.status(400).json({ error: sessionError });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const existing = await pool.query(
        `SELECT id, "accountId", "loginEmail", platform
         FROM creators
         WHERE id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const creator = existing.rows[0];
      if (!creator.accountId) {
        return res.status(400).json({ error: 'Creator has no account partition to refresh' });
      }

      if (creator.platform !== 'maloum') {
        return res.status(400).json({ error: 'Only Maloum session refresh is supported currently' });
      }

      const loginEmail = creator.loginEmail || '';
      const { encryptedSession, savedAt: sessionSavedAt } = buildEncryptedSessionPayload({
        cookies,
        origins,
        loginEmail,
      });
      const tokenPersistence = buildTokenPersistenceFromOrigins(origins);

      const result = await pool.query(
        `UPDATE creators
         SET "encryptedSession" = $2,
             "encryptedAccessToken" = COALESCE($3, "encryptedAccessToken"),
             "encryptedRefreshToken" = COALESCE($4, "encryptedRefreshToken"),
             "accessTokenExpiresAt" = COALESCE($5, "accessTokenExpiresAt"),
             "authRefreshState" = CASE
               WHEN $4 IS NOT NULL THEN 'active'
               ELSE "authRefreshState"
             END,
             "tokenRefreshFailureCount" = CASE
               WHEN $4 IS NOT NULL THEN 0
               ELSE "tokenRefreshFailureCount"
             END,
             "connectionStatus" = 'connected',
             "lastValidatedAt" = NOW(),
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        [
          id,
          encryptedSession,
          tokenPersistence?.encryptedAccessToken ?? null,
          tokenPersistence?.encryptedRefreshToken ?? null,
          tokenPersistence?.accessTokenExpiresAt ?? null,
        ]
      );

      const accessUserIds = await getUserIdsWithCreatorAccess(id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: id,
        accountId: creator.accountId,
        sessionUpdatedAt: sessionSavedAt,
      });

      res.json({
        creator: toCreator(result.rows[0]),
        accountId: creator.accountId,
        sessionUpdatedAt: sessionSavedAt,
      });
    } catch (err) {
      console.error('Refresh creator session error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/:id/auth-tokens',
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

      const result = await pool.query(
        `SELECT id, "accountId", "encryptedAccessToken", "accessTokenExpiresAt", "authRefreshState"
         FROM creators
         WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const creator = result.rows[0];
      const accessToken = decryptAccessToken(creator.encryptedAccessToken);

      if (!accessToken) {
        return res.status(404).json({ error: 'No saved auth token for this creator' });
      }

      res.json({
        accountId: creator.accountId,
        accessToken,
        expiresAt: creator.accessTokenExpiresAt || null,
        authRefreshState: creator.authRefreshState || 'active',
      });
    } catch (err) {
      console.error('Get creator auth tokens error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/:id/session',
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

      const result = await pool.query(
        `SELECT id, "displayName", username, "avatarUrl", "accountId", "partitionId",
                "encryptedSession", "encryptedProxy", "connectionStatus", "updatedAt"
         FROM creators
         WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const creator = result.rows[0];

      if (!creator.encryptedSession) {
        return res.status(404).json({ error: 'No saved session for this creator' });
      }

      const session = decryptJson(creator.encryptedSession);
      const cookies = session.cookies || [];
      const origins = session.origins || [];
      const userAgent =
        typeof session.userAgent === 'string' && session.userAgent.trim()
          ? session.userAgent.trim()
          : null;
      let proxyUrl = null;
      if (creator.encryptedProxy) {
        try {
          proxyUrl = decryptSecret(creator.encryptedProxy) || null;
        } catch {
          proxyUrl = null;
        }
      }

      res.json({
        accountId: creator.accountId,
        partitionId: creator.partitionId,
        displayName: creator.displayName,
        username: creator.username,
        avatarUrl: creator.avatarUrl || null,
        cookies,
        origins,
        userAgent,
        proxyUrl,
        sessionUpdatedAt: sessionUpdatedAtFrom(session, creator.updatedAt),
      });
    } catch (err) {
      console.error('Get creator session error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/avatar',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    const { imageBase64, contentType, overwrite = false } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 is required' });
    }

    if (!contentType || typeof contentType !== 'string') {
      return res.status(400).json({ error: 'contentType is required' });
    }

    try {
      const existing = await pool.query(
        `SELECT id, "avatarUrl", "avatarSource"
         FROM creators
         WHERE id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const creator = existing.rows[0];
      const isManual = creator.avatarSource === 'manual';

      if (isManual && !overwrite) {
        return res.json({
          creator: toCreator(
            (
              await pool.query(
                `SELECT id, "displayName", username, platform, "connectionStatus",
                        "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId",
                        "partitionId", "loginEmail", "lastValidatedAt", "createdAt", "updatedAt"
                 FROM creators WHERE id = $1`,
                [id]
              )
            ).rows[0]
          ),
          skipped: true,
          reason: 'Manual avatar is protected',
        });
      }

      const buffer = Buffer.from(imageBase64, 'base64');
      if (!buffer.length) {
        return res.status(400).json({ error: 'imageBase64 is invalid' });
      }

      const avatarPath = saveCreatorAvatarFromBuffer(
        id,
        buffer,
        contentType.trim()
      );

      const result = await pool.query(
        `UPDATE creators
         SET "avatarUrl" = $2,
             "avatarSource" = 'maloum',
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING id, "displayName", username, platform, "connectionStatus",
                   "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId",
                   "partitionId", "loginEmail", "lastValidatedAt", "createdAt", "updatedAt"`,
        [id, avatarPath]
      );

      res.json({ creator: toCreator(result.rows[0]) });
    } catch (err) {
      console.error('Save creator avatar error:', err);
      const message = err.message || 'Failed to save creator avatar';
      const status =
        /required|invalid|unsupported|too large/i.test(message) ? 400 : 500;
      res.status(status).json({ error: message });
    }
  }
);

router.patch(
  '/:id',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    const { displayName } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName is required' });
    }

    try {
      const result = await pool.query(
        `UPDATE creators
         SET "displayName" = $2,
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        [id, displayName.trim()]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      res.json({ creator: toCreator(result.rows[0]) });
    } catch (err) {
      console.error('Rename creator error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch(
  '/:id/session-validation',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    const { valid } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    if (typeof valid !== 'boolean') {
      return res.status(400).json({ error: 'valid must be a boolean' });
    }

    try {
      const result = await pool.query(
        `UPDATE creators
         SET "connectionStatus" = $2,
             "lastValidatedAt" = NOW(),
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING id, "displayName", username, platform, "connectionStatus",
                   "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
                   "loginEmail", "lastValidatedAt", "createdAt", "updatedAt"`,
        [id, valid ? 'connected' : 'error']
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      res.json({ creator: toCreator(result.rows[0]) });
    } catch (err) {
      console.error('Update session validation error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/:id', authenticate, requirePermission('creators.manage'), async (req, res) => {
  const { id } = req.params;

  try {
    const creatorResult = await pool.query(
      `SELECT id, "displayName", "accountId", "partitionId"
       FROM creators
       WHERE id = $1`,
      [id]
    );

    if (creatorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const creator = creatorResult.rows[0];

    const assignedStaff = await pool.query(
      `SELECT "userId" FROM creator_staff_assignments WHERE "creatorId" = $1`,
      [id]
    );

    const result = await pool.query(
      `DELETE FROM creators
       WHERE id = $1
       RETURNING id, "accountId", "partitionId", platform`,
      [id]
    );

    const { accountId, partitionId, platform } = result.rows[0];

    if (platform === '4based') {
      disconnectCreator(id);
    }

    if (accountId) {
      await pool.query(
        'DELETE FROM creator_connect_pending WHERE "accountId" = $1',
        [accountId]
      );
    }

    const assignedUserIds = assignedStaff.rows.map((row) => row.userId);
    if (assignedUserIds.length > 0) {
      emitToUsers(assignedUserIds, {
        type: 'creator:access-revoked',
        creatorId: creator.id,
        accountId: creator.accountId || null,
        displayName: creator.displayName,
      });
    }

    res.json({
      message: 'Creator removed',
      accountId: accountId || null,
      partitionId: partitionId || null,
    });
  } catch (err) {
    console.error('Delete creator error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function loadFourBasedCreator(creatorId) {
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
  if (row.platform !== '4based') {
    return { error: { status: 400, message: 'Creator is not a 4based account' } };
  }

  let session = {};
  try {
    if (row.encryptedSession) {
      session = decryptJson(row.encryptedSession) || {};
    }
  } catch (err) {
    return { error: { status: 500, message: 'Failed to decrypt 4based session' } };
  }

  const accessToken = decryptSecret(row.encryptedAccessToken) || session.token || null;
  let proxyUrl = decryptSecret(row.encryptedProxy) || null;
  if (!proxyUrl) {
    try {
      proxyUrl = fourBasedClient.resolveFourBasedProxyUrl(null);
    } catch {
      proxyUrl = null;
    }
  }
  const providerUserId = row.providerUserId || session.providerUserId || null;

  if (!accessToken || !providerUserId) {
    return {
      error: {
        status: 400,
        message: '4based account is missing auth credentials. Please reconnect.',
      },
    };
  }

  if (!proxyUrl) {
    return {
      error: {
        status: 400,
        message:
          '4based proxy is required. Set FOURBASED_PROXY_URL in backend .env or reconnect with a proxy.',
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
      session: {
        ...session,
        providerUserId,
        token: accessToken,
        cookies: session.cookies || {},
        resource: session.resource || null,
      },
    },
  };
}

function handleFourBasedError(res, err, label) {
  if (err instanceof fourBasedClient.WrongPasswordError) {
    return res.status(400).json({ error: 'Password not correct' });
  }
  if (err instanceof fourBasedClient.FourBasedApiError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({ error: err.message || '4based request failed' });
  }
  console.error(label, err);
  return res.status(500).json({ error: 'Internal server error' });
}

/** Single-flight media-session refresh per creator (mint fresh media_jwt via re-login). */
const fourBasedMediaSessionRefreshInflight = new Map();

/**
 * Re-login with saved credentials and persist cookies (including media_jwt).
 * Returns a fresh loadFourBasedCreator() result or { error }.
 */
async function refreshFourBasedSessionFromSaved(creatorId) {
  const existing = fourBasedMediaSessionRefreshInflight.get(creatorId);
  if (existing) return existing;

  const promise = (async () => {
    const result = await pool.query(
      `SELECT id, platform, "loginEmail", "encryptedLoginPassword", "encryptedProxy",
              "accountId"
       FROM creators WHERE id = $1`,
      [creatorId]
    );
    if (result.rows.length === 0) {
      return { error: { status: 404, message: 'Creator not found' } };
    }
    const row = result.rows[0];
    if (row.platform !== '4based') {
      return { error: { status: 400, message: 'Creator is not a 4based account' } };
    }
    if (!row.loginEmail || !row.encryptedLoginPassword) {
      return {
        error: {
          status: 401,
          message:
            'Protected media auth expired and no saved credentials to refresh. Reconnect the 4based account.',
        },
      };
    }

    const loginPassword = decryptSecret(row.encryptedLoginPassword);
    if (!loginPassword) {
      return {
        error: {
          status: 401,
          message:
            'Protected media auth expired and saved credentials are unreadable. Reconnect the 4based account.',
        },
      };
    }

    const storedProxy = row.encryptedProxy ? decryptSecret(row.encryptedProxy) : null;
    let resolvedProxy;
    try {
      resolvedProxy = fourBasedClient.resolveFourBasedProxyUrl(storedProxy);
    } catch (err) {
      if (err instanceof fourBasedClient.FourBasedApiError) {
        return { error: { status: err.status || 400, message: err.message } };
      }
      throw err;
    }

    let loginResult;
    try {
      loginResult = await fourBasedClient.login({
        identifier: row.loginEmail.trim(),
        password: loginPassword,
        proxyUrl: resolvedProxy,
      });
    } catch (err) {
      if (err instanceof fourBasedClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
        return { error: { status: 400, message: 'Password not correct' } };
      }
      if (err instanceof fourBasedClient.FourBasedApiError) {
        return {
          error: {
            status: err.status >= 400 && err.status < 600 ? err.status : 502,
            message: err.message || '4based login failed',
          },
        };
      }
      throw err;
    }

    if (!fourBasedClient.hasMediaJwt(loginResult.cookies)) {
      console.warn(
        `[4based] media session refresh for ${creatorId} still missing media_jwt`
      );
    }

    const loginEmail = row.loginEmail.trim();
    const sessionPayload = {
      cookies: loginResult.cookies,
      token: loginResult.token,
      resource: loginResult.resource,
      providerUserId: loginResult.providerUserId,
      loginEmail,
      savedAt: new Date().toISOString(),
      platform: '4based',
    };
    const encryptedSession = encryptJson(sessionPayload);
    const encryptedAccessToken = encryptSecret(loginResult.token);
    const encryptedProxy = encryptSecret(resolvedProxy);

    await pool.query(
      `UPDATE creators SET
         "encryptedSession" = $1,
         "encryptedAccessToken" = $2,
         "encryptedProxy" = $3,
         "providerUserId" = $4,
         "loginEmail" = $5,
         username = COALESCE($6, username),
         "avatarUrl" = COALESCE($7, "avatarUrl"),
         "postLoginUrl" = $8,
         "connectionStatus" = 'connected',
         "lastValidatedAt" = NOW(),
         "authRefreshState" = 'active',
         "updatedAt" = NOW()
       WHERE id = $9`,
      [
        encryptedSession,
        encryptedAccessToken,
        encryptedProxy,
        loginResult.providerUserId,
        loginEmail,
        loginResult.username,
        loginResult.avatarUrl,
        loginResult.postLoginUrl,
        creatorId,
      ]
    );

    const accessUserIds = await getUserIdsWithCreatorAccess(creatorId);
    emitCreatorSessionUpdated(accessUserIds, {
      creatorId,
      accountId: row.accountId,
      sessionUpdatedAt: sessionPayload.savedAt,
    });

    return loadFourBasedCreator(creatorId);
  })();

  fourBasedMediaSessionRefreshInflight.set(creatorId, promise);
  try {
    return await promise;
  } finally {
    fourBasedMediaSessionRefreshInflight.delete(creatorId);
  }
}

/**
 * Ensure creator has a usable media_jwt.
 * - force: always re-login (e.g. after upstream 401)
 * - otherwise: only refresh when media_jwt exists but is within 1h of expiry
 *   (missing media_jwt is not re-logged on every request — that would spam if proxy strips cookies)
 */
async function ensureFourBasedMediaAuth(creatorId, creator, { force = false } = {}) {
  const cookies = creator?.session?.cookies || {};
  if (!force) {
    const hasJwt = fourBasedClient.hasMediaJwt(cookies);
    if (!hasJwt || !fourBasedClient.isMediaJwtStale(cookies)) {
      return { creator };
    }
  }
  console.info(
    `[4based] refreshing media session for ${creatorId} (force=${force}, hasMediaJwt=${fourBasedClient.hasMediaJwt(cookies)})`
  );
  return refreshFourBasedSessionFromSaved(creatorId);
}

/** Max concurrent upstream media fetches per creator (cache hits unaffected). */
const FOURBASED_MEDIA_UPSTREAM_CONCURRENCY = Math.max(
  1,
  Number(process.env.FOURBASED_MEDIA_UPSTREAM_CONCURRENCY) || 5
);

/** @type {Map<string, { active: number, queue: Array<() => void> }>} */
const fourBasedMediaSemaphores = new Map();

/** In-flight full-file downloads keyed by creatorId\\npath — single-flight de-dupe. */
const fourBasedMediaInflight = new Map();

function acquireFourBasedMediaSlot(creatorId) {
  let state = fourBasedMediaSemaphores.get(creatorId);
  if (!state) {
    state = { active: 0, queue: [] };
    fourBasedMediaSemaphores.set(creatorId, state);
  }
  if (state.active < FOURBASED_MEDIA_UPSTREAM_CONCURRENCY) {
    state.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.queue.push(resolve);
  }).then(() => {
    state.active += 1;
  });
}

function releaseFourBasedMediaSlot(creatorId) {
  const state = fourBasedMediaSemaphores.get(creatorId);
  if (!state) return;
  state.active = Math.max(0, state.active - 1);
  const next = state.queue.shift();
  if (next) next();
  if (state.active === 0 && state.queue.length === 0) {
    fourBasedMediaSemaphores.delete(creatorId);
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainUpstreamBody(body) {
  if (!body) return;
  try {
    const { Readable } = require('stream');
    Readable.fromWeb(body).resume();
  } catch {
    // ignore
  }
}

async function fetchFourBasedMediaThrottled(creator, { path, rangeHeader } = {}) {
  await acquireFourBasedMediaSlot(creator.id);
  try {
    let lastErr;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const upstream = await fourBasedClient.fetchMedia(creator, {
          path,
          rangeHeader,
        });
        if (upstream.ok || upstream.status === 206) {
          return upstream;
        }
        const status = upstream.status || 0;
        lastErr = new fourBasedClient.FourBasedApiError(
          `Failed to fetch media (${status || 'no status'})`,
          status || 502
        );
        await drainUpstreamBody(upstream.body);
        // Retry transient upstream / proxy pressure; don't hammer 404s.
        if (status === 404 || status === 400 || status === 401) {
          throw lastErr;
        }
        if (attempt < maxAttempts - 1) {
          await sleepMs(250 * (attempt + 1));
        }
      } catch (err) {
        lastErr = err;
        if (
          err instanceof fourBasedClient.FourBasedApiError &&
          (err.status === 404 || err.status === 400 || err.status === 401)
        ) {
          throw err;
        }
        if (attempt < maxAttempts - 1) {
          await sleepMs(250 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('Failed to fetch media');
  } finally {
    releaseFourBasedMediaSlot(creator.id);
  }
}

function parseBytesRange(rangeHeader, size) {
  if (!rangeHeader || typeof rangeHeader !== 'string' || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start == null && end == null) return null;
  if (start == null) {
    // suffix: last N bytes
    const suffix = end;
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) return null;
    if (end == null || !Number.isFinite(end)) end = size - 1;
    if (end >= size) end = size - 1;
    if (start > end) return null;
  }
  return { start, end };
}

function setFourBasedMediaCommonHeaders(res, { contentType, etag, cacheStatus }) {
  if (contentType) res.setHeader('Content-Type', contentType);
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Cache-Control',
    'private, max-age=86400, stale-while-revalidate=604800'
  );
  res.setHeader('X-DomX-Media-Cache', cacheStatus);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function sendFourBasedCachedFile(res, cached, rangeHeader, cacheStatus = 'HIT') {
  const fs = require('fs');
  const size = cached.size;
  const range = parseBytesRange(rangeHeader, size);
  setFourBasedMediaCommonHeaders(res, {
    contentType: cached.contentType,
    etag: cached.etag,
    cacheStatus,
  });

  if (range) {
    const chunkSize = range.end - range.start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(chunkSize));
    const stream = fs.createReadStream(cached.binPath, {
      start: range.start,
      end: range.end,
    });
    stream.on('error', (err) => {
      console.warn('4based media cache stream error:', err.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(err);
    });
    stream.pipe(res);
    return;
  }

  res.status(200);
  res.setHeader('Content-Length', String(size));
  const stream = fs.createReadStream(cached.binPath);
  stream.on('error', (err) => {
    console.warn('4based media cache stream error:', err.message);
    if (!res.headersSent) res.status(502).end();
    else res.destroy(err);
  });
  stream.pipe(res);
}

async function fetchFourBasedMediaWithAuthRetry(creatorId, creator, { path, rangeHeader } = {}) {
  let activeCreator = creator;
  const ensured = await ensureFourBasedMediaAuth(creatorId, activeCreator);
  if (ensured.error) {
    // Proceed with existing session; may still work via x-auth headers.
    console.warn(
      `[4based] media auth ensure failed for ${creatorId}:`,
      ensured.error.message
    );
  } else if (ensured.creator) {
    activeCreator = ensured.creator;
  }

  let upstream = await fetchFourBasedMediaThrottled(activeCreator, {
    path,
    rangeHeader,
  });

  if (upstream.status === 401) {
    try {
      if (upstream.body) {
        const { Readable } = require('stream');
        Readable.fromWeb(upstream.body).resume();
      }
    } catch {
      // ignore
    }
    const refreshed = await ensureFourBasedMediaAuth(creatorId, activeCreator, {
      force: true,
    });
    if (refreshed.error) {
      throw new fourBasedClient.FourBasedApiError(
        refreshed.error.message ||
          'Failed to refresh 4based media auth (401). Reconnect the account.',
        refreshed.error.status || 401
      );
    }
    activeCreator = refreshed.creator;
    if (!fourBasedClient.hasMediaJwt(activeCreator?.session?.cookies || {})) {
      console.warn(
        `[4based] media_jwt still missing after reconnect for ${creatorId}; retrying with x-auth headers`
      );
    }
    upstream = await fetchFourBasedMediaThrottled(activeCreator, {
      path,
      rangeHeader,
    });
    if (upstream.status === 401) {
      try {
        if (upstream.body) {
          const { Readable } = require('stream');
          Readable.fromWeb(upstream.body).resume();
        }
      } catch {
        // ignore
      }
      throw new fourBasedClient.FourBasedApiError(
        'Failed to fetch media (401). media_jwt missing or rejected — reconnect the account; if login logs show no media_jwt, the proxy may be stripping Set-Cookie.',
        401
      );
    }
  }

  return { upstream, creator: activeCreator };
}

/**
 * Download full media file through residential proxy once, write to disk cache,
 * and resolve with the cached path metadata. Single-flight per creator+path.
 */
async function downloadFourBasedMediaToCache(creator, creatorId, mediaPath) {
  const flightKey = `${creatorId}\n${mediaPath}`;
  const existing = fourBasedMediaInflight.get(flightKey);
  if (existing) return existing;

  const promise = (async () => {
    const fs = require('fs');
    const fsp = require('fs/promises');
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');

    // Re-check cache in case another request finished while we waited for the slot.
    const already = await fourBasedMediaCache.readCachePath(creatorId, mediaPath);
    if (already) return already;

    const { upstream } = await fetchFourBasedMediaWithAuthRetry(creatorId, creator, {
      path: mediaPath,
      rangeHeader: null,
    });
    if (!upstream.ok || !upstream.body) {
      throw new fourBasedClient.FourBasedApiError(
        `Failed to fetch media (${upstream.status || 'no status'})`,
        upstream.status || 502
      );
    }

    const contentType =
      upstream.headers.get('content-type') || 'application/octet-stream';
    const etag = upstream.headers.get('etag') || null;
    const tmpPath = fourBasedMediaCache.tempDownloadPath(creatorId, mediaPath);
    const maxBytes = fourBasedMediaCache.maxBytesForPath(mediaPath);
    let written = 0;

    try {
      const nodeStream = Readable.fromWeb(upstream.body);
      const writeStream = fs.createWriteStream(tmpPath);
      nodeStream.on('data', (chunk) => {
        written += chunk.length;
        if (written > maxBytes) {
          nodeStream.destroy(new Error('Media exceeds cache size limit'));
        }
      });
      await pipeline(nodeStream, writeStream);
      const committed = await fourBasedMediaCache.commitTempFile(
        creatorId,
        mediaPath,
        tmpPath,
        { contentType, etag, size: written }
      );
      if (!committed) {
        throw new Error('Failed to commit media to cache');
      }
      const cached = await fourBasedMediaCache.readCachePath(creatorId, mediaPath);
      if (!cached) {
        throw new Error('Media cache miss after commit');
      }
      return cached;
    } catch (err) {
      void fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }
  })();

  fourBasedMediaInflight.set(flightKey, promise);
  try {
    return await promise;
  } finally {
    fourBasedMediaInflight.delete(flightKey);
  }
}

function fourBasedVaultThumbCandidatePaths(providerUserId, item) {
  const id = item?._id || item?.id;
  if (!id) return [];
  const paths = [];
  const seen = new Set();
  const pushPath = (mediaPath) => {
    if (!mediaPath || typeof mediaPath !== 'string' || seen.has(mediaPath)) return;
    seen.add(mediaPath);
    paths.push(mediaPath);
  };
  const fromPreviewUrl = (url) => {
    if (typeof url !== 'string') return null;
    if (url.includes('/protected/')) {
      const idx = url.indexOf('/protected/');
      return url.slice(idx + 1);
    }
    if (url.startsWith('https://media.4based.com/')) {
      return url.slice('https://media.4based.com/'.length);
    }
    return null;
  };
  const preview = item.preview;
  if (preview && typeof preview === 'object') {
    // Prefer 500x500 (native grid), then smaller fallbacks if that size fails.
    for (const key of [
      '500x500',
      '500x500.jpg',
      '200x200',
      '200x200.jpg',
      '100x100',
      '100x100.jpg',
    ]) {
      pushPath(fromPreviewUrl(preview[key]));
    }
  }
  pushPath(
    fourBasedClient.buildMediaPreviewPath(providerUserId, id, '500x500.jpg')
  );
  pushPath(
    fourBasedClient.buildMediaPreviewPath(providerUserId, id, '200x200.jpg')
  );
  return paths;
}

async function prewarmFourBasedVaultThumbs(creator, creatorId, items) {
  const providerUserId = creator.providerUserId;
  if (!providerUserId || !Array.isArray(items) || items.length === 0) return;

  // Give interactive vault/chat media requests a short head start.
  await sleepMs(150);

  const jobs = items
    .map((item) => fourBasedVaultThumbCandidatePaths(providerUserId, item))
    .filter((candidates) => candidates.length > 0);

  // Keep prewarm quieter than UI clicks so full-image opens win the semaphore.
  const concurrency = 2;
  let index = 0;
  async function worker() {
    while (index < jobs.length) {
      const current = index;
      index += 1;
      const candidates = jobs[current];
      for (const mediaPath of candidates) {
        try {
          const hit = await fourBasedMediaCache.readCachePath(creatorId, mediaPath);
          if (hit) break;
          await downloadFourBasedMediaToCache(creator, creatorId, mediaPath);
          break;
        } catch (err) {
          console.warn(
            '4based vault thumb prewarm failed:',
            mediaPath,
            err?.message || err
          );
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker())
  );
}

router.post(
  '/:id/4based/reconnect',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    const { email, password, proxyUrl } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!password || typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Password is required' });
    }

    let resolvedProxy;
    try {
      resolvedProxy = fourBasedClient.resolveFourBasedProxyUrl(proxyUrl);
    } catch (err) {
      if (err instanceof fourBasedClient.FourBasedApiError) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      throw err;
    }

    try {
      const result = await pool.query(
        `SELECT id, platform, "accountId", "displayName"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (result.rows[0].platform !== '4based') {
        return res.status(400).json({ error: 'Creator is not a 4based account' });
      }

      let loginResult;
      try {
        loginResult = await fourBasedClient.login({
          identifier: email.trim(),
          password,
          proxyUrl: resolvedProxy,
        });
      } catch (err) {
        if (err instanceof fourBasedClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
          return res.status(400).json({ error: 'Password not correct' });
        }
        if (err instanceof fourBasedClient.FourBasedApiError) {
          return res
            .status(err.status >= 400 && err.status < 600 ? err.status : 502)
            .json({ error: err.message || '4based login failed' });
        }
        throw err;
      }

      const loginEmail = email.trim();
      const sessionPayload = {
        cookies: loginResult.cookies,
        token: loginResult.token,
        resource: loginResult.resource,
        providerUserId: loginResult.providerUserId,
        loginEmail,
        savedAt: new Date().toISOString(),
        platform: '4based',
      };
      const encryptedSession = encryptJson(sessionPayload);
      const encryptedAccessToken = encryptSecret(loginResult.token);
      const encryptedProxy = encryptSecret(resolvedProxy);
      const encryptedLoginPassword = encryptOptionalLoginPassword(password);

      const updated = await pool.query(
        `UPDATE creators SET
           "encryptedSession" = $1,
           "encryptedAccessToken" = $2,
           "encryptedProxy" = $3,
           "providerUserId" = $4,
           "loginEmail" = $5,
           "encryptedLoginPassword" = COALESCE($6, "encryptedLoginPassword"),
           username = COALESCE($7, username),
           "avatarUrl" = COALESCE($8, "avatarUrl"),
           "postLoginUrl" = $9,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "updatedAt" = NOW()
         WHERE id = $10
         RETURNING id, "displayName", username, platform, "connectionStatus",
                   "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
                   "loginEmail", "lastValidatedAt", "authRefreshState", "accessTokenExpiresAt",
                   "createdAt", "updatedAt"`,
        [
          encryptedSession,
          encryptedAccessToken,
          encryptedProxy,
          loginResult.providerUserId,
          loginEmail,
          encryptedLoginPassword ?? null,
          loginResult.username,
          loginResult.avatarUrl,
          loginResult.postLoginUrl,
          id,
        ]
      );

      void connectCreatorById(id).catch((err) => {
        console.warn('[4based] Failed to reopen socket after reconnect:', err.message);
      });

      const accessUserIds = await getUserIdsWithCreatorAccess(id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: id,
        accountId: updated.rows[0].accountId,
        sessionUpdatedAt: sessionPayload.savedAt,
      });

      res.json({ creator: toCreator(updated.rows[0]) });
    } catch (err) {
      console.error('Reconnect 4based creator error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/4based/reconnect-saved',
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
        `SELECT id, platform, "accountId", "displayName", "loginEmail",
                "encryptedLoginPassword", "encryptedProxy"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      const row = result.rows[0];
      if (row.platform !== '4based') {
        return res.status(400).json({ error: 'Creator is not a 4based account' });
      }
      if (!row.loginEmail || !row.encryptedLoginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      const loginPassword = decryptSecret(row.encryptedLoginPassword);
      if (!loginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      const storedProxy = row.encryptedProxy ? decryptSecret(row.encryptedProxy) : null;
      let resolvedProxy;
      try {
        resolvedProxy = fourBasedClient.resolveFourBasedProxyUrl(storedProxy);
      } catch (err) {
        if (err instanceof fourBasedClient.FourBasedApiError) {
          return res.status(err.status || 400).json({ error: err.message });
        }
        throw err;
      }

      let loginResult;
      try {
        loginResult = await fourBasedClient.login({
          identifier: row.loginEmail.trim(),
          password: loginPassword,
          proxyUrl: resolvedProxy,
        });
      } catch (err) {
        if (err instanceof fourBasedClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
          return res.status(400).json({ error: 'Password not correct' });
        }
        if (err instanceof fourBasedClient.FourBasedApiError) {
          return res
            .status(err.status >= 400 && err.status < 600 ? err.status : 502)
            .json({ error: err.message || '4based login failed' });
        }
        throw err;
      }

      const loginEmail = row.loginEmail.trim();
      const sessionPayload = {
        cookies: loginResult.cookies,
        token: loginResult.token,
        resource: loginResult.resource,
        providerUserId: loginResult.providerUserId,
        loginEmail,
        savedAt: new Date().toISOString(),
        platform: '4based',
      };
      const encryptedSession = encryptJson(sessionPayload);
      const encryptedAccessToken = encryptSecret(loginResult.token);
      const encryptedProxy = encryptSecret(resolvedProxy);

      const updated = await pool.query(
        `UPDATE creators SET
           "encryptedSession" = $1,
           "encryptedAccessToken" = $2,
           "encryptedProxy" = $3,
           "providerUserId" = $4,
           "loginEmail" = $5,
           username = COALESCE($6, username),
           "avatarUrl" = COALESCE($7, "avatarUrl"),
           "postLoginUrl" = $8,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "updatedAt" = NOW()
         WHERE id = $9
         RETURNING id, "displayName", username, platform, "connectionStatus",
                   "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
                   "loginEmail", "encryptedLoginPassword", "lastValidatedAt", "authRefreshState",
                   "accessTokenExpiresAt", "createdAt", "updatedAt"`,
        [
          encryptedSession,
          encryptedAccessToken,
          encryptedProxy,
          loginResult.providerUserId,
          loginEmail,
          loginResult.username,
          loginResult.avatarUrl,
          loginResult.postLoginUrl,
          id,
        ]
      );

      void connectCreatorById(id).catch((err) => {
        console.warn('[4based] Failed to reopen socket after reconnect-saved:', err.message);
      });

      const accessUserIds = await getUserIdsWithCreatorAccess(id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: id,
        accountId: updated.rows[0].accountId,
        sessionUpdatedAt: sessionPayload.savedAt,
      });

      res.json({ creator: toCreator(updated.rows[0]) });
    } catch (err) {
      console.error('Reconnect-saved 4based creator error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/reconnect',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    const { email, password, proxyUrl } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!password || typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Password is required' });
    }

    let resolvedProxy;
    try {
      resolvedProxy = maloumClient.resolveMaloumProxyUrl(proxyUrl);
    } catch (err) {
      if (err instanceof maloumClient.MaloumApiError) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      throw err;
    }

    try {
      const result = await pool.query(
        `SELECT id, platform, "accountId", "displayName", "avatarUrl", "avatarSource"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (result.rows[0].platform !== 'maloum') {
        return res.status(400).json({ error: 'Creator is not a Maloum account' });
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
      const encryptedProxy = encryptSecret(resolvedProxy);
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
           "encryptedProxy" = $5,
           "providerUserId" = $6,
           "loginEmail" = $7,
           "encryptedLoginPassword" = COALESCE($8, "encryptedLoginPassword"),
           username = COALESCE($9, username),
           "avatarUrl" = COALESCE($10, "avatarUrl"),
           "avatarSource" = COALESCE($11, "avatarSource"),
           "postLoginUrl" = $12,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "tokenRefreshFailureCount" = 0,
           "updatedAt" = NOW()
         WHERE id = $13
         RETURNING id, "displayName", username, platform, "connectionStatus",
                   "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
                   "loginEmail", "lastValidatedAt", "authRefreshState", "accessTokenExpiresAt",
                   "createdAt", "updatedAt"`,
        [
          encryptedSession,
          tokenFields?.encryptedAccessToken ?? null,
          tokenFields?.encryptedRefreshToken ?? null,
          tokenFields?.accessTokenExpiresAt ?? null,
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
                "loginEmail", "encryptedLoginPassword", "encryptedProxy"
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
      const encryptedProxy = encryptSecret(resolvedProxy);

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
           "encryptedProxy" = $5,
           "providerUserId" = $6,
           "loginEmail" = $7,
           username = COALESCE($8, username),
           "avatarUrl" = COALESCE($9, "avatarUrl"),
           "avatarSource" = COALESCE($10, "avatarSource"),
           "postLoginUrl" = $11,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "tokenRefreshFailureCount" = 0,
           "updatedAt" = NOW()
         WHERE id = $12
         RETURNING id, "displayName", username, platform, "connectionStatus",
                   "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
                   "loginEmail", "encryptedLoginPassword", "lastValidatedAt", "authRefreshState",
                   "accessTokenExpiresAt", "createdAt", "updatedAt"`,
        [
          encryptedSession,
          tokenFields?.encryptedAccessToken ?? null,
          tokenFields?.encryptedRefreshToken ?? null,
          tokenFields?.accessTokenExpiresAt ?? null,
          encryptedProxy,
          loginResult.providerUserId,
          loginEmail,
          loginResult.username,
          nextAvatarUrl,
          nextAvatarSource,
          loginResult.postLoginUrl,
          id,
        ]
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

router.get(
  '/:id/4based/chats',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 30, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const filterRaw =
        typeof req.query.filter === 'string' ? req.query.filter.trim() : '';
      const listId =
        typeof req.query.listId === 'string' && req.query.listId.trim()
          ? req.query.listId.trim()
          : undefined;
      const listName =
        filterRaw && fourBasedClient.BUILTIN_CHAT_FILTERS.has(filterRaw)
          ? filterRaw
          : undefined;
      if (filterRaw && !listName && !listId) {
        return res.status(400).json({
          error:
            'Invalid filter. Use online, unread, read, follower, subscribers, or listId.',
        });
      }
      const chats = await fourBasedClient.listChats(loaded.creator, {
        limit,
        offset,
        listName,
        userListId: listId,
      });
      res.json({
        chats: Array.isArray(chats) ? chats : chats?.items || chats || [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based chats error:');
    }
  }
);

router.post(
  '/:id/4based/chats/:chatId/pin',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const isPinned =
        req.body?.isPinned === true ||
        req.body?.is_pinned === true ||
        req.body?.isPinned === 'true';
      const result = await fourBasedClient.pinChat(loaded.creator, chatId, isPinned);
      res.json({
        ok: true,
        isPinned,
        result: result || null,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Pin 4based chat error:');
    }
  }
);

router.get(
  '/:id/4based/user-lists',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const lists = await fourBasedClient.listUserLists(loaded.creator, {
        limit,
        offset,
      });
      res.json({ lists: Array.isArray(lists) ? lists : [] });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based user lists error:');
    }
  }
);

router.get(
  '/:id/4based/user-lists/contains/:fanId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const result = await fourBasedClient.getUserListsForFan(loaded.creator, fanId);
      res.json(result);
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based fan lists error:');
    }
  }
);

router.post(
  '/:id/4based/user-lists/:listId/add',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, listId } = req.params;
    const fanId = req.body?.fanId;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!listId || !fanId || typeof fanId !== 'string') {
      return res.status(400).json({ error: 'listId and fanId are required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const result = await fourBasedClient.addUserToList(
        loaded.creator,
        listId,
        fanId
      );
      res.json({ ok: true, result: result || null });
    } catch (err) {
      return handleFourBasedError(res, err, 'Add 4based fan to list error:');
    }
  }
);

router.post(
  '/:id/4based/user-lists/:listId/remove',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, listId } = req.params;
    const fanId = req.body?.fanId;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!listId || !fanId || typeof fanId !== 'string') {
      return res.status(400).json({ error: 'listId and fanId are required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const result = await fourBasedClient.removeUserFromList(
        loaded.creator,
        listId,
        fanId
      );
      res.json({ ok: true, result: result || null });
    } catch (err) {
      return handleFourBasedError(res, err, 'Remove 4based fan from list error:');
    }
  }
);

router.get(
  '/:id/4based/pivot/:fanId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const pivot = await fourBasedClient.getPivot(loaded.creator, fanId);
      res.json({
        pivot: pivot || null,
        alias: typeof pivot?.alias === 'string' ? pivot.alias : '',
        note: typeof pivot?.note === 'string' ? pivot.note : '',
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based pivot error:');
    }
  }
);

router.put(
  '/:id/4based/pivot/:fanId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const patch = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'alias')) {
        patch.alias = req.body.alias;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) {
        patch.note = req.body.note;
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'alias or note is required' });
      }

      const pivot = await fourBasedClient.updatePivot(loaded.creator, fanId, patch);
      res.json({
        pivot: pivot || null,
        alias: typeof pivot?.alias === 'string' ? pivot.alias : '',
        note: typeof pivot?.note === 'string' ? pivot.note : '',
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Update 4based pivot error:');
    }
  }
);

router.delete(
  '/:id/4based/pivot/:fanId/:field',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId, field } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }
    if (field !== 'alias' && field !== 'note') {
      return res.status(400).json({ error: 'field must be alias or note' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      await fourBasedClient.deletePivotField(loaded.creator, fanId, field);
      // Also clear via PUT so subsequent GET is consistent (HAR does both).
      await fourBasedClient.updatePivot(
        loaded.creator,
        fanId,
        field === 'alias' ? { alias: '' } : { note: '' }
      );
      const pivot = await fourBasedClient.getPivot(loaded.creator, fanId);
      res.json({
        ok: true,
        pivot: pivot || null,
        alias: typeof pivot?.alias === 'string' ? pivot.alias : '',
        note: typeof pivot?.note === 'string' ? pivot.note : '',
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Delete 4based pivot field error:');
    }
  }
);

router.get(
  '/:id/4based/unread',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const unread = await fourBasedClient.getUnread(loaded.creator);
      res.json({ unread });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based unread error:');
    }
  }
);

router.get(
  '/:id/4based/badges',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const [badges, saleTipActivities] = await Promise.all([
        fourBasedClient.getBadges(loaded.creator),
        fourBasedClient
          .listActivities(loaded.creator, {
            offset: 0,
            limit: 15,
            types: 'sale,tip',
          })
          .catch((err) => {
            console.warn(
              '4based badge sale/tip fetch failed:',
              err.message || err
            );
            return [];
          }),
      ]);

      try {
        await messagingDashboard.processFourBasedSaleAndTipNotifications(
          id,
          Array.isArray(saleTipActivities) ? saleTipActivities : []
        );
      } catch (err) {
        console.warn('4based sale/tip sync failed:', err.message);
      }

      res.json(badges);
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based badges error:');
    }
  }
);

router.get(
  '/:id/4based/activities',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const types =
        typeof req.query.types === 'string' && req.query.types.trim()
          ? req.query.types.trim()
          : undefined;

      const payload = await fourBasedClient.listActivities(loaded.creator, {
        offset,
        limit,
        types,
      });
      const activities = Array.isArray(payload) ? payload : [];

      try {
        await messagingDashboard.processFourBasedSaleAndTipNotifications(id, activities);
      } catch (err) {
        console.warn('4based sale/tip sync failed:', err.message);
      }

      res.json({
        activities,
        offset,
        limit,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based activities error:');
    }
  }
);

router.post(
  '/:id/4based/activities/reset',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      await fourBasedClient.resetActivities(loaded.creator);
      res.json({ ok: true });
    } catch (err) {
      return handleFourBasedError(res, err, 'Reset 4based activities error:');
    }
  }
);

router.get(
  '/:id/4based/chats/:chatId',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const chat = await fourBasedClient.getChat(loaded.creator, chatId);
      try {
        await fourBasedClient.markReceived(loaded.creator, chatId);
      } catch (err) {
        console.warn('markReceived failed:', err.message);
      }

      res.json({ chat, providerUserId: loaded.creator.providerUserId });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based chat error:');
    }
  }
);

router.get(
  '/:id/4based/chats/:chatId/messages',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const messages = await fourBasedClient.getMessages(loaded.creator, chatId, {
        limit,
        offset,
      });
      res.json({
        messages: Array.isArray(messages) ? messages : messages?.items || messages || [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based messages error:');
    }
  }
);

router.post(
  '/:id/4based/chats/:chatId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    const {
      message,
      fileStackId,
      vaultId,
      vaultGuid,
      vaults,
      priceCoins,
      localId,
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const text = typeof message === 'string' ? message : '';
      const resolvedLocalId =
        typeof localId === 'string' && localId.trim() ? localId.trim() : randomUUID();

      const hasVaults = Array.isArray(vaults) && vaults.length > 0;

      // PPV / priced vault send (single or multi)
      if (vaultId || hasVaults) {
        const result = await fourBasedClient.sendPpv(loaded.creator, chatId, {
          message: text,
          vaultId,
          vaultGuid,
          vaults: hasVaults ? vaults : undefined,
          priceCoins: Number(priceCoins) || 0,
          localId: resolvedLocalId,
        });
        return res.status(201).json({
          message: result.message,
          fileStack: result.fileStack,
          localId: resolvedLocalId,
        });
      }

      // Free media (existing file stack) or plain text
      if (fileStackId) {
        const sent = await fourBasedClient.sendMessage(loaded.creator, chatId, {
          message: text,
          fileStackId,
          localId: resolvedLocalId,
        });
        return res.status(201).json({ message: sent, localId: resolvedLocalId });
      }

      if (!text.trim()) {
        return res.status(400).json({ error: 'Message text is required' });
      }

      const sent = await fourBasedClient.sendText(loaded.creator, chatId, {
        message: text,
        localId: resolvedLocalId,
      });
      return res.status(201).json({ message: sent, localId: resolvedLocalId });
    } catch (err) {
      return handleFourBasedError(res, err, 'Send 4based message error:');
    }
  }
);

router.delete(
  '/:id/4based/chats/:chatId/messages/:messageId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId, messageId } = req.params;

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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const message = await fourBasedClient.deleteMessage(
        loaded.creator,
        chatId,
        messageId
      );
      return res.json({ ok: true, message });
    } catch (err) {
      return handleFourBasedError(res, err, 'Delete 4based message error:');
    }
  }
);

router.get(
  '/:id/4based/profile',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const profile = await fourBasedClient.getUser(
        loaded.creator,
        loaded.creator.providerUserId
      );
      res.json({
        profile,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based profile error:');
    }
  }
);

router.get(
  '/:id/4based/users/:userId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, userId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const user = await fourBasedClient.getUser(loaded.creator, userId);
      res.json({
        user,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based user error:');
    }
  }
);

router.get(
  '/:id/4based/vault',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    const fanId =
      typeof req.query.fanId === 'string' && req.query.fanId.trim()
        ? req.query.fanId.trim()
        : undefined;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 60, 120);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const folder =
        typeof req.query.folder === 'string' && req.query.folder.trim()
          ? req.query.folder.trim()
          : undefined;
      const fileType =
        req.query.fileType === 'image' || req.query.fileType === 'video'
          ? req.query.fileType
          : undefined;
      let sold;
      if (req.query.sold === 'true') sold = true;
      else if (req.query.sold === 'false') sold = false;
      let sent;
      if (req.query.sent === 'true') sent = true;
      else if (req.query.sent === 'false') sent = false;
      let lastPublished;
      if (req.query.lastPublished === 'true') lastPublished = true;
      else if (req.query.lastPublished === 'false') lastPublished = false;

      if ((sold !== undefined || sent !== undefined) && !fanId) {
        return res.status(400).json({
          error: 'fanId query parameter is required when using sold or sent filters',
        });
      }

      const vault = await fourBasedClient.listVault(loaded.creator, {
        fanId,
        limit,
        offset,
        folder,
        fileType,
        sold,
        sent,
        lastPublished,
      });
      const items = Array.isArray(vault) ? vault : vault?.items || vault || [];
      res.json({
        items,
        providerUserId: loaded.creator.providerUserId,
      });
      // Prewarm thumbnails in background so the grid hits disk cache.
      void prewarmFourBasedVaultThumbs(loaded.creator, id, items).catch((err) => {
        console.warn('4based vault prewarm error:', err?.message || err);
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based vault error:');
    }
  }
);

router.get(
  '/:id/4based/mass-messages',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const tab = req.query.tab === 'unsent' ? 'unsent' : 'sent';
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const messages = await fourBasedClient.listMassMessages(loaded.creator, {
        tab,
        limit,
        offset,
      });
      res.json({
        messages: Array.isArray(messages) ? messages : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based mass messages error:');
    }
  }
);

router.post(
  '/:id/4based/mass-messages/receivers/count',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const {
        filter,
        includeUserList,
        excludeUserList,
        excludeFilter,
        include_user_list,
        exclude_user_list,
        exclude_filter,
      } = req.body || {};

      const result = await fourBasedClient.countMassMessageReceivers(loaded.creator, {
        filter,
        includeUserList: includeUserList || include_user_list,
        excludeUserList: excludeUserList || exclude_user_list,
        excludeFilter: excludeFilter || exclude_filter,
      });
      res.json(result);
    } catch (err) {
      return handleFourBasedError(res, err, 'Count 4based mass message receivers error:');
    }
  }
);

router.post(
  '/:id/4based/mass-messages',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const {
        message,
        text,
        includeUserList,
        excludeUserList,
        excludeFilter,
        include_user_list,
        exclude_user_list,
        exclude_filter,
        filter,
        vaults,
        vaultId,
        vaultGuid,
        priceCoins,
        price,
        fileStackId,
        file_stack_id,
      } = req.body || {};

      const bodyText =
        typeof message === 'string' ? message : typeof text === 'string' ? text : '';
      const includeLists = Array.isArray(includeUserList)
        ? includeUserList
        : Array.isArray(include_user_list)
          ? include_user_list
          : [];
      const excludeLists = Array.isArray(excludeUserList)
        ? excludeUserList
        : Array.isArray(exclude_user_list)
          ? exclude_user_list
          : [];

      let resolvedFileStackId =
        typeof fileStackId === 'string' && fileStackId.trim()
          ? fileStackId.trim()
          : typeof file_stack_id === 'string' && file_stack_id.trim()
            ? file_stack_id.trim()
            : null;

      const hasVaults = Array.isArray(vaults) && vaults.length > 0;
      const hasVaultId = typeof vaultId === 'string' && vaultId.trim();
      if (!resolvedFileStackId && (hasVaults || hasVaultId)) {
        const coins =
          priceCoins !== undefined && priceCoins !== null
            ? Number(priceCoins)
            : Number(price) || 0;
        const fileStack = await fourBasedClient.createFileStackFromVault(loaded.creator, {
          vaultId: hasVaultId ? vaultId.trim() : undefined,
          vaultGuid: typeof vaultGuid === 'string' ? vaultGuid : undefined,
          vaults: hasVaults ? vaults : undefined,
          description: bodyText,
          priceCoins: Number.isFinite(coins) ? coins : 0,
        });
        resolvedFileStackId = fileStack?._id || null;
        if (!resolvedFileStackId) {
          return res.status(502).json({ error: 'Failed to create file stack for mass message' });
        }
      }

      if (!bodyText.trim() && !resolvedFileStackId) {
        return res.status(400).json({ error: 'message or media is required' });
      }

      const created = await fourBasedClient.sendMassMessage(loaded.creator, {
        message: bodyText,
        includeUserList: includeLists,
        excludeUserList: excludeLists,
        excludeFilter: excludeFilter || exclude_filter,
        filter,
        fileStackId: resolvedFileStackId,
      });

      return res.status(201).json({
        message: created,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Send 4based mass message error:');
    }
  }
);

router.delete(
  '/:id/4based/mass-messages/:massMessageId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, massMessageId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!massMessageId) {
      return res.status(400).json({ error: 'massMessageId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const result = await fourBasedClient.deleteMassMessage(loaded.creator, massMessageId);
      res.json({ ok: true, id: result?.id || massMessageId });
    } catch (err) {
      return handleFourBasedError(res, err, 'Delete 4based mass message error:');
    }
  }
);

router.get(
  '/:id/4based/coin-packages',
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

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const packages = await fourBasedClient.getCoinPackages(loaded.creator);
      res.json({
        packages: Array.isArray(packages) ? packages : packages?.items || packages || [],
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based coin packages error:');
    }
  }
);

router.get(
  '/:id/4based/media',
  async (req, res, next) => {
    // <img>/<video> cannot send Authorization headers; allow ?access_token=
    if (!req.headers.authorization && typeof req.query.access_token === 'string') {
      req.headers.authorization = `Bearer ${req.query.access_token}`;
    }
    return authenticate(req, res, next);
  },
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    const mediaPath = req.query.path;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!mediaPath || typeof mediaPath !== 'string') {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const rangeHeader = req.headers.range || null;
      const cacheable = fourBasedMediaCache.isCacheablePath(mediaPath);

      // Cacheable paths (thumbs, full previews, videos): serve from disk,
      // including Range/206. On miss, download the full file once (single-flight)
      // through the residential proxy, then serve from disk.
      if (cacheable) {
        let cached = await fourBasedMediaCache.readCachePath(id, mediaPath);
        let cacheStatus = 'HIT';
        if (!cached) {
          cached = await downloadFourBasedMediaToCache(
            loaded.creator,
            id,
            mediaPath
          );
          cacheStatus = 'MISS';
        }
        return sendFourBasedCachedFile(res, cached, rangeHeader, cacheStatus);
      }

      // Non-cacheable paths: stream through with optional Range.
      const { upstream } = await fetchFourBasedMediaWithAuthRetry(
        id,
        loaded.creator,
        {
          path: mediaPath,
          rangeHeader,
        }
      );
      if (!upstream.ok && upstream.status !== 206) {
        return res
          .status(upstream.status || 502)
          .json({
            error:
              upstream.status === 401
                ? 'Failed to fetch media (401). Reconnect the 4based account or check media_jwt cookies.'
                : 'Failed to fetch media',
          });
      }

      const passthrough = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
      ];
      for (const header of passthrough) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-DomX-Media-Cache', 'BYPASS');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.status(upstream.status);
      if (!upstream.body) return res.end();

      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', (err) => {
        console.warn('4based media stream error:', err.message);
        if (!res.headersSent) res.status(502).end();
        else res.destroy(err);
      });
      nodeStream.pipe(res);
    } catch (err) {
      return handleFourBasedError(res, err, 'Proxy 4based media error:');
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

/** Never forward Maloum/platform 401 as HTTP 401 — that clears the DomX staff JWT. */
function maloumClientHttpStatus(err) {
  const status = err?.status >= 400 && err.status < 600 ? err.status : 502;
  return status === 401 ? 502 : status;
}

function maloumClientHttpMessage(err, fallback = 'Maloum request failed') {
  if (err?.status === 401) {
    return 'Maloum session expired. Reconnect this creator.';
  }
  return err?.message || fallback;
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

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 100);
      const next = typeof req.query.next === 'string' ? req.query.next : undefined;
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
      const filter = filterRaw || undefined;
      const lastMessageSender = lastMessageSenderRaw || undefined;
      const chats = await maloumClient.listChats(loaded.creator, {
        limit,
        next,
        filter,
        lastMessageSender,
      });
      res.json({
        next: chats?.next ?? null,
        chats: Array.isArray(chats?.data) ? chats.data : Array.isArray(chats) ? chats : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'List Maloum chats error:');
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

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const unread = await maloumClient.getUnreadCount(loaded.creator);
      res.json({ unread: typeof unread === 'number' ? unread : Number(unread) || 0 });
    } catch (err) {
      return handleMaloumError(res, err, 'Get Maloum unread count error:');
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

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const [messagesUnread, notificationsUnread, notificationsPayload] = await Promise.all([
        maloumClient.getUnreadCount(loaded.creator),
        maloumClient.getNotificationsUnreadCount(loaded.creator),
        maloumClient.listNotifications(loaded.creator, { limit: 15 }),
      ]);

      const notifications = maloumClient.normalizeListData(notificationsPayload);

      try {
        await messagingDashboard.processMaloumSaleAndTipNotifications(id, notifications);
      } catch (err) {
        console.warn('Maloum sale/tip sync failed:', err.message);
      }

      const toCount = (value) =>
        typeof value === 'number' ? value : Number(value) || 0;

      res.json({
        messages: toCount(messagesUnread),
        notifications: toCount(notificationsUnread),
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Get Maloum badges error:');
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

      const loaded = await loadMaloumCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 15, 100);
      const next = typeof req.query.next === 'string' ? req.query.next : undefined;
      const messages = await maloumClient.getMessages(loaded.creator, chatId, {
        limit,
        next,
      });
      res.json({
        next: messages?.next ?? null,
        messages: Array.isArray(messages?.data)
          ? messages.data
          : Array.isArray(messages)
            ? messages
            : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Get Maloum messages error:');
    }
  }
);

router.post(
  '/:id/maloum/chats/:chatId/messages/:messageId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId, messageId } = req.params;
    const { deleteTextOnly } = req.body || {};

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

      await maloumClient.deleteMessage(loaded.creator, chatId, messageId, {
        deleteTextOnly: Boolean(deleteTextOnly),
      });
      return res.json({ ok: true });
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
      const resolvedOptimisticId =
        typeof optimisticMessageId === 'string' && optimisticMessageId.trim()
          ? optimisticMessageId.trim()
          : randomUUID();

      if (Array.isArray(media) && media.length > 0) {
        const net = Number(priceNet) || 0;
        const messageId = await maloumClient.sendMedia(loaded.creator, chatId, {
          media,
          text: bodyText,
          priceNet: net,
          optimisticMessageId: resolvedOptimisticId,
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
    const { name } = req.body || {};
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

      const list = await maloumClient.createChatList(loaded.creator, name);
      return res.status(201).json({
        list,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleMaloumError(res, err, 'Create Maloum chat list error:');
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

      await maloumClient.setMemberChatLists(
        loaded.creator,
        memberId,
        Array.isArray(chatListIds) ? chatListIds : []
      );
      const lists = await maloumClient.getMemberChatLists(loaded.creator, memberId);
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

      await maloumClient.updateFanNickname(loaded.creator, chatId, nickname);
      const chat = await maloumClient.getChat(loaded.creator, chatId);
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

      await maloumClient.updateFanNotes(loaded.creator, chatId, notes);
      const chat = await maloumClient.getChat(loaded.creator, chatId);
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
        nodeStream.on('data', (chunk) => chunks.push(chunk));
        nodeStream.on('error', (err) => {
          console.warn('Maloum media stream error:', err.message);
          if (!res.headersSent) {
            res.status(502).end();
          } else {
            res.destroy(err);
          }
        });
        nodeStream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (!res.headersSent) {
            res.setHeader('Content-Length', String(buffer.length));
          }
          res.end(buffer);
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

const VAULT_NOTE_PLATFORMS = new Set(['maloum', '4based']);
const VAULT_NOTE_MAX_LENGTH = 2000;
const VAULT_NOTE_BATCH_MAX = 200;

function normalizeVaultNotePlatform(value) {
  return typeof value === 'string' && VAULT_NOTE_PLATFORMS.has(value) ? value : null;
}

function normalizeVaultMediaKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key.length > 0 && key.length <= 256 ? key : null;
}

router.get(
  '/:id/vault-notes',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const platform = normalizeVaultNotePlatform(req.query.platform);
    if (!platform) {
      return res.status(400).json({ error: 'platform must be maloum or 4based' });
    }

    const rawKeys =
      typeof req.query.keys === 'string'
        ? req.query.keys.split(',')
        : Array.isArray(req.query.keys)
          ? req.query.keys
          : [];
    const keys = [
      ...new Set(
        rawKeys
          .map((k) => (typeof k === 'string' ? k.trim() : ''))
          .filter((k) => k.length > 0 && k.length <= 256)
      ),
    ].slice(0, VAULT_NOTE_BATCH_MAX);

    if (keys.length === 0) {
      return res.json({ notes: {} });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const result = await pool.query(
        `SELECT "mediaKey", note
         FROM vault_media_notes
         WHERE "creatorId" = $1 AND platform = $2 AND "mediaKey" = ANY($3::text[])`,
        [id, platform, keys]
      );

      const notes = {};
      for (const row of result.rows) {
        notes[row.mediaKey] = row.note || '';
      }
      return res.json({ notes });
    } catch (err) {
      console.error('List vault media notes error:', err);
      return res.status(500).json({ error: 'Failed to load vault notes' });
    }
  }
);

router.get(
  '/:id/vault-notes/:platform/:mediaKey',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, platform: platformParam, mediaKey: mediaKeyParam } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const platform = normalizeVaultNotePlatform(platformParam);
    const mediaKey = normalizeVaultMediaKey(
      typeof mediaKeyParam === 'string' ? decodeURIComponent(mediaKeyParam) : ''
    );
    if (!platform) {
      return res.status(400).json({ error: 'platform must be maloum or 4based' });
    }
    if (!mediaKey) {
      return res.status(400).json({ error: 'Invalid media key' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const result = await pool.query(
        `SELECT "mediaKey", note, "updatedAt"
         FROM vault_media_notes
         WHERE "creatorId" = $1 AND platform = $2 AND "mediaKey" = $3`,
        [id, platform, mediaKey]
      );

      if (result.rows.length === 0) {
        return res.json({ mediaKey, note: '', updatedAt: null });
      }

      const row = result.rows[0];
      return res.json({
        mediaKey: row.mediaKey,
        note: row.note || '',
        updatedAt: row.updatedAt,
      });
    } catch (err) {
      console.error('Get vault media note error:', err);
      return res.status(500).json({ error: 'Failed to load vault note' });
    }
  }
);

router.put(
  '/:id/vault-notes/:platform/:mediaKey',
  authenticate,
  requirePermission('vault.notes.edit'),
  async (req, res) => {
    const { id, platform: platformParam, mediaKey: mediaKeyParam } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const platform = normalizeVaultNotePlatform(platformParam);
    const mediaKey = normalizeVaultMediaKey(
      typeof mediaKeyParam === 'string' ? decodeURIComponent(mediaKeyParam) : ''
    );
    if (!platform) {
      return res.status(400).json({ error: 'platform must be maloum or 4based' });
    }
    if (!mediaKey) {
      return res.status(400).json({ error: 'Invalid media key' });
    }

    const rawNote = req.body?.note;
    if (typeof rawNote !== 'string') {
      return res.status(400).json({ error: 'note must be a string' });
    }
    const note = rawNote.trim();
    if (note.length > VAULT_NOTE_MAX_LENGTH) {
      return res.status(400).json({
        error: `note must be at most ${VAULT_NOTE_MAX_LENGTH} characters`,
      });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const result = await pool.query(
        `INSERT INTO vault_media_notes (id, "creatorId", platform, "mediaKey", note, "updatedBy", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT ("creatorId", platform, "mediaKey")
         DO UPDATE SET
           note = EXCLUDED.note,
           "updatedBy" = EXCLUDED."updatedBy",
           "updatedAt" = NOW()
         RETURNING "mediaKey", note, "updatedAt"`,
        [randomUUID(), id, platform, mediaKey, note, req.user.id]
      );

      const row = result.rows[0];
      return res.json({
        mediaKey: row.mediaKey,
        note: row.note || '',
        updatedAt: row.updatedAt,
      });
    } catch (err) {
      console.error('Upsert vault media note error:', err);
      return res.status(500).json({ error: 'Failed to save vault note' });
    }
  }
);

// --- Creator chat scripts ---

const SCRIPT_TITLE_MAX = 200;
const SCRIPT_SHORTCUT_MAX = 64;
const SCRIPT_MESSAGE_MAX = 10000;
const SCRIPT_MEDIA_MAX = 50;
const SCRIPT_FOLDER_NAME_MAX = 120;

function normalizeScriptPlatform(value) {
  return normalizeVaultNotePlatform(value);
}

function normalizeShortcutCode(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const code = value.trim();
  if (!code) return null;
  if (code.length > SCRIPT_SHORTCUT_MAX) return undefined;
  return code;
}

function normalizeScriptMedia(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > SCRIPT_MEDIA_MAX) return null;
  const media = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const mediaKey = normalizeVaultMediaKey(item.mediaKey);
    if (!mediaKey) return null;
    const entry = { mediaKey };
    if (typeof item.type === 'string' && item.type.trim()) {
      entry.type = item.type.trim().slice(0, 64);
    }
    if (typeof item.previewUrl === 'string' && item.previewUrl.trim()) {
      entry.previewUrl = item.previewUrl.trim().slice(0, 2048);
    }
    if (typeof item.width === 'number' && Number.isFinite(item.width)) {
      entry.width = Math.round(item.width);
    }
    if (typeof item.height === 'number' && Number.isFinite(item.height)) {
      entry.height = Math.round(item.height);
    }
    if (typeof item.guid === 'string' && item.guid.trim()) {
      entry.guid = item.guid.trim().slice(0, 256);
    }
    media.push(entry);
  }
  return media;
}

function mapScriptFolderRow(row) {
  return {
    id: row.id,
    creatorId: row.creatorId,
    platform: row.platform,
    name: row.name || '',
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapScriptRow(row, sentFanIds) {
  const media = Array.isArray(row.media) ? row.media : [];
  const script = {
    id: row.id,
    creatorId: row.creatorId,
    platform: row.platform,
    folderId: row.folderId || null,
    title: row.title || '',
    shortcutCode: row.shortcutCode || null,
    messageText: row.messageText || '',
    price: Number(row.price) || 0,
    media,
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (sentFanIds) {
    script.sentToFan = sentFanIds.has(row.id);
  }
  return script;
}

router.get(
  '/:id/scripts',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const platform = normalizeScriptPlatform(req.query.platform);
    if (!platform) {
      return res.status(400).json({ error: 'platform must be maloum or 4based' });
    }

    const fanId =
      typeof req.query.fanId === 'string' && req.query.fanId.trim()
        ? req.query.fanId.trim().slice(0, 256)
        : null;

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const [foldersResult, scriptsResult] = await Promise.all([
        pool.query(
          `SELECT id, "creatorId", platform, name, "sortOrder", "createdAt", "updatedAt"
           FROM creator_script_folders
           WHERE "creatorId" = $1 AND platform = $2
           ORDER BY "sortOrder" ASC, name ASC, "createdAt" ASC`,
          [id, platform]
        ),
        pool.query(
          `SELECT id, "creatorId", platform, "folderId", title, "shortcutCode", "messageText",
                  price, media, "sortOrder", "createdAt", "updatedAt"
           FROM creator_scripts
           WHERE "creatorId" = $1 AND platform = $2
           ORDER BY "sortOrder" ASC, title ASC, "createdAt" ASC`,
          [id, platform]
        ),
      ]);

      let sentFanIds = null;
      if (fanId && scriptsResult.rows.length > 0) {
        const scriptIds = scriptsResult.rows.map((r) => r.id);
        const sentResult = await pool.query(
          `SELECT "scriptId"
           FROM creator_script_sends
           WHERE "creatorId" = $1 AND platform = $2 AND "fanId" = $3
             AND "scriptId" = ANY($4::uuid[])`,
          [id, platform, fanId, scriptIds]
        );
        sentFanIds = new Set(sentResult.rows.map((r) => r.scriptId));
      }

      return res.json({
        folders: foldersResult.rows.map(mapScriptFolderRow),
        scripts: scriptsResult.rows.map((row) => mapScriptRow(row, sentFanIds)),
      });
    } catch (err) {
      console.error('List creator scripts error:', err);
      return res.status(500).json({ error: 'Failed to load scripts' });
    }
  }
);

router.post(
  '/:id/script-folders',
  authenticate,
  requirePermission('scripts.manage'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const platform = normalizeScriptPlatform(req.body?.platform);
    if (!platform) {
      return res.status(400).json({ error: 'platform must be maloum or 4based' });
    }

    const name =
      typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.length > SCRIPT_FOLDER_NAME_MAX) {
      return res.status(400).json({
        error: `name must be at most ${SCRIPT_FOLDER_NAME_MAX} characters`,
      });
    }

    const sortOrder =
      typeof req.body?.sortOrder === 'number' && Number.isFinite(req.body.sortOrder)
        ? Math.round(req.body.sortOrder)
        : 0;

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const result = await pool.query(
        `INSERT INTO creator_script_folders
           (id, "creatorId", platform, name, "sortOrder", "createdBy", "updatedBy", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $6, NOW(), NOW())
         RETURNING id, "creatorId", platform, name, "sortOrder", "createdAt", "updatedAt"`,
        [randomUUID(), id, platform, name, sortOrder, req.user.id]
      );

      return res.status(201).json(mapScriptFolderRow(result.rows[0]));
    } catch (err) {
      console.error('Create script folder error:', err);
      return res.status(500).json({ error: 'Failed to create folder' });
    }
  }
);

router.put(
  '/:id/script-folders/:folderId',
  authenticate,
  requirePermission('scripts.manage'),
  async (req, res) => {
    const { id, folderId } = req.params;
    if (!isValidUuid(id) || !isValidUuid(folderId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim();
      if (!name) {
        return res.status(400).json({ error: 'name cannot be empty' });
      }
      if (name.length > SCRIPT_FOLDER_NAME_MAX) {
        return res.status(400).json({
          error: `name must be at most ${SCRIPT_FOLDER_NAME_MAX} characters`,
        });
      }
      updates.push(`name = $${idx++}`);
      values.push(name);
    }

    if (typeof req.body?.sortOrder === 'number' && Number.isFinite(req.body.sortOrder)) {
      updates.push(`"sortOrder" = $${idx++}`);
      values.push(Math.round(req.body.sortOrder));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push(`"updatedBy" = $${idx++}`);
    values.push(req.user.id);
    updates.push('"updatedAt" = NOW()');

    values.push(id, folderId);

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const result = await pool.query(
        `UPDATE creator_script_folders
         SET ${updates.join(', ')}
         WHERE "creatorId" = $${idx++} AND id = $${idx}
         RETURNING id, "creatorId", platform, name, "sortOrder", "createdAt", "updatedAt"`,
        values
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Folder not found' });
      }

      return res.json(mapScriptFolderRow(result.rows[0]));
    } catch (err) {
      console.error('Update script folder error:', err);
      return res.status(500).json({ error: 'Failed to update folder' });
    }
  }
);

router.delete(
  '/:id/script-folders/:folderId',
  authenticate,
  requirePermission('scripts.manage'),
  async (req, res) => {
    const { id, folderId } = req.params;
    if (!isValidUuid(id) || !isValidUuid(folderId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      // ON DELETE SET NULL on scripts.folderId handles unlinking
      const result = await pool.query(
        `DELETE FROM creator_script_folders
         WHERE "creatorId" = $1 AND id = $2
         RETURNING id`,
        [id, folderId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Folder not found' });
      }

      return res.json({ ok: true, id: folderId });
    } catch (err) {
      console.error('Delete script folder error:', err);
      return res.status(500).json({ error: 'Failed to delete folder' });
    }
  }
);

router.post(
  '/:id/scripts',
  authenticate,
  requirePermission('scripts.manage'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const platform = normalizeScriptPlatform(req.body?.platform);
    if (!platform) {
      return res.status(400).json({ error: 'platform must be maloum or 4based' });
    }

    const title =
      typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (title.length > SCRIPT_TITLE_MAX) {
      return res.status(400).json({
        error: `title must be at most ${SCRIPT_TITLE_MAX} characters`,
      });
    }

    const shortcutCode = normalizeShortcutCode(req.body?.shortcutCode);
    if (shortcutCode === undefined) {
      return res.status(400).json({ error: 'Invalid shortcutCode' });
    }

    const messageText =
      typeof req.body?.messageText === 'string' ? req.body.messageText : '';
    if (messageText.length > SCRIPT_MESSAGE_MAX) {
      return res.status(400).json({
        error: `messageText must be at most ${SCRIPT_MESSAGE_MAX} characters`,
      });
    }

    const priceRaw = req.body?.price;
    const price =
      priceRaw == null || priceRaw === ''
        ? 0
        : Number(priceRaw);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
    }

    const media = normalizeScriptMedia(req.body?.media);
    if (media == null) {
      return res.status(400).json({ error: 'Invalid media array' });
    }

    let folderId = null;
    if (req.body?.folderId != null && req.body.folderId !== '') {
      if (!isValidUuid(req.body.folderId)) {
        return res.status(400).json({ error: 'Invalid folderId' });
      }
      folderId = req.body.folderId;
    }

    const sortOrder =
      typeof req.body?.sortOrder === 'number' && Number.isFinite(req.body.sortOrder)
        ? Math.round(req.body.sortOrder)
        : 0;

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      if (folderId) {
        const folderCheck = await pool.query(
          `SELECT id FROM creator_script_folders
           WHERE id = $1 AND "creatorId" = $2 AND platform = $3`,
          [folderId, id, platform]
        );
        if (folderCheck.rows.length === 0) {
          return res.status(400).json({ error: 'Folder not found for this creator/platform' });
        }
      }

      const result = await pool.query(
        `INSERT INTO creator_scripts
           (id, "creatorId", platform, "folderId", title, "shortcutCode", "messageText",
            price, media, "sortOrder", "createdBy", "updatedBy", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $11, NOW(), NOW())
         RETURNING id, "creatorId", platform, "folderId", title, "shortcutCode", "messageText",
                   price, media, "sortOrder", "createdAt", "updatedAt"`,
        [
          randomUUID(),
          id,
          platform,
          folderId,
          title,
          shortcutCode,
          messageText,
          price,
          JSON.stringify(media),
          sortOrder,
          req.user.id,
        ]
      );

      return res.status(201).json(mapScriptRow(result.rows[0], null));
    } catch (err) {
      if (err && err.code === '23505') {
        return res.status(409).json({ error: 'Shortcut code already exists for this creator' });
      }
      console.error('Create script error:', err);
      return res.status(500).json({ error: 'Failed to create script' });
    }
  }
);

router.put(
  '/:id/scripts/:scriptId',
  authenticate,
  requirePermission('scripts.manage'),
  async (req, res) => {
    const { id, scriptId } = req.params;
    if (!isValidUuid(id) || !isValidUuid(scriptId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (typeof req.body?.title === 'string') {
      const title = req.body.title.trim();
      if (!title) {
        return res.status(400).json({ error: 'title cannot be empty' });
      }
      if (title.length > SCRIPT_TITLE_MAX) {
        return res.status(400).json({
          error: `title must be at most ${SCRIPT_TITLE_MAX} characters`,
        });
      }
      updates.push(`title = $${idx++}`);
      values.push(title);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'shortcutCode')) {
      const shortcutCode = normalizeShortcutCode(req.body.shortcutCode);
      if (shortcutCode === undefined) {
        return res.status(400).json({ error: 'Invalid shortcutCode' });
      }
      updates.push(`"shortcutCode" = $${idx++}`);
      values.push(shortcutCode);
    }

    if (typeof req.body?.messageText === 'string') {
      if (req.body.messageText.length > SCRIPT_MESSAGE_MAX) {
        return res.status(400).json({
          error: `messageText must be at most ${SCRIPT_MESSAGE_MAX} characters`,
        });
      }
      updates.push(`"messageText" = $${idx++}`);
      values.push(req.body.messageText);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'price')) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      updates.push(`price = $${idx++}`);
      values.push(price);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'media')) {
      const media = normalizeScriptMedia(req.body.media);
      if (media == null) {
        return res.status(400).json({ error: 'Invalid media array' });
      }
      updates.push(`media = $${idx++}::jsonb`);
      values.push(JSON.stringify(media));
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'folderId')) {
      const rawFolder = req.body.folderId;
      if (rawFolder == null || rawFolder === '') {
        updates.push(`"folderId" = $${idx++}`);
        values.push(null);
      } else if (isValidUuid(rawFolder)) {
        updates.push(`"folderId" = $${idx++}`);
        values.push(rawFolder);
      } else {
        return res.status(400).json({ error: 'Invalid folderId' });
      }
    }

    if (typeof req.body?.sortOrder === 'number' && Number.isFinite(req.body.sortOrder)) {
      updates.push(`"sortOrder" = $${idx++}`);
      values.push(Math.round(req.body.sortOrder));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push(`"updatedBy" = $${idx++}`);
    values.push(req.user.id);
    updates.push('"updatedAt" = NOW()');

    values.push(id, scriptId);

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      // Validate folder belongs to same creator/platform if setting folderId
      if (
        Object.prototype.hasOwnProperty.call(req.body || {}, 'folderId') &&
        req.body.folderId != null &&
        req.body.folderId !== ''
      ) {
        const existing = await pool.query(
          `SELECT platform FROM creator_scripts WHERE id = $1 AND "creatorId" = $2`,
          [scriptId, id]
        );
        if (existing.rows.length === 0) {
          return res.status(404).json({ error: 'Script not found' });
        }
        const folderCheck = await pool.query(
          `SELECT id FROM creator_script_folders
           WHERE id = $1 AND "creatorId" = $2 AND platform = $3`,
          [req.body.folderId, id, existing.rows[0].platform]
        );
        if (folderCheck.rows.length === 0) {
          return res.status(400).json({ error: 'Folder not found for this creator/platform' });
        }
      }

      const result = await pool.query(
        `UPDATE creator_scripts
         SET ${updates.join(', ')}
         WHERE "creatorId" = $${idx++} AND id = $${idx}
         RETURNING id, "creatorId", platform, "folderId", title, "shortcutCode", "messageText",
                   price, media, "sortOrder", "createdAt", "updatedAt"`,
        values
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Script not found' });
      }

      return res.json(mapScriptRow(result.rows[0], null));
    } catch (err) {
      if (err && err.code === '23505') {
        return res.status(409).json({ error: 'Shortcut code already exists for this creator' });
      }
      console.error('Update script error:', err);
      return res.status(500).json({ error: 'Failed to update script' });
    }
  }
);

router.delete(
  '/:id/scripts/:scriptId',
  authenticate,
  requirePermission('scripts.manage'),
  async (req, res) => {
    const { id, scriptId } = req.params;
    if (!isValidUuid(id) || !isValidUuid(scriptId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const result = await pool.query(
        `DELETE FROM creator_scripts
         WHERE "creatorId" = $1 AND id = $2
         RETURNING id`,
        [id, scriptId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Script not found' });
      }

      return res.json({ ok: true, id: scriptId });
    } catch (err) {
      console.error('Delete script error:', err);
      return res.status(500).json({ error: 'Failed to delete script' });
    }
  }
);

router.post(
  '/:id/scripts/:scriptId/sent',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, scriptId } = req.params;
    if (!isValidUuid(id) || !isValidUuid(scriptId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const fanId =
      typeof req.body?.fanId === 'string' ? req.body.fanId.trim().slice(0, 256) : '';
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    const chatId =
      typeof req.body?.chatId === 'string' && req.body.chatId.trim()
        ? req.body.chatId.trim().slice(0, 256)
        : null;

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const scriptResult = await pool.query(
        `SELECT id, platform FROM creator_scripts
         WHERE id = $1 AND "creatorId" = $2`,
        [scriptId, id]
      );
      if (scriptResult.rows.length === 0) {
        return res.status(404).json({ error: 'Script not found' });
      }

      const platform = scriptResult.rows[0].platform;

      const result = await pool.query(
        `INSERT INTO creator_script_sends
           (id, "scriptId", "creatorId", platform, "fanId", "chatId", "sentBy", "sentAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT ("scriptId", "fanId")
         DO UPDATE SET
           "chatId" = COALESCE(EXCLUDED."chatId", creator_script_sends."chatId"),
           "sentBy" = EXCLUDED."sentBy",
           "sentAt" = NOW()
         RETURNING id, "scriptId", "fanId", "chatId", "sentAt"`,
        [randomUUID(), scriptId, id, platform, fanId, chatId, req.user.id]
      );

      const row = result.rows[0];
      return res.json({
        id: row.id,
        scriptId: row.scriptId,
        fanId: row.fanId,
        chatId: row.chatId,
        sentAt: row.sentAt,
      });
    } catch (err) {
      console.error('Mark script sent error:', err);
      return res.status(500).json({ error: 'Failed to mark script as sent' });
    }
  }
);

module.exports = router;
