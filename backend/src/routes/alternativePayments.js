const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requireOwnerOrManager } = require('../middleware/authorize');

const router = express.Router();

const PAYMENT_METHODS = new Set(['revolut', 'amazon', 'paypal', 'bitcoin']);
const CURRENCIES = new Set(['EUR', 'USD']);
const STAFF_ROLES = ['chatter', 'team_leader'];

const PAYMENT_SELECT = `
  SELECT p.id,
         p."saleCode",
         to_char(p."saleDate", 'YYYY-MM-DD') AS "saleDate",
         p."fanName",
         p."creatorId",
         COALESCE(c."displayName", NULLIF(p."creatorName", '')) AS "creatorName",
         c.username AS "creatorUsername",
         c."avatarUrl" AS "creatorAvatarUrl",
         c.platform AS "creatorPlatform",
         p."chatterId",
         COALESCE(u.name, NULLIF(p."chatterName", '')) AS "chatterName",
         p."paymentMethod",
         p.amount,
         p.currency,
         p.notes,
         p."createdAt",
         p."updatedAt"
  FROM alternative_payments p
  LEFT JOIN creators c ON c.id = p."creatorId"
  LEFT JOIN users u ON u.id = p."chatterId"
`;

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function emptyToNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseAmount(value) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100) / 100;
}

