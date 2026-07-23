const pool = require('../db/pool');
const { backfillDueCreators } = require('./maloumTokenBackfill');
const { decryptJson, encryptJson } = require('./crypto');
const {
  buildEncryptedTokenFields,
  decryptRefreshToken,
  getSupabaseConfig,
  mergeSessionWithSupabaseResponse,
} = require('./maloumAuthTokens');
const { emitToUsers } = require('./userEventBus');

const REFRESH_INTERVAL_MS = 60_000;
const REFRESH_AHEAD_MS = 5 * 60_000;
const MAX_REFRESH_FAILURES = 3;

let schedulerTimer = null;
let refreshQueue = Promise.resolve();

function enqueueRefresh(task) {
  refreshQueue = refreshQueue.then(task, task);
  return refreshQueue;
}

async function getUserIdsWithCreatorAccess(creatorId) {
  const [assigned, managers] = await Promise.all([
    pool.query(
      `SELECT "userId" FROM creator_staff_assignments WHERE "creatorId" = $1`,
      [creatorId]
    ),
    pool.query(`SELECT id FROM users WHERE status = 'active' AND role <> 'chatter'`),
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

class MaloumRefreshError extends Error {
  constructor(message, { status = null, permanent = false } = {}) {
    super(message);
    this.name = 'MaloumRefreshError';
    this.status = status;
    this.permanent = permanent;
  }
}

async function callSupabaseRefresh(refreshToken) {
  const { url, publishableKey } = getSupabaseConfig();

  const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  const rawBody = await response.text();
  let parsedBody = null;

  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = null;
    }
  }

  if (!response.ok) {
    const message =
      parsedBody?.error_description ||
      parsedBody?.msg ||
      parsedBody?.message ||
      rawBody ||
      `Supabase refresh failed (${response.status})`;

    const permanent =
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403 ||
      /invalid refresh token|refresh_token/i.test(String(message));

    throw new MaloumRefreshError(message, {
      status: response.status,
      permanent,
    });
  }

  if (!parsedBody?.access_token || !parsedBody?.refresh_token) {
    throw new MaloumRefreshError('Supabase refresh returned an incomplete session', {
      permanent: true,
    });
  }

  return parsedBody;
}

async function refreshCreatorTokens(creatorId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, "accountId", "encryptedSession", "encryptedRefreshToken",
              "accessTokenExpiresAt", "authRefreshState", "tokenRefreshFailureCount"
       FROM creators
       WHERE id = $1
       FOR UPDATE`,
      [creatorId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { refreshed: false, reason: 'not_found' };
    }

    const creator = result.rows[0];

    if (creator.authRefreshState !== 'active') {
      await client.query('ROLLBACK');
      return { refreshed: false, reason: creator.authRefreshState };
    }

    if (!creator.encryptedRefreshToken) {
      await client.query('ROLLBACK');
      return { refreshed: false, reason: 'missing_refresh_token' };
    }

    const refreshToken = decryptRefreshToken(creator.encryptedRefreshToken);
    if (!refreshToken) {
      await client.query('ROLLBACK');
      return { refreshed: false, reason: 'invalid_refresh_token' };
    }

    const supabaseSession = await callSupabaseRefresh(refreshToken);
    const encryptedSessionPayload = creator.encryptedSession
      ? decryptJson(creator.encryptedSession)
      : { cookies: [], origins: [] };
    const mergedSession = mergeSessionWithSupabaseResponse(
      encryptedSessionPayload,
      supabaseSession
    );
    const encryptedTokens = buildEncryptedTokenFields({
      accessToken: supabaseSession.access_token,
      refreshToken: supabaseSession.refresh_token,
      expiresAt: supabaseSession.expires_at,
    });

    const updated = await client.query(
      `UPDATE creators
       SET "encryptedSession" = $2,
           "encryptedAccessToken" = $3,
           "encryptedRefreshToken" = $4,
           "accessTokenExpiresAt" = $5,
           "authRefreshState" = 'active',
           "lastTokenRefreshedAt" = NOW(),
           "tokenRefreshFailureCount" = 0,
           "connectionStatus" = 'connected',
           "updatedAt" = NOW()
       WHERE id = $1
       RETURNING id, "accountId"`,
      [
        creatorId,
        encryptJson(mergedSession),
        encryptedTokens.encryptedAccessToken,
        encryptedTokens.encryptedRefreshToken,
        encryptedTokens.accessTokenExpiresAt,
      ]
    );

    await client.query('COMMIT');

    const accessUserIds = await getUserIdsWithCreatorAccess(creatorId);
    emitCreatorSessionUpdated(accessUserIds, {
      creatorId,
      accountId: updated.rows[0]?.accountId || creator.accountId,
      sessionUpdatedAt: mergedSession.savedAt,
    });

    return {
      refreshed: true,
      creatorId,
      accountId: updated.rows[0]?.accountId || creator.accountId,
      expiresAt: encryptedTokens.accessTokenExpiresAt,
    };
  } catch (error) {
    await client.query('ROLLBACK');

    const failureCountResult = await pool.query(
      `UPDATE creators
       SET "tokenRefreshFailureCount" = "tokenRefreshFailureCount" + 1,
           "authRefreshState" = CASE
             WHEN $2 THEN 'needs_reauth'
             WHEN "tokenRefreshFailureCount" + 1 >= $3 THEN 'needs_reauth'
             ELSE "authRefreshState"
           END,
           "connectionStatus" = CASE
             WHEN $2 OR "tokenRefreshFailureCount" + 1 >= $3 THEN 'error'
             ELSE "connectionStatus"
           END,
           "updatedAt" = NOW()
       WHERE id = $1
       RETURNING "tokenRefreshFailureCount", "authRefreshState"`,
      [
        creatorId,
        Boolean(error instanceof MaloumRefreshError && error.permanent),
        MAX_REFRESH_FAILURES,
      ]
    );

    return {
      refreshed: false,
      creatorId,
      reason: error instanceof Error ? error.message : String(error),
      authRefreshState: failureCountResult.rows[0]?.authRefreshState || null,
    };
  } finally {
    client.release();
  }
}

async function refreshDueCreators() {
  await backfillDueCreators();

  const threshold = new Date(Date.now() + REFRESH_AHEAD_MS);

  const result = await pool.query(
    `SELECT id
     FROM creators
     WHERE platform = 'maloum'
       AND "authRefreshState" = 'active'
       AND "encryptedRefreshToken" IS NOT NULL
       AND (
         "accessTokenExpiresAt" IS NULL
         OR "accessTokenExpiresAt" <= $1
       )
     ORDER BY "accessTokenExpiresAt" ASC NULLS FIRST
     LIMIT 25`,
    [threshold]
  );

  for (const row of result.rows) {
    await enqueueRefresh(() => refreshCreatorTokens(row.id));
  }
}

function startMaloumTokenRefreshScheduler() {
  if (schedulerTimer) {
    return;
  }

  const tick = () => {
    void refreshDueCreators().catch((error) => {
      console.error('Maloum token refresh scheduler tick failed:', error);
    });
  };

  tick();
  schedulerTimer = setInterval(tick, REFRESH_INTERVAL_MS);
  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

function stopMaloumTokenRefreshScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  MaloumRefreshError,
  refreshCreatorTokens,
  refreshDueCreators,
  startMaloumTokenRefreshScheduler,
  stopMaloumTokenRefreshScheduler,
};
