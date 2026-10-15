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
  invalidateCreatorAccessCache,
} = require('../services/creatorAccess');
const {
  buildEncryptedTokenFields,
  buildTokenWriteFromOrigins,
  decryptAccessToken,
} = require('../services/maloumAuthTokens');
const { emitToUser, emitToUsers } = require('../services/userEventBus');
const fourBasedClient = require('../services/fourBasedClient');
const maloumClient = require('../services/maloumClient');
const { connectFanslyCreator } = require('./creatorsFansly');
const {
  abortPendingTelegramLogin,
  startTelegramAfterCreate,
  disconnectTelegramCreator,
} = require('./creatorsTelegram');
const {
  InvalidProxyError,
  buildProxyUrl,
  parseProxyParts,
  customProxyFromBody,
} = require('../services/proxyUrl');
const {
  reconcileCreatorPayouts,
  parseYearMonth,
} = require('../services/salePayoutReconciler');
const massMessageUnsendAllRunner = require('../services/massMessageUnsendAllRunner');
const {
  connectCreatorById,
  disconnectCreator,
} = require('../services/fourBasedSocket');
const { randomUUID } = require('crypto');

const router = express.Router();



const VALID_PLATFORMS = ['maloum', '4based', 'telegram', 'fansly'];
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
    hasCustomProxy: Boolean(row.hasCustomProxy),
    lastValidatedAt: row.lastValidatedAt || null,
    marketingEnabled: Boolean(row.marketingEnabled),
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

function encryptCustomProxy(provided, resolvedUrl) {
  if (!provided || !resolvedUrl) {
    return null;
  }
  return encryptSecret(resolvedUrl);
}

function decryptStoredProxy(encryptedProxy) {
  if (!encryptedProxy) {
    return null;
  }
  try {
    return decryptSecret(encryptedProxy) || null;
  } catch {
    return null;
  }
}

