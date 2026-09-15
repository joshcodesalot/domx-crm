const pool = require('../../../db/pool');

const RECENT_ACTIVE_MS = 2 * 60_000;
const RECENT_ACTIVE_LIMIT = 5;

function asChatId(value) {
  return String(value || '').trim();
}

async function listRecentActiveConversations(
  {
    creatorId,
    platform,
    skipChatIds = [],
    sinceMs = RECENT_ACTIVE_MS,
    limit = RECENT_ACTIVE_LIMIT,
  } = {},
  client = pool
) {
  if (!creatorId || !platform) return [];
  const skip = new Set(
    (Array.isArray(skipChatIds) ? skipChatIds : []).map(asChatId).filter(Boolean)
  );
  const fetchLimit = Math.max(Number(limit) || RECENT_ACTIVE_LIMIT, 1) + skip.size;
  const windowMs = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : RECENT_ACTIVE_MS;
  const result = await client.query(
    `SELECT "platformChatId", "platformFanId", "fanUsername"
     FROM ai_conversations
     WHERE "creatorId" = $1
       AND platform = $2
       AND (
         "lastInboundAt" > NOW() - ($3 * INTERVAL '1 millisecond')
         OR "lastMessageAt" > NOW() - ($3 * INTERVAL '1 millisecond')
       )
     ORDER BY GREATEST("lastInboundAt", "lastMessageAt") DESC NULLS LAST
     LIMIT $4`,
    [creatorId, platform, windowMs, fetchLimit]
  );
  return (result.rows || [])
    .filter((row) => {
      const id = asChatId(row.platformChatId);
      return id && !skip.has(id);
    })
    .slice(0, Math.max(Number(limit) || RECENT_ACTIVE_LIMIT, 1));
}

module.exports = {
  RECENT_ACTIVE_MS,
  RECENT_ACTIVE_LIMIT,
  listRecentActiveConversations,
};
