const pool = require('../../../db/pool');
const { emitToUsers } = require('../../userEventBus');
const { getUserIdsWithCreatorAccess } = require('../../creatorAccess');
const { MODES, ROUTES } = require('../contracts');

const SUGGESTION_STATUSES = {
  PENDING: 'pending',
  STALE: 'stale',
  SUPERSEDED: 'superseded',
  APPROVED: 'approved',
  EDITED: 'edited',
  REJECTED: 'rejected',
  SENT: 'sent',
  FAILED: 'failed',
};

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function toSuggestionDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId || null,
    conversationId: row.conversationId || null,
    creatorId: row.creatorId || null,
    platform: row.platform || null,
    platformChatId: row.platformChatId || null,
    revision: row.revision ?? null,
    anchorInboundMessageId: row.anchorInboundMessageId || null,
    status: row.status,
    reply: row.reply || '',
    replyEnglish: row.replyEnglish || '',
    intent: row.intent || null,
    action: row.action || null,
    route: row.route || null,
    output: row.output || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function buildPendingRow({ conversation, run, output } = {}) {
  const convo = conversation && typeof conversation === 'object' ? conversation : {};
  const completed = run && typeof run === 'object' ? run : {};
  const draft = output && typeof output === 'object' ? output : {};

  return {
    conversationId: convo.id || completed.conversationId || null,
    runId: completed.id || null,
    creatorId: convo.creatorId || completed.creatorId || null,
    platform: convo.platform || completed.platform || null,
    platformChatId: convo.platformChatId || completed.platformChatId || null,
    revision: completed.revision ?? convo.revision ?? null,
    anchorInboundMessageId:
      completed.anchorInboundMessageId || convo.lastInboundPlatformMessageId || null,
    status: SUGGESTION_STATUSES.PENDING,
    reply: asText(draft.reply),
    replyEnglish: asText(draft.replyEnglish),
    intent: draft.intent || null,
    action: draft.action || null,
    route: completed.route || ROUTES.HUMAN_REVIEW,
    output: draft,
  };
}

function applySupersedePending(rows, conversationId) {
  const list = Array.isArray(rows) ? rows : [];
  let count = 0;
  for (const row of list) {
    if (row.conversationId === conversationId && row.status === SUGGESTION_STATUSES.PENDING) {
      row.status = SUGGESTION_STATUSES.SUPERSEDED;
      count += 1;
    }
  }
  return count;
}

async function supersedePending(conversationId, client = pool) {
  if (!conversationId) return 0;
  const result = await client.query(
    `UPDATE ai_suggestions
     SET status = 'superseded', "updatedAt" = NOW()
     WHERE "conversationId" = $1 AND status = 'pending'`,
    [conversationId]
  );
  return result.rowCount || 0;
}

