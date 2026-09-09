const pool = require('../../../db/pool');
const maloumClient = require('../../maloumClient');
const fourBasedClient = require('../../fourBasedClient');
const telegramWorker = require('../../telegramWorker');
const {
  loadMaloumCreator,
  loadFourBasedCreator,
} = require('../../platformCreatorSession');
const { ingestConversation, MAX_BACKFILL_MESSAGES } = require('../ingest');
const { mapMaloumMessagesForIngest } = require('../poller/maloumInboundPoller');
const { mapFourBasedMessagesForIngest } = require('../poller/fourBasedInboundPoller');
const { mapTelegramMessagesForIngest } = require('../poller/telegramInboundPoller');

const BACKFILL_PAGE_LIMIT = 20;
const BACKFILL_MAX_PAGES = 15;
const BACKFILL_TIMEOUT_MS = 12_000;
const THIN_PAGE = 20;

function asList(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload)) return payload;
  return [];
}

function pageNext(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload.next || null;
}

function shouldBackfill(conversation, messageCount) {
  if (!conversation?.id) return false;
  if (conversation.historyBackfilledAt) return false;
  return messageCount < THIN_PAGE;
}

async function defaultMessageCount(conversationId, client = pool) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count FROM ai_messages WHERE "conversationId" = $1`,
    [conversationId]
  );
  return Number(result.rows[0]?.count) || 0;
}

async function markBackfilled(conversationId, client = pool) {
  await client.query(
    `UPDATE ai_conversations
     SET "historyBackfilledAt" = NOW(), "updatedAt" = NOW()
     WHERE id = $1`,
    [conversationId]
  );
}

async function fetchMaloumPages({ creator, platformChatId, getMessages, now }) {
  const collected = [];
  let next;
  for (let page = 0; page < BACKFILL_MAX_PAGES; page += 1) {
    if (Date.now() - now > BACKFILL_TIMEOUT_MS) break;
    const payload = await getMessages(creator, platformChatId, {
      limit: BACKFILL_PAGE_LIMIT,
      next,
    });
    const list = asList(payload);
    collected.push(...list);
    next = pageNext(payload);
    if (!next || list.length === 0) break;
    if (collected.length >= MAX_BACKFILL_MESSAGES) break;
  }
  return collected.slice(0, MAX_BACKFILL_MESSAGES);
}

async function fetchFourBasedPages({ creator, platformChatId, getMessages, now }) {
  const collected = [];
  let offset = 0;
  for (let page = 0; page < BACKFILL_MAX_PAGES; page += 1) {
    if (Date.now() - now > BACKFILL_TIMEOUT_MS) break;
    const payload = await getMessages(creator, platformChatId, {
      limit: BACKFILL_PAGE_LIMIT,
      offset,
    });
    const list = asList(payload);
    collected.push(...list);
    if (list.length === 0) break;
    offset += list.length;
    if (collected.length >= MAX_BACKFILL_MESSAGES) break;
  }
  return collected.slice(0, MAX_BACKFILL_MESSAGES);
}

async function fetchTelegramPages({ creatorId, platformChatId, listMessages, now }) {
  const collected = [];
  let offsetId;
  let offsetDate;
  for (let page = 0; page < BACKFILL_MAX_PAGES; page += 1) {
    if (Date.now() - now > BACKFILL_TIMEOUT_MS) break;
    const payload = await listMessages(creatorId, platformChatId, {
      limit: BACKFILL_PAGE_LIMIT,
      offsetId,
      offsetDate,
      markRead: false,
    });
    const list = asList(payload);
    collected.push(...list);
    const next = payload?.next;
    const hasMore = Boolean(payload?.hasMore) && next && next.id != null;
    if (!hasMore || list.length === 0) break;
    offsetId = next.id;
    offsetDate = next.date;
    if (collected.length >= MAX_BACKFILL_MESSAGES) break;
  }
  return collected.slice(0, MAX_BACKFILL_MESSAGES);
}

async function maybeBackfillHistory(
  { conversation, creatorId, platform, platformChatId } = {},
  deps = {}
) {
  const d = {
    pool: deps.pool || pool,
    messageCount: deps.messageCount || defaultMessageCount,
    markBackfilled: deps.markBackfilled || markBackfilled,
    loadMaloumCreator: deps.loadMaloumCreator || loadMaloumCreator,
    loadFourBasedCreator: deps.loadFourBasedCreator || loadFourBasedCreator,
    getMaloumMessages:
      deps.getMaloumMessages || maloumClient.getMessages.bind(maloumClient),
    getFourBasedMessages:
      deps.getFourBasedMessages || fourBasedClient.getMessages.bind(fourBasedClient),
    listTelegramMessages:
      deps.listTelegramMessages || telegramWorker.listMessages.bind(telegramWorker),
    ingestConversation: deps.ingestConversation || ingestConversation,
    now: deps.now || Date.now,
  };

  if (!conversation?.id) return { skipped: true, reason: 'conversation_missing' };
  const count = await d.messageCount(conversation.id, d.pool);
  if (!shouldBackfill(conversation, count)) {
    return { skipped: true, reason: 'already_backfilled' };
  }

  const started = d.now();
  try {
    let mapped = [];
    if (platform === 'maloum') {
      const loaded = await d.loadMaloumCreator(creatorId);
      if (loaded?.error || !loaded?.creator) {
        throw new Error(loaded?.error?.message || 'Failed to load Maloum creator');
      }
      const raw = await fetchMaloumPages({
        creator: loaded.creator,
        platformChatId,
        getMessages: d.getMaloumMessages,
        now: started,
      });
      mapped = mapMaloumMessagesForIngest(raw, loaded.creator.providerUserId || null);
    } else if (platform === '4based') {
      const loaded = await d.loadFourBasedCreator(creatorId);
      if (loaded?.error || !loaded?.creator) {
        throw new Error(loaded?.error?.message || 'Failed to load 4based creator');
      }
      const raw = await fetchFourBasedPages({
        creator: loaded.creator,
        platformChatId,
        getMessages: d.getFourBasedMessages,
        now: started,
      });
      mapped = mapFourBasedMessagesForIngest(
        raw,
        loaded.creator.providerUserId || null
      );
    } else if (platform === 'telegram') {
      const raw = await fetchTelegramPages({
        creatorId,
        platformChatId,
        listMessages: d.listTelegramMessages,
        now: started,
      });
      mapped = mapTelegramMessagesForIngest(raw);
    } else {
      await d.markBackfilled(conversation.id, d.pool);
      return { skipped: true, reason: 'unsupported_platform' };
    }

    if (mapped.length > 0) {
      await d.ingestConversation({
        creatorId,
        platform,
        platformChatId,
        platformFanId: conversation.platformFanId || null,
        fanUsername: conversation.fanUsername || null,
        source: 'backfill',
        messages: mapped,
        skipProcess: true,
        maxMessages: MAX_BACKFILL_MESSAGES,
      });
    }

    await d.markBackfilled(conversation.id, d.pool);
    return {
      skipped: false,
      insertedHint: mapped.length,
      timedOut: Date.now() - started >= BACKFILL_TIMEOUT_MS,
    };
  } catch (err) {
    try {
      await d.markBackfilled(conversation.id, d.pool);
    } catch (markErr) {
      console.error('AI history backfill mark error:', markErr);
    }
    console.error('AI history backfill error:', err);
    return { skipped: true, reason: 'failed', error: err?.message || String(err) };
  }
}

module.exports = {
  BACKFILL_PAGE_LIMIT,
  BACKFILL_MAX_PAGES,
  BACKFILL_TIMEOUT_MS,
  THIN_PAGE,
  shouldBackfill,
  maybeBackfillHistory,
};
