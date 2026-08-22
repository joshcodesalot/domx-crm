const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator } = require('../services/creatorAccess');
const { applyModeration } = require('../services/contentModeration');
const {
  TelegramWorkerError,
  startPhoneLogin,
  completePhoneLogin,
  abortPendingLogin,
  persistPendingConnect,
  applyReconnectReady,
  listDialogs,
  listMessages,
  sendText,
  deleteText,
  resolveUsername,
  unreadCount,
  disconnectCreator,
} = require('../services/telegramWorker');
const {
  canOpenChatByUsername,
  redactFan,
  redactDialog,
  redactMessage,
} = require('../services/telegramFanView');
const { upsertMessageUnsend } = require('../services/messageUnsend');

const router = express.Router();

const connectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { error: 'Too many Telegram connect attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

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
  const message = err?.message ? String(err.message).slice(0, 240) : 'Telegram request failed';
  return res.status(400).json({ error: message });
}

router.post(
  '/connect/telegram/start',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { accountId, phone } = req.body || {};
    if (!isValidUuid(accountId)) {
      return res.status(400).json({ error: 'Invalid account ID' });
    }
    try {
      const result = await startPhoneLogin({ accountId, phone });
      return res.json(result);
    } catch (err) {
      return handleTelegramError(res, err, 'Telegram connect start error:');
    }
  }
);

router.post(
  '/connect/telegram/complete',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { accountId, code, password } = req.body || {};
    if (!isValidUuid(accountId)) {
      return res.status(400).json({ error: 'Invalid account ID' });
    }
    try {
      const result = await completePhoneLogin({ accountId, code, password });
      if (result.status !== 'ready') {
        return res.json({ status: result.status });
      }
      const pending = await persistPendingConnect({
        accountId,
        createdBy: req.user.id,
        user: result.user,
        phone: result.phone,
        storageKey: result.storageKey,
        encryptedSession: result.encryptedSession,
        avatarUrl: result.avatarUrl || null,
      });
      return res.status(201).json({
        status: 'ready',
        ...pending,
      });
    } catch (err) {
      return handleTelegramError(res, err, 'Telegram connect complete error:');
    }
  }
);

router.post(
  '/connect/telegram/abort',
  authenticate,
  requirePermission('creators.manage'),
  async (req, res) => {
    const { accountId } = req.body || {};
    if (!isValidUuid(accountId)) {
      return res.status(400).json({ error: 'Invalid account ID' });
    }
    await abortPendingLogin(accountId);
    return res.json({ ok: true });
  }
);

router.post(
  '/:id/telegram/reconnect/start',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    const { phone } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const creator = await pool.query(
        `SELECT id, platform FROM creators WHERE id = $1`,
        [id]
      );
      if (creator.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (creator.rows[0].platform !== 'telegram') {
        return res.status(400).json({ error: 'Creator is not a Telegram account' });
      }
      await disconnectCreator(id);
      const result = await startPhoneLogin({
        accountId: id,
        phone,
        storageKey: id,
        wipeStorage: true,
      });
      return res.json(result);
    } catch (err) {
      return handleTelegramError(res, err, 'Telegram reconnect start error:');
    }
  }
);

router.post(
  '/:id/telegram/reconnect/complete',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    const { code, password } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const creator = await pool.query(
        `SELECT id, platform FROM creators WHERE id = $1`,
        [id]
      );
      if (creator.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (creator.rows[0].platform !== 'telegram') {
        return res.status(400).json({ error: 'Creator is not a Telegram account' });
      }
      const result = await completePhoneLogin({
        accountId: id,
        code,
        password,
      });
      if (result.status !== 'ready') {
        return res.json({ status: result.status });
      }
      const row = await applyReconnectReady(id, result);
      return res.json({
        status: 'ready',
        creator: {
          id: row.id,
          displayName: row.displayName,
          username: row.username,
          platform: row.platform,
          connectionStatus: row.connectionStatus,
          postLoginUrl: row.postLoginUrl,
          avatarUrl: row.avatarUrl,
          avatarSource: row.avatarSource,
          staffCount: row.staffCount,
          accountId: row.accountId,
          partitionId: row.partitionId,
          loginEmail: row.loginEmail,
          lastValidatedAt: row.lastValidatedAt,
          authRefreshState: row.authRefreshState,
          accessTokenExpiresAt: row.accessTokenExpiresAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      });
    } catch (err) {
      return handleTelegramError(res, err, 'Telegram reconnect complete error:');
    }
  }
);

router.get(
  '/:id/telegram/dialogs',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const dialogs = await listDialogs(id, {
        limit: Number(req.query.limit) || 80,
      });
      return res.json({
        dialogs: dialogs.map((dialog) => redactDialog(dialog, req.user)),
      });
    } catch (err) {
      return handleTelegramError(res, err, 'List Telegram dialogs error:');
    }
  }
);

