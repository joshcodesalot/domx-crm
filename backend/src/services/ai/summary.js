const pool = require('../../db/pool');

const SESSION_GAP_THRESHOLD_HOURS = 12;
const SUMMARY_MESSAGE_LIMIT = 20;
const SUMMARY_LINE_CHARS = 200;
const SUMMARY_TOTAL_CHARS = 1500;

const SECRET_KEYS = new Set([
  'encryptedloginpassword',
  'accesstoken',
  'refreshtoken',
  'proxy',
  'customproxy',
  'token',
  'password',
  'cookies',
  'cookie',
  'jwt',
]);

function isSecretKey(key) {
  return SECRET_KEYS.has(String(key || '').toLowerCase());
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function messageTimeMs(msg) {
  if (!msg?.sentAt) return null;
  const ms = new Date(msg.sentAt).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function sortBySentAt(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((msg) => msg && typeof msg === 'object')
    .slice()
    .sort((a, b) => (messageTimeMs(a) || 0) - (messageTimeMs(b) || 0));
}

function newestInbound(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.direction === 'inbound' && messageTimeMs(msg) != null) {
      return msg;
    }
  }
  return null;
}

function roleLabel(msg) {
  if (msg.senderRole === 'creator' || msg.direction === 'outbound') return 'creator';
  if (msg.senderRole === 'system') return 'system';
  return 'fan';
}

function planSessionSummary(messages, now) {
  const sorted = sortBySentAt(messages);
  const inbound = newestInbound(sorted);
  const newestAt = inbound ? messageTimeMs(inbound) : null;
  if (newestAt == null) {
    return { shouldWrite: false, gapHours: null, previousMessages: [] };
  }

  const cutoffMs = newestAt - SESSION_GAP_THRESHOLD_HOURS * 36e5;
  const previousMessages = sorted.filter((msg) => {
    const ms = messageTimeMs(msg);
    return ms != null && ms <= cutoffMs;
  });
  if (previousMessages.length === 0) {
    return { shouldWrite: false, gapHours: null, previousMessages: [] };
  }

  const lastPrevious = previousMessages[previousMessages.length - 1];
  const lastPreviousAt = messageTimeMs(lastPrevious);
  const gapHours =
    lastPreviousAt == null
      ? null
      : Math.round(((newestAt - lastPreviousAt) / 36e5) * 10) / 10;

  if (gapHours == null || gapHours <= SESSION_GAP_THRESHOLD_HOURS) {
    return { shouldWrite: false, gapHours, previousMessages };
  }

  return {
    shouldWrite: true,
    gapHours,
    uptoPlatformMessageId: String(lastPrevious.platformMessageId || '').trim() || null,
    uptoSentAt: lastPrevious.sentAt
      ? new Date(lastPrevious.sentAt).toISOString()
      : null,
    previousMessages,
  };
}

function formatSessionSummary(messages, gapHours) {
  const lines = [];
  const capped = sortBySentAt(messages).slice(-SUMMARY_MESSAGE_LIMIT);
  for (const msg of capped) {
    if (!msg || typeof msg !== 'object') continue;
    if (Object.keys(msg).some((key) => isSecretKey(key))) continue;
    const text = asText(msg.text).trim().slice(0, SUMMARY_LINE_CHARS);
    if (!text) continue;
    lines.push(`[${roleLabel(msg)}] ${text}`);
  }
  if (lines.length === 0) return null;

  const gapLabel =
    gapHours != null && Number.isFinite(Number(gapHours))
      ? `Previous session (~${Number(gapHours)}h gap):`
      : 'Previous session:';
  let body = `${gapLabel}\n${lines.join('\n')}`;
  if (body.length > SUMMARY_TOTAL_CHARS) {
    body = body.slice(0, SUMMARY_TOTAL_CHARS);
  }
  return body;
}

async function getLatestSessionSummary(conversationId, client = pool) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const result = await client.query(
    `SELECT summary
     FROM ai_conversation_summaries
     WHERE "conversationId" = $1
     ORDER BY "createdAt" DESC, "uptoSentAt" DESC NULLS LAST
     LIMIT 1`,
    [id]
  );
  const summary = asText(result.rows[0]?.summary).trim();
  return summary || null;
}

async function maybeWriteSessionSummary(
  { conversationId, messages, now } = {},
  client = pool
) {
  const id = String(conversationId || '').trim();
  if (!id) return null;

  try {
    const plan = planSessionSummary(messages, now);
    const summary =
      plan.shouldWrite && plan.uptoPlatformMessageId
        ? formatSessionSummary(plan.previousMessages, plan.gapHours)
        : null;

    if (summary) {
      await client.query(
        `INSERT INTO ai_conversation_summaries (
           "conversationId", "uptoPlatformMessageId", "uptoSentAt", "gapHours", summary
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("conversationId", "uptoPlatformMessageId")
           WHERE "uptoPlatformMessageId" IS NOT NULL
         DO NOTHING`,
        [
          id,
          plan.uptoPlatformMessageId,
          plan.uptoSentAt,
          plan.gapHours,
          summary,
        ]
      );
    }

    return getLatestSessionSummary(id, client);
  } catch (err) {
    console.error('AI session summary error:', err);
    try {
      return await getLatestSessionSummary(id, client);
    } catch {
      return null;
    }
  }
}

module.exports = {
  SESSION_GAP_THRESHOLD_HOURS,
  SUMMARY_MESSAGE_LIMIT,
  SUMMARY_LINE_CHARS,
  SUMMARY_TOTAL_CHARS,
  planSessionSummary,
  formatSessionSummary,
  getLatestSessionSummary,
  maybeWriteSessionSummary,
};
