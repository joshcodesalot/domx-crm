const pool = require('../../../db/pool');
const fourBasedClient = require('../../fourBasedClient');
const { loadFourBasedCreator } = require('../../platformCreatorSession');
const { getAiFlags } = require('../../appSettings');
const { MODES } = require('../contracts');
const { resolveEffectiveAiMode } = require('../flags');
const { ingestConversation } = require('../ingest');
const { sanitizeFanUsername } = require('../names');

const POLL_MS = 15_000;
const PAGE_LIMIT = 15;
const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000];
const BACKOFF_CAP_MS = 5 * 60_000;
const FOURBASED_COINS_PER_DOLLAR = 121;

let schedulerTimer = null;
let ticking = false;
const backoffByCreator = new Map();

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeList(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function fourBasedFanId(chat, providerUserId) {
  const mine = String(providerUserId || '');
  const users = Array.isArray(chat?.users) ? chat.users : [];
  const otherUser = users.find((user) => {
    const id = String(user?._id || user?.id || '').trim();
    return id && id !== mine;
  });
  if (otherUser?._id) return String(otherUser._id);
  if (otherUser?.id) return String(otherUser.id);
  const ids = Array.isArray(chat?.user_ids) ? chat.user_ids : [];
  const otherId = ids.find((id) => String(id || '').trim() && String(id) !== mine);
  if (otherId) return String(otherId);
  return null;
}

function fourBasedFanUsername(chat, providerUserId) {
  const mine = String(providerUserId || '');
  const users = Array.isArray(chat?.users) ? chat.users : [];
  const otherUser = users.find((user) => {
    const id = String(user?._id || user?.id || '').trim();
    return id && id !== mine;
  });
  return sanitizeFanUsername(
    otherUser?.username || otherUser?.name || otherUser?.displayName
  );
}

function isUnreadFourBasedChat(chat, providerUserId) {
  if (!chat || !chat._id) return false;
  const raw = chat.unread_message_count;
  if (raw != null && raw !== '') {
    const count = Number(raw);
    if (Number.isFinite(count)) return count > 0;
  }
  const lastUser = String(chat.last_message?.user_id || '').trim();
  if (!lastUser) return false;
  return lastUser !== String(providerUserId || '');
}

function mapFourBasedMessagesForIngest(messages, providerUserId) {
  const mapped = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (Array.isArray(msg.deleted_user_ids) && msg.deleted_user_ids.length > 0) {
      continue;
    }
    const platformMessageId = String(msg?._id || '').trim();
    if (!platformMessageId) continue;
    const mine = Boolean(
      providerUserId && msg.user_id && msg.user_id === providerUserId
    );
    const priceCoins = msg.file_stack?.price;
    const isPpv = typeof priceCoins === 'number' && priceCoins > 0;
    mapped.push({
      platformMessageId,
      direction: mine ? 'outbound' : 'inbound',
      senderRole: mine ? 'creator' : 'fan',
      text: asText(msg.message),
      hasMedia: Boolean(msg.file_stack || msg.file_stack_id),
      isPpv,
      priceNet:
        isPpv && typeof priceCoins === 'number'
          ? priceCoins / FOURBASED_COINS_PER_DOLLAR
          : null,
      sentAt: msg.created_at || null,
    });
  }
  return mapped;
}

const POLL_MODES = new Set([
  MODES.SHADOW,
  MODES.SUGGEST_ONLY,
  MODES.AUTO_LOW_RISK,
  MODES.AUTO,
]);

function selectEligibleCreators(rows, globalFlags) {
  if (!globalFlags?.enabled) return [];
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => {
    if (!row || row.platform !== '4based') return false;
    if (row.connectionStatus !== 'connected') return false;
    if (row.paused) return false;
    if (!POLL_MODES.has(row.mode)) return false;
    const effective = resolveEffectiveAiMode({
      global: globalFlags,
      creator: row,
    });
    return POLL_MODES.has(effective);
  });
}

function nextBackoffMs(failures) {
  const step = BACKOFF_STEPS_MS[Math.min(Math.max(failures, 1) - 1, BACKOFF_STEPS_MS.length - 1)];
  return Math.min(step, BACKOFF_CAP_MS);
}

function isBackedOff(creatorId, now = Date.now()) {
  const entry = backoffByCreator.get(creatorId);
  return Boolean(entry && entry.until > now);
}