function serializePayment(row) {
  return {
    id: row.id,
    saleCode: row.saleCode,
    saleDate: row.saleDate,
    fanName: row.fanName || null,
    creatorId: row.creatorId || null,
    creatorName: row.creatorName || null,
    creatorUsername: row.creatorUsername || null,
    creatorAvatarUrl: row.creatorAvatarUrl || null,
    creatorPlatform: row.creatorPlatform || null,
    chatterId: row.chatterId || null,
    chatterName: row.chatterName || null,
    paymentMethod: row.paymentMethod,
    amount: Number(row.amount) || 0,
    currency: row.currency === 'USD' ? 'USD' : 'EUR',
    notes: row.notes || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the one to surface.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function loadPayment(client, id) {
  const result = await client.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [id]);
  return result.rows[0] || null;
}

async function resolveCreator(client, creatorId) {
  if (!creatorId) return null;
  const result = await client.query(
    `SELECT id, "displayName" AS name, platform FROM creators WHERE id = $1`,
    [creatorId]
  );
  const creator = result.rows[0] || null;
  if (creator && creator.platform !== 'telegram') {
    const error = new Error('Alternative payments can only be attached to a Telegram creator');
    error.status = 400;
    throw error;
  }
  return creator;
}

async function resolveChatter(client, chatterId) {
  if (!chatterId) return null;
  const result = await client.query(
    `SELECT id, name, email, role
     FROM users
     WHERE id = $1 AND role = ANY($2::text[])`,
    [chatterId, STAFF_ROLES]
  );
  return result.rows[0] || null;
}

async function syncLedger(client, paymentId) {
  const result = await client.query(
    `SELECT p.id,
            to_char(p."saleDate", 'YYYY-MM-DD') AS "saleDate",
            p."fanName",
            p."creatorId",
            p."chatterId",
            p.amount,
            p.currency,
            p.notes,
            c."displayName" AS "creatorName",
            c.username AS "creatorUsername",
            c."avatarUrl" AS "creatorAvatarUrl",
            u.name AS "chatterName",
            u.email AS "chatterEmail"
     FROM alternative_payments p
     LEFT JOIN creators c ON c.id = p."creatorId"
     LEFT JOIN users u ON u.id = p."chatterId"
     WHERE p.id = $1`,
    [paymentId]
  );
  const payment = result.rows[0];
  if (!payment) return null;

  const messageId = `altpay:${payment.id}`;
  const sentAt = `${payment.saleDate}T12:00:00.000Z`;
  const ledger = await client.query(
    `INSERT INTO messaging_dashboard_entries (
       id,
       "creatorId",
       "creatorName",
       "creatorUsername",
       "creatorAvatarUrl",
       platform,
       "chatterId",
       "chatterName",
       "chatterEmail",
       "chatId",
       "fanId",
       "fanUsername",
       "maloumMessageId",
       "contentType",
       "actualSentText",
       "priceNet",
       currency,
       purchased,
       "unlockedAt",
       "payoutVerified",
       "payoutVerifiedAt",
       "sentAt"
     ) VALUES (
       $1, $2, $3, $4, $5, 'alternative', $6, $7, $8, $9,
       NULL, $10, $11, 'alternative_payment', $12, $13, $14,
       TRUE, $15, TRUE, $15, $15
     )
     ON CONFLICT ("maloumMessageId") DO UPDATE SET
       "creatorId" = EXCLUDED."creatorId",
       "creatorName" = EXCLUDED."creatorName",
       "creatorUsername" = EXCLUDED."creatorUsername",
       "creatorAvatarUrl" = EXCLUDED."creatorAvatarUrl",
       platform = 'alternative',
       "chatterId" = EXCLUDED."chatterId",
       "chatterName" = EXCLUDED."chatterName",
       "chatterEmail" = EXCLUDED."chatterEmail",
       "fanUsername" = EXCLUDED."fanUsername",
       "actualSentText" = EXCLUDED."actualSentText",
       "priceNet" = EXCLUDED."priceNet",
       currency = EXCLUDED.currency,
       purchased = TRUE,
       "unlockedAt" = EXCLUDED."unlockedAt",
       "payoutVerified" = TRUE,
       "payoutVerifiedAt" = EXCLUDED."payoutVerifiedAt",
       "sentAt" = EXCLUDED."sentAt",
       "updatedAt" = NOW()
     RETURNING id`,
    [
      randomUUID(),
      payment.creatorId,
      payment.creatorName || '',
      payment.creatorUsername || null,
      payment.creatorAvatarUrl || null,
      payment.chatterId,
      payment.chatterName || '',
      payment.chatterEmail || null,
      messageId,
      payment.fanName || null,
      messageId,
      payment.notes || null,
      payment.amount,
      payment.currency === 'USD' ? 'USD' : 'EUR',
      sentAt,
    ]
  );

  const messagingEntryId = ledger.rows[0].id;
  await client.query(
    `UPDATE alternative_payments
     SET "messagingEntryId" = $2,
         "creatorName" = $3,
         "chatterName" = $4,
         "updatedAt" = NOW()
     WHERE id = $1`,
    [
      payment.id,
      messagingEntryId,
      payment.creatorName || null,
      payment.chatterName || null,
    ]
  );
  return messagingEntryId;
}

function readPayload(body, { partial } = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];
  const payload = {};

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'saleDate')) {
    const saleDate = typeof source.saleDate === 'string' ? source.saleDate.trim() : '';
    if (!isIsoDate(saleDate)) errors.push('A valid sale date is required');
    else payload.saleDate = saleDate;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'paymentMethod')) {
    const paymentMethod = String(source.paymentMethod || '').trim().toLowerCase();
    if (!PAYMENT_METHODS.has(paymentMethod)) errors.push('Payment method is invalid');
    else payload.paymentMethod = paymentMethod;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'amount')) {
    const amount = parseAmount(source.amount);
    if (amount == null) errors.push('Amount must be zero or greater');
    else payload.amount = amount;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'currency')) {
    const currency = String(source.currency || 'EUR').trim().toUpperCase();
    if (!CURRENCIES.has(currency)) errors.push('Currency must be EUR or USD');
    else payload.currency = currency;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'fanName')) {
    const fanName = emptyToNull(source.fanName == null ? '' : String(source.fanName));
    if (fanName && fanName.length > 200) errors.push('Fan name is too long');
    else payload.fanName = fanName;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'notes')) {
    const notes = emptyToNull(source.notes == null ? '' : String(source.notes));
    if (notes && notes.length > 2000) errors.push('Notes are too long');
    else payload.notes = notes;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'creatorId')) {
    const creatorId = emptyToNull(source.creatorId == null ? '' : String(source.creatorId));
    if (creatorId && !isValidUuid(creatorId)) errors.push('Creator is invalid');
    else payload.creatorId = creatorId;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'chatterId')) {
    const chatterId = emptyToNull(source.chatterId == null ? '' : String(source.chatterId));
    if (chatterId && !isValidUuid(chatterId)) errors.push('Chatter is invalid');
    else payload.chatterId = chatterId;
  }

  return { payload, errors };
}

