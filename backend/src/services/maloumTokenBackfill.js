const pool = require('../db/pool');
const { decryptJson } = require('./crypto');
const { buildTokenWriteFromOrigins } = require('./maloumAuthTokens');

async function backfillCreatorTokensFromSession(creatorId) {
  const result = await pool.query(
    `SELECT id, "encryptedSession", "encryptedRefreshToken"
     FROM creators
     WHERE id = $1`,
    [creatorId]
  );

  if (result.rows.length === 0) {
    return { backfilled: false, reason: 'not_found' };
  }

  const creator = result.rows[0];
  if (creator.encryptedRefreshToken || !creator.encryptedSession) {
    return { backfilled: false, reason: 'not_needed' };
  }

  let session;
  try {
    session = decryptJson(creator.encryptedSession);
  } catch {
    return { backfilled: false, reason: 'invalid_session' };
  }

  const tokenWrite = buildTokenWriteFromOrigins(session.origins || []);
  if (!tokenWrite) {
    return { backfilled: false, reason: 'missing_auth_storage' };
  }

  await pool.query(
    `UPDATE creators
     SET "encryptedAccessToken" = $2,
         "encryptedRefreshToken" = $3,
         "accessTokenExpiresAt" = $4,
         "authRefreshState" = 'active',
         "tokenRefreshFailureCount" = 0,
         "updatedAt" = NOW()
     WHERE id = $1`,
    [
      creatorId,
      tokenWrite.encryptedAccessToken,
      tokenWrite.encryptedRefreshToken,
      tokenWrite.accessTokenExpiresAt,
    ]
  );

  return { backfilled: true, creatorId };
}

async function backfillDueCreators(limit = 25) {
  const result = await pool.query(
    `SELECT id
     FROM creators
     WHERE platform = 'maloum'
       AND "encryptedSession" IS NOT NULL
       AND "encryptedRefreshToken" IS NULL
     ORDER BY "updatedAt" DESC
     LIMIT $1`,
    [limit]
  );

  for (const row of result.rows) {
    await backfillCreatorTokensFromSession(row.id);
  }
}

module.exports = {
  backfillCreatorTokensFromSession,
  backfillDueCreators,
};
