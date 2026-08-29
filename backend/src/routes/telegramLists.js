const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator } = require('../services/creatorAccess');
const {
  isTelegramServiceDialog,
  listAllDmPeers,
  TelegramWorkerError,
} = require('../services/telegramWorker');

const router = express.Router();

const LIST_NAME_MAX = 80;

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function parseUuidList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || '').trim()).filter(isValidUuid))];
}

async function loadTelegramCreator(id) {
  const result = await pool.query(
    `SELECT id, "displayName", platform FROM creators WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) {
    return { error: { status: 404, message: 'Creator not found' } };
  }
  if (result.rows[0].platform !== 'telegram') {
    return { error: { status: 400, message: 'Creator is not a Telegram account' } };
  }
  return { creator: result.rows[0] };
}

async function requireTelegramCreator(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid creator ID' });
    return null;
  }
  const allowed = await userCanAccessCreator(req.user, id);
  if (!allowed) {
    res.status(403).json({ error: 'You do not have access to this creator' });
    return null;
  }
  const loaded = await loadTelegramCreator(id);
  if (loaded.error) {
    res.status(loaded.error.status).json({ error: loaded.error.message });
    return null;
  }
  return loaded.creator;
}

function handleTelegramError(res, err, logLabel) {
  if (err instanceof TelegramWorkerError) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  console.error(logLabel, err);
  const message = err?.message ? String(err.message).slice(0, 240) : 'Telegram request failed';
  return res.status(400).json({ error: message });
}

function serializeList(row) {
  return {
    id: row.id,
    _id: row.id,
    creatorId: row.creatorId,
    name: row.name,
    memberCount: Number(row.memberCount) || 0,
    totalMemberCount: Number(row.memberCount) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadLists(creatorId) {
  const result = await pool.query(
    `SELECT l.*, COUNT(m."telegramUserId")::int AS "memberCount"
     FROM telegram_lists l
     LEFT JOIN telegram_list_members m ON m."listId" = l.id
     WHERE l."creatorId" = $1
     GROUP BY l.id
     ORDER BY lower(l.name) ASC, l."createdAt" ASC`,
    [creatorId]
  );
  return result.rows.map(serializeList);
}

async function loadListForCreator(creatorId, listId) {
  const result = await pool.query(
    `SELECT l.*, COUNT(m."telegramUserId")::int AS "memberCount"
     FROM telegram_lists l
     LEFT JOIN telegram_list_members m ON m."listId" = l.id
     WHERE l.id = $1 AND l."creatorId" = $2
     GROUP BY l.id`,
    [listId, creatorId]
  );
  return result.rows[0] ? serializeList(result.rows[0]) : null;
}

async function assertAssignableFan(creatorId, telegramUserId) {
  const fanId = String(telegramUserId || '').trim();
  if (!fanId) return { error: { status: 400, message: 'Fan id is required' } };
  if (isTelegramServiceDialog({ peerId: fanId, kind: 'dm' })) {
    return { error: { status: 400, message: 'Service chats cannot be added to lists' } };
  }
  const result = await pool.query(
    `SELECT "telegramUserId", kind, "displayName", username, nickname
     FROM telegram_fan_profiles
     WHERE "creatorId" = $1 AND "telegramUserId" = $2`,
    [creatorId, fanId]
  );
  let row = result.rows[0];
  if (!row) {
    const inserted = await pool.query(
      `INSERT INTO telegram_fan_profiles (
         "creatorId", "telegramUserId", "displayName", kind
       ) VALUES ($1, $2, 'Fan', 'dm')
       ON CONFLICT ("creatorId", "telegramUserId") DO UPDATE SET "updatedAt" = NOW()
       RETURNING "telegramUserId", kind, "displayName", username, nickname`,
      [creatorId, fanId]
    );
    row = inserted.rows[0];
  }
  if (row.kind === 'group') {
    return { error: { status: 400, message: 'Groups cannot be added to lists' } };
  }
  return { fan: row };
}

router.get(
  '/:id/telegram/lists',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      return res.json({ lists: await loadLists(creator.id) });
    } catch (err) {
      console.error('List Telegram lists error:', err);
      return res.status(500).json({ error: 'Failed to load lists' });
    }
  }
);

router.post(
  '/:id/telegram/lists',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'List name is required' });
    }
    if (name.length > LIST_NAME_MAX) {
      return res.status(400).json({ error: `List name must be ${LIST_NAME_MAX} characters or fewer` });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const existing = await pool.query(
        `SELECT id FROM telegram_lists
         WHERE "creatorId" = $1 AND lower(name) = lower($2)`,
        [creator.id, name]
      );
      if (existing.rows[0]) {
        return res.status(409).json({ error: 'A list with that name already exists' });
      }
      const inserted = await pool.query(
        `INSERT INTO telegram_lists ("creatorId", name)
         VALUES ($1, $2)
         RETURNING *`,
        [creator.id, name]
      );
      return res.status(201).json({
        list: serializeList({ ...inserted.rows[0], memberCount: 0 }),
      });
    } catch (err) {
      console.error('Create Telegram list error:', err);
      return res.status(500).json({ error: 'Failed to create list' });
    }
  }
);

router.delete(
  '/:id/telegram/lists/:listId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { listId } = req.params;
    if (!isValidUuid(listId)) {
      return res.status(400).json({ error: 'Invalid list ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const result = await pool.query(
        `DELETE FROM telegram_lists WHERE id = $1 AND "creatorId" = $2 RETURNING id`,
        [listId, creator.id]
      );
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'List not found' });
      }
      return res.json({ ok: true, id: listId });
    } catch (err) {
      console.error('Delete Telegram list error:', err);
      return res.status(500).json({ error: 'Failed to delete list' });
    }
  }
);

router.get(
  '/:id/telegram/lists/:listId/members',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { listId } = req.params;
    if (!isValidUuid(listId)) {
      return res.status(400).json({ error: 'Invalid list ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const list = await loadListForCreator(creator.id, listId);
      if (!list) {
        return res.status(404).json({ error: 'List not found' });
      }
      const members = await pool.query(
        `SELECT m."telegramUserId",
                COALESCE(p."displayName", '') AS "displayName",
                COALESCE(p.nickname, '') AS nickname,
                p.username
         FROM telegram_list_members m
         LEFT JOIN telegram_fan_profiles p
           ON p."creatorId" = $1 AND p."telegramUserId" = m."telegramUserId"
         WHERE m."listId" = $2
         ORDER BY lower(COALESCE(NULLIF(p.nickname, ''), p."displayName", m."telegramUserId"))`,
        [creator.id, listId]
      );
      return res.json({ list, members: members.rows });
    } catch (err) {
      console.error('List Telegram list members error:', err);
      return res.status(500).json({ error: 'Failed to load members' });
    }
  }
);

router.post(
  '/:id/telegram/lists/:listId/members/from-dms',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { listId } = req.params;
    if (!isValidUuid(listId)) {
      return res.status(400).json({ error: 'Invalid list ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const existing = await loadListForCreator(creator.id, listId);
      if (!existing) {
        return res.status(404).json({ error: 'List not found' });
      }
      const peers = await listAllDmPeers(creator.id);
      const peerIds = peers.map((entry) => entry.peerId);
      let added = 0;
      if (peerIds.length > 0) {
        const inserted = await pool.query(
          `INSERT INTO telegram_list_members ("listId", "telegramUserId")
           SELECT $1, x.peer_id
           FROM unnest($2::text[]) AS x(peer_id)
           ON CONFLICT DO NOTHING`,
          [listId, peerIds]
        );
        added = inserted.rowCount || 0;
      }
      const list = await loadListForCreator(creator.id, listId);
      return res.json({
        list,
        added,
        totalDms: peerIds.length,
      });
    } catch (err) {
      return handleTelegramError(res, err, 'Fill Telegram list from DMs error:');
    }
  }
);

router.get(
  '/:id/telegram/fans/:fanId/lists',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const checked = await assertAssignableFan(creator.id, req.params.fanId);
      if (checked.error) {
        return res.status(checked.error.status).json({ error: checked.error.message });
      }
      const result = await pool.query(
        `SELECT l.*, COUNT(m2."telegramUserId")::int AS "memberCount"
         FROM telegram_lists l
         JOIN telegram_list_members m ON m."listId" = l.id
         LEFT JOIN telegram_list_members m2 ON m2."listId" = l.id
         WHERE l."creatorId" = $1 AND m."telegramUserId" = $2
         GROUP BY l.id
         ORDER BY lower(l.name) ASC`,
        [creator.id, checked.fan.telegramUserId]
      );
      return res.json({ lists: result.rows.map(serializeList) });
    } catch (err) {
      console.error('Get Telegram fan lists error:', err);
      return res.status(500).json({ error: 'Failed to load fan lists' });
    }
  }
);

router.put(
  '/:id/telegram/fans/:fanId/lists',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const listIds = parseUuidList(req.body?.listIds);
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const checked = await assertAssignableFan(creator.id, req.params.fanId);
      if (checked.error) {
        return res.status(checked.error.status).json({ error: checked.error.message });
      }
      if (listIds.length > 0) {
        const owned = await pool.query(
          `SELECT id FROM telegram_lists WHERE "creatorId" = $1 AND id = ANY($2::uuid[])`,
          [creator.id, listIds]
        );
        if (owned.rows.length !== listIds.length) {
          return res.status(400).json({ error: 'One or more lists were not found' });
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM telegram_list_members m
           USING telegram_lists l
           WHERE m."listId" = l.id
             AND l."creatorId" = $1
             AND m."telegramUserId" = $2`,
          [creator.id, checked.fan.telegramUserId]
        );
        if (listIds.length > 0) {
          await client.query(
            `INSERT INTO telegram_list_members ("listId", "telegramUserId")
             SELECT x.list_id, $2
             FROM unnest($1::uuid[]) AS x(list_id)
             ON CONFLICT DO NOTHING`,
            [listIds, checked.fan.telegramUserId]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const result = await pool.query(
        `SELECT l.*, COUNT(m2."telegramUserId")::int AS "memberCount"
         FROM telegram_lists l
         JOIN telegram_list_members m ON m."listId" = l.id
         LEFT JOIN telegram_list_members m2 ON m2."listId" = l.id
         WHERE l."creatorId" = $1 AND m."telegramUserId" = $2
         GROUP BY l.id
         ORDER BY lower(l.name) ASC`,
        [creator.id, checked.fan.telegramUserId]
      );
      return res.json({ lists: result.rows.map(serializeList) });
    } catch (err) {
      console.error('Set Telegram fan lists error:', err);
      return res.status(500).json({ error: 'Failed to update lists' });
    }
  }
);

module.exports = router;