async function insertPendingSuggestion(row, client = pool) {
  const result = await client.query(
    `INSERT INTO ai_suggestions (
       "conversationId", "runId", "creatorId", platform, "platformChatId",
       revision, "anchorInboundMessageId", status, reply, "replyEnglish",
       intent, action, route, output
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      row.conversationId,
      row.runId,
      row.creatorId,
      row.platform,
      row.platformChatId,
      row.revision,
      row.anchorInboundMessageId,
      SUGGESTION_STATUSES.PENDING,
      row.reply,
      row.replyEnglish,
      row.intent,
      row.action,
      row.route,
      row.output ? JSON.stringify(row.output) : null,
    ]
  );
  return result.rows[0];
}

async function persistPendingSuggestion(input = {}, deps = {}) {
  const row = buildPendingRow(input);
  if (!row.conversationId) return null;
  if (input.conversation?.aiIgnored) return null;

  const isIgnored =
    deps.isConversationIgnored ||
    (async (conversationId, client = pool) => {
      const result = await client.query(
        `SELECT "aiIgnored" FROM ai_conversations WHERE id = $1`,
        [conversationId]
      );
      return Boolean(result.rows[0]?.aiIgnored);
    });
  const client = deps.client;
  if (await isIgnored(row.conversationId, client)) return null;

  const doSupersede = deps.supersedePending || supersedePending;
  const doInsert = deps.insertPendingSuggestion || insertPendingSuggestion;

  await doSupersede(row.conversationId, client);
  return doInsert(row, client);
}

async function getSuggestionById(id, client = pool) {
  if (!id) return null;
  const result = await client.query(`SELECT * FROM ai_suggestions WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function updateSuggestionStatus(id, patch, client = pool) {
  const result = await client.query(
    `UPDATE ai_suggestions
     SET status = $2,
         reply = COALESCE($3, reply),
         "replyEnglish" = COALESCE($4, "replyEnglish"),
         "sentPlatformMessageId" = COALESCE($5, "sentPlatformMessageId"),
         "reviewedBy" = COALESCE($6, "reviewedBy"),
         "reviewedAt" = COALESCE($7, "reviewedAt"),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      patch.status,
      patch.reply ?? null,
      patch.replyEnglish ?? null,
      patch.sentPlatformMessageId ?? null,
      patch.reviewedBy ?? null,
      patch.reviewedAt ?? null,
    ]
  );
  return result.rows[0] || null;
}

async function getPendingSuggestion(conversationId, client = pool) {
  if (!conversationId) return null;
  const result = await client.query(
    `SELECT *
     FROM ai_suggestions
     WHERE "conversationId" = $1 AND status = 'pending'
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] || null;
}

async function getPendingSuggestionByChat(
  { creatorId, platform, platformChatId } = {},
  client = pool
) {
  if (!creatorId || !platform || !platformChatId) return null;
  const result = await client.query(
    `SELECT s.*
     FROM ai_suggestions s
     JOIN ai_conversations c ON c.id = s."conversationId"
     WHERE c."creatorId" = $1
       AND c.platform = $2
       AND c."platformChatId" = $3
       AND s.status = 'pending'
     ORDER BY s."createdAt" DESC
     LIMIT 1`,
    [creatorId, platform, platformChatId]
  );
  return result.rows[0] || null;
}

function toSuggestionEvent(suggestion) {
  const row = suggestion && typeof suggestion === 'object' ? suggestion : {};
  const output = row.output && typeof row.output === 'object' ? row.output : {};
  return {
    type: 'ai:suggestion',
    suggestionId: row.id || null,
    runId: row.runId || null,
    creatorId: row.creatorId || null,
    platform: row.platform || null,
    platformChatId: row.platformChatId || null,
    conversationId: row.conversationId || null,
    revision: row.revision ?? null,
    anchorInboundMessageId: row.anchorInboundMessageId || null,
    status: row.status || SUGGESTION_STATUSES.PENDING,
    reply: row.reply || '',
    replyEnglish: row.replyEnglish || '',
    intent: row.intent || null,
    action: row.action || output.action || null,
    mediaId: output.mediaId || null,
    price: output.price ?? null,
    route: row.route || null,
  };
}

async function takeoverConversation({ conversationId, userId }, client = pool) {
  const convo = await client.query(
    `SELECT id, "creatorId" FROM ai_conversations WHERE id = $1`,
    [conversationId]
  );
  const conversation = convo.rows[0];
  if (!conversation) return null;

  await client.query(
    `INSERT INTO ai_creator_settings ("creatorId", mode, paused, "takeoverByUserId", "takeoverAt")
     VALUES ($1, 'human_takeover', false, $2, NOW())
     ON CONFLICT ("creatorId") DO UPDATE SET
       mode = 'human_takeover',
       "takeoverByUserId" = EXCLUDED."takeoverByUserId",
       "takeoverAt" = NOW(),
       "updatedAt" = NOW()`,
    [conversation.creatorId, userId || null]
  );
  const updated = await client.query(
    `UPDATE ai_conversations
     SET "humanTakeover" = true, "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [conversationId]
  );
  return updated.rows[0] || conversation;
}

async function resumeConversation({ conversationId }, client = pool) {
  const convo = await client.query(
    `SELECT id, "creatorId" FROM ai_conversations WHERE id = $1`,
    [conversationId]
  );
  const conversation = convo.rows[0];
  if (!conversation) return null;

  await client.query(
    `INSERT INTO ai_creator_settings ("creatorId", mode, paused, "takeoverByUserId", "takeoverAt")
     VALUES ($1, 'suggest_only', false, NULL, NULL)
     ON CONFLICT ("creatorId") DO UPDATE SET
       mode = 'suggest_only',
       "takeoverByUserId" = NULL,
       "takeoverAt" = NULL,
       "updatedAt" = NOW()`,
    [conversation.creatorId]
  );
  const updated = await client.query(
    `UPDATE ai_conversations
     SET "humanTakeover" = false, "aiPaused" = false, "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [conversationId]
  );
  return updated.rows[0] || conversation;
}

async function pauseConversation({ conversationId }, client = pool) {
  const convo = await client.query(
    `SELECT id FROM ai_conversations WHERE id = $1`,
    [conversationId]
  );
  const conversation = convo.rows[0];
  if (!conversation) return null;

  const updated = await client.query(
    `UPDATE ai_conversations
     SET "aiPaused" = true, "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [conversationId]
  );
  return updated.rows[0] || conversation;
}

function toConversationFlags(row) {
  if (!row) return null;
  return {
    conversationId: row.id,
    aiIgnored: Boolean(row.aiIgnored),
    aiPaused: Boolean(row.aiPaused),
    humanTakeover: Boolean(row.humanTakeover),
  };
}

async function getConversationByChat(
  { creatorId, platform, platformChatId } = {},
  client = pool
) {
  if (!creatorId || !platform || !platformChatId) return null;
  const result = await client.query(
    `SELECT id, "aiIgnored", "aiPaused", "humanTakeover"
     FROM ai_conversations
     WHERE "creatorId" = $1 AND platform = $2 AND "platformChatId" = $3`,
    [creatorId, platform, platformChatId]
  );
  return toConversationFlags(result.rows[0] || null);
}

async function ignoreConversation({ conversationId, userId }, client = pool) {
  const convo = await client.query(
    `SELECT id FROM ai_conversations WHERE id = $1`,
    [conversationId]
  );
  const conversation = convo.rows[0];
  if (!conversation) return null;

  const updated = await client.query(
    `UPDATE ai_conversations
     SET "aiIgnored" = true,
         "ignoredAt" = NOW(),
         "ignoredByUserId" = $2,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [conversationId, userId || null]
  );
  await supersedePending(conversationId, client);
  return updated.rows[0] || conversation;
}

async function unignoreConversation({ conversationId }, client = pool) {
  const convo = await client.query(
    `SELECT id FROM ai_conversations WHERE id = $1`,
    [conversationId]
  );
  const conversation = convo.rows[0];
  if (!conversation) return null;

  const updated = await client.query(
    `UPDATE ai_conversations
     SET "aiIgnored" = false,
         "ignoredAt" = NULL,
         "ignoredByUserId" = NULL,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [conversationId]
  );
  return updated.rows[0] || conversation;
}

async function ignoreConversationByChat(
  { creatorId, platform, platformChatId, userId } = {},
  client = pool
) {
  if (!creatorId || !platform || !platformChatId) return null;
  const upserted = await client.query(
    `INSERT INTO ai_conversations ("creatorId", platform, "platformChatId")
     VALUES ($1, $2, $3)
     ON CONFLICT ("creatorId", platform, "platformChatId") DO UPDATE SET
       "updatedAt" = ai_conversations."updatedAt"
     RETURNING id`,
    [creatorId, platform, String(platformChatId)]
  );
  const id = upserted.rows[0]?.id;
  if (!id) return null;
  return ignoreConversation({ conversationId: id, userId }, client);
}

async function emitSuggestionEvent(suggestion, { mode } = {}, deps = {}) {
  if (!suggestion) return { emitted: false, reason: 'missing' };
  if (mode === MODES.SHADOW) return { emitted: false, reason: 'shadow' };

  const loadAccess = deps.getUserIdsWithCreatorAccess || getUserIdsWithCreatorAccess;
  const emit = deps.emitToUsers || emitToUsers;
  const userIds = await loadAccess(suggestion.creatorId);
  emit(userIds, toSuggestionEvent(suggestion));
  return { emitted: true };
}

module.exports = {
  SUGGESTION_STATUSES,
  toSuggestionDto,
  buildPendingRow,
  applySupersedePending,
  supersedePending,
  persistPendingSuggestion,
  getSuggestionById,
  updateSuggestionStatus,
  getPendingSuggestion,
  getPendingSuggestionByChat,
  toSuggestionEvent,
  emitSuggestionEvent,
  takeoverConversation,
  resumeConversation,
  pauseConversation,
  ignoreConversation,
  unignoreConversation,
  ignoreConversationByChat,
  getConversationByChat,
  toConversationFlags,
};
