const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  VALID_MATCH_MODES,
  normalizeKeywords,
  normalizeActions,
  toRule,
  invalidateRulesCache,
} = require('../services/contentModeration');

const router = express.Router();

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function resolveKeywordLists(body, current) {
  let englishKeywords;
  let germanKeywords;

  if (
    body?.englishKeywords !== undefined ||
    body?.englishKeywordText !== undefined
  ) {
    englishKeywords = normalizeKeywords(
      body.englishKeywords ?? body.englishKeywordText
    );
  } else if (body?.keywords !== undefined || body?.keywordText !== undefined) {
    // Legacy single-list payload → apply to both stages
    const legacy = normalizeKeywords(body.keywords ?? body.keywordText);
    englishKeywords = legacy;
    germanKeywords = legacy;
  } else if (current) {
    englishKeywords = Array.isArray(current.englishKeywords)
      ? current.englishKeywords
      : [];
  } else {
    englishKeywords = [];
  }

  if (
    body?.germanKeywords !== undefined ||
    body?.germanKeywordText !== undefined
  ) {
    germanKeywords = normalizeKeywords(
      body.germanKeywords ?? body.germanKeywordText
    );
  } else if (germanKeywords === undefined) {
    germanKeywords = current
      ? Array.isArray(current.germanKeywords)
        ? current.germanKeywords
        : []
      : [];
  }

  return { englishKeywords, germanKeywords };
}

function toEvent(row) {
  return {
    id: row.id,
    ruleId: row.ruleId || null,
    matchedKeyword: row.matchedKeyword || '',
    matchedStage: row.matchedStage || null,
    actionsTaken: Array.isArray(row.actionsTaken) ? row.actionsTaken : [],
    userId: row.userId || null,
    chatterName: row.chatterName || null,
    chatterEmail: row.chatterEmail || null,
    creatorId: row.creatorId || null,
    creatorName: row.creatorName || null,
    creatorUsername: row.creatorUsername || null,
    platform: row.platform,
    chatId: row.chatId || null,
    fanId: row.fanId || null,
    fanUsername: row.fanUsername || null,
    messageText: row.messageText || '',
    englishMessageText: row.englishMessageText || '',
    blocked: Boolean(row.blocked),
    notified: Boolean(row.notified),
    status: row.status,
    reviewedBy: row.reviewedBy || null,
    reviewedByName: row.reviewedByName || null,
    reviewedAt: row.reviewedAt || null,
    createdAt: row.createdAt,
  };
}

const RULE_SELECT = `id, name, keywords, "englishKeywords", "germanKeywords",
  "matchMode", "caseSensitive", actions, enabled,
  "createdBy", "updatedBy", "createdAt", "updatedAt"`;

// ── Rules ──────────────────────────────────────────────────────────────────

