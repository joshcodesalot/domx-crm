const pool = require('../../db/pool');
const { getAiFlags } = require('../appSettings');
const { MODES } = require('./contracts');
const { maybeCopySourceNotes } = require('./memory');

const { sanitizeFanUsername } = require('./names');

const INGEST_PLATFORMS = ['maloum', '4based', 'telegram'];
const SENDER_ROLES = new Set(['fan', 'creator', 'system']);
const MAX_INGEST_MESSAGES = 50;
const MAX_BACKFILL_MESSAGES = 300;

const CONVERSATION_UPSERT_SQL = `
INSERT INTO ai_conversations (
  "creatorId", platform, "platformChatId", "platformFanId",
  "fanUsername", "humanTakeover", "aiPaused"
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT ("creatorId", platform, "platformChatId") DO UPDATE SET
  "platformFanId" = COALESCE(EXCLUDED."platformFanId", ai_conversations."platformFanId"),
  "fanUsername" = COALESCE(EXCLUDED."fanUsername", ai_conversations."fanUsername"),
  "updatedAt" = NOW()
RETURNING *`;

function shouldPersistIngest({ globalEnabled, creatorMode } = {}) {
  if (globalEnabled) return true;
  return Boolean(creatorMode) && creatorMode !== MODES.OFF;
}

