const pool = require('../../../db/pool');
const maloumClient = require('../../maloumClient');
const fourBasedClient = require('../../fourBasedClient');

const CHAT_NOT_FOUND_RE = /chat cannot be found/i;
const DEAD_CHAT_SKIP_MS = 5 * 60_000;
const deadChatUntil = new Map();

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function isChatNotFoundError(err) {
  if (!err) return false;
  if (Number(err.status) === 404) return true;
  return CHAT_NOT_FOUND_RE.test(asText(err.message));
}

function deadChatKey(creatorId, chatId) {
  return `${creatorId || ''}:${chatId || ''}`;
}

function isDeadChatSkipped(creatorId, chatId, now = Date.now()) {
  const until = deadChatUntil.get(deadChatKey(creatorId, chatId));
  return Boolean(until && until > now);
}

function markDeadChat(creatorId, chatId, now = Date.now()) {
  if (!creatorId || !chatId) return;
  deadChatUntil.set(deadChatKey(creatorId, chatId), now + DEAD_CHAT_SKIP_MS);
}

function resetDeadChatSkips() {
  deadChatUntil.clear();
}

function extractChatId(payload) {
  if (!payload) return null;
  if (Array.isArray(payload) && payload[0]?._id) return String(payload[0]._id);
  if (payload._id) return String(payload._id);
  if (payload.id != null && String(payload.id).trim()) return String(payload.id);
  if (payload.chat?._id) return String(payload.chat._id);
  if (payload.chat?.id != null) return String(payload.chat.id);
  return null;
}

async function resolveMaloumChatId(
  { creator, platformChatId, platformFanId } = {},
  deps = {}
) {
  const getChat = deps.getChat || maloumClient.getChat.bind(maloumClient);
  const createChat = deps.createChat || maloumClient.createChat.bind(maloumClient);
  const stored = asText(platformChatId).trim();
  if (stored) {
    try {
      const chat = await getChat(creator, stored);
      const id = extractChatId(chat) || stored;
      if (id) return { platformChatId: id, source: 'getChat' };
    } catch (err) {
      if (!isChatNotFoundError(err)) throw err;
    }
  }
  const fanId = asText(platformFanId).trim();
  if (!fanId) return { platformChatId: null, source: null };
  const created = await createChat(creator, fanId);
  const id = extractChatId(created);
  return { platformChatId: id || null, source: id ? 'createChat' : null };
}

async function resolveFourBasedChatId(
  { creator, platformChatId, platformFanId } = {},
  deps = {}
) {
  const getChatByUser =
    deps.getChatByUser || fourBasedClient.getChatByUser.bind(fourBasedClient);
  const createChatByUser =
    deps.createChatByUser || fourBasedClient.createChatByUser.bind(fourBasedClient);
  const fanId = asText(platformFanId).trim();
  if (fanId) {
    try {
      const existing = await getChatByUser(creator, fanId);
      const existingId = extractChatId(existing);
      if (existingId) return { platformChatId: existingId, source: 'getChatByUser' };
    } catch (err) {
      if (!isChatNotFoundError(err) && Number(err?.status) !== 404) throw err;
    }
    const created = await createChatByUser(creator, fanId);
    const id = extractChatId(created);
    if (id) return { platformChatId: id, source: 'createChatByUser' };
  }
  const stored = asText(platformChatId).trim();
  return { platformChatId: stored || null, source: stored ? 'stored' : null };
}

async function resolvePlatformChat(
  { platform, creator, platformChatId, platformFanId } = {},
  deps = {}
) {
  if (platform === 'maloum') {
    return resolveMaloumChatId({ creator, platformChatId, platformFanId }, deps);
  }
  if (platform === '4based') {
    return resolveFourBasedChatId({ creator, platformChatId, platformFanId }, deps);
  }
  return { platformChatId: asText(platformChatId).trim() || null, source: 'stored' };
}

function newerTimestamp(left, right) {
  const a = left ? Date.parse(left) : NaN;
  const b = right ? Date.parse(right) : NaN;
  if (Number.isFinite(b) && (!Number.isFinite(a) || b >= a)) return right;
  return left;
}

