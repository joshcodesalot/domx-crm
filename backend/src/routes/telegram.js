const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator } = require('../services/creatorAccess');
const { applyModeration } = require('../services/contentModeration');
const {
  TelegramWorkerError,
  describeError,
  startPhoneLogin,
  completePhoneLogin,
  abortPendingLogin,
  persistPendingConnect,
  applyReconnectReady,
  listDialogs,
  listMessages,
  listChatMembers,
  sendText,
  sendVaultToPeer,
  uploadVaultMedia,
  deleteSavedVaultMessage,
  getCachedMessageMedia,
  getCachedVaultMedia,
  deleteText,
  resolveUsername,
  unreadCount,
  disconnectCreator,
  isTelegramServiceDialog,
} = require('../services/telegramWorker');
const {
  canOpenChatByUsername,
  canSeeTelegramServiceChats,
  redactFan,
  redactDialog,
  redactMessage,
  redactMember,
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
  return res.status(400).json({ error: describeError(err) });
}

const FOLDER_NAME_MAX = 120;
const VAULT_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

const vaultUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(os.tmpdir(), 'domx-telegram-vault');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '') || '';
      cb(null, `vault-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: VAULT_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '');
    if (mime.startsWith('image/') || mime.startsWith('video/')) {
      cb(null, true);
      return;
    }
    cb(new Error('Only photos and videos can be added to the vault'));
  },
});

function authenticateMedia(req, res, next) {
  if (!req.headers.authorization && typeof req.query.access_token === 'string') {
    req.headers.authorization = `Bearer ${req.query.access_token}`;
  }
  return authenticate(req, res, next);
}

function sendLocalFile(res, filePath, mimeType) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved);
  const base = path.basename(resolved) || 'media';
  const filename =
    ext || !(mimeType && String(mimeType).startsWith('video/'))
      ? base
      : `${base}.mp4`;
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${String(filename).replace(/"/g, '')}"`
  );
  return res.sendFile(resolved);
}

function cleanupUpload(file) {
  const dest = file?.path;
  if (!dest) return;
  try {
    fs.unlinkSync(dest);
  } catch {
    // ignore
  }
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

function serializeVaultFolder(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeVaultItem(row) {
  return {
    id: row.id,
    folderId: row.folderId || null,
    savedMessageId: row.savedMessageId,
    fileUniqueId: row.fileUniqueId || null,
    kind: row.kind,
    fileName: row.fileName || null,
    duration: row.duration,
    width: row.width,
    height: row.height,
    uploadedBy: row.uploadedBy || null,
    createdAt: row.createdAt,
    sent: Boolean(row.sent),
  };
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
      const visible = canSeeTelegramServiceChats(req.user)
        ? dialogs
        : dialogs.filter((dialog) => !isTelegramServiceDialog(dialog));
      return res.json({
        dialogs: visible.map((dialog) => redactDialog(dialog, req.user)),
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
      if (
        !canSeeTelegramServiceChats(req.user) &&
        isTelegramServiceDialog({ peerId, kind: 'dm' })
      ) {
        return res.status(403).json({ error: 'You do not have access to this chat' });
      }
      const offsetId = req.query.offsetId ? String(req.query.offsetId) : undefined;
      const offsetDateRaw = Number(req.query.offsetDate);
      const result = await listMessages(id, peerId, {
        limit: Number(req.query.limit) || 50,
        offsetId,
        offsetDate: Number.isFinite(offsetDateRaw) ? offsetDateRaw : undefined,
      });
      if (
        !canSeeTelegramServiceChats(req.user) &&
        isTelegramServiceDialog({
          peerId: result.peerId,
          kind: result.kind,
          displayName: result.fan?.displayName,
          username: result.fan?.username,
        })
      ) {
        return res.status(403).json({ error: 'You do not have access to this chat' });
      }
      return res.json({
        peerId: result.peerId,
        kind: result.kind || 'dm',
        fan: redactFan(result.fan, req.user),
        messages: result.messages.map((msg) => redactMessage(msg, req.user)),
        next: result.next || null,
        hasMore: Boolean(result.hasMore),
      });
    } catch (err) {
      return handleTelegramError(res, err, 'List Telegram messages error:');
    }
  }
);

router.get(
  '/:id/telegram/dialogs/:peerId/members',
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
      const result = await listChatMembers(id, peerId);
      return res.json({
        peerId: result.peerId,
        memberCount: result.memberCount,
        members: result.members.map((member) => redactMember(member, req.user)),
      });
    } catch (err) {
      return handleTelegramError(res, err, 'List Telegram group members error:');
    }
  }
);

