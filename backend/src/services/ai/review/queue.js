const pool = require('../../../db/pool');
const { getAiFlags } = require('../../appSettings');
const { userSeesAllCreators } = require('../../creatorAccess');
const {
  MODES,
  CONVERSATION_STATES,
  CONVERSATION_STATE_VALUES,
  defaultCreatorAiSettings,
} = require('../contracts');
const { resolveEffectiveAiMode } = require('../flags');
const { displayFanLabel } = require('../names');
const { isSuggestionStale } = require('../send/executeApprovedSend');

const INBOUND_PREVIEW_MAX = 140;

const QUEUE_BUCKETS = {
  PAUSED: 'paused',
  TAKEN_OVER: 'taken_over',
  NEEDS_REVIEW: 'needs_review',
  AI_HANDLING: 'ai_handling',
  IGNORED: 'ignored',
};

const QUEUE_BUCKET_VALUES = Object.values(QUEUE_BUCKETS);

function emptyCounts() {
  return {
    [QUEUE_BUCKETS.NEEDS_REVIEW]: 0,
    [QUEUE_BUCKETS.AI_HANDLING]: 0,
    [QUEUE_BUCKETS.TAKEN_OVER]: 0,
    [QUEUE_BUCKETS.PAUSED]: 0,
    [QUEUE_BUCKETS.IGNORED]: 0,
  };
}

function classifyQueueBucket({
  settings,
  conversation,
  pendingSuggestion,
  effectiveMode,
} = {}) {
  if (conversation?.aiIgnored) return QUEUE_BUCKETS.IGNORED;

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

function previewText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.length > INBOUND_PREVIEW_MAX
    ? text.slice(0, INBOUND_PREVIEW_MAX)
    : text;
}

function toQueueRow(row, bucket, effectiveMode) {
  const creatorPaused = Boolean(row.paused);
  const aiPaused = Boolean(row.aiPaused);
  return {
    conversationId: row.conversationId,
    creatorId: row.creatorId,
    creatorName: row.creatorName || '',
    platform: row.platform,
    platformChatId: row.platformChatId,
    platformFanId: row.platformFanId || null,
    fanUsername: row.fanUsername || null,
    fanLabel: displayFanLabel({
      nickname: row.fanNickname,
      fanLabel: row.fanLabel,
      fanUsername: row.fanUsername,
    }),
    state: row.state || CONVERSATION_STATES.NEW,
    bucket,
    mode: row.mode || defaultCreatorAiSettings().mode,
    effectiveMode,
    paused: creatorPaused || aiPaused,
    creatorPaused,
    aiPaused,
    aiIgnored: Boolean(row.aiIgnored),
    humanTakeover: Boolean(row.humanTakeover),
    lastInboundAt: row.lastInboundAt || null,
    lastMessageAt: row.lastMessageAt || null,
    lastInboundPreview: previewText(row.lastInboundPreview),
    suggestionStale: row.suggestionId
      ? isSuggestionStale(
          {
            revision: row.suggestionRevision,
            anchorInboundMessageId: row.anchorInboundMessageId,
          },
          {
            revision: row.revision,
            lastInboundPlatformMessageId: row.lastInboundPlatformMessageId,
          }
        )
      : false,
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
       conv."fanUsername",
       COALESCE(
         NULLIF(TRIM(mem.nickname), ''),
         NULLIF(TRIM(conv."fanUsername"), '')
       ) AS "fanLabel",
       mem.nickname AS "fanNickname",
       conv.state,
       conv."humanTakeover",
       conv."aiPaused",
       conv."aiIgnored",
       conv."lastInboundAt",
       conv."lastMessageAt",
       conv.revision,
       conv."lastInboundPlatformMessageId",
       COALESCE(st.mode, 'off') AS mode,
       COALESCE(st.paused, false) AS paused,
       inbound."lastInboundPreview",
       s.id AS "suggestionId",
       s.status AS "suggestionStatus",
       s.reply,
       s."replyEnglish",
       s.intent,
       s."updatedAt" AS "suggestionUpdatedAt",
       s.revision AS "suggestionRevision",
       s."anchorInboundMessageId"
     FROM ai_conversations conv
     JOIN creators cr ON cr.id = conv."creatorId"
     LEFT JOIN ai_creator_settings st ON st."creatorId" = conv."creatorId"
     LEFT JOIN ai_fan_memories mem
       ON mem."creatorId" = conv."creatorId"
      AND mem.platform = conv.platform
      AND mem."platformFanId" = conv."platformFanId"
     LEFT JOIN LATERAL (
       SELECT LEFT(text, ${INBOUND_PREVIEW_MAX}) AS "lastInboundPreview"
       FROM ai_messages
       WHERE "conversationId" = conv.id AND direction = 'inbound'
       ORDER BY "sentAt" DESC NULLS LAST, "createdAt" DESC
       LIMIT 1
     ) inbound ON true
     LEFT JOIN LATERAL (
       SELECT id, status, reply, "replyEnglish", intent, "updatedAt",
              revision, "anchorInboundMessageId"
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
      aiIgnored: Boolean(row.aiIgnored),
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
  { bucket, state, creatorId, platform, user, limit } = {},
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
  let filtered = QUEUE_BUCKET_VALUES.includes(bucket)
    ? items.filter((item) => item.bucket === bucket)
    : items;
  if (state && CONVERSATION_STATE_VALUES.includes(state)) {
    filtered = filtered.filter((item) => item.state === state);
  }
  return {
    items: filtered.slice(0, max),
    counts,
  };
}

async function listConversationMessages(conversationId, { limit } = {}, client = pool) {
  const max = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const result = await client.query(
    `SELECT "platformMessageId", direction, "senderRole", text,
            "hasMedia", "isPpv", "priceNet", "sentAt"
     FROM ai_messages
     WHERE "conversationId" = $1
     ORDER BY "sentAt" DESC NULLS LAST, "createdAt" DESC
     LIMIT $2`,
    [conversationId, max]
  );
  return result.rows.slice().reverse();
}

module.exports = {
  QUEUE_BUCKETS,
  QUEUE_BUCKET_VALUES,
  INBOUND_PREVIEW_MAX,
  classifyQueueBucket,
  toQueueRow,
  buildQueueItems,
  emptyCounts,
  listQueue,
  listConversationMessages,
};