router.get('/', authenticate, requireOwnerOrManager, async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      paymentMethod,
      chatterId,
      creatorId,
      page = '1',
      limit = '20',
    } = req.query;

    const conditions = [];
    const values = [];

    function add(condition, value) {
      values.push(value);
      conditions.push(condition.replace('?', `$${values.length}`));
    }

    if (startDate != null && String(startDate).trim() !== '') {
      if (!isIsoDate(String(startDate))) {
        return res.status(400).json({ error: 'Invalid startDate' });
      }
      add('p."saleDate" >= ?::date', String(startDate));
    }
    if (endDate != null && String(endDate).trim() !== '') {
      if (!isIsoDate(String(endDate))) {
        return res.status(400).json({ error: 'Invalid endDate' });
      }
      add('p."saleDate" <= ?::date', String(endDate));
    }
    if (paymentMethod != null && String(paymentMethod).trim() !== '') {
      const method = String(paymentMethod).trim().toLowerCase();
      if (!PAYMENT_METHODS.has(method)) {
        return res.status(400).json({ error: 'Invalid payment method' });
      }
      add('p."paymentMethod" = ?', method);
    }
    if (chatterId === 'unassigned') {
      conditions.push('p."chatterId" IS NULL');
    } else if (chatterId != null && String(chatterId).trim() !== '') {
      if (!isValidUuid(String(chatterId))) {
        return res.status(400).json({ error: 'Invalid chatterId' });
      }
      add('p."chatterId" = ?', String(chatterId));
    }
    if (creatorId === 'unassigned') {
      conditions.push('p."creatorId" IS NULL');
    } else if (creatorId != null && String(creatorId).trim() !== '') {
      if (!isValidUuid(String(creatorId))) {
        return res.status(400).json({ error: 'Invalid creatorId' });
      }
      add('p."creatorId" = ?', String(creatorId));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const parsedPage = Math.max(Number.parseInt(String(page), 10) || 1, 1);
    const parsedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
    const offset = (parsedPage - 1) * parsedLimit;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM alternative_payments p
       ${whereClause}`,
      values
    );
    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `${PAYMENT_SELECT}
       ${whereClause}
       ORDER BY p."saleDate" DESC, p."saleCode" DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, parsedLimit, offset]
    );

    const totalsResult = await pool.query(
      `SELECT p.currency,
              COALESCE(SUM(p.amount), 0)::float AS amount
       FROM alternative_payments p
       ${whereClause}
       GROUP BY p.currency`,
      values
    );

    const from = total === 0 ? 0 : offset + 1;
    const to = total === 0 ? 0 : Math.min(offset + dataResult.rows.length, total);

    res.json({
      data: dataResult.rows.map(serializePayment),
      totals: totalsResult.rows
        .map((row) => ({
          currency: row.currency === 'USD' ? 'USD' : 'EUR',
          amount: Number(row.amount) || 0,
        }))
        .filter((row) => row.amount > 0),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        from,
        to,
      },
    });
  } catch (err) {
    console.error('list alternative payments failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authenticate, requireOwnerOrManager, async (req, res) => {
  const { payload, errors } = readPayload(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: errors[0] });
  }

  try {
    const created = await withTransaction(async (client) => {
      const creator = await resolveCreator(client, payload.creatorId);
      if (payload.creatorId && !creator) {
        const error = new Error('Creator not found');
        error.status = 400;
        throw error;
      }
      const chatter = await resolveChatter(client, payload.chatterId);
      if (payload.chatterId && !chatter) {
        const error = new Error('Chatter must be a chatter or team leader');
        error.status = 400;
        throw error;
      }

      const id = randomUUID();
      await client.query(
        `INSERT INTO alternative_payments (
           id,
           "saleCode",
           "saleDate",
           "fanName",
           "creatorId",
           "creatorName",
           "chatterId",
           "chatterName",
           "paymentMethod",
           amount,
           currency,
           notes,
           "createdBy",
           "updatedBy"
         ) VALUES (
           $1,
           'ALT-' || lpad(nextval('alternative_payment_sale_seq')::text, 3, '0'),
           $2::date,
           $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12
         )`,
        [
          id,
          payload.saleDate,
          payload.fanName,
          creator?.id || null,
          creator?.name || null,
          chatter?.id || null,
          chatter?.name || null,
          payload.paymentMethod,
          payload.amount,
          payload.currency,
          payload.notes,
          req.user.id,
        ]
      );
      await syncLedger(client, id);
      return loadPayment(client, id);
    });

    res.status(201).json({ payment: serializePayment(created) });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error('create alternative payment failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', authenticate, requireOwnerOrManager, async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid payment id' });
  }
  const { payload, errors } = readPayload(req.body, { partial: true });
  if (errors.length > 0) {
    return res.status(400).json({ error: errors[0] });
  }
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: 'No changes to save' });
  }

  try {
    const updated = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, "creatorId", "chatterId"
         FROM alternative_payments
         WHERE id = $1
         FOR UPDATE`,
        [req.params.id]
      );
      if (!existing.rows[0]) {
        const error = new Error('Payment not found');
        error.status = 404;
        throw error;
      }

      const nextCreatorId = Object.prototype.hasOwnProperty.call(payload, 'creatorId')
        ? payload.creatorId
        : existing.rows[0].creatorId;
      const nextChatterId = Object.prototype.hasOwnProperty.call(payload, 'chatterId')
        ? payload.chatterId
        : existing.rows[0].chatterId;
      const creator = await resolveCreator(client, nextCreatorId);
      if (nextCreatorId && !creator) {
        const error = new Error('Creator not found');
        error.status = 400;
        throw error;
      }
      const chatter = await resolveChatter(client, nextChatterId);
      if (nextChatterId && !chatter) {
        const error = new Error('Chatter must be a chatter or team leader');
        error.status = 400;
        throw error;
      }

      const sets = [];
      const values = [];
      function set(column, value) {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }

      if (Object.prototype.hasOwnProperty.call(payload, 'saleDate')) {
        set('"saleDate"', payload.saleDate);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'fanName')) set('"fanName"', payload.fanName);
      if (Object.prototype.hasOwnProperty.call(payload, 'paymentMethod')) {
        set('"paymentMethod"', payload.paymentMethod);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'amount')) set('amount', payload.amount);
      if (Object.prototype.hasOwnProperty.call(payload, 'currency')) set('currency', payload.currency);
      if (Object.prototype.hasOwnProperty.call(payload, 'notes')) set('notes', payload.notes);
      if (Object.prototype.hasOwnProperty.call(payload, 'creatorId')) {
        set('"creatorId"', creator?.id || null);
        set('"creatorName"', creator?.name || null);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'chatterId')) {
        set('"chatterId"', chatter?.id || null);
        set('"chatterName"', chatter?.name || null);
      }
      set('"updatedBy"', req.user.id);
      sets.push('"updatedAt" = NOW()');
      values.push(req.params.id);

      await client.query(
        `UPDATE alternative_payments
         SET ${sets.join(', ')}
         WHERE id = $${values.length}`,
        values
      );
      await syncLedger(client, req.params.id);
      return loadPayment(client, req.params.id);
    });

    res.json({ payment: serializePayment(updated) });
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('update alternative payment failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticate, requireOwnerOrManager, async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid payment id' });
  }

  try {
    const removed = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, "messagingEntryId"
         FROM alternative_payments
         WHERE id = $1
         FOR UPDATE`,
        [req.params.id]
      );
      if (!existing.rows[0]) return false;
      await client.query('DELETE FROM alternative_payments WHERE id = $1', [req.params.id]);
      await client.query(
        `DELETE FROM messaging_dashboard_entries
         WHERE id = $1 OR "maloumMessageId" = $2`,
        [existing.rows[0].messagingEntryId, `altpay:${req.params.id}`]
      );
      return true;
    });

    if (!removed) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('delete alternative payment failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