router.get(
  '/:id/telegram/dialogs/:peerId/messages/:messageId/media',
  authenticateMedia,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, peerId, messageId } = req.params;
    const variant = req.query.variant === 'full' ? 'full' : 'thumb';
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const media = await getCachedMessageMedia(id, peerId, messageId, variant);
      return sendLocalFile(res, media.filePath, media.mimeType);
    } catch (err) {
      return handleTelegramError(res, err, 'Get Telegram chat media error:');
    }
  }
);

router.post(
  '/:id/telegram/dialogs/:peerId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, peerId } = req.params;
    const { text, englishText, vaultIds } = req.body || {};
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const vaultIdList = Array.isArray(vaultIds)
      ? [...new Set(vaultIds.map((value) => String(value || '').trim()).filter(isValidUuid))]
      : [];
    if (!trimmed && vaultIdList.length === 0) {
      return res.status(400).json({ error: 'Message text or vault media is required' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;

      if (trimmed) {
        const moderation = await applyModeration({
          germanText: trimmed,
          englishText: typeof englishText === 'string' ? englishText : '',
          userId: req.user.id,
          creatorId: id,
          platform: 'telegram',
          chatId: String(peerId),
          fanId: String(peerId),
          fanUsername: null,
          creatorName: creator.displayName,
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

      if (vaultIdList.length === 0) {
        const message = await sendText(id, peerId, trimmed);
        return res.status(201).json({
          message: redactMessage(message, req.user),
          messages: [redactMessage(message, req.user)],
        });
      }

      const items = await pool.query(
        `SELECT id, "savedMessageId"
         FROM telegram_vault_items
         WHERE "creatorId" = $1 AND id = ANY($2::uuid[])`,
        [id, vaultIdList]
      );
      if (items.rows.length !== vaultIdList.length) {
        return res.status(400).json({ error: 'One or more vault items were not found' });
      }
      const byId = new Map(items.rows.map((row) => [row.id, row]));
      const ordered = vaultIdList.map((itemId) => byId.get(itemId)).filter(Boolean);
      const sent = await sendVaultToPeer(id, peerId, {
        itemMessageIds: ordered.map((row) => row.savedMessageId),
        caption: trimmed,
      });
      await recordVaultSent({
        creatorId: id,
        fanId: peerId,
        itemIds: ordered.map((row) => row.id),
        userId: req.user.id,
      });
      const messages = sent.map((msg) => redactMessage(msg, req.user));
      return res.status(201).json({
        message: messages[0] || null,
        messages,
        vaultIds: ordered.map((row) => row.id),
      });
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
      const counts = await unreadCount(id, {
        hideService: !canSeeTelegramServiceChats(req.user),
      });
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
      const counts = await unreadCount(id, {
        hideService: !canSeeTelegramServiceChats(req.user),
      });
      return res.json(counts);
    } catch (err) {
      return handleTelegramError(res, err, 'Telegram badges error:');
    }
  }
);

router.get(
  '/:id/telegram/vault/folders',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      let result = await pool.query(
        `SELECT id, name, "sortOrder", "createdAt", "updatedAt"
         FROM telegram_vault_folders
         WHERE "creatorId" = $1
         ORDER BY "sortOrder" ASC, "createdAt" ASC`,
        [creator.id]
      );
      if (result.rows.length === 0) {
        const created = await pool.query(
          `INSERT INTO telegram_vault_folders ("creatorId", name, "sortOrder", "createdBy", "updatedBy")
           VALUES ($1, 'Vault', 0, $2, $2)
           RETURNING id, name, "sortOrder", "createdAt", "updatedAt"`,
          [creator.id, req.user.id]
        );
        result = created;
      }
      return res.json({ folders: result.rows.map(serializeVaultFolder) });
    } catch (err) {
      return handleTelegramError(res, err, 'List Telegram vault folders error:');
    }
  }
);

router.post(
  '/:id/telegram/vault/folders',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }
    if (name.length > FOLDER_NAME_MAX) {
      return res.status(400).json({ error: `Folder name must be ${FOLDER_NAME_MAX} characters or fewer` });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const sort = await pool.query(
        `SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS next
         FROM telegram_vault_folders WHERE "creatorId" = $1`,
        [creator.id]
      );
      const created = await pool.query(
        `INSERT INTO telegram_vault_folders ("creatorId", name, "sortOrder", "createdBy", "updatedBy")
         VALUES ($1, $2, $3, $4, $4)
         RETURNING id, name, "sortOrder", "createdAt", "updatedAt"`,
        [creator.id, name, Number(sort.rows[0]?.next) || 0, req.user.id]
      );
      return res.status(201).json({ folder: serializeVaultFolder(created.rows[0]) });
    } catch (err) {
      return handleTelegramError(res, err, 'Create Telegram vault folder error:');
    }
  }
);

