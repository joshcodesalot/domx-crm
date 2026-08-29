const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  userCanAccessCreator,
  userSeesAllCreators,
} = require('../services/creatorAccess');
const { applyModeration } = require('../services/contentModeration');
const {
  TelegramWorkerError,
  sendText,
  sendVaultToPeer,
} = require('../services/telegramWorker');
const {
  DEFAULT_BLOCKS,
  clampBlockCount,
  generateFemdomSession,
  assignBlocksToCreators,
} = require('../services/femdomSessionGenerator');

const router = express.Router();

const INTENSITIES = new Set(['soft', 'medium', 'extreme']);
const ORGASM_RULES = new Set(['denied', 'ruined', 'full', 'multiple']);
const GOALS = new Set(['training', 'punishment', 'reward', 'edge-only']);

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function handleTelegramError(res, err, logLabel) {
  if (err instanceof TelegramWorkerError) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  console.error(logLabel, err);
  const message = err?.message
    ? String(err.message).slice(0, 240)
    : 'Telegram request failed';
  return res.status(400).json({ error: message });
}

function trimText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function parseUuidList(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  return [...new Set(source.map((id) => String(id || '').trim()).filter(isValidUuid))];
}

function serializeSession(row, blocks = null) {
  const session = {
    id: row.id,
    fanName: row.fanName,
    slaveName: row.slaveName,
    groupPeerId: row.groupPeerId,
    creatorIds: row.creatorIds || [],
    numberOfBlocks: row.numberOfBlocks,
    toys: row.toys,
    intensity: row.intensity,
    orgasmRule: row.orgasmRule,
    themes: row.themes,
    goal: row.goal,
    scenario: row.scenario,
    extraInstructions: row.extraInstructions,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pendingCount: Number(row.pendingCount) || 0,
    sentCount: Number(row.sentCount) || 0,
  };
  if (blocks) {
    session.blocks = blocks.map(serializeBlock);
  }
  return session;
}

function serializeBlock(row) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    blockIndex: row.blockIndex,
    creatorId: row.creatorId,
    speakerName: row.speakerName,
    creatorName: row.creatorName || row.speakerName,
    creatorAvatarUrl: row.creatorAvatarUrl || null,
    englishText: row.englishText,
    vaultIds: parseUuidList(row.vaultIds),
    status: row.status,
    sentAt: row.sentAt,
    sentBy: row.sentBy,
    telegramMessageId: row.telegramMessageId,
  };
}

async function getAssignedCreatorIds(userId) {
  const result = await pool.query(
    `SELECT "creatorId" FROM creator_staff_assignments WHERE "userId" = $1`,
    [userId]
  );
  return result.rows.map((row) => row.creatorId);
}

async function userCanAccessSession(user, creatorIds) {
  const ids = Array.isArray(creatorIds) ? creatorIds : [];
  if (ids.length === 0) return userSeesAllCreators(user);
  for (const creatorId of ids) {
    if (await userCanAccessCreator(user, creatorId)) {
      return true;
    }
  }
  return false;
}

async function loadSessionRow(id) {
  const result = await pool.query(
    `SELECT s.*,
            COUNT(*) FILTER (WHERE b.status = 'pending')::int AS "pendingCount",
            COUNT(*) FILTER (WHERE b.status = 'sent')::int AS "sentCount"
     FROM telegram_sexting_sessions s
     LEFT JOIN telegram_sexting_session_blocks b ON b."sessionId" = s.id
     WHERE s.id = $1
     GROUP BY s.id`,
    [id]
  );
  return result.rows[0] || null;
}

async function loadSessionBlocks(sessionId) {
  const result = await pool.query(
    `SELECT b.*, c."displayName" AS "creatorName", c."avatarUrl" AS "creatorAvatarUrl"
     FROM telegram_sexting_session_blocks b
     JOIN creators c ON c.id = b."creatorId"
     WHERE b."sessionId" = $1
     ORDER BY b."blockIndex" ASC`,
    [sessionId]
  );
  return result.rows;
}

async function recordVaultSent({ creatorId, fanId, itemIds, userId }) {
  const ids = (itemIds || []).filter((id) => isValidUuid(id));
  if (!ids.length) return;
  await pool.query(
    `INSERT INTO telegram_vault_sent ("creatorId", "fanId", "itemId", "sentByUserId")
     SELECT $1, $2, x.item_id, $3
     FROM unnest($4::uuid[]) AS x(item_id)
     ON CONFLICT ("creatorId", "fanId", "itemId")
     DO UPDATE SET
       "sentByUserId" = COALESCE(EXCLUDED."sentByUserId", telegram_vault_sent."sentByUserId"),
       "sentAt" = NOW()`,
    [creatorId, String(fanId), userId || null, ids]
  );
}

