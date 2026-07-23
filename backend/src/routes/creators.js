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
  buildTokenWriteFromOrigins,
  decryptAccessToken,
} = require('../services/maloumAuthTokens');
const { emitToUser, emitToUsers } = require('../services/userEventBus');

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

    if (platform !== 'maloum') {
      return res.status(400).json({ error: 'Only Maloum is supported currently' });
    }

    if (!isClientMaloumSession(req.body)) {
      return res.status(400).json({
        error:
          'Connect requires a Maloum session from the DomX desktop app. Server-side login is no longer supported.',
      });
    }

    const sessionError = validateClientSessionPayload(req.body);
    if (sessionError) {
      return res.status(400).json({ error: sessionError });
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

      const accountToken = generateAccountToken();
      const accountTokenHash = hashToken(accountToken);
      const partitionId = partitionIdFor(accountId);
      const loginEmail = email.trim();
      const { encryptedSession } = buildEncryptedSessionPayload({
        cookies,
        origins,
        loginEmail,
      });
      const tokenPersistence = buildTokenPersistenceFromOrigins(origins);
      const encryptedLoginPassword = encryptOptionalLoginPassword(password);
      const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000);

      await pool.query(
        `INSERT INTO creator_connect_pending (
           "accountId", "accountTokenHash", "partitionId", platform,
           "displayName", username, "postLoginUrl", "avatarUrl", "encryptedSession",
           "loginEmail", "encryptedLoginPassword", "encryptedAccessToken",
           "encryptedRefreshToken", "accessTokenExpiresAt", "createdBy", "expiresAt"
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          accountId,
          accountTokenHash,
          partitionId,
          platform,
          displayName.trim(),
          username || null,
          postLoginUrl,
          avatarUrl || null,
          encryptedSession,
          loginEmail,
          encryptedLoginPassword ?? null,
          tokenPersistence?.encryptedAccessToken ?? null,
          tokenPersistence?.encryptedRefreshToken ?? null,
          tokenPersistence?.accessTokenExpiresAt ?? null,
          req.user.id,
          expiresAt,
        ]
      );

      res.status(201).json({
        accountToken,
        accountId,
        partitionId,
        displayName: displayName.trim(),
        username: username || null,
        postLoginUrl,
        avatarUrl: avatarUrl || null,
        cookies,
        origins: origins || [],
      });
    } catch (err) {
      console.error('Connect creator error:', err);
      res.status(500).json({ error: 'Internal server error' });
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
         "tokenRefreshFailureCount", "lastValidatedAt"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id, "displayName", username, platform, "connectionStatus",
                 "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId", "partitionId",
                 "loginEmail", "lastValidatedAt", "authRefreshState", "accessTokenExpiresAt",
                 "createdAt", "updatedAt"`,
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
       RETURNING id, "accountId", "partitionId"`,
      [id]
    );

    const { accountId, partitionId } = result.rows[0];

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

module.exports = router;