router.patch(
  '/:id/telegram/vault/folders/:folderId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { folderId } = req.params;
    if (!isValidUuid(folderId)) {
      return res.status(400).json({ error: 'Invalid folder ID' });
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }
    if (name.length > FOLDER_NAME_MAX) {
      return res.status(400).json({ error: `Folder name must be ${FOLDER_NAME_MAX} characters or fewer` });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const updated = await pool.query(
        `UPDATE telegram_vault_folders
         SET name = $3, "updatedBy" = $4, "updatedAt" = NOW()
         WHERE id = $1 AND "creatorId" = $2
         RETURNING id, name, "sortOrder", "createdAt", "updatedAt"`,
        [folderId, creator.id, name, req.user.id]
      );
      if (updated.rows.length === 0) {
        return res.status(404).json({ error: 'Folder not found' });
      }
      return res.json({ folder: serializeVaultFolder(updated.rows[0]) });
    } catch (err) {
      return handleTelegramError(res, err, 'Update Telegram vault folder error:');
    }
  }
);

router.delete(
  '/:id/telegram/vault/folders/:folderId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { folderId } = req.params;
    if (!isValidUuid(folderId)) {
      return res.status(400).json({ error: 'Invalid folder ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const deleted = await pool.query(
        `DELETE FROM telegram_vault_folders
         WHERE id = $1 AND "creatorId" = $2
         RETURNING id`,
        [folderId, creator.id]
      );
      if (deleted.rows.length === 0) {
        return res.status(404).json({ error: 'Folder not found' });
      }
      return res.json({ ok: true });
    } catch (err) {
      return handleTelegramError(res, err, 'Delete Telegram vault folder error:');
    }
  }
);

