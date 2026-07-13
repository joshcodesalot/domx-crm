const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  userSeesAllCreators,
  userCanAccessCreator,
} = require('../services/creatorAccess');

const router = express.Router();

const VALID_STATUSES = new Set(['pending', 'confirmed', 'failed']);

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function toSentMessage(row) {
  return {
    id: row.id,
    creatorId: row.creatorId,
    chatId: row.chatId,
    maloumMessageId: row.maloumMessageId,
    optimisticMessageId: row.optimisticMessageId,
    contentText: row.contentText,
    sentByUserId: row.sentByUserId,
    sentByUserName: row.sentByUserName,
    sentAt: row.sentAt,
    status: row.status,
    domMarked: row.domMarked,
    createdAt: row.createdAt,
  };
}

router.post(
  '/',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const {
      id,
      creatorId,
      chatId,
      maloumMessageId = null,
      optimisticMessageId = null,
      contentText = '',
      sentByUserId,
      sentByUserName,
      sentAt,
      status,
      domMarked = false,
    } = req.body || {};

    if (!id || !isValidUuid(id)) {
      return res.status(400).json({ error: 'Valid message record id is required' });
    }

    if (!creatorId || !isValidUuid(creatorId)) {
      return res.status(400).json({ error: 'Valid creatorId is required' });
    }

    if (!chatId || typeof chatId !== 'string') {
      return res.status(400).json({ error: 'chatId is required' });
    }

    if (!sentByUserId || !isValidUuid(sentByUserId)) {
      return res.status(400).json({ error: 'Valid sentByUserId is required' });
    }

    if (sentByUserId !== req.user.id) {
      return res.status(403).json({ error: 'sentByUserId must match authenticated user' });
    }

    if (!sentByUserName || typeof sentByUserName !== 'string') {
      return res.status(400).json({ error: 'sentByUserName is required' });
    }

    if (!sentAt) {
      return res.status(400).json({ error: 'sentAt is required' });
    }

    if (!status || !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Valid status is required' });
    }

    const creatorCheck = await pool.query('SELECT id FROM creators WHERE id = $1', [creatorId]);
    if (creatorCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const allowed = await userCanAccessCreator(req.user, creatorId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }

    const result = await pool.query(
      `INSERT INTO maloum_sent_messages (
        id,
        "creatorId",
        "chatId",
        "maloumMessageId",
        "optimisticMessageId",
        "contentText",
        "sentByUserId",
        "sentByUserName",
        "sentAt",
        status,
        "domMarked"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        "maloumMessageId" = EXCLUDED."maloumMessageId",
        "optimisticMessageId" = EXCLUDED."optimisticMessageId",
        "contentText" = EXCLUDED."contentText",
        "sentByUserName" = EXCLUDED."sentByUserName",
        status = EXCLUDED.status,
        "domMarked" = EXCLUDED."domMarked"
      RETURNING *`,
      [
        id,
        creatorId,
        chatId,
        maloumMessageId,
        optimisticMessageId,
        contentText,
        sentByUserId,
        sentByUserName,
        sentAt,
        status,
        Boolean(domMarked),
      ]
    );

    res.json({ record: toSentMessage(result.rows[0]) });
  }
);

router.get(
  '/',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { creatorId, chatId, limit = '50' } = req.query;

    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (creatorId) {
      if (!isValidUuid(String(creatorId))) {
        return res.status(400).json({ error: 'Invalid creatorId' });
      }

      const allowed = await userCanAccessCreator(req.user, String(creatorId));
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      conditions.push(`"creatorId" = $${paramIndex}`);
      values.push(creatorId);
      paramIndex += 1;
    } else if (!userSeesAllCreators(req.user)) {
      conditions.push(`"creatorId" IN (
        SELECT "creatorId"
        FROM creator_staff_assignments
        WHERE "userId" = $${paramIndex}
      )`);
      values.push(req.user.id);
      paramIndex += 1;
    }

    if (chatId) {
      conditions.push(`"chatId" = $${paramIndex}`);
      values.push(String(chatId));
      paramIndex += 1;
    }

    const parsedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT *
       FROM maloum_sent_messages
       ${whereClause}
       ORDER BY "sentAt" DESC
       LIMIT $${paramIndex}`,
      [...values, parsedLimit]
    );

    res.json({
      records: result.rows.map(toSentMessage),
    });
  }
);

module.exports = router;