async function mergeConversationPointers(from, ontoId, client = pool) {
  const result = await client.query(
    `SELECT * FROM ai_conversations WHERE id = $1`,
    [ontoId]
  );
  const onto = result.rows[0];
  if (!onto) return null;
  const inboundAt = newerTimestamp(onto.lastInboundAt, from.lastInboundAt);
  const useFromInbound = inboundAt === from.lastInboundAt && from.lastInboundAt;
  const messageAt = newerTimestamp(onto.lastMessageAt, from.lastMessageAt);
  const merged = await client.query(
    `UPDATE ai_conversations
     SET "platformFanId" = COALESCE(ai_conversations."platformFanId", $2),
         revision = GREATEST(ai_conversations.revision, $3),
         "lastInboundPlatformMessageId" = $4,
         "lastInboundAt" = $5,
         "lastMessageAt" = $6,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      ontoId,
      from.platformFanId || null,
      Number(from.revision) || 0,
      useFromInbound
        ? from.lastInboundPlatformMessageId || onto.lastInboundPlatformMessageId
        : onto.lastInboundPlatformMessageId,
      inboundAt || onto.lastInboundAt || null,
      messageAt || onto.lastMessageAt || null,
    ]
  );
  return merged.rows[0] || onto;
}

async function updateSuggestionChat(
  { suggestionId, platformChatId, conversationId } = {},
  client = pool
) {
  if (!suggestionId) return null;
  const result = await client.query(
    `UPDATE ai_suggestions
     SET "platformChatId" = COALESCE($2, "platformChatId"),
         "conversationId" = COALESCE($3, "conversationId"),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [suggestionId, platformChatId || null, conversationId || null]
  );
  return result.rows[0] || null;
}

async function persistResolvedChatId(
  { conversation, suggestion, newChatId, client = pool } = {}
) {
  const current = asText(conversation?.platformChatId).trim();
  const resolved = asText(newChatId).trim();
  if (!conversation?.id || !resolved) {
    return {
      conversation,
      suggestion,
      platformChatId: resolved || current || null,
    };
  }
  if (resolved === current) {
    return { conversation, suggestion, platformChatId: resolved };
  }

  try {
    const updated = await client.query(
      `UPDATE ai_conversations
       SET "platformChatId" = $2, "updatedAt" = NOW()
       WHERE id = $1
       RETURNING *`,
      [conversation.id, resolved]
    );
    const convo = updated.rows[0] || { ...conversation, platformChatId: resolved };
    const sug = suggestion?.id
      ? await updateSuggestionChat(
          {
            suggestionId: suggestion.id,
            platformChatId: resolved,
            conversationId: convo.id,
          },
          client
        )
      : suggestion;
    return {
      conversation: convo,
      suggestion: sug || suggestion,
      platformChatId: resolved,
    };
  } catch (err) {
    if (err?.code !== '23505') throw err;
    const existing = await client.query(
      `SELECT * FROM ai_conversations
       WHERE "creatorId" = $1 AND platform = $2 AND "platformChatId" = $3
       LIMIT 1`,
      [conversation.creatorId, conversation.platform, resolved]
    );
    const target = existing.rows[0];
    if (!target) throw err;
    const merged = await mergeConversationPointers(conversation, target.id, client);
    const sug = suggestion?.id
      ? await updateSuggestionChat(
          {
            suggestionId: suggestion.id,
            platformChatId: resolved,
            conversationId: merged?.id || target.id,
          },
          client
        )
      : suggestion;
    return {
      conversation: merged || target,
      suggestion: sug || suggestion,
      platformChatId: resolved,
    };
  }
}

module.exports = {
  isChatNotFoundError,
  extractChatId,
  resolvePlatformChat,
  persistResolvedChatId,
  updateSuggestionChat,
  mergeConversationPointers,
  isDeadChatSkipped,
  markDeadChat,
  resetDeadChatSkips,
  DEAD_CHAT_SKIP_MS,
};
