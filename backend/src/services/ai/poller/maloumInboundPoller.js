const pool = require('../../../db/pool');
const maloumClient = require('../../maloumClient');
const { loadMaloumCreator } = require('../../platformCreatorSession');
const { getAiFlags } = require('../../appSettings');
const { MODES } = require('../contracts');
const { resolveEffectiveAiMode } = require('../flags');
const { ingestConversation } = require('../ingest');

const POLL_MS = 15_000;
const PAGE_LIMIT = 15;
const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000];
const BACKOFF_CAP_MS = 5 * 60_000;

let schedulerTimer = null;
let ticking = false;
const backoffByCreator = new Map();

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeList(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function maloumHasMedia(msg) {
  const content = msg?.content;
  if (!content) return false;
  return (
    (Array.isArray(content.media) && content.media.length > 0) ||
    (Array.isArray(content.thumbnails) && content.thumbnails.length > 0)
  );
}

function maloumPriceNet(msg) {
  const net = msg?.content?.price?.net;
  if (typeof net === 'number' && Number.isFinite(net)) return net;
  const fallback = msg?.content?.priceNet;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return null;
}

function mapMaloumMessagesForIngest(messages, providerUserId) {
  const mapped = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg?.domxUnsent) continue;
    const platformMessageId = String(msg?._id || '').trim();
    if (!platformMessageId) continue;
    const mine = Boolean(
      providerUserId && msg.senderId && msg.senderId === providerUserId
    );
    mapped.push({
      platformMessageId,
      direction: mine ? 'outbound' : 'inbound',
      senderRole: mine ? 'creator' : 'fan',
      text: asText(msg.content?.text),
      hasMedia: maloumHasMedia(msg),
      isPpv: msg.content?.type === 'chat_product',
      priceNet: maloumPriceNet(msg),
      sentAt: msg.sentAt || null,
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
    if (!row || row.platform !== 'maloum') return false;
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
     WHERE c.platform = 'maloum'`
  );
  return result.rows;
}

async function pollCreator(row, deps) {
  const loaded = await deps.loadMaloumCreator(row.id);
  if (loaded?.error || !loaded?.creator) {
    throw new Error(loaded?.error?.message || 'Failed to load Maloum creator');
  }
  const creator = loaded.creator;
  const chatsPayload = await deps.listChats(creator, {
    limit: PAGE_LIMIT,
    filter: 'unread',
  });
  const chats = normalizeList(chatsPayload).filter(
    (chat) => chat && chat.unreadMessages === true && chat._id
  );

  for (const chat of chats) {
    const messagesPayload = await deps.getMessages(creator, chat._id, {
      limit: PAGE_LIMIT,
    });
    const mapped = mapMaloumMessagesForIngest(
      normalizeList(messagesPayload),
      creator.providerUserId || null
    );
    if (mapped.length === 0) continue;
    await deps.ingestConversation({
      creatorId: row.id,
      platform: 'maloum',
      platformChatId: String(chat._id),
      platformFanId: chat.chatPartner?._id ? String(chat.chatPartner._id) : null,
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
    loadMaloumCreator: deps.loadMaloumCreator || loadMaloumCreator,
    listChats: deps.listChats || maloumClient.listChats.bind(maloumClient),
    getMessages: deps.getMessages || maloumClient.getMessages.bind(maloumClient),
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
        console.error('AI Maloum inbound poll error:', row.id, err?.message || err);
      }
    }
    return { skipped: false, eligible: rows.length, polled };
  } catch (err) {
    console.error('AI Maloum inbound poll tick failed:', err);
    return { skipped: true, reason: 'tick_failed' };
  } finally {
    ticking = false;
  }
}

function startMaloumInboundPoller() {
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

function stopMaloumInboundPoller() {
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
  mapMaloumMessagesForIngest,
  nextBackoffMs,
  isBackedOff,
  recordSuccess,
  recordFailure,
  tick,
  startMaloumInboundPoller,
  stopMaloumInboundPoller,
  resetPollerBackoff,
};
