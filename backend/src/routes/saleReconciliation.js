const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const {
  parseYearMonth,
  monthBounds,
  startReconcileAll,
  getReconcileAllStatus,
} = require('../services/salePayoutReconciler');

const router = express.Router();

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function requireOwnerOrManager(req, res, next) {
  const role = req.user?.role;
  if (role === 'owner' || role === 'manager') return next();
  return res.status(403).json({ error: 'Owner or manager access required' });
}

function toEvent(row) {
  return {
    id: row.id,
    creatorId: row.creatorId,
    creatorName: row.creatorName || null,
    platform: row.platform,
    eventType: row.eventType,
    status: row.status,
    messagingEntryId: row.messagingEntryId,
    maloumMessageId: row.maloumMessageId,
    payoutTxnId: row.payoutTxnId,
    fanId: row.fanId,
    fanUsername: row.fanUsername,
    chatId: row.chatId,
    amount: row.amount != null ? Number(row.amount) : null,
    currency: row.currency,
    unlockedAt: row.unlockedAt || null,
    reason: row.reason,
    detailJson: row.detailJson || null,
    recoveredMessageText: row.recoveredMessageText || null,
    recoveredMediaJson: row.recoveredMediaJson || null,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt || null,
    resolution: row.resolution || null,
    createdAt: row.createdAt,
  };
}

