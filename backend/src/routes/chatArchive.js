const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requireOwnerOrManager } = require('../middleware/authorize');
const { getUserTimeZone } = require('../services/rbac');

const router = express.Router();

const PLATFORMS = new Set(['maloum', '4based', 'telegram', 'fansly']);
const EXPORT_CAP = 20000;
const SEARCH_LIMIT_MAX = 50;
const THREAD_LIMIT = 1000;

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function includeMass(query) {
  const value = String(query.includeMass || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function kindsFor(query) {
  return includeMass(query) ? ['dm', 'ppv', 'mass'] : ['dm', 'ppv'];
}

function likePhrase(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function snippet(row, phrase) {
  const sources = [row.textEn, row.textDe, row.textSent].filter((value) => textOf(value));
  const needle = phrase.toLowerCase();
  for (const source of sources) {
    const index = source.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - 48);
    const end = Math.min(source.length, index + phrase.length + 96);
    const slice = source.slice(start, end);
    return `${start > 0 ? '…' : ''}${slice}${end < source.length ? '…' : ''}`;
  }
  return (sources[0] || '').slice(0, 160);
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildFilters(query, timeZone) {
  const values = [];
  const conditions = [];

  values.push(kindsFor(query));
  conditions.push(`m.kind = ANY($${values.length}::text[])`);

  const phrase = typeof query.q === 'string' ? query.q.trim() : '';
  if (phrase) {
    values.push(`%${likePhrase(phrase)}%`);
    conditions.push(`m."searchText" ILIKE $${values.length} ESCAPE '\\'`);
  }

  if (query.platform && PLATFORMS.has(String(query.platform))) {
    values.push(String(query.platform));
    conditions.push(`c.platform = $${values.length}`);
  }

  if (query.creatorId && isValidUuid(query.creatorId)) {
    values.push(String(query.creatorId));
    conditions.push(`c."creatorId" = $${values.length}`);
  }

  if (query.chatterId && isValidUuid(query.chatterId)) {
    values.push(String(query.chatterId));
    conditions.push(`m."chatterId" = $${values.length}`);
  }

  const direction = String(query.direction || '');
  if (direction === 'inbound' || direction === 'outbound') {
    values.push(direction);
    conditions.push(`m.direction = $${values.length}`);
  }

  if (isIsoDate(query.startDate)) {
    values.push(timeZone);
    const tz = values.length;
    values.push(String(query.startDate));
    conditions.push(`(m."sentAt" AT TIME ZONE $${tz})::date >= $${values.length}::date`);
  }

  if (isIsoDate(query.endDate)) {
    values.push(timeZone);
    const tz = values.length;
    values.push(String(query.endDate));
    conditions.push(`(m."sentAt" AT TIME ZONE $${tz})::date <= $${values.length}::date`);
  }

  return {
    phrase,
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

function exportMessage(row) {
  return {
    at: row.sentAt,
    role: row.direction === 'inbound' ? 'fan' : row.senderRole === 'system' ? 'system' : 'chatter',
    chatter: row.chatterName || null,
    textEn: row.textEn || null,
    textDe: row.textDe || null,
    textSent: row.textSent || '',
    ppv: row.isPpv
      ? { price: numberOrNull(row.priceNet), currency: row.currency || null }
      : null,
    deleted: Boolean(row.deletedAt),
  };
}

function conversationExport(row, messages) {
  const times = messages.map((message) => message.sentAt).filter(Boolean);
  return {
    creator: row.creatorName || '',
    platform: row.platform,
    fan: row.fanLabel || row.fanUsername || row.platformFanId || '',
    capturedFrom: times[0] || row.capturedFrom || null,
    capturedTo: times[times.length - 1] || row.capturedTo || null,
    messages: messages.map(exportMessage),
  };
}

async function loadConversation(id) {
  const result = await pool.query(
    `SELECT c.id, c.platform, c."platformChatId", c."platformFanId", c."fanUsername", c."fanLabel",
            c."messageCount", c."creatorId",
            cr."displayName" AS "creatorName",
            cr.username AS "creatorUsername"
     FROM fan_conversations c
     LEFT JOIN creators cr ON cr.id = c."creatorId"
     WHERE c.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function loadThreadMessages(conversationId, kinds, limit = THREAD_LIMIT) {
  const result = await pool.query(
    `SELECT id, "platformMessageId", direction, "senderRole", "chatterId", "chatterName",
            kind, "textSent", "textEn", "textDe", "hasMedia", "isPpv", "priceNet", currency,
            "sentAt", "deletedAt"
     FROM (
       SELECT *
       FROM fan_messages
       WHERE "conversationId" = $1 AND kind = ANY($2::text[])
       ORDER BY "sentAt" DESC NULLS LAST, id DESC
       LIMIT $3
     ) recent
     ORDER BY "sentAt" ASC NULLS LAST, id ASC`,
    [conversationId, kinds, limit]
  );
  return result.rows;
}

router.get('/search', authenticate, requireOwnerOrManager, async (req, res) => {
  try {
    const timeZone = await getUserTimeZone(req.user.id);
    const filters = buildFilters(req.query, timeZone);
    if (filters.phrase.length < 3) {
      return res.status(400).json({ error: 'Search needs at least 3 characters' });
    }
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), SEARCH_LIMIT_MAX);
    const offset = (page - 1) * limit;
    const countValues = filters.values.slice();
    const listValues = filters.values.slice();
    listValues.push(limit, offset);

    const [countResult, listResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM fan_messages m
         JOIN fan_conversations c ON c.id = m."conversationId"
         ${filters.where}`,
        countValues
      ),
      pool.query(
        `SELECT m.id, m."conversationId", m.direction, m."senderRole", m."chatterName",
                m.kind, m."textSent", m."textEn", m."textDe", m."isPpv", m."priceNet",
                m.currency, m."sentAt", m."deletedAt",
                c.platform, c."fanLabel", c."fanUsername", c."platformFanId", c."creatorId",
                cr."displayName" AS "creatorName"
         FROM fan_messages m
         JOIN fan_conversations c ON c.id = m."conversationId"
         LEFT JOIN creators cr ON cr.id = c."creatorId"
         ${filters.where}
         ORDER BY m."sentAt" DESC NULLS LAST, m.id DESC
         LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
        listValues
      ),
    ]);

    const total = countResult.rows[0]?.total || 0;
    return res.json({
      data: listResult.rows.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        sentAt: row.sentAt,
        direction: row.direction,
        senderRole: row.senderRole,
        chatterName: row.chatterName || null,
        kind: row.kind,
        textEn: row.textEn || null,
        textDe: row.textDe || null,
        textSent: row.textSent || '',
        snippet: filters.phrase ? snippet(row, filters.phrase) : (row.textSent || row.textEn || '').slice(0, 160),
        isPpv: row.isPpv === true,
        priceNet: numberOrNull(row.priceNet),
        currency: row.currency || null,
        deleted: Boolean(row.deletedAt),
        platform: row.platform,
        fanLabel: row.fanLabel || row.fanUsername || '',
        creatorId: row.creatorId,
        creatorName: row.creatorName || '',
      })),
      pagination: {
        page,
        limit,
        total,
        from: total === 0 ? 0 : offset + 1,
        to: Math.min(offset + listResult.rows.length, total),
      },
    });
  } catch (err) {
    console.error('Chat archive search error:', err);
    return res.status(500).json({ error: 'Failed to search chat archive' });
  }
});

router.get('/conversations/:id/messages', authenticate, requireOwnerOrManager, async (req, res) => {
  try {
    if (!isValidUuid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversation ID' });
    }
    const conversation = await loadConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const kinds = kindsFor(req.query);
    const [messages, range] = await Promise.all([
      loadThreadMessages(conversation.id, kinds),
      pool.query(
        `SELECT MIN("sentAt") AS "capturedFrom", MAX("sentAt") AS "capturedTo", COUNT(*)::int AS total
         FROM fan_messages
         WHERE "conversationId" = $1 AND kind = ANY($2::text[])`,
        [conversation.id, kinds]
      ),
    ]);
    const totals = range.rows[0] || {};
    return res.json({
      conversation: {
        id: conversation.id,
        platform: conversation.platform,
        creatorId: conversation.creatorId,
        creatorName: conversation.creatorName || '',
        creatorUsername: conversation.creatorUsername || null,
        fanLabel: conversation.fanLabel || conversation.fanUsername || '',
        fanUsername: conversation.fanUsername || null,
        messageCount: totals.total || 0,
        capturedFrom: totals.capturedFrom || null,
        capturedTo: totals.capturedTo || null,
        truncated: (totals.total || 0) > messages.length,
      },
      messages: messages.map((row) => ({
        id: row.id,
        platformMessageId: row.platformMessageId,
        direction: row.direction,
        senderRole: row.senderRole,
        chatterName: row.chatterName || null,
        kind: row.kind,
        textEn: row.textEn || null,
        textDe: row.textDe || null,
        textSent: row.textSent || '',
        hasMedia: row.hasMedia === true,
        isPpv: row.isPpv === true,
        priceNet: numberOrNull(row.priceNet),
        currency: row.currency || null,
        sentAt: row.sentAt,
        deleted: Boolean(row.deletedAt),
      })),
    });
  } catch (err) {
    console.error('Chat archive thread error:', err);
    return res.status(500).json({ error: 'Failed to load archived chat' });
  }
});

router.get('/export', authenticate, requireOwnerOrManager, async (req, res) => {
  try {
    const timeZone = await getUserTimeZone(req.user.id);
    const kinds = kindsFor(req.query);
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId.trim() : '';

    if (conversationId) {
      if (!isValidUuid(conversationId)) {
        return res.status(400).json({ error: 'Invalid conversation ID' });
      }
      const conversation = await loadConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      const count = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM fan_messages
         WHERE "conversationId" = $1 AND kind = ANY($2::text[])`,
        [conversationId, kinds]
      );
      const total = count.rows[0]?.total || 0;
      if (total > EXPORT_CAP) {
        return res.status(400).json({
          error: `This chat has ${total} messages. Narrow the export (limit ${EXPORT_CAP}).`,
        });
      }
      const messages = await loadThreadMessages(conversationId, kinds, EXPORT_CAP);
      const body = conversationExport(conversation, messages);
      const filename = `chat-archive-${conversation.platform || 'chat'}.json`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(JSON.stringify(body, null, 2));
    }

    const filters = buildFilters(req.query, timeZone);
    if (filters.phrase && filters.phrase.length < 3) {
      return res.status(400).json({ error: 'Search needs at least 3 characters' });
    }
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM fan_messages exported
       WHERE exported.kind = ANY($1::text[])
         AND exported."conversationId" IN (
           SELECT DISTINCT c.id
           FROM fan_messages m
           JOIN fan_conversations c ON c.id = m."conversationId"
           ${filters.where}
         )`,
      filters.values
    );
    const total = count.rows[0]?.total || 0;
    if (total > EXPORT_CAP) {
      return res.status(400).json({
        error: `This export has ${total} messages. Narrow the date range (limit ${EXPORT_CAP}).`,
      });
    }

    const matched = await pool.query(
      `SELECT DISTINCT c.id
       FROM fan_messages m
       JOIN fan_conversations c ON c.id = m."conversationId"
       ${filters.where}`,
      filters.values
    );

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="chat-archive.jsonl"');
    for (const row of matched.rows) {
      const conversation = await loadConversation(row.id);
      if (!conversation) continue;
      const messages = await loadThreadMessages(row.id, kinds, EXPORT_CAP);
      res.write(`${JSON.stringify(conversationExport(conversation, messages))}\n`);
    }
    return res.end();
  } catch (err) {
    console.error('Chat archive export error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to export chat archive' });
    }
    return res.end();
  }
});

module.exports = router;
