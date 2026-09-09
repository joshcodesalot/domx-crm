const pool = require('../../../db/pool');
const telegramWorker = require('../../telegramWorker');
const { getAiFlags } = require('../../appSettings');
const { MODES } = require('../contracts');
const { resolveEffectiveAiMode } = require('../flags');
const { ingestConversation } = require('../ingest');
const { sanitizeFanUsername } = require('../names');

const POLL_MS = 15_000;
const PAGE_LIMIT = 15;
const DIALOG_LIMIT = 80;
const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000];
const BACKOFF_CAP_MS = 5 * 60_000;

let schedulerTimer = null;
let ticking = false;
const backoffByCreator = new Map();

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeMessages(payload) {
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function mapTelegramMessagesForIngest(messages) {
  const mapped = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg?.deleted) continue;
    const platformMessageId = String(msg?.id || '').trim();
    if (!platformMessageId) continue;
    const outbound = Boolean(msg.isOutgoing);
    mapped.push({
      platformMessageId,
      direction: outbound ? 'outbound' : 'inbound',
      senderRole: outbound ? 'creator' : 'fan',
      text: asText(msg.text),
      hasMedia: Boolean(msg.hasMedia) || (Boolean(msg.kind) && msg.kind !== 'text'),
      isPpv: false,
      priceNet: null,
      sentAt: msg.date || null,
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
    if (!row || row.platform !== 'telegram') return false;
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
     WHERE c.platform = 'telegram'`
  );
  return result.rows;
}

function telegramFanUsername(dialog) {
  return sanitizeFanUsername(dialog?.username || dialog?.user?.username);
}

function isUnreadDialog(dialog) {
  return Boolean(dialog && dialog.peerId && Number(dialog.unreadCount) > 0);
}

async function pollCreator(row, deps) {
  const dialogs = await deps.listDialogs(row.id, { limit: DIALOG_LIMIT });
  const unread = (Array.isArray(dialogs) ? dialogs : []).filter((dialog) => {
    if (!isUnreadDialog(dialog)) return false;
    if (deps.isTelegramServiceDialog(dialog)) return false;
    return true;
  });

  for (const dialog of unread) {
    const peerId = String(dialog.peerId);
    const messagesPayload = await deps.listMessages(row.id, peerId, {
      limit: PAGE_LIMIT,
    });
    const mapped = mapTelegramMessagesForIngest(normalizeMessages(messagesPayload));
    if (mapped.length === 0) continue;
    await deps.ingestConversation({
      creatorId: row.id,
      platform: 'telegram',
      platformChatId: peerId,
      platformFanId: peerId,
      fanUsername: telegramFanUsername(dialog),
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
    listDialogs: deps.listDialogs || telegramWorker.listDialogs.bind(telegramWorker),
    listMessages: deps.listMessages || telegramWorker.listMessages.bind(telegramWorker),
    ingestConversation: deps.ingestConversation || ingestConversation,
    isTelegramServiceDialog:
      deps.isTelegramServiceDialog || telegramWorker.isTelegramServiceDialog,
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
        console.error('AI Telegram inbound poll error:', row.id, err?.message || err);
      }
    }
    return { skipped: false, eligible: rows.length, polled };
  } catch (err) {
    console.error('AI Telegram inbound poll tick failed:', err);
    return { skipped: true, reason: 'tick_failed' };
  } finally {
    ticking = false;
  }
}

function startTelegramInboundPoller() {
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

function stopTelegramInboundPoller() {
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
  DIALOG_LIMIT,
  BACKOFF_STEPS_MS,
  BACKOFF_CAP_MS,
  selectEligibleCreators,
  mapTelegramMessagesForIngest,
  telegramFanUsername,
  nextBackoffMs,
  isBackedOff,
  recordSuccess,
  recordFailure,
  tick,
  startTelegramInboundPoller,
  stopTelegramInboundPoller,
  resetPollerBackoff,
};
