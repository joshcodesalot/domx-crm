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
const { saveCreatorAvatarFromBuffer } = require('../services/creatorAvatar');
const {
  userSeesAllCreators,
  userCanAccessCreator,
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

function partitionIdFor(accountId) {
  return `persist:creator-${accountId}`;
}

function buildEncryptedSessionPayload({ cookies, origins, loginEmail, savedAt }) {
  const stampedAt = savedAt || new Date().toISOString();
  return {
    encryptedSession: encryptJson({
      cookies,
      origins: origins || [],
      loginEmail,
      savedAt: stampedAt,
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

async function getUserIdsWithCreatorAccess(creatorId) {
  const [assigned, managers] = await Promise.all([
    pool.query(
      `SELECT "userId" FROM creator_staff_assignments WHERE "creatorId" = $1`,
      [creatorId]
    ),
    pool.query(
      `SELECT id FROM users WHERE status = 'active' AND role <> 'chatter'`
    ),
  ]);

  return [
    ...new Set([
      ...assigned.rows.map((row) => row.userId),
      ...managers.rows.map((row) => row.id),
    ]),
  ];
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
          return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
            error: err.message || 'Maloum login failed',
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
                "encryptedSession", "connectionStatus", "updatedAt"
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

      res.json({
        accountId: creator.accountId,
        partitionId: creator.partitionId,
        displayName: creator.displayName,
        username: creator.username,
        avatarUrl: creator.avatarUrl || null,
        cookies,
        origins,
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
            .status(err.status >= 400 && err.status < 600 ? err.status : 502)
            .json({ error: err.message || 'Maloum login failed' });
        }
        throw err;
      }

      const loginEmail = email.trim();
      const { encryptedSession, savedAt: sessionSavedAt } = buildEncryptedSessionPayload({
        cookies: loginResult.cookies,
        origins: loginResult.origins,
        loginEmail,
      });
      const tokenFields = buildEncryptedTokenFields({
        accessToken: loginResult.accessToken,
        refreshToken: loginResult.refreshToken,
        expiresAt: loginResult.expiresAt,
      });
      const encryptedProxy = encryptSecret(resolvedProxy);
      const encryptedLoginPassword = encryptOptionalLoginPassword(password);

      const creator = result.rows[0];
      const nextAvatarUrl =
        creator.avatarSource === 'manual' || isBackendStoredAvatarUrl(creator.avatarUrl)
          ? creator.avatarUrl
          : loginResult.avatarUrl || creator.avatarUrl;

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
           "postLoginUrl" = $11,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "tokenRefreshFailureCount" = 0,
           "updatedAt" = NOW()
         WHERE id = $12
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
      const chats = await fourBasedClient.listChats(loaded.creator, { limit, offset });
      res.json({
        chats: Array.isArray(chats) ? chats : chats?.items || chats || [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based chats error:');
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

      const badges = await fourBasedClient.getBadges(loaded.creator);
      res.json(badges);
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based badges error:');
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

      // PPV / priced vault send
      if (vaultId) {
        const result = await fourBasedClient.sendPpv(loaded.creator, chatId, {
          message: text,
          vaultId,
          vaultGuid,
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
    const fanId = req.query.fanId;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId || typeof fanId !== 'string') {
      return res.status(400).json({ error: 'fanId query parameter is required' });
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
      const tag =
        typeof req.query.tag === 'string' && req.query.tag.trim()
          ? req.query.tag.trim()
          : undefined;
      const vault = await fourBasedClient.listVault(loaded.creator, {
        fanId,
        limit,
        offset,
        tag,
      });
      res.json({
        items: Array.isArray(vault) ? vault : vault?.items || vault || [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based vault error:');
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
      const canUseDiskCache =
        !rangeHeader && fourBasedMediaCache.isCacheablePath(mediaPath);

      if (canUseDiskCache) {
        const cached = await fourBasedMediaCache.readCache(id, mediaPath);
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

      const upstream = await fourBasedClient.fetchMedia(loaded.creator, {
        path: mediaPath,
        rangeHeader,
      });

      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status || 502).json({ error: 'Failed to fetch media' });
      }

      const passthrough = [
        'content-type',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
      ];
      // Only forward content-length when streaming; buffered cache path sets it after download.
      if (!(canUseDiskCache && upstream.status === 200)) {
        passthrough.push('content-length');
      }
      for (const header of passthrough) {
        const value = upstream.headers.get(header);
        if (value) {
          res.setHeader(header, value);
        }
      }

      // Prefer long-lived browser cache for previews; videos stay shorter.
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
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.status(upstream.status);

      if (!upstream.body) {
        return res.end();
      }

      // Buffer cacheable image bodies so we can store them; stream everything else.
      if (canUseDiskCache && upstream.status === 200) {
        const { Readable } = require('stream');
        const nodeStream = Readable.fromWeb(upstream.body);
        const chunks = [];
        nodeStream.on('data', (chunk) => chunks.push(chunk));
        nodeStream.on('error', (err) => {
          console.warn('4based media stream error:', err.message);
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
          void fourBasedMediaCache.writeCache(id, mediaPath, {
            buffer,
            contentType: upstream.headers.get('content-type') || 'application/octet-stream',
            etag: upstream.headers.get('etag') || null,
          });
        });
        return;
      }

      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', (err) => {
        console.warn('4based media stream error:', err.message);
        if (!res.headersSent) {
          res.status(502).end();
        } else {
          res.destroy(err);
        }
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

function handleMaloumError(res, err, label) {
  if (err instanceof maloumClient.WrongPasswordError) {
    return res.status(400).json({ error: 'Password not correct' });
  }
  if (err instanceof maloumClient.MaloumApiError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({ error: err.message || 'Maloum request failed' });
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
      const chats = await maloumClient.listChats(loaded.creator, { limit, next });
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

      const [chatsPayload, notificationsPayload] = await Promise.all([
        maloumClient.listChats(loaded.creator, { limit: 15 }),
        maloumClient.listNotifications(loaded.creator, { limit: 15 }),
      ]);

      const notifications = maloumClient.normalizeListData(notificationsPayload);

      try {
        await messagingDashboard.processMaloumSaleAndTipNotifications(id, notifications);
      } catch (err) {
        console.warn('Maloum sale/tip sync failed:', err.message);
      }

      res.json({
        messages: maloumClient.countUnreadChatsFromList(chatsPayload),
        notifications: maloumClient.countUnreadNotificationsFromList(notificationsPayload),
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

module.exports = router;