function resolveSessionProxyUrl(encryptedProxy, platform) {
  const stored = decryptStoredProxy(encryptedProxy);
  if (stored) {
    return stored;
  }
  try {
    if (platform === '4based') {
      return fourBasedClient.resolveFourBasedProxyUrl(null);
    }
    return maloumClient.resolveMaloumProxyUrl(null);
  } catch {
    return null;
  }
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
  "accessTokenExpiresAt", "marketingEnabled", "createdAt", "updatedAt",
  ("encryptedProxy" IS NOT NULL) AS "hasCustomProxy"
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
                c."authRefreshState", c."accessTokenExpiresAt", c."createdAt", c."updatedAt",
                (c."encryptedProxy" IS NOT NULL) AS "hasCustomProxy"
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

function parseMassUnsendPlatform(req) {
  const platform = String(req.body?.platform || req.query?.platform || '').trim();
  if (platform !== '4based' && platform !== 'maloum') return null;
  return platform;
}

async function listAccessibleCreatorsForPlatform(user, platform) {
  let result;
  if (userSeesAllCreators(user)) {
    result = await pool.query(
      `SELECT id, "displayName" FROM creators WHERE platform = $1 ORDER BY "createdAt" ASC`,
      [platform]
    );
  } else {
    result = await pool.query(
      `SELECT c.id, c."displayName"
       FROM creators c
       INNER JOIN creator_staff_assignments a
         ON a."creatorId" = c.id AND a."userId" = $1
       WHERE c.platform = $2
       ORDER BY c."createdAt" ASC`,
      [user.id, platform]
    );
  }
  return result.rows;
}

router.post(
  '/mass-messages/unsend-all-platform',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const platform = parseMassUnsendPlatform(req);
    if (!platform) {
      return res.status(400).json({ error: 'platform must be 4based or maloum' });
    }
    try {
      const creators = await listAccessibleCreatorsForPlatform(req.user, platform);
      if (creators.length === 0) {
        return res.status(400).json({ error: `No ${platform} creators you can access` });
      }
      const started = massMessageUnsendAllRunner.startUnsendAllPlatform(
        platform,
        creators
      );
      if (started.error) {
        return res.status(started.error.status).json({ error: started.error.message });
      }
      res.json({ progress: started });
    } catch (err) {
      console.error('Start platform unsend-all error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/mass-messages/unsend-all-platform',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const platform = parseMassUnsendPlatform(req);
    if (!platform) {
      return res.status(400).json({ error: 'platform must be 4based or maloum' });
    }
    try {
      res.json({
        progress: massMessageUnsendAllRunner.snapshotPlatform(platform),
      });
    } catch (err) {
      console.error('Get platform unsend-all error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/mass-messages/unsend-all-platform/stop',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const platform = parseMassUnsendPlatform(req);
    if (!platform) {
      return res.status(400).json({ error: 'platform must be 4based or maloum' });
    }
    try {
      res.json({
        progress: massMessageUnsendAllRunner.stopUnsendAllPlatform(platform),
      });
    } catch (err) {
      console.error('Stop platform unsend-all error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

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

      const customProxy = readCustomProxy(req.body);
      if (!customProxy.ok) {
        return res.status(400).json({ error: customProxy.error });
      }

      let resolvedProxy;
      try {
        resolvedProxy = fourBasedClient.resolveFourBasedProxyUrl(customProxy.proxyUrl);
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
        const encryptedProxy = encryptCustomProxy(customProxy.provided, resolvedProxy);
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

    // --- Fansly API-based connect ---
    if (platform === 'fansly') {
      return connectFanslyCreator(req, res, {
        readCustomProxy,
        cleanupExpiredPending,
        partitionIdFor,
        encryptCustomProxy,
        encryptOptionalLoginPassword,
        PENDING_TTL_MINUTES,
      });
    }

    // --- Maloum API-based connect ---
    if (platform !== 'maloum') {
      return res.status(400).json({ error: 'Only Maloum, 4based, and Fansly are supported currently' });
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

    let resolvedProxy;
    try {
      resolvedProxy = maloumClient.resolveMaloumProxyUrl(customProxy.proxyUrl);
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
      const encryptedProxy = encryptCustomProxy(customProxy.provided, resolvedProxy);
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
      abortPendingTelegramLogin(accountId);

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
                 "providerUserId", "createdAt", "updatedAt",
                 ("encryptedProxy" IS NOT NULL) AS "hasCustomProxy"`,
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

    if (saved.platform === 'telegram' && pending?.accountId) {
      startTelegramAfterCreate(saved.id, pending.accountId);
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
      invalidateCreatorAccessCache(id);

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
      invalidateCreatorAccessCache(id);

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
                "encryptedSession", "encryptedProxy", platform, "connectionStatus", "updatedAt"
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
      const proxyUrl = resolveSessionProxyUrl(creator.encryptedProxy, creator.platform);

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
  '/:id/marketing',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    const { enabled } = req.body;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' });
    }

    try {
      const result = await pool.query(
        `UPDATE creators
         SET "marketingEnabled" = $2,
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        [id, enabled]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      res.json({ creator: toCreator(result.rows[0]) });
    } catch (err) {
      console.error('Set creator marketing error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/:id/proxy',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const result = await pool.query(
        `SELECT id, platform, "encryptedProxy"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const row = result.rows[0];
      const stored = decryptStoredProxy(row.encryptedProxy);
      const parts = stored ? parseProxyParts(stored) : null;
      const envLabel =
        row.platform === '4based'
          ? 'FOURBASED_PROXY_URL'
          : row.platform === 'fansly'
            ? 'FANSLY_PROXY_URL'
            : 'MALOUM_PROXY_URL';

      return res.json({
        hasCustomProxy: Boolean(stored),
        proxyHost: parts?.hostPort || null,
        proxyUsername: parts?.username || null,
        envLabel,
      });
    } catch (err) {
      console.error('Get creator proxy error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put(
  '/:id/proxy',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const proxyHost =
      typeof req.body?.proxyHost === 'string' ? req.body.proxyHost.trim() : '';
    const proxyUsername =
      typeof req.body?.proxyUsername === 'string' ? req.body.proxyUsername : '';
    const proxyPassword =
      typeof req.body?.proxyPassword === 'string' ? req.body.proxyPassword : '';

    try {
      const existing = await pool.query(
        `SELECT id, platform, "encryptedProxy"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      if (!proxyHost) {
        const updated = await pool.query(
          `UPDATE creators
           SET "encryptedProxy" = NULL, "updatedAt" = NOW()
           WHERE id = $1
           RETURNING ${CREATOR_SELECT_COLUMNS}`,
          [id]
        );
        return res.json({ creator: toCreator(updated.rows[0]) });
      }

      let passwordToStore = proxyPassword;
      if (!proxyPassword) {
        const stored = decryptStoredProxy(existing.rows[0].encryptedProxy);
        const parts = stored ? parseProxyParts(stored) : null;
        if (parts?.password) {
          passwordToStore = parts.password;
        }
      }

      const built = buildProxyUrl(proxyHost, proxyUsername, passwordToStore);
      if (!built) {
        return res.status(400).json({
          error: 'Proxy address is invalid. Use host:port (for example 1.2.3.4:8080).',
        });
      }

      const updated = await pool.query(
        `UPDATE creators
         SET "encryptedProxy" = $2, "updatedAt" = NOW()
         WHERE id = $1
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        [id, encryptSecret(built)]
      );
      return res.json({ creator: toCreator(updated.rows[0]) });
    } catch (err) {
      console.error('Update creator proxy error:', err);
      return res.status(500).json({ error: 'Internal server error' });
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

  const client = await pool.connect();
  try {
    const creatorResult = await client.query(
      `SELECT id, "displayName", "accountId", "partitionId", platform
       FROM creators
       WHERE id = $1`,
      [id]
    );

    if (creatorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const creator = creatorResult.rows[0];
    const creatorPlatform =
      creator.platform === '4based' ? '4based' : 'maloum';

    const assignedStaff = await client.query(
      `SELECT "userId" FROM creator_staff_assignments WHERE "creatorId" = $1`,
      [id]
    );

    await client.query('BEGIN');

    await client.query(
      `UPDATE messaging_dashboard_entries
       SET "creatorName" = 'Deleted',
           "creatorUsername" = NULL,
           "creatorAvatarUrl" = NULL,
           platform = COALESCE(NULLIF(TRIM(platform), ''), $2)
       WHERE "creatorId" = $1`,
      [id, creatorPlatform]
    );

    const result = await client.query(
      `DELETE FROM creators
       WHERE id = $1
       RETURNING id, "accountId", "partitionId", platform`,
      [id]
    );

    await client.query('COMMIT');

    const { accountId, partitionId, platform } = result.rows[0];

    if (platform === '4based') {
      disconnectCreator(id);
    }
    if (platform === 'telegram') {
      disconnectTelegramCreator(id);
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
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('Delete creator error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});






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



router.post(
  '/:id/reconcile-payouts',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    const role = req.user?.role;
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Owner or manager access required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const yearMonth = parseYearMonth(req.body?.yearMonth);
      const result = await reconcileCreatorPayouts(id, {
        yearMonth,
        force: true,
      });
      res.json(result);
    } catch (err) {
      console.error('Reconcile payouts error:', err);
      res.status(500).json({ error: 'Failed to reconcile payouts' });
    }
  }
);


const VAULT_NOTE_PLATFORMS = new Set(['maloum', '4based', 'telegram']);
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
      return res.status(400).json({ error: 'platform must be maloum, 4based, or telegram' });
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
      return res.status(400).json({ error: 'platform must be maloum, 4based, or telegram' });
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
      return res.status(400).json({ error: 'platform must be maloum, 4based, or telegram' });
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

const SCRIPT_PLATFORMS = new Set(['maloum', '4based', 'telegram']);

function normalizeScriptPlatform(value) {
  return typeof value === 'string' && SCRIPT_PLATFORMS.has(value) ? value : null;
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

module.exports.buildEncryptedSessionPayload = buildEncryptedSessionPayload;
module.exports.tryCacheMaloumAvatar = tryCacheMaloumAvatar;
module.exports.persistCachedMaloumAvatar = persistCachedMaloumAvatar;
module.exports.isBackendStoredAvatarUrl = isBackendStoredAvatarUrl;
module.exports.maloumClientHttpStatus = maloumClientHttpStatus;
module.exports.maloumClientHttpMessage = maloumClientHttpMessage;
module.exports.isValidUuid = isValidUuid;
module.exports.readCustomProxy = readCustomProxy;
module.exports.toCreator = toCreator;
module.exports.connectLimiter = connectLimiter;
module.exports.encryptCustomProxy = encryptCustomProxy;
module.exports.decryptStoredProxy = decryptStoredProxy;
module.exports.encryptOptionalLoginPassword = encryptOptionalLoginPassword;
module.exports.CREATOR_SELECT_COLUMNS = CREATOR_SELECT_COLUMNS;
module.exports.emitCreatorSessionUpdated = emitCreatorSessionUpdated;