router.get(
  '/:id/telegram/dialogs/:peerId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, peerId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const result = await listMessages(id, peerId, {
        limit: Number(req.query.limit) || 50,
      });
      return res.json({
        peerId: result.peerId,
        kind: result.kind || 'dm',
        fan: redactFan(result.fan, req.user),
        messages: result.messages.map((msg) => redactMessage(msg, req.user)),
      });
    } catch (err) {
      return handleTelegramError(res, err, 'List Telegram messages error:');
    }
  }
);

router.post(
  '/:id/telegram/dialogs/:peerId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, peerId } = req.params;
    const { text, englishText } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const creatorRow = await pool.query(
        `SELECT id, "displayName", platform FROM creators WHERE id = $1`,
        [id]
      );
      if (creatorRow.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (creatorRow.rows[0].platform !== 'telegram') {
        return res.status(400).json({ error: 'Creator is not a Telegram account' });
      }

      const moderation = await applyModeration({
        germanText: trimmed,
        englishText: typeof englishText === 'string' ? englishText : '',
        userId: req.user.id,
        creatorId: id,
        platform: 'telegram',
        chatId: String(peerId),
        fanId: String(peerId),
        fanUsername: null,
        creatorName: creatorRow.rows[0].displayName,
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

      const message = await sendText(id, peerId, trimmed);
      return res.status(201).json({ message: redactMessage(message, req.user) });
    } catch (err) {
      return handleTelegramError(res, err, 'Send Telegram message error:');
    }
  }
);

router.delete(
  '/:id/telegram/dialogs/:peerId/messages/:messageId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, peerId, messageId } = req.params;
    const { originalText, messageSentAt } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      await deleteText(id, peerId, messageId);
      let unsend = null;
      try {
        unsend = await upsertMessageUnsend({
          creatorId: id,
          platform: 'telegram',
          chatId: String(peerId),
          platformMessageId: String(messageId),
          originalText,
          messageSentAt,
          user: req.user,
        });
      } catch (auditErr) {
        console.error('Persist Telegram message unsend error:', auditErr);
      }
      return res.json({ ok: true, unsend });
    } catch (err) {
      return handleTelegramError(res, err, 'Delete Telegram message error:');
    }
  }
);

router.patch(
  '/:id/telegram/fans/:telegramUserId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, telegramUserId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    const fanId = String(telegramUserId || '').trim();
    if (!fanId) {
      return res.status(400).json({ error: 'telegramUserId is required' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const nickname =
        typeof req.body?.nickname === 'string' ? req.body.nickname.trim() : undefined;
      const notes =
        typeof req.body?.notes === 'string' ? req.body.notes : undefined;
      if (nickname === undefined && notes === undefined) {
        return res.status(400).json({ error: 'nickname or notes is required' });
      }

      const existing = await pool.query(
        `SELECT "telegramUserId", username, "displayName", nickname, notes, "avatarUrl"
         FROM telegram_fan_profiles
         WHERE "creatorId" = $1 AND "telegramUserId" = $2`,
        [id, fanId]
      );
      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO telegram_fan_profiles (
             "creatorId", "telegramUserId", "displayName", nickname, notes
           )
           VALUES ($1, $2, $3, $4, $5)`,
          [
            id,
            fanId,
            'Fan',
            nickname || '',
            notes === undefined ? '' : String(notes),
          ]
        );
      } else {
        const sets = ['"updatedAt" = NOW()'];
        const vals = [id, fanId];
        if (nickname !== undefined) {
          vals.push(nickname);
          sets.push(`nickname = $${vals.length}`);
        }
        if (notes !== undefined) {
          vals.push(String(notes));
          sets.push(`notes = $${vals.length}`);
        }
        await pool.query(
          `UPDATE telegram_fan_profiles
           SET ${sets.join(', ')}
           WHERE "creatorId" = $1 AND "telegramUserId" = $2`,
          vals
        );
      }

      const row = await pool.query(
        `SELECT "telegramUserId", username, "displayName", nickname, notes, "avatarUrl"
         FROM telegram_fan_profiles
         WHERE "creatorId" = $1 AND "telegramUserId" = $2`,
        [id, fanId]
      );
      return res.json({ fan: redactFan(row.rows[0], req.user) });
    } catch (err) {
      return handleTelegramError(res, err, 'Update Telegram fan error:');
    }
  }
);

router.post(
  '/:id/telegram/resolve-username',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!canOpenChatByUsername(req.user)) {
      return res.status(403).json({ error: 'Only owners and managers can open chats by username' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const resolved = await resolveUsername(id, req.body?.username);
      return res.json({
        peerId: resolved.peerId,
        fan: redactFan(resolved.fan, req.user),
      });
    } catch (err) {
      return handleTelegramError(res, err, 'Resolve Telegram username error:');
    }
  }
);

router.get(
  '/:id/telegram/unread',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const counts = await unreadCount(id);
      return res.json(counts);
    } catch (err) {
      return handleTelegramError(res, err, 'Telegram unread error:');
    }
  }
);

router.get(
  '/:id/telegram/badges',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const counts = await unreadCount(id);
      return res.json(counts);
    } catch (err) {
      return handleTelegramError(res, err, 'Telegram badges error:');
    }
  }
);

module.exports = router;
