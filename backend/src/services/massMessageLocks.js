const pool = require('../db/pool');

const PLATFORMS = new Set(['maloum', '4based', 'telegram']);
const LOCKED_MESSAGE = 'This mass message is undeleteable';

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function asIdList(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    ),
  ];
}

function mapLock(row, telegramMessageIds) {
  return {
    id: row.id,
    creatorId: row.creatorId,
    platform: row.platform,
    platformMessageId: row.platformMessageId,
    bodyText: row.bodyText || '',
    mediaIds: asIdList(row.mediaIds),
    lockedByUserId: row.lockedByUserId || null,
    createdAt: row.createdAt,
    telegramMessageIds: asIdList(telegramMessageIds),
  };
}

function assertPlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (!PLATFORMS.has(value)) {
    const err = new Error('platform must be maloum, 4based, or telegram');
    err.status = 400;
    throw err;
  }
  return value;
}

async function listLocks(creatorId, platform) {
  const params = [creatorId];
  let platformSql = '';
  if (platform) {
    params.push(assertPlatform(platform));
    platformSql = `AND l.platform = $2`;
  }
  const result = await pool.query(
    `SELECT l.*,
       COALESCE((
         SELECT jsonb_agg(DISTINCT (elem #>> '{}'))
         FROM telegram_mm_recipients r
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(r."telegramMessageIds") = 'array' THEN r."telegramMessageIds"
             ELSE '[]'::jsonb
           END
         ) elem
         WHERE l.platform = 'telegram'
           AND r."campaignId"::text = l."platformMessageId"
       ), '[]'::jsonb) AS "telegramMessageIds"
     FROM mass_message_locks l
     WHERE l."creatorId" = $1
       ${platformSql}
     ORDER BY l."createdAt" DESC`,
    params
  );
  return result.rows.map((row) => mapLock(row, row.telegramMessageIds));
}

async function lockedIdSet(creatorId, platform) {
  const locks = await listLocks(creatorId, platform);
  return new Set(locks.map((lock) => lock.platformMessageId));
}

async function isLocked(creatorId, platform, platformMessageId) {
  const id = String(platformMessageId || '').trim();
  if (!id) return false;
  const result = await pool.query(
    `SELECT 1
     FROM mass_message_locks
     WHERE "creatorId" = $1 AND platform = $2 AND "platformMessageId" = $3
     LIMIT 1`,
    [creatorId, assertPlatform(platform), id]
  );
  return result.rowCount > 0;
}

async function lockMessage({
  creatorId,
  platform,
  platformMessageId,
  bodyText,
  mediaIds,
  userId,
}) {
  const id = String(platformMessageId || '').trim();
  if (!id) {
    const err = new Error('platformMessageId is required');
    err.status = 400;
    throw err;
  }
  const result = await pool.query(
    `INSERT INTO mass_message_locks (
       "creatorId", platform, "platformMessageId", "bodyText", "mediaIds", "lockedByUserId"
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT ("creatorId", platform, "platformMessageId")
     DO UPDATE SET
       "bodyText" = EXCLUDED."bodyText",
       "mediaIds" = EXCLUDED."mediaIds",
       "lockedByUserId" = EXCLUDED."lockedByUserId"
     RETURNING *`,
    [
      creatorId,
      assertPlatform(platform),
      id,
      String(bodyText || ''),
      JSON.stringify(asIdList(mediaIds)),
      userId || null,
    ]
  );
  const locks = await listLocks(creatorId, platform);
  return locks.find((lock) => lock.platformMessageId === id) || mapLock(result.rows[0], []);
}

async function unlockMessage(creatorId, platform, platformMessageId) {
  const id = String(platformMessageId || '').trim();
  if (!id) {
    const err = new Error('platformMessageId is required');
    err.status = 400;
    throw err;
  }
  const result = await pool.query(
    `DELETE FROM mass_message_locks
     WHERE "creatorId" = $1 AND platform = $2 AND "platformMessageId" = $3`,
    [creatorId, assertPlatform(platform), id]
  );
  return result.rowCount > 0;
}

function copyMatchesLock(lock, { text, mediaIds }) {
  const lockText = normalizeText(lock.bodyText);
  const needle = normalizeText(text);
  if (lockText && needle && lockText === needle) return true;
  if (!lockText) {
    const media = new Set(asIdList(mediaIds));
    return lock.mediaIds.some((id) => media.has(id));
  }
  return false;
}

async function isChatCopyLocked(creatorId, platform, details = {}) {
  const resolved = assertPlatform(platform);
  if (resolved === 'telegram') {
    const messageId = String(details.telegramMessageId || '').trim();
    if (!messageId) return false;
    const result = await pool.query(
      `SELECT 1
       FROM mass_message_locks l
       INNER JOIN telegram_mm_recipients r
         ON r."campaignId"::text = l."platformMessageId"
       WHERE l."creatorId" = $1
         AND l.platform = 'telegram'
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(r."telegramMessageIds") = 'array' THEN r."telegramMessageIds"
               ELSE '[]'::jsonb
             END
           ) elem
           WHERE elem #>> '{}' = $2
         )
       LIMIT 1`,
      [creatorId, messageId]
    );
    return result.rowCount > 0;
  }
  const locks = await listLocks(creatorId, resolved);
  return locks.some((lock) => copyMatchesLock(lock, details));
}

module.exports = {
  LOCKED_MESSAGE,
  listLocks,
  lockedIdSet,
  isLocked,
  lockMessage,
  unlockMessage,
  isChatCopyLocked,
};