router.get(
  '/',
  authenticate,
  requireOwnerOrManager,
  async (req, res) => {
    try {
      const status =
        typeof req.query.status === 'string' && req.query.status.trim()
          ? req.query.status.trim()
          : null;
      const platform =
        req.query.platform === 'maloum' || req.query.platform === '4based'
          ? req.query.platform
          : null;
      const creatorId =
        typeof req.query.creatorId === 'string' && isValidUuid(req.query.creatorId)
          ? req.query.creatorId
          : null;
      const tab =
        typeof req.query.tab === 'string' ? req.query.tab.trim() : null;
      const yearMonth = parseYearMonth(req.query.yearMonth);
      const bounds = monthBounds(yearMonth);
      const page = Math.max(Number.parseInt(String(req.query.page || '1'), 10) || 1, 1);
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit || '50'), 10) || 50, 1),
        200
      );
      const offset = (page - 1) * limit;

      const conditions = [
        `e."createdAt" >= $1::timestamptz`,
        `e."createdAt" <= $2::timestamptz`,
      ];
      const values = [bounds.monthFrom, bounds.monthTo];
      let i = 3;

      if (status) {
        conditions.push(`e.status = $${i}`);
        values.push(status);
        i += 1;
      }
      if (platform) {
        conditions.push(`e.platform = $${i}`);
        values.push(platform);
        i += 1;
      }
      if (creatorId) {
        conditions.push(`e."creatorId" = $${i}`);
        values.push(creatorId);
        i += 1;
      }
      if (tab === 'cleared') {
        conditions.push(`e."eventType" = 'false_unlock_cleared'`);
      } else if (tab === 'deleted_imports') {
        conditions.push(`e."eventType" = 'payout_orphan_imported'`);
      } else if (tab === 'needs_review') {
        conditions.push(`e.status = 'needs_review'`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM sale_reconciliation_events e
         ${where}`,
        values
      );

      const listValues = [...values, limit, offset];
      const listResult = await pool.query(
        `SELECT e.*,
                c."displayName" AS "creatorName"
         FROM sale_reconciliation_events e
         LEFT JOIN creators c ON c.id = e."creatorId"
         ${where}
         ORDER BY e."createdAt" DESC
         LIMIT $${i} OFFSET $${i + 1}`,
        listValues
      );

      res.json({
        yearMonth,
        data: listResult.rows.map(toEvent),
        pagination: {
          page,
          limit,
          total: countResult.rows[0]?.total || 0,
        },
      });
    } catch (err) {
      console.error('List sale reconciliation error:', err);
      res.status(500).json({ error: 'Failed to list reconciliation events' });
    }
  }
);

router.get(
  '/reconcile-all',
  authenticate,
  requireOwnerOrManager,
  async (_req, res) => {
    res.json({ job: getReconcileAllStatus() });
  }
);

router.post(
  '/reconcile-all',
  authenticate,
  requireOwnerOrManager,
  async (req, res) => {
    const yearMonth = parseYearMonth(req.body?.yearMonth);
    const result = startReconcileAll({ yearMonth });
    if (!result.started && result.reason === 'already_running') {
      return res.status(409).json({
        error: 'A reconcile-all job is already running',
        job: result.job,
      });
    }
    res.json({ job: result.job });
  }
);

router.post(
  '/:id/resolve',
  authenticate,
  requireOwnerOrManager,
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid event id' });
    }

    const action = String(req.body?.action || '').trim();
    const allowed = new Set([
      'confirm_false',
      'restore_sale',
      'dismiss',
      'reassign',
    ]);
    if (!allowed.has(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query(
        `SELECT * FROM sale_reconciliation_events WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (eventResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Event not found' });
      }
      const event = eventResult.rows[0];

      if (action === 'confirm_false' && event.messagingEntryId) {
        await client.query(
          `UPDATE messaging_dashboard_entries
           SET purchased = false,
               "unlockedAt" = NULL,
               "payoutVerified" = false,
               "payoutVerifiedAt" = NULL,
               "payoutTxnId" = NULL,
               "updatedAt" = NOW()
           WHERE id = $1`,
          [event.messagingEntryId]
        );
      }

      if (action === 'restore_sale' && event.messagingEntryId) {
        const unlockedAt =
          event.unlockedAt ||
          (event.detailJson && typeof event.detailJson === 'object'
            ? null
            : null) ||
          new Date().toISOString();
        await client.query(
          `UPDATE messaging_dashboard_entries
           SET purchased = true,
               "unlockedAt" = COALESCE("unlockedAt", $2::timestamptz),
               "payoutVerified" = CASE
                 WHEN $3::text IS NOT NULL THEN true
                 ELSE "payoutVerified"
               END,
               "payoutVerifiedAt" = CASE
                 WHEN $3::text IS NOT NULL THEN NOW()
                 ELSE "payoutVerifiedAt"
               END,
               "payoutTxnId" = COALESCE("payoutTxnId", $3),
               "priceNet" = COALESCE("priceNet", $4),
               "updatedAt" = NOW()
           WHERE id = $1`,
          [
            event.messagingEntryId,
            unlockedAt,
            event.payoutTxnId || null,
            event.amount != null ? Number(event.amount) : null,
          ]
        );
      }

      if (action === 'reassign') {
        const chatterId = req.body?.chatterId;
        if (!chatterId || !isValidUuid(chatterId)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'chatterId is required' });
        }
        const chatter = await client.query(
          `SELECT id, name, email FROM users WHERE id = $1`,
          [chatterId]
        );
        if (chatter.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Chatter not found' });
        }
        if (!event.messagingEntryId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Event has no messaging entry' });
        }
        await client.query(
          `UPDATE messaging_dashboard_entries
           SET "chatterId" = $2,
               "chatterName" = $3,
               "chatterEmail" = $4,
               "attributionSource" = COALESCE("attributionSource", 'deleted_import'),
               "updatedAt" = NOW()
           WHERE id = $1`,
          [
            event.messagingEntryId,
            chatter.rows[0].id,
            chatter.rows[0].name || 'Staff',
            chatter.rows[0].email || null,
          ]
        );
      }

      const resolutionMap = {
        confirm_false: 'confirmed_false',
        restore_sale: 'restored_sale',
        dismiss: 'dismissed',
        reassign: 'reassigned',
      };

      const updated = await client.query(
        `UPDATE sale_reconciliation_events
         SET status = 'resolved',
             resolution = $2,
             "resolvedBy" = $3,
             "resolvedAt" = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, resolutionMap[action], req.user.id]
      );

      await client.query('COMMIT');

      const creatorName = event.creatorId
        ? (
            await pool.query(
              `SELECT "displayName" FROM creators WHERE id = $1`,
              [event.creatorId]
            )
          ).rows[0]?.displayName
        : null;

      res.json({
        event: toEvent({ ...updated.rows[0], creatorName }),
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      console.error('Resolve sale reconciliation error:', err);
      res.status(500).json({ error: 'Failed to resolve event' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