router.get(
  '/:id/telegram/vault',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const folderId =
      typeof req.query.folderId === 'string' && isValidUuid(req.query.folderId)
        ? req.query.folderId
        : null;
    const kind = req.query.kind === 'photo' || req.query.kind === 'video' ? req.query.kind : null;
    const fanId =
      typeof req.query.fanId === 'string' && req.query.fanId.trim()
        ? req.query.fanId.trim()
        : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 120);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const vals = [creator.id];
      const where = ['i."creatorId" = $1'];
      if (folderId) {
        vals.push(folderId);
        where.push(`i."folderId" = $${vals.length}`);
      }
      if (kind) {
        vals.push(kind);
        where.push(`i.kind = $${vals.length}`);
      }
      vals.push(limit);
      const limitIdx = vals.length;
      vals.push(offset);
      const offsetIdx = vals.length;
      let sentJoin = '';
      let sentSelect = 'FALSE AS sent';
      if (fanId) {
        vals.push(fanId);
        sentJoin = `LEFT JOIN telegram_vault_sent s
          ON s."itemId" = i.id AND s."creatorId" = i."creatorId" AND s."fanId" = $${vals.length}`;
        sentSelect = 's.id IS NOT NULL AS sent';
      }
      const result = await pool.query(
        `SELECT i.id, i."folderId", i."savedMessageId", i."fileUniqueId", i.kind,
                i."fileName", i.duration, i.width, i.height, i."uploadedBy", i."createdAt",
                ${sentSelect}
         FROM telegram_vault_items i
         ${sentJoin}
         WHERE ${where.join(' AND ')}
         ORDER BY i."createdAt" DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        vals
      );
      return res.json({
        items: result.rows.map(serializeVaultItem),
        hasMore: result.rows.length === limit,
      });
    } catch (err) {
      return handleTelegramError(res, err, 'List Telegram vault error:');
    }
  }
);

router.post(
  '/:id/telegram/vault',
  authenticate,
  requirePermission('creators.view'),
  (req, res, next) => {
    vaultUpload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'thumb', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      return next();
    });
  },
  async (req, res) => {
    const mediaFile = Array.isArray(req.files?.file) ? req.files.file[0] : null;
    const thumbFile = Array.isArray(req.files?.thumb) ? req.files.thumb[0] : null;
    const folderId =
      typeof req.body?.folderId === 'string' && isValidUuid(req.body.folderId)
        ? req.body.folderId
        : null;
    if (!folderId) {
      cleanupUpload(mediaFile);
      cleanupUpload(thumbFile);
      return res.status(400).json({ error: 'folderId is required' });
    }
    if (!mediaFile?.path) {
      cleanupUpload(thumbFile);
      return res.status(400).json({ error: 'file is required' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) {
        cleanupUpload(mediaFile);
        cleanupUpload(thumbFile);
        return undefined;
      }
      const folder = await pool.query(
        `SELECT id FROM telegram_vault_folders WHERE id = $1 AND "creatorId" = $2`,
        [folderId, creator.id]
      );
      if (folder.rows.length === 0) {
        cleanupUpload(mediaFile);
        cleanupUpload(thumbFile);
        return res.status(404).json({ error: 'Folder not found' });
      }
      const uploaded = await uploadVaultMedia(creator.id, {
        filePath: mediaFile.path,
        mimeType: mediaFile.mimetype,
        fileName: mediaFile.originalname,
        thumbPath: thumbFile?.path || null,
      });
      const inserted = await pool.query(
        `INSERT INTO telegram_vault_items (
           "creatorId", "folderId", "savedMessageId", "fileUniqueId", kind,
           "fileName", duration, width, height, "uploadedBy"
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT ("creatorId", "savedMessageId")
         DO UPDATE SET
           "folderId" = EXCLUDED."folderId",
           "fileUniqueId" = COALESCE(EXCLUDED."fileUniqueId", telegram_vault_items."fileUniqueId"),
           kind = EXCLUDED.kind,
           "fileName" = COALESCE(EXCLUDED."fileName", telegram_vault_items."fileName"),
           duration = COALESCE(EXCLUDED.duration, telegram_vault_items.duration),
           width = COALESCE(EXCLUDED.width, telegram_vault_items.width),
           height = COALESCE(EXCLUDED.height, telegram_vault_items.height),
           "updatedAt" = NOW()
         RETURNING id, "folderId", "savedMessageId", "fileUniqueId", kind,
                   "fileName", duration, width, height, "uploadedBy", "createdAt"`,
        [
          creator.id,
          folderId,
          uploaded.savedMessageId,
          uploaded.fileUniqueId,
          uploaded.kind,
          uploaded.fileName || mediaFile.originalname || null,
          uploaded.duration,
          uploaded.width,
          uploaded.height,
          req.user.id,
        ]
      );
      return res.status(201).json({ item: serializeVaultItem(inserted.rows[0]) });
    } catch (err) {
      return handleTelegramError(res, err, 'Upload Telegram vault error:');
    } finally {
      cleanupUpload(mediaFile);
      cleanupUpload(thumbFile);
    }
  }
);

router.patch(
  '/:id/telegram/vault/:itemId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { itemId } = req.params;
    if (!isValidUuid(itemId)) {
      return res.status(400).json({ error: 'Invalid vault item ID' });
    }
    const folderId =
      req.body?.folderId == null
        ? undefined
        : isValidUuid(req.body.folderId)
          ? req.body.folderId
          : null;
    if (folderId === undefined) {
      return res.status(400).json({ error: 'folderId is required' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      if (folderId) {
        const folder = await pool.query(
          `SELECT id FROM telegram_vault_folders WHERE id = $1 AND "creatorId" = $2`,
          [folderId, creator.id]
        );
        if (folder.rows.length === 0) {
          return res.status(404).json({ error: 'Folder not found' });
        }
      }
      const updated = await pool.query(
        `UPDATE telegram_vault_items
         SET "folderId" = $3, "updatedAt" = NOW()
         WHERE id = $1 AND "creatorId" = $2
         RETURNING id, "folderId", "savedMessageId", "fileUniqueId", kind,
                   "fileName", duration, width, height, "uploadedBy", "createdAt"`,
        [itemId, creator.id, folderId]
      );
      if (updated.rows.length === 0) {
        return res.status(404).json({ error: 'Vault item not found' });
      }
      return res.json({ item: serializeVaultItem(updated.rows[0]) });
    } catch (err) {
      return handleTelegramError(res, err, 'Update Telegram vault item error:');
    }
  }
);

router.delete(
  '/:id/telegram/vault/:itemId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { itemId } = req.params;
    if (!isValidUuid(itemId)) {
      return res.status(400).json({ error: 'Invalid vault item ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const existing = await pool.query(
        `SELECT id, "savedMessageId"
         FROM telegram_vault_items
         WHERE id = $1 AND "creatorId" = $2`,
        [itemId, creator.id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Vault item not found' });
      }
      try {
        await deleteSavedVaultMessage(creator.id, existing.rows[0].savedMessageId);
      } catch (err) {
        console.warn('[telegram] Vault Saved Messages delete failed:', err.message || err);
      }
      await pool.query(
        `DELETE FROM telegram_vault_items WHERE id = $1 AND "creatorId" = $2`,
        [itemId, creator.id]
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleTelegramError(res, err, 'Delete Telegram vault item error:');
    }
  }
);

router.get(
  '/:id/telegram/vault/:itemId/media',
  authenticateMedia,
  requirePermission('creators.view'),
  async (req, res) => {
    const { itemId } = req.params;
    const variant = req.query.variant === 'full' ? 'full' : 'thumb';
    if (!isValidUuid(itemId)) {
      return res.status(400).json({ error: 'Invalid vault item ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const item = await pool.query(
        `SELECT "savedMessageId"
         FROM telegram_vault_items
         WHERE id = $1 AND "creatorId" = $2`,
        [itemId, creator.id]
      );
      if (item.rows.length === 0) {
        return res.status(404).json({ error: 'Vault item not found' });
      }
      const media = await getCachedVaultMedia(
        creator.id,
        item.rows[0].savedMessageId,
        variant
      );
      return sendLocalFile(res, media.filePath, media.mimeType);
    } catch (err) {
      return handleTelegramError(res, err, 'Get Telegram vault media error:');
    }
  }
);

router.get(
  '/:id/telegram/vault-sent',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const fanId =
      typeof req.query.fanId === 'string' && req.query.fanId.trim()
        ? req.query.fanId.trim()
        : '';
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const result = await pool.query(
        `SELECT "itemId"
         FROM telegram_vault_sent
         WHERE "creatorId" = $1 AND "fanId" = $2`,
        [creator.id, fanId]
      );
      return res.json({ itemIds: result.rows.map((row) => row.itemId) });
    } catch (err) {
      return handleTelegramError(res, err, 'List Telegram vault sent error:');
    }
  }
);

module.exports = router;