function recordSuccess(creatorId) {
  backoffByCreator.delete(creatorId);
}

function recordFailure(creatorId, now = Date.now()) {
  const prev = backoffByCreator.get(creatorId) || { failures: 0 };
  const failures = prev.failures + 1;
  backoffByCreator.set(creatorId, {
    failures,
    until: now + nextBackoffMs(failures),
  });
}

async function defaultLoadEligibleRows(client = pool) {
  const result = await client.query(
    `SELECT c.id, c.platform, c."connectionStatus",
            s.mode, s.paused
     FROM creators c
     JOIN ai_creator_settings s ON s."creatorId" = c.id
     WHERE c.platform = '4based'`
  );
  return result.rows;
}

async function pollCreator(row, deps) {
  const loaded = await deps.loadFourBasedCreator(row.id);
  if (loaded?.error || !loaded?.creator) {
    throw new Error(loaded?.error?.message || 'Failed to load 4based creator');
  }
  const creator = loaded.creator;
  const chatsPayload = await deps.listChats(creator, {
    limit: PAGE_LIMIT,
    listName: 'unread',
  });
  const chats = normalizeList(chatsPayload).filter((chat) =>
    isUnreadFourBasedChat(chat, creator.providerUserId || null)
  );

  for (const chat of chats) {
    const messagesPayload = await deps.getMessages(creator, chat._id, {
      limit: PAGE_LIMIT,
    });
    const mapped = mapFourBasedMessagesForIngest(
      normalizeList(messagesPayload),
      creator.providerUserId || null
    );
    if (mapped.length === 0) continue;
    await deps.ingestConversation({
      creatorId: row.id,
      platform: '4based',
      platformChatId: String(chat._id),
      platformFanId: fourBasedFanId(chat, creator.providerUserId || null),
      fanUsername: fourBasedFanUsername(chat, creator.providerUserId || null),
      source: 'poll',
      messages: mapped,
    });
  }
}

async function tick(deps = {}) {
  if (ticking) return { skipped: true, reason: 'busy' };
  ticking = true;
  const d = {
    getAiFlags: deps.getAiFlags || getAiFlags,
    loadEligibleRows: deps.loadEligibleRows || defaultLoadEligibleRows,
    loadFourBasedCreator: deps.loadFourBasedCreator || loadFourBasedCreator,
    listChats: deps.listChats || fourBasedClient.listChats.bind(fourBasedClient),
    getMessages: deps.getMessages || fourBasedClient.getMessages.bind(fourBasedClient),
    ingestConversation: deps.ingestConversation || ingestConversation,
    now: deps.now || Date.now,
  };

  try {
    const flags = await d.getAiFlags();
    if (!flags?.enabled) return { skipped: true, reason: 'ai_off' };

    const rows = selectEligibleCreators(await d.loadEligibleRows(), flags);
    let polled = 0;
    for (const row of rows) {
      if (isBackedOff(row.id, d.now())) continue;
      try {
        await pollCreator(row, d);
        recordSuccess(row.id);
        polled += 1;
      } catch (err) {
        recordFailure(row.id, d.now());
        console.error('AI 4based inbound poll error:', row.id, err?.message || err);
      }
    }
    return { skipped: false, eligible: rows.length, polled };
  } catch (err) {
    console.error('AI 4based inbound poll tick failed:', err);
    return { skipped: true, reason: 'tick_failed' };
  } finally {
    ticking = false;
  }
}

function startFourBasedInboundPoller() {
  if (schedulerTimer) return;
  const run = () => {
    void tick();
  };
  run();
  schedulerTimer = setInterval(run, POLL_MS);
  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

function stopFourBasedInboundPoller() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  ticking = false;
}

function resetPollerBackoff() {
  backoffByCreator.clear();
}

module.exports = {
  POLL_MS,
  PAGE_LIMIT,
  BACKOFF_STEPS_MS,
  BACKOFF_CAP_MS,
  selectEligibleCreators,
  mapFourBasedMessagesForIngest,
  isUnreadFourBasedChat,
  fourBasedFanId,
  fourBasedFanUsername,
  nextBackoffMs,
  isBackedOff,
  recordSuccess,
  recordFailure,
  tick,
  startFourBasedInboundPoller,
  stopFourBasedInboundPoller,
  resetPollerBackoff,
};
