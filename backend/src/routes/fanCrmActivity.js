const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requireOwnerOrManager } = require('../middleware/authorize');
const { getUserTimeZone } = require('../services/rbac');
const { ACTIONS } = require('../services/fanCrmActivity');

const router = express.Router();

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function emptySummary() {
  return {
    rename: 0,
    noteAdd: 0,
    noteRemove: 0,
    noteEdit: 0,
    listAdd: 0,
    listRemove: 0,
    listBulkAdd: 0,
  };
}

function summaryKey(action) {
  switch (action) {
    case 'rename':
      return 'rename';
    case 'note_add':
      return 'noteAdd';
    case 'note_remove':
      return 'noteRemove';
    case 'note_edit':
      return 'noteEdit';
    case 'list_add':
      return 'listAdd';
    case 'list_remove':
      return 'listRemove';
    case 'list_bulk_add':
      return 'listBulkAdd';
    default:
      return null;
  }
}

function toEvent(row) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    chatterId: row.chatterId,
    chatterName: row.chatterName,
    creatorId: row.creatorId,
    creatorName: row.creatorName || '',
    creatorUsername: row.creatorUsername || null,
    creatorAvatarUrl: row.creatorAvatarUrl || null,
    platform: row.platform,
    fanId: row.fanId || '',
    fanLabel: row.fanLabel || '',
    chatId: row.chatId || null,
    action: row.action,
    previousValue: row.previousValue || '',
    nextValue: row.nextValue || '',
    listId: row.listId || null,
    listName: row.listName || '',
  };
}

router.get(
  '/',
  authenticate,
  requireOwnerOrManager,
  async (req, res) => {
    try {
      const tz = await getUserTimeZone(req.user.id);
      const { startDate, endDate, chatterId, creatorId, platform, action, page = '1', limit = '20' } =
        req.query;

      const conditions = [];
      const values = [];
      let paramIndex = 1;

      if (startDate) {
        const dateValue = String(startDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
          return res.status(400).json({ error: 'Invalid startDate' });
        }
        conditions.push(
          `(e."createdAt" AT TIME ZONE '${tz}')::date >= $${paramIndex}::date`
        );
        values.push(dateValue);
        paramIndex += 1;
      }

      if (endDate) {
        const dateValue = String(endDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
          return res.status(400).json({ error: 'Invalid endDate' });
        }
        conditions.push(
          `(e."createdAt" AT TIME ZONE '${tz}')::date <= $${paramIndex}::date`
        );
        values.push(dateValue);
        paramIndex += 1;
      }

      if (chatterId) {
        if (!isValidUuid(chatterId)) {
          return res.status(400).json({ error: 'Invalid chatterId' });
        }
        conditions.push(`e."chatterId" = $${paramIndex}`);
        values.push(chatterId);
        paramIndex += 1;
      }

      if (creatorId) {
        if (!isValidUuid(creatorId)) {
          return res.status(400).json({ error: 'Invalid creatorId' });
        }
        conditions.push(`e."creatorId" = $${paramIndex}`);
        values.push(creatorId);
        paramIndex += 1;
      }

      if (platform === 'maloum' || platform === '4based' || platform === 'telegram') {
        conditions.push(`e.platform = $${paramIndex}`);
        values.push(platform);
        paramIndex += 1;
      } else if (platform != null && String(platform).trim() !== '') {
        return res.status(400).json({ error: 'Invalid platform' });
      }

      let actionValue = '';
      if (action != null && String(action).trim() !== '') {
        actionValue = String(action).trim();
        if (!ACTIONS.has(actionValue)) {
          return res.status(400).json({ error: 'Invalid action' });
        }
      }

      const summaryConditions = [...conditions];
      const summaryValues = [...values];
      if (actionValue) {
        conditions.push(`e.action = $${paramIndex}`);
        values.push(actionValue);
        paramIndex += 1;
      }

      const parsedPage = Math.max(Number.parseInt(String(page), 10) || 1, 1);
      const parsedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
      const offset = (parsedPage - 1) * parsedLimit;
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const summaryWhere =
        summaryConditions.length > 0 ? `WHERE ${summaryConditions.join(' AND ')}` : '';

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM fan_crm_events e
         ${whereClause}`,
        values
      );
      const total = countResult.rows[0]?.total || 0;

      const summaryResult = await pool.query(
        `SELECT e.action, COUNT(*)::int AS count
         FROM fan_crm_events e
         ${summaryWhere}
         GROUP BY e.action`,
        summaryValues
      );
      const summary = emptySummary();
      for (const row of summaryResult.rows) {
        const key = summaryKey(row.action);
        if (key) summary[key] = row.count;
      }

      const dataResult = await pool.query(
        `SELECT e.*,
                COALESCE(c."displayName", '') AS "creatorName",
                c.username AS "creatorUsername",
                c."avatarUrl" AS "creatorAvatarUrl"
         FROM fan_crm_events e
         LEFT JOIN creators c ON c.id = e."creatorId"
         ${whereClause}
         ORDER BY e."createdAt" DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...values, parsedLimit, offset]
      );

      const from = total === 0 ? 0 : offset + 1;
      const to = total === 0 ? 0 : Math.min(offset + dataResult.rows.length, total);

      return res.json({
        data: dataResult.rows.map(toEvent),
        summary,
        pagination: {
          page: parsedPage,
          limit: parsedLimit,
          total,
          from,
          to,
        },
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error('fan crm activity list failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
