const { randomUUID } = require('crypto');
const pool = require('../db/pool');

function parseOptionalTimestamp(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function dashboardLookupId(platform, platformMessageId) {
  if (platform === '4based') return `4based:${platformMessageId}`;
  if (platform === 'telegram') return `telegram:${platformMessageId}`;
  return platformMessageId;
}

async function upsertMessageUnsend({
  creatorId,
  platform,
  chatId,
  platformMessageId,
  originalText,
  messageSentAt,
  user,
}) {
  let text = typeof originalText === 'string' ? originalText.trim() : '';

  if (!text) {
    const lookupId = dashboardLookupId(platform, platformMessageId);
    const fallback = await pool.query(
      `SELECT COALESCE(NULLIF("actualSentText", ''), NULLIF("englishMessage", ''), '') AS text
       FROM messaging_dashboard_entries
       WHERE "creatorId" = $1 AND "maloumMessageId" = $2
       LIMIT 1`,
      [creatorId, lookupId]
    );
    text = String(fallback.rows[0]?.text || '');
  }

  const unsentByUserId = user?.id || null;
  const unsentByUserName =
    (typeof user?.name === 'string' && user.name.trim()) || 'Unknown';
  const sentAt = parseOptionalTimestamp(messageSentAt);

  const result = await pool.query(
    `INSERT INTO message_unsends (
       id, "creatorId", platform, "chatId", "platformMessageId",
       "originalText", "unsentByUserId", "unsentByUserName", "messageSentAt", "unsentAt"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT ("creatorId", platform, "platformMessageId")
     DO UPDATE SET
       "chatId" = EXCLUDED."chatId",
       "originalText" = CASE
         WHEN EXCLUDED."originalText" <> '' THEN EXCLUDED."originalText"
         ELSE message_unsends."originalText"
       END,
       "unsentByUserId" = EXCLUDED."unsentByUserId",
       "unsentByUserName" = EXCLUDED."unsentByUserName",
       "messageSentAt" = COALESCE(EXCLUDED."messageSentAt", message_unsends."messageSentAt"),
       "unsentAt" = NOW()
     RETURNING
       "platformMessageId", "originalText", "unsentByUserName", "unsentAt", "messageSentAt"`,
    [
      randomUUID(),
      creatorId,
      platform,
      String(chatId),
      String(platformMessageId),
      text,
      unsentByUserId,
      unsentByUserName,
      sentAt,
    ]
  );

  const row = result.rows[0];
  return {
    platformMessageId: row.platformMessageId,
    originalText: row.originalText || '',
    unsentByUserName: row.unsentByUserName,
    unsentAt: row.unsentAt,
    messageSentAt: row.messageSentAt,
  };
}

module.exports = {
  upsertMessageUnsend,
};
