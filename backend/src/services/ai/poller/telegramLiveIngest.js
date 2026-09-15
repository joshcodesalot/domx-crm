const pool = require('../../../db/pool');
const { getAiFlags } = require('../../appSettings');
const { ingestConversation } = require('../ingest');

async function ingestLiveTelegramMessage(creatorId, msg, deps = {}) {
  if (!creatorId || !msg || msg.isOutgoing) return { skipped: true, reason: 'outgoing' };
  const peerId = String(msg.chat?.id || msg.peerId || '').trim();
  if (!peerId) return { skipped: true, reason: 'no_peer' };

  const telegramWorker = deps.telegramWorker || require('../../telegramWorker');
  if (telegramWorker.isTelegramServiceDialog({ peerId })) {
    return { skipped: true, reason: 'service' };
  }

  const poller = deps.telegramInboundPoller || require('./telegramInboundPoller');
  const selectEligibleCreators =
    deps.selectEligibleCreators || poller.selectEligibleCreators;
  const mapTelegramMessagesForIngest =
    deps.mapTelegramMessagesForIngest || poller.mapTelegramMessagesForIngest;
  const PAGE_LIMIT = deps.PAGE_LIMIT || poller.PAGE_LIMIT;

  const getFlags = deps.getAiFlags || getAiFlags;
  const flags = await getFlags();
  if (!flags?.enabled) return { skipped: true, reason: 'ai_off' };

  const loadRow =
    deps.loadCreatorRow ||
    (async (id) => {
      const result = await pool.query(
        `SELECT c.id, c.platform, c."connectionStatus",
                s.mode, s.paused
         FROM creators c
         JOIN ai_creator_settings s ON s."creatorId" = c.id
         WHERE c.id = $1 AND c.platform = 'telegram'`,
        [id]
      );
      return result.rows[0] || null;
    });
  const row = await loadRow(creatorId);
  if (!selectEligibleCreators(row ? [row] : [], flags).length) {
    return { skipped: true, reason: 'ineligible' };
  }

  const listMessages =
    deps.listMessages || telegramWorker.listMessages.bind(telegramWorker);
  const payload = await listMessages(creatorId, peerId, {
    limit: PAGE_LIMIT || 15,
    markRead: false,
  });
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload)
      ? payload
      : [];
  const mapped = mapTelegramMessagesForIngest(messages);
  if (mapped.length === 0) return { skipped: true, reason: 'empty' };

  const ingest = deps.ingestConversation || ingestConversation;
  await ingest({
    creatorId,
    platform: 'telegram',
    platformChatId: peerId,
    platformFanId: peerId,
    source: 'live',
    skipProcess: false,
    messages: mapped,
  });
  return { skipped: false, peerId };
}

function scheduleLiveTelegramIngest(creatorId, msg) {
  Promise.resolve()
    .then(() => ingestLiveTelegramMessage(creatorId, msg))
    .catch((err) => {
      console.error('AI telegram live ingest error:', err?.message || err);
    });
}

module.exports = {
  ingestLiveTelegramMessage,
  scheduleLiveTelegramIngest,
};
