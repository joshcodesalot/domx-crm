const pool = require('../../../db/pool');
const { getAiFlags } = require('../../appSettings');
const { userSeesAllCreators } = require('../../creatorAccess');
const { MODES, defaultCreatorAiSettings } = require('../contracts');
const { resolveEffectiveAiMode } = require('../flags');

const QUEUE_BUCKETS = {
  PAUSED: 'paused',
  TAKEN_OVER: 'taken_over',
  NEEDS_REVIEW: 'needs_review',
  AI_HANDLING: 'ai_handling',
};

const QUEUE_BUCKET_VALUES = Object.values(QUEUE_BUCKETS);

function emptyCounts() {
  return {
    [QUEUE_BUCKETS.NEEDS_REVIEW]: 0,
    [QUEUE_BUCKETS.AI_HANDLING]: 0,
    [QUEUE_BUCKETS.TAKEN_OVER]: 0,
    [QUEUE_BUCKETS.PAUSED]: 0,
  };
}

function classifyQueueBucket({
  settings,
  conversation,
  pendingSuggestion,
  effectiveMode,
} = {}) {
  const paused = Boolean(settings?.paused || conversation?.aiPaused);
  if (paused) return QUEUE_BUCKETS.PAUSED;

  const takeover =
    Boolean(conversation?.humanTakeover) ||
    settings?.mode === MODES.HUMAN_TAKEOVER;
  if (takeover) return QUEUE_BUCKETS.TAKEN_OVER;

  const pending = Boolean(
    pendingSuggestion && pendingSuggestion.status === 'pending'
  );
  if (pending && effectiveMode !== MODES.SHADOW) {
    return QUEUE_BUCKETS.NEEDS_REVIEW;
  }

  if (
    effectiveMode === MODES.SHADOW ||
    effectiveMode === MODES.SUGGEST_ONLY ||
    effectiveMode === MODES.AUTO_LOW_RISK ||
    effectiveMode === MODES.AUTO
  ) {
    return QUEUE_BUCKETS.AI_HANDLING;
  }

  return null;
}

function toQueueRow(row, bucket, effectiveMode) {
  return {
    conversationId: row.conversationId,
    creatorId: row.creatorId,
    creatorName: row.creatorName || '',
    platform: row.platform,
    platformChatId: row.platformChatId,
    platformFanId: row.platformFanId || null,
    bucket,
    mode: row.mode || defaultCreatorAiSettings().mode,
    effectiveMode,
    paused: Boolean(row.paused || row.aiPaused),
    humanTakeover: Boolean(row.humanTakeover),
    lastInboundAt: row.lastInboundAt || null,
    lastMessageAt: row.lastMessageAt || null,
    suggestion: row.suggestionId
      ? {
          id: row.suggestionId,
          status: row.suggestionStatus || 'pending',
          reply: row.reply || '',
          replyEnglish: row.replyEnglish || '',
          intent: row.intent || null,
          updatedAt: row.suggestionUpdatedAt || null,
        }
      : null,
  };
}

async function loadQueueRows(
  { creatorId, platform, userId, seeAll } = {},
  client = pool
) {
  const params = [];
  const where = [];

  if (creatorId) {
    params.push(creatorId);
    where.push(`conv."creatorId" = $${params.length}`);
  }
  if (platform) {
    params.push(platform);
    where.push(`conv.platform = $${params.length}`);
  }
  if (!seeAll) {
    params.push(userId);
    where.push(
      `conv."creatorId" IN (SELECT "creatorId" FROM creator_staff_assignments WHERE "userId" = $${params.length})`
    );
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await client.query(
    `SELECT
       conv.id AS "conversationId",
       conv."creatorId",
       cr."displayName" AS "creatorName",
       conv.platform,
       conv."platformChatId",
       conv."platformFanId",
       conv."humanTakeover",
       conv."aiPaused",
       conv."lastInboundAt",
       conv."lastMessageAt",
       COALESCE(st.mode, 'off') AS mode,
       COALESCE(st.paused, false) AS paused,
       s.id AS "suggestionId",
       s.status AS "suggestionStatus",
       s.reply,
       s."replyEnglish",
       s.intent,
       s."updatedAt" AS "suggestionUpdatedAt"
     FROM ai_conversations conv
     JOIN creators cr ON cr.id = conv."creatorId"
     LEFT JOIN ai_creator_settings st ON st."creatorId" = conv."creatorId"
     LEFT JOIN LATERAL (
       SELECT id, status, reply, "replyEnglish", intent, "updatedAt"
       FROM ai_suggestions
       WHERE "conversationId" = conv.id AND status = 'pending'
       ORDER BY "createdAt" DESC
       LIMIT 1
     ) s ON true
     ${clause}
     ORDER BY conv."lastMessageAt" DESC NULLS LAST, conv."updatedAt" DESC
     LIMIT 1000`,
    params
  );
  return result.rows;
}

function buildQueueItems(rows, globalFlags) {
  const counts = emptyCounts();
  const items = [];

  for (const row of rows) {
    const settings = {
      mode: row.mode || defaultCreatorAiSettings().mode,
      paused: Boolean(row.paused),
    };
    const conversation = {
      humanTakeover: Boolean(row.humanTakeover),
      aiPaused: Boolean(row.aiPaused),
    };
    const pendingSuggestion = row.suggestionId
      ? { status: row.suggestionStatus || 'pending' }
      : null;
    const effectiveMode = resolveEffectiveAiMode({
      global: globalFlags,
      creator: settings,
    });
    const bucket = classifyQueueBucket({
      settings,
      conversation,
      pendingSuggestion,
      effectiveMode,
    });
    if (!bucket) continue;
    counts[bucket] += 1;
    items.push(toQueueRow(row, bucket, effectiveMode));
  }

  return { items, counts };
}

async function listQueue(
  { bucket, creatorId, platform, user, limit } = {},
  deps = {}
) {
  const flags = deps.getAiFlags ? await deps.getAiFlags() : await getAiFlags();
  const seeAll = userSeesAllCreators(user);
  const loadRows = deps.loadQueueRows || loadQueueRows;
  const rows = await loadRows({
    creatorId: creatorId || null,
    platform: platform || null,
    userId: user?.id || null,
    seeAll,
  });
  const { items, counts } = buildQueueItems(rows, flags);
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const filtered = QUEUE_BUCKET_VALUES.includes(bucket)
    ? items.filter((item) => item.bucket === bucket)
    : items;
  return {
    items: filtered.slice(0, max),
    counts,
  };
}

module.exports = {
  QUEUE_BUCKETS,
  QUEUE_BUCKET_VALUES,
  classifyQueueBucket,
  toQueueRow,
  buildQueueItems,
  emptyCounts,
  listQueue,
};