function messageTimeMs(msg) {
  if (!msg?.sentAt) return 0;
  const ms = new Date(msg.sentAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function latestByDirection(messages, direction) {
  let best = null;
  for (const msg of messages) {
    if (msg.direction !== direction) continue;
    if (!best || messageTimeMs(msg) >= messageTimeMs(best)) best = msg;
  }
  return best;
}

function latestAny(messages) {
  let best = null;
  for (const msg of messages) {
    if (!best || messageTimeMs(msg) >= messageTimeMs(best)) best = msg;
  }
  return best;
}

function normalizeIngestMessage(raw, source = 'poll') {
  if (!raw || typeof raw !== 'object') return null;
  const platformMessageId = String(raw.platformMessageId || '').trim();
  if (!platformMessageId) return null;

  const direction =
    raw.direction === 'inbound' || raw.direction === 'outbound'
      ? raw.direction
      : null;
  if (!direction) return null;

  const senderRole = SENDER_ROLES.has(raw.senderRole)
    ? raw.senderRole
    : direction === 'inbound'
      ? 'fan'
      : 'creator';

  const text = typeof raw.text === 'string' ? raw.text : '';
  const hasMedia = Boolean(raw.hasMedia);
  const isPpv = Boolean(raw.isPpv);

  let priceNet = null;
  if (raw.priceNet != null && raw.priceNet !== '') {
    const n = Number(raw.priceNet);
    if (Number.isFinite(n)) priceNet = n;
  }

  let sentAt = null;
  if (raw.sentAt) {
    const parsed = new Date(raw.sentAt);
    if (!Number.isNaN(parsed.getTime())) sentAt = parsed.toISOString();
  }

  return {
    platformMessageId,
    direction,
    senderRole,
    text,
    hasMedia,
    isPpv,
    priceNet,
    sentAt,
    source: typeof source === 'string' && source.trim() ? source.trim() : 'poll',
  };
}

function planIngest({ existingIds, messages, source, maxMessages } = {}) {
  const known = new Set(
    (existingIds || []).map((id) => String(id || '').trim()).filter(Boolean)
  );
  const seenInBatch = new Set();
  const toInsert = [];
  let inboundCount = 0;
  const cap = Math.min(
    Math.max(Number(maxMessages) || MAX_INGEST_MESSAGES, 1),
    MAX_BACKFILL_MESSAGES
  );

  for (const raw of Array.isArray(messages) ? messages : []) {
    const msg = normalizeIngestMessage(raw, source);
    if (!msg) continue;
    if (known.has(msg.platformMessageId) || seenInBatch.has(msg.platformMessageId)) {
      continue;
    }
    seenInBatch.add(msg.platformMessageId);
    toInsert.push(msg);
    if (msg.direction === 'inbound') inboundCount += 1;
    if (toInsert.length >= cap) break;
  }

  return { toInsert, inboundCount };
}

async function loadCreatorMode(creatorId, client = pool) {
  const result = await client.query(
    `SELECT mode, paused FROM ai_creator_settings WHERE "creatorId" = $1`,
    [creatorId]
  );
  return result.rows[0] || null;
}

function scheduleIncomingProcess(args) {
  setImmediate(() => {
    const { processIncomingMessage } = require('./orchestrator');
    processIncomingMessage(args).catch((err) => {
      console.error('AI inbound generate error:', err);
    });
  });
}

function shouldReplacePointer(existingAt, incomingAt) {
  if (!incomingAt) return !existingAt;
  if (!existingAt) return true;
  return new Date(incomingAt).getTime() >= new Date(existingAt).getTime();
}

function isBackfillIngest({ source, skipProcess } = {}) {
  return source === 'backfill' || skipProcess === true;
}

function nextIngestPointers({
  conversation,
  toInsert,
  inboundCount,
  source,
  skipProcess,
} = {}) {
  const convo = conversation && typeof conversation === 'object' ? conversation : {};
  const batch = Array.isArray(toInsert) ? toInsert : [];
  const inbound = latestByDirection(batch, 'inbound');
  const outbound = latestByDirection(batch, 'outbound');
  const newest = latestAny(batch);
  const backfill = isBackfillIngest({ source, skipProcess });

  return {
    revision: backfill
      ? Number(convo.revision || 0)
      : Number(convo.revision || 0) + Number(inboundCount || 0),
    lastInboundPlatformMessageId: backfill
      ? convo.lastInboundPlatformMessageId || null
      : inbound && shouldReplacePointer(convo.lastInboundAt, inbound.sentAt)
        ? inbound.platformMessageId
        : convo.lastInboundPlatformMessageId || null,
    lastInboundAt: backfill
      ? convo.lastInboundAt || null
      : inbound && shouldReplacePointer(convo.lastInboundAt, inbound.sentAt)
        ? inbound.sentAt
        : convo.lastInboundAt || null,
    lastOutboundPlatformMessageId:
      outbound && shouldReplacePointer(convo.lastMessageAt, outbound.sentAt)
        ? outbound.platformMessageId
        : convo.lastOutboundPlatformMessageId || null,
    lastMessageAt:
      newest && shouldReplacePointer(convo.lastMessageAt, newest.sentAt)
        ? newest.sentAt
        : convo.lastMessageAt || null,
    inbound,
  };
}

async function ingestConversation({
  creatorId,
  platform,
  platformChatId,
  platformFanId,
  fanUsername,
  fanNotes,
  source,
  messages,
  skipProcess = false,
  maxMessages,
} = {}) {
  const [flags, settings] = await Promise.all([
    getAiFlags(),
    loadCreatorMode(creatorId),
  ]);
  const creatorMode = settings?.mode || MODES.OFF;
  if (!shouldPersistIngest({ globalEnabled: flags.enabled, creatorMode })) {
    return { skipped: true, reason: 'ai_off' };
  }

  const humanTakeover = creatorMode === MODES.HUMAN_TAKEOVER;
  const aiPaused = Boolean(settings?.paused);
  const fanId =
    platformFanId == null || platformFanId === ''
      ? null
      : String(platformFanId);
  const username = sanitizeFanUsername(fanUsername);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upserted = await client.query(CONVERSATION_UPSERT_SQL, [
      creatorId,
      platform,
      platformChatId,
      fanId,
      username,
      humanTakeover,
      aiPaused,
    ]);
    const conversation = upserted.rows[0];

    const candidateIds = (Array.isArray(messages) ? messages : [])
      .map((msg) => String(msg?.platformMessageId || '').trim())
      .filter(Boolean);

    let existingIds = [];
    if (candidateIds.length > 0) {
      const existing = await client.query(
        `SELECT "platformMessageId"
         FROM ai_messages
         WHERE "conversationId" = $1
           AND "platformMessageId" = ANY($2::text[])`,
        [conversation.id, candidateIds]
      );
      existingIds = existing.rows.map((row) => row.platformMessageId);
    }

    const { toInsert, inboundCount } = planIngest({
      existingIds,
      messages,
      source,
      maxMessages,
    });

    if (toInsert.length > 0) {
      const values = [];
      const params = [];
      for (const msg of toInsert) {
        const offset = params.length;
        values.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`
        );
        params.push(
          conversation.id,
          msg.direction,
          msg.platformMessageId,
          msg.senderRole,
          msg.text,
          msg.hasMedia,
          msg.isPpv,
          msg.priceNet,
          msg.sentAt,
          msg.source
        );
      }

      await client.query(
        `INSERT INTO ai_messages (
           "conversationId", direction, "platformMessageId", "senderRole",
           text, "hasMedia", "isPpv", "priceNet", "sentAt", source
         )
         VALUES ${values.join(', ')}
         ON CONFLICT ("conversationId", "platformMessageId")
           WHERE "platformMessageId" IS NOT NULL
         DO NOTHING`,
        params
      );
    }

    const pointers = nextIngestPointers({
      conversation,
      toInsert,
      inboundCount,
      source,
      skipProcess,
    });

    const updated = await client.query(
      `UPDATE ai_conversations
       SET revision = $2,
           "lastInboundPlatformMessageId" = $3,
           "lastInboundAt" = $4,
           "lastOutboundPlatformMessageId" = $5,
           "lastMessageAt" = $6,
           "updatedAt" = NOW()
       WHERE id = $1
       RETURNING id, revision`,
      [
        conversation.id,
        pointers.revision,
        pointers.lastInboundPlatformMessageId,
        pointers.lastInboundAt,
        pointers.lastOutboundPlatformMessageId,
        pointers.lastMessageAt,
      ]
    );

    await client.query('COMMIT');

    const resolvedFanId = fanId || conversation.platformFanId || null;
    const notes = typeof fanNotes === 'string' ? fanNotes.trim() : '';
    if (resolvedFanId && notes) {
      try {
        await maybeCopySourceNotes({
          creatorId,
          platform,
          platformFanId: resolvedFanId,
          notes,
        });
      } catch (err) {
        console.error('AI fan notes snapshot error:', err);
      }
    }

    const result = {
      skipped: false,
      conversationId: updated.rows[0].id,
      inserted: toInsert.length,
      inboundCount,
      revision: updated.rows[0].revision,
    };

    if (inboundCount > 0 && !skipProcess) {
      scheduleIncomingProcess({
        creatorId,
        platform,
        platformChatId,
        inboundPlatformMessageId:
          pointers.inbound?.platformMessageId ||
          pointers.lastInboundPlatformMessageId ||
          undefined,
        fanNotes: notes || undefined,
      });
    }

    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  INGEST_PLATFORMS,
  MAX_INGEST_MESSAGES,
  MAX_BACKFILL_MESSAGES,
  CONVERSATION_UPSERT_SQL,
  shouldPersistIngest,
  normalizeIngestMessage,
  planIngest,
  shouldReplacePointer,
  isBackfillIngest,
  nextIngestPointers,
  ingestConversation,
};