router.get('/rules', authenticate, requirePermission('moderation.manage'), async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${RULE_SELECT}
       FROM keyword_rules
       ORDER BY "createdAt" DESC`
    );
    res.json({ rules: result.rows.map(toRule) });
  } catch (err) {
    console.error('List keyword rules error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/rules', authenticate, requirePermission('moderation.manage'), async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const { englishKeywords, germanKeywords } = resolveKeywordLists(req.body, null);
    const actions = normalizeActions(req.body?.actions);
    const matchMode =
      typeof req.body?.matchMode === 'string' && VALID_MATCH_MODES.has(req.body.matchMode)
        ? req.body.matchMode
        : 'whole_word';
    const caseSensitive = Boolean(req.body?.caseSensitive);
    const enabled = req.body?.enabled === undefined ? true : Boolean(req.body.enabled);
    const legacyKeywords = [...englishKeywords, ...germanKeywords];

    if (englishKeywords.length === 0 && germanKeywords.length === 0) {
      return res.status(400).json({
        error: 'At least one English or German keyword is required',
      });
    }
    if (actions.length === 0) {
      return res.status(400).json({
        error: 'Select at least one action (block_warn, notify_management, log_for_review)',
      });
    }

    const result = await pool.query(
      `INSERT INTO keyword_rules (
         name, keywords, "englishKeywords", "germanKeywords",
         "matchMode", "caseSensitive", actions, enabled, "createdBy", "updatedBy"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING *`,
      [
        name,
        legacyKeywords,
        englishKeywords,
        germanKeywords,
        matchMode,
        caseSensitive,
        actions,
        enabled,
        req.user.id,
      ]
    );

    invalidateRulesCache();
    res.status(201).json({ rule: toRule(result.rows[0]) });
  } catch (err) {
    console.error('Create keyword rule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/rules/:id', authenticate, requirePermission('moderation.manage'), async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid rule ID' });
  }

  try {
    const existing = await pool.query('SELECT * FROM keyword_rules WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    const current = existing.rows[0];
    const name =
      typeof req.body?.name === 'string' ? req.body.name.trim() : current.name;
    const { englishKeywords, germanKeywords } = resolveKeywordLists(req.body, current);
    const actions =
      req.body?.actions !== undefined
        ? normalizeActions(req.body.actions)
        : current.actions;
    const matchMode =
      typeof req.body?.matchMode === 'string' && VALID_MATCH_MODES.has(req.body.matchMode)
        ? req.body.matchMode
        : current.matchMode;
    const caseSensitive =
      req.body?.caseSensitive !== undefined
        ? Boolean(req.body.caseSensitive)
        : current.caseSensitive;
    const enabled =
      req.body?.enabled !== undefined ? Boolean(req.body.enabled) : current.enabled;
    const legacyKeywords = [...englishKeywords, ...germanKeywords];

    if (englishKeywords.length === 0 && germanKeywords.length === 0) {
      return res.status(400).json({
        error: 'At least one English or German keyword is required',
      });
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'Select at least one action' });
    }

    const result = await pool.query(
      `UPDATE keyword_rules
       SET name = $1,
           keywords = $2,
           "englishKeywords" = $3,
           "germanKeywords" = $4,
           "matchMode" = $5,
           "caseSensitive" = $6,
           actions = $7,
           enabled = $8,
           "updatedBy" = $9,
           "updatedAt" = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        name,
        legacyKeywords,
        englishKeywords,
        germanKeywords,
        matchMode,
        caseSensitive,
        actions,
        enabled,
        req.user.id,
        id,
      ]
    );

    invalidateRulesCache();
    res.json({ rule: toRule(result.rows[0]) });
  } catch (err) {
    console.error('Update keyword rule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/rules/:id', authenticate, requirePermission('moderation.manage'), async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid rule ID' });
  }

  try {
    const result = await pool.query(
      'DELETE FROM keyword_rules WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    invalidateRulesCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete keyword rule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Review events ──────────────────────────────────────────────────────────

router.get('/events', authenticate, requirePermission('moderation.review'), async (req, res) => {
  try {
    const status =
      typeof req.query.status === 'string' && req.query.status.trim()
        ? req.query.status.trim()
        : null;
    const platform =
      typeof req.query.platform === 'string' && req.query.platform.trim()
        ? req.query.platform.trim()
        : null;
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

    const clauses = [];
    const params = [];

    if (status && ['open', 'reviewed', 'dismissed'].includes(status)) {
      params.push(status);
      clauses.push(`e.status = $${params.length}`);
    }
    if (platform && ['maloum', '4based'].includes(platform)) {
      params.push(platform);
      clauses.push(`e.platform = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      clauses.push(
        `(e."matchedKeyword" ILIKE $${idx}
          OR e."messageText" ILIKE $${idx}
          OR e."englishMessageText" ILIKE $${idx}
          OR e."fanUsername" ILIKE $${idx}
          OR u.name ILIKE $${idx}
          OR c."displayName" ILIKE $${idx})`
      );
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const result = await pool.query(
      `SELECT e.*,
              u.name AS "chatterName",
              u.email AS "chatterEmail",
              c."displayName" AS "creatorName",
              c.username AS "creatorUsername",
              rb.name AS "reviewedByName"
       FROM moderation_events e
       LEFT JOIN users u ON u.id = e."userId"
       LEFT JOIN creators c ON c.id = e."creatorId"
       LEFT JOIN users rb ON rb.id = e."reviewedBy"
       ${where}
       ORDER BY e."createdAt" DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    res.json({ events: result.rows.map(toEvent) });
  } catch (err) {
    console.error('List moderation events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/events/:id', authenticate, requirePermission('moderation.review'), async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid event ID' });
  }

  const status =
    typeof req.body?.status === 'string' ? req.body.status.trim() : '';
  if (!['open', 'reviewed', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status must be open, reviewed, or dismissed' });
  }

  try {
    const result = await pool.query(
      `UPDATE moderation_events
       SET status = $1,
           "reviewedBy" = CASE WHEN $1 = 'open' THEN NULL ELSE $2 END,
           "reviewedAt" = CASE WHEN $1 = 'open' THEN NULL ELSE NOW() END
       WHERE id = $3
       RETURNING *`,
      [status, req.user.id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const enriched = await pool.query(
      `SELECT e.*,
              u.name AS "chatterName",
              u.email AS "chatterEmail",
              c."displayName" AS "creatorName",
              c.username AS "creatorUsername",
              rb.name AS "reviewedByName"
       FROM moderation_events e
       LEFT JOIN users u ON u.id = e."userId"
       LEFT JOIN creators c ON c.id = e."creatorId"
       LEFT JOIN users rb ON rb.id = e."reviewedBy"
       WHERE e.id = $1`,
      [id]
    );

    res.json({ event: toEvent(enriched.rows[0]) });
  } catch (err) {
    console.error('Update moderation event error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