router.use(authenticate, requirePermission('creators.view'));

router.get('/', async (req, res) => {
  try {
    const values = [];
    let accessClause = '';
    if (!userSeesAllCreators(req.user)) {
      const assigned = await getAssignedCreatorIds(req.user.id);
      if (assigned.length === 0) {
        return res.json({ sessions: [] });
      }
      values.push(assigned);
      accessClause = `WHERE s."creatorIds" && $${values.length}::uuid[]`;
    }

    const result = await pool.query(
      `SELECT s.*,
              COUNT(*) FILTER (WHERE b.status = 'pending')::int AS "pendingCount",
              COUNT(*) FILTER (WHERE b.status = 'sent')::int AS "sentCount"
       FROM telegram_sexting_sessions s
       LEFT JOIN telegram_sexting_session_blocks b ON b."sessionId" = s.id
       ${accessClause}
       GROUP BY s.id
       ORDER BY s."createdAt" DESC`,
      values
    );
    return res.json({ sessions: result.rows.map((row) => serializeSession(row)) });
  } catch (err) {
    console.error('List telegram sexting sessions error:', err);
    return res.status(500).json({ error: 'Failed to load sessions' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  try {
    const session = await loadSessionRow(id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await userCanAccessSession(req.user, session.creatorIds))) {
      return res.status(403).json({ error: 'You do not have access to this session' });
    }
    const blocks = await loadSessionBlocks(id);
    return res.json({ session: serializeSession(session, blocks) });
  } catch (err) {
    console.error('Get telegram sexting session error:', err);
    return res.status(500).json({ error: 'Failed to load session' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  try {
    const session = await loadSessionRow(id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await userCanAccessSession(req.user, session.creatorIds))) {
      return res.status(403).json({ error: 'You do not have access to this session' });
    }
    await pool.query(`DELETE FROM telegram_sexting_sessions WHERE id = $1`, [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Delete telegram sexting session error:', err);
    return res.status(500).json({ error: 'Failed to delete session' });
  }
});

router.post('/', async (req, res) => {
  req.setTimeout(180000);
  const body = req.body || {};
  const fanName = trimText(body.fanName);
  const slaveName = trimText(body.slaveName);
  const groupPeerId = trimText(body.groupPeerId);
  const creatorIds = parseUuidList(body.creatorIds);
  const toys = trimText(body.toys);
  const intensity = trimText(body.intensity, 'medium').toLowerCase();
  const orgasmRule = trimText(body.orgasmRule, 'denied').toLowerCase();
  const themes = trimText(body.themes);
  const goal = trimText(body.goal, 'training').toLowerCase();
  const scenario = trimText(body.scenario);
  const extraInstructions = trimText(body.extraInstructions);

  if (!fanName) return res.status(400).json({ error: 'Fan name is required' });
  if (!slaveName) return res.status(400).json({ error: 'Slave name is required' });
  if (!groupPeerId) {
    return res.status(400).json({ error: 'Chat ID is required' });
  }
  const numberOfBlocks = clampBlockCount(
    body.numberOfBlocks == null ? DEFAULT_BLOCKS : body.numberOfBlocks
  );
  if (creatorIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one Telegram creator' });
  }
  if (!INTENSITIES.has(intensity)) {
    return res.status(400).json({ error: 'Invalid intensity' });
  }
  if (!ORGASM_RULES.has(orgasmRule)) {
    return res.status(400).json({ error: 'Invalid orgasm rule' });
  }
  if (!GOALS.has(goal)) {
    return res.status(400).json({ error: 'Invalid goal' });
  }

  try {
    for (const creatorId of creatorIds) {
      const allowed = await userCanAccessCreator(req.user, creatorId);
      if (!allowed) {
        return res.status(403).json({
          error: 'You do not have access to one of the selected creators',
        });
      }
    }

    const creatorsResult = await pool.query(
      `SELECT id, "displayName", platform
       FROM creators
       WHERE id = ANY($1::uuid[])`,
      [creatorIds]
    );
    if (creatorsResult.rows.length !== creatorIds.length) {
      return res.status(400).json({ error: 'One or more creators were not found' });
    }
    if (creatorsResult.rows.some((row) => row.platform !== 'telegram')) {
      return res.status(400).json({ error: 'Creator list must be Telegram creators only' });
    }

    const creators = creatorIds
      .map((id) => creatorsResult.rows.find((row) => row.id === id))
      .filter(Boolean);
    const generated = await generateFemdomSession({
      slaveName,
      dommes: creators.map((creator) => creator.displayName),
      toys,
      intensity,
      orgasmRule,
      themes,
      goal,
      scenario,
      extraInstructions,
      numberOfBlocks,
    });
    const assigned = assignBlocksToCreators(generated.blocks, creators);

    const client = await pool.connect();
    let sessionId = null;
    try {
      await client.query('BEGIN');
      const sessionInsert = await client.query(
        `INSERT INTO telegram_sexting_sessions (
           "fanName", "slaveName", "groupPeerId", "creatorIds", "numberOfBlocks",
           toys, intensity, "orgasmRule", themes, goal, scenario,
           "extraInstructions", "rawOutput", "createdBy"
         ) VALUES (
           $1, $2, $3, $4::uuid[], $5,
           $6, $7, $8, $9, $10, $11,
           $12, $13, $14
         )
         RETURNING id`,
        [
          fanName,
          slaveName,
          groupPeerId,
          creatorIds,
          generated.numberOfBlocks || numberOfBlocks,
          toys,
          intensity,
          orgasmRule,
          themes,
          goal,
          scenario,
          extraInstructions,
          generated.rawOutput,
          req.user.id,
        ]
      );
      sessionId = sessionInsert.rows[0].id;

      for (const block of assigned) {
        await client.query(
          `INSERT INTO telegram_sexting_session_blocks (
             "sessionId", "blockIndex", "creatorId", "speakerName", "englishText"
           ) VALUES ($1, $2, $3, $4, $5)`,
          [sessionId, block.index, block.creatorId, block.speaker, block.text]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const session = await loadSessionRow(sessionId);
    const blocks = await loadSessionBlocks(sessionId);
    return res.status(201).json({ session: serializeSession(session, blocks) });
  } catch (err) {
    console.error('Generate telegram sexting session error:', err);
    return res.status(500).json({
      error: err?.message || 'Failed to generate session',
    });
  }
});

router.patch('/:id/blocks/:blockId', async (req, res) => {
  const { id, blockId } = req.params;
  if (!isValidUuid(id) || !isValidUuid(blockId)) {
    return res.status(400).json({ error: 'Invalid session or block ID' });
  }

  try {
    const session = await loadSessionRow(id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await userCanAccessSession(req.user, session.creatorIds))) {
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    const existing = await pool.query(
      `SELECT * FROM telegram_sexting_session_blocks
       WHERE id = $1 AND "sessionId" = $2`,
      [blockId, id]
    );
    const block = existing.rows[0];
    if (!block) {
      return res.status(404).json({ error: 'Block not found' });
    }
    if (block.status === 'sent') {
      return res.status(409).json({ error: 'Sent blocks cannot be edited' });
    }

    const allowed = await userCanAccessCreator(req.user, block.creatorId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }

    const nextText =
      typeof req.body?.englishText === 'string'
        ? req.body.englishText
        : block.englishText;
    const nextVaultIds =
      req.body?.vaultIds == null ? parseUuidList(block.vaultIds) : parseUuidList(req.body.vaultIds);

    if (nextVaultIds.length > 0) {
      const vaultCheck = await pool.query(
        `SELECT id FROM telegram_vault_items
         WHERE "creatorId" = $1 AND id = ANY($2::uuid[])`,
        [block.creatorId, nextVaultIds]
      );
      if (vaultCheck.rows.length !== nextVaultIds.length) {
        return res.status(400).json({ error: 'One or more vault items were not found' });
      }
    }

    await pool.query(
      `UPDATE telegram_sexting_session_blocks
       SET "englishText" = $1, "vaultIds" = $2::jsonb
       WHERE id = $3`,
      [nextText, JSON.stringify(nextVaultIds), blockId]
    );
    await pool.query(
      `UPDATE telegram_sexting_sessions SET "updatedAt" = NOW() WHERE id = $1`,
      [id]
    );

    const refreshed = await loadSessionRow(id);
    const blocks = await loadSessionBlocks(id);
    return res.json({ session: serializeSession(refreshed, blocks) });
  } catch (err) {
    console.error('Update telegram sexting block error:', err);
    return res.status(500).json({ error: 'Failed to update block' });
  }
});

router.post('/:id/blocks/:blockId/send', async (req, res) => {
  const { id, blockId } = req.params;
  if (!isValidUuid(id) || !isValidUuid(blockId)) {
    return res.status(400).json({ error: 'Invalid session or block ID' });
  }

  try {
    const session = await loadSessionRow(id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await userCanAccessSession(req.user, session.creatorIds))) {
      return res.status(403).json({ error: 'You do not have access to this session' });
    }

    const existing = await pool.query(
      `SELECT b.*, c."displayName" AS "creatorName"
       FROM telegram_sexting_session_blocks b
       JOIN creators c ON c.id = b."creatorId"
       WHERE b.id = $1 AND b."sessionId" = $2`,
      [blockId, id]
    );
    const block = existing.rows[0];
    if (!block) {
      return res.status(404).json({ error: 'Block not found' });
    }
    if (block.status === 'sent') {
      return res.status(409).json({ error: 'This block was already sent' });
    }

    const allowed = await userCanAccessCreator(req.user, block.creatorId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }

    const englishText =
      typeof req.body?.englishText === 'string'
        ? req.body.englishText
        : block.englishText;
    const sendTextValue =
      typeof req.body?.text === 'string' && req.body.text.trim()
        ? req.body.text.trim()
        : String(englishText || '').trim();
    const vaultIds =
      req.body?.vaultIds == null
        ? parseUuidList(block.vaultIds)
        : parseUuidList(req.body.vaultIds);

    if (!sendTextValue && vaultIds.length === 0) {
      return res.status(400).json({ error: 'Message text or vault media is required' });
    }

    if (sendTextValue) {
      const moderation = await applyModeration({
        germanText: sendTextValue,
        englishText: typeof englishText === 'string' ? englishText : '',
        userId: req.user.id,
        creatorId: block.creatorId,
        platform: 'telegram',
        chatId: String(session.groupPeerId),
        fanId: String(session.groupPeerId),
        fanUsername: session.fanName || null,
        creatorName: block.creatorName,
        chatterName: req.user.name || null,
      });
      if (moderation.blocked) {
        return res.status(403).json({
          error: moderation.message,
          code: 'CONTENT_BLOCKED',
          matchedKeyword: moderation.matchedKeyword,
          matchedStage: moderation.matchedStage,
        });
      }
    }

    let sentMessages = [];
    if (vaultIds.length === 0) {
      const message = await sendText(block.creatorId, session.groupPeerId, sendTextValue);
      sentMessages = [message];
    } else {
      const items = await pool.query(
        `SELECT id, "savedMessageId"
         FROM telegram_vault_items
         WHERE "creatorId" = $1 AND id = ANY($2::uuid[])`,
        [block.creatorId, vaultIds]
      );
      if (items.rows.length !== vaultIds.length) {
        return res.status(400).json({ error: 'One or more vault items were not found' });
      }
      const byId = new Map(items.rows.map((row) => [row.id, row]));
      const ordered = vaultIds.map((itemId) => byId.get(itemId)).filter(Boolean);
      sentMessages = await sendVaultToPeer(block.creatorId, session.groupPeerId, {
        itemMessageIds: ordered.map((row) => row.savedMessageId),
        caption: sendTextValue,
      });
      await recordVaultSent({
        creatorId: block.creatorId,
        fanId: session.groupPeerId,
        itemIds: ordered.map((row) => row.id),
        userId: req.user.id,
      });
    }

    const firstId = sentMessages[0]?.id ? String(sentMessages[0].id) : null;
    await pool.query(
      `UPDATE telegram_sexting_session_blocks
       SET "englishText" = $1,
           "vaultIds" = $2::jsonb,
           status = 'sent',
           "sentAt" = NOW(),
           "sentBy" = $3,
           "telegramMessageId" = $4
       WHERE id = $5`,
      [englishText, JSON.stringify(vaultIds), req.user.id, firstId, blockId]
    );
    await pool.query(
      `UPDATE telegram_sexting_sessions SET "updatedAt" = NOW() WHERE id = $1`,
      [id]
    );

    const refreshed = await loadSessionRow(id);
    const blocks = await loadSessionBlocks(id);
    return res.json({
      session: serializeSession(refreshed, blocks),
      telegramMessageId: firstId,
    });
  } catch (err) {
    return handleTelegramError(res, err, 'Send telegram sexting block error:');
  }
});

module.exports = router;
