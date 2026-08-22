const fs = require('fs');
const os = require('os');
const path = require('path');
const { TelegramClient } = require('@mtcute/node');
const pool = require('../db/pool');
const { encryptJson, decryptJson } = require('./crypto');
const { emitToUsers } = require('./userEventBus');
const { getUserIdsWithCreatorAccess } = require('./creatorAccess');
const { saveCreatorAvatarFromBuffer } = require('./creatorAvatar');

const DATA_DIR = path.join(__dirname, '../../data/telegram');
const FAN_AVATARS_DIR = path.join(__dirname, '../../data/telegram-fans');
const FAN_AVATARS_PUBLIC = '/uploads/telegram-fans';
const LOGIN_TIMEOUT_MS = 90_000;
const FAN_AVATAR_PREFETCH_CONCURRENCY = 3;

/** @type {Map<string, Promise<string | null>>} */
const fanAvatarInFlight = new Map();

/** @type {Map<string, { client: import('@mtcute/node').TelegramClient, self: object | null }>} */
const hotClients = new Map();

/** @type {Map<string, object>} */
const pendingLogins = new Map();

class TelegramWorkerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TelegramWorkerError';
    this.status = status;
  }
}

function getApiCreds() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '').trim();
  if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
    throw new TelegramWorkerError(
      'TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in backend .env',
      500
    );
  }
  return { apiId, apiHash };
}

function storageDirFor(key) {
  return path.join(DATA_DIR, String(key));
}

function storagePathFor(key) {
  const dir = storageDirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'session');
}

function removeStorage(key) {
  const dir = storageDirFor(key);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function moveStorage(fromKey, toKey) {
  const fromDir = storageDirFor(fromKey);
  const toDir = storageDirFor(toKey);
  if (fromKey === toKey) return;
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  if (fs.existsSync(toDir)) {
    fs.rmSync(toDir, { recursive: true, force: true });
  }
  if (fs.existsSync(fromDir)) {
    fs.renameSync(fromDir, toDir);
  }
}

function describeError(err) {
  const raw = String(err?.text || err?.message || err || '');
  if (/PHONE_NUMBER_INVALID/i.test(raw)) return 'Invalid phone number';
  if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/i.test(raw)) {
    return 'Invalid or expired Telegram code';
  }
  if (/SESSION_PASSWORD_NEEDED|PASSWORD_HASH_INVALID/i.test(raw)) {
    return 'Invalid two-factor password';
  }
  if (/FLOOD_WAIT[_ ]?(\d+)/i.test(raw)) {
    const seconds = Number(RegExp.$1) || 0;
    return seconds
      ? `Telegram rate limit. Try again in ${seconds}s`
      : 'Telegram rate limit. Try again later';
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/i.test(raw)) {
    return 'Telegram session expired. Please reconnect.';
  }
  if (/USER_PRIVACY_RESTRICTED/i.test(raw)) {
    return 'This user does not allow messages from this account';
  }
  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/i.test(raw)) {
    return 'Telegram username not found';
  }
  return raw.replace(/^Error:\s*/i, '').slice(0, 240) || 'Telegram request failed';
}

function createClient(storageKey) {
  const { apiId, apiHash } = getApiCreds();
  return new TelegramClient({
    apiId,
    apiHash,
    storage: storagePathFor(storageKey),
  });
}

function subscribeUpdates(creatorId, client) {
  const handler = (msg) => {
    void relayUpdate(creatorId, 'new_message', {
      peerId: String(msg.chat?.id || ''),
      messageId: msg.id,
    });
  };
  const editHandler = (msg) => {
    void relayUpdate(creatorId, 'edit_message', {
      peerId: String(msg.chat?.id || ''),
      messageId: msg.id,
    });
  };
  if (client.onNewMessage && typeof client.onNewMessage.add === 'function') {
    client.onNewMessage.add(handler);
    client.onEditMessage?.add?.(editHandler);
  }
  return () => {
    try {
      client.onNewMessage?.remove?.(handler);
      client.onEditMessage?.remove?.(editHandler);
    } catch {
      // ignore
    }
  };
}

async function relayUpdate(creatorId, event, payload) {
  try {
    const userIds = await getUserIdsWithCreatorAccess(creatorId);
    emitToUsers(userIds, {
      type: 'telegram:event',
      event,
      creatorId,
      payload: payload || null,
    });
  } catch (err) {
    console.warn('[telegram] Relay failed', err.message || err);
  }
}

function isInboxPeer(peer) {
  if (!peer) return false;
  if (peer.type === 'user') {
    return !peer.isSelf && !peer.isBot;
  }
  if (peer.type === 'chat') {
    if (peer.chatType === 'channel' || peer.chatType === 'community') return false;
    return Boolean(peer.isGroup);
  }
  return false;
}

function peerKind(peer) {
  if (peer && peer.type === 'chat' && peer.isGroup) return 'group';
  return 'dm';
}

function peerTitle(peer) {
  if (!peer) return 'Fan';
  if (peer.type === 'chat') {
    return peer.title || peer.displayName || 'Group';
  }
  return peer.displayName || peer.firstName || 'Fan';
}

function mediaPlaceholder(media) {
  const type = media && typeof media === 'object' ? media.type : null;
  if (type === 'photo') return { kind: 'photo', text: 'Photo' };
  if (type === 'video') return { kind: 'video', text: 'Video' };
  if (type === 'voice' || type === 'audio') return { kind: 'audio', text: 'Audio' };
  if (type === 'sticker') return { kind: 'sticker', text: 'Sticker' };
  if (type === 'document') return { kind: 'document', text: 'File' };
  if (type) return { kind: 'media', text: 'Media' };
  return null;
}

function serializeMessage(msg) {
  if (!msg) return null;
  const text = typeof msg.text === 'string' ? msg.text : '';
  const placeholder = text ? null : mediaPlaceholder(msg.media);
  const sender = msg.sender;
  return {
    id: String(msg.id),
    peerId: String(msg.chat?.id || ''),
    isOutgoing: Boolean(msg.isOutgoing),
    date: msg.date instanceof Date ? msg.date.toISOString() : null,
    text,
    kind: placeholder?.kind || (text ? 'text' : 'empty'),
    placeholder: placeholder?.text || null,
    senderId: sender?.id != null ? String(sender.id) : null,
    senderName: sender
      ? sender.displayName || sender.title || sender.firstName || null
      : null,
    senderUsername: sender?.username || null,
  };
}

function serializeUserPreview(user) {
  if (!user) return null;
  return {
    telegramUserId: String(user.id),
    displayName: user.displayName || user.firstName || 'Fan',
    username: user.username || null,
  };
}

async function upsertFanProfile(creatorId, peer) {
  if (!creatorId || !peer) return;
  const telegramUserId = String(peer.id);
  const displayName = peerTitle(peer);
  const username = peer.username || null;
  await pool.query(
    `INSERT INTO telegram_fan_profiles (
       "creatorId", "telegramUserId", username, "displayName"
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("creatorId", "telegramUserId")
     DO UPDATE SET
       username = EXCLUDED.username,
       "displayName" = EXCLUDED."displayName",
       "updatedAt" = NOW()`,
    [creatorId, telegramUserId, username, displayName]
  );
}

async function loadProfiles(creatorId, userIds) {
  if (!userIds.length) return new Map();
  const result = await pool.query(
    `SELECT "telegramUserId", username, "displayName", nickname, notes, "avatarUrl"
     FROM telegram_fan_profiles
     WHERE "creatorId" = $1 AND "telegramUserId" = ANY($2::text[])`,
    [creatorId, userIds]
  );
  return new Map(result.rows.map((row) => [row.telegramUserId, row]));
}

function safePeerFileId(peerId) {
  return String(peerId || '').replace(/[^0-9A-Za-z_-]/g, '_') || 'unknown';
}

function fanAvatarRelPath(creatorId, peerId) {
  return `${creatorId}/${safePeerFileId(peerId)}.jpg`;
}

function fanAvatarAbsPath(creatorId, peerId) {
  return path.join(FAN_AVATARS_DIR, fanAvatarRelPath(creatorId, peerId));
}

function fanAvatarPublicUrl(creatorId, peerId) {
  return `${FAN_AVATARS_PUBLIC}/${fanAvatarRelPath(creatorId, peerId)}`;
}

function fanAvatarFileExists(avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== 'string') return false;
  if (!avatarUrl.startsWith(`${FAN_AVATARS_PUBLIC}/`)) return false;
  const rel = avatarUrl.slice(FAN_AVATARS_PUBLIC.length + 1);
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return false;
  return fs.existsSync(path.join(FAN_AVATARS_DIR, rel));
}

async function downloadPhotoToFile(client, photo, destPath) {
  if (!client || !photo || !destPath) return false;
  const locations = [photo.big, photo.small, photo].filter(Boolean);
  const tmp = path.join(
    os.tmpdir(),
    `tg-fan-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`
  );
  try {
    let downloaded = false;
    for (const location of locations) {
      try {
        await client.downloadToFile(tmp, location);
        downloaded = true;
        break;
      } catch {
        // ChatPhoto.big/small or the photo itself may be the valid location
      }
    }
    if (!downloaded) return false;
    const buffer = fs.readFileSync(tmp);
    if (!buffer.length) return false;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch (err) {
    console.warn('[telegram] Fan photo download failed:', err.message || err);
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

async function cachePeerAvatar(creatorId, client, peer) {
  if (!creatorId || !client || !peer) return null;
  const telegramUserId = String(peer.id);
  const key = `${creatorId}:${telegramUserId}`;
  const pending = fanAvatarInFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    try {
      const existing = await pool.query(
        `SELECT "avatarUrl" FROM telegram_fan_profiles
         WHERE "creatorId" = $1 AND "telegramUserId" = $2`,
        [creatorId, telegramUserId]
      );
      const current = existing.rows[0]?.avatarUrl || null;
      if (current && fanAvatarFileExists(current)) return current;

      if (!peer.photo) return current;

      const destPath = fanAvatarAbsPath(creatorId, telegramUserId);
      const saved = await downloadPhotoToFile(client, peer.photo, destPath);
      if (!saved) return current;

      const avatarUrl = fanAvatarPublicUrl(creatorId, telegramUserId);
      await pool.query(
        `UPDATE telegram_fan_profiles
         SET "avatarUrl" = $3, "updatedAt" = NOW()
         WHERE "creatorId" = $1 AND "telegramUserId" = $2`,
        [creatorId, telegramUserId, avatarUrl]
      );
      return avatarUrl;
    } catch (err) {
      console.warn('[telegram] Fan avatar cache failed:', err.message || err);
      return null;
    } finally {
      fanAvatarInFlight.delete(key);
    }
  })();

  fanAvatarInFlight.set(key, work);
  return work;
}

function scheduleFanAvatarPrefetch(creatorId, client, peers, profiles) {
  const missing = peers.filter((peer) => {
    const url = profiles.get(String(peer.id))?.avatarUrl;
    return !url || !fanAvatarFileExists(url);
  });
  if (!missing.length) return;

  void (async () => {
    const queue = [...missing];
    const workerCount = Math.min(FAN_AVATAR_PREFETCH_CONCURRENCY, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length) {
          const peer = queue.shift();
          if (!peer) break;
          try {
            await cachePeerAvatar(creatorId, client, peer);
          } catch {
            // best-effort
          }
        }
      })
    );
  })();
}

async function downloadProfilePhoto(client, user, destId) {
  const photo = user?.photo;
  if (!client || !photo || !destId) return null;
  const locations = [photo.big, photo.small, photo].filter(Boolean);
  const tmp = path.join(os.tmpdir(), `tg-avatar-${destId}-${Date.now()}.jpg`);
  try {
    let downloaded = false;
    for (const location of locations) {
      try {
        await client.downloadToFile(tmp, location);
        downloaded = true;
        break;
      } catch {
        // ChatPhoto.big/small or the photo itself may be the valid location
      }
    }
    if (!downloaded) return null;
    const buffer = fs.readFileSync(tmp);
    if (!buffer.length) return null;
    return saveCreatorAvatarFromBuffer(destId, buffer, 'image/jpeg');
  } catch (err) {
    console.warn('[telegram] Profile photo download failed:', err.message || err);
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

async function cacheTelegramSelfAvatar(creatorId, client, self) {
  const user = self || client;
  let me = self;
  if (!me && client?.getMe) {
    try {
      me = await client.getMe();
    } catch {
      me = null;
    }
  }
  const avatarUrl = await downloadProfilePhoto(client, me || user, creatorId);
  if (!avatarUrl) return null;
  await pool.query(
    `UPDATE creators SET "avatarUrl" = $2, "avatarSource" = 'telegram', "updatedAt" = NOW()
     WHERE id = $1`,
    [creatorId, avatarUrl]
  );
  return avatarUrl;
}

function sessionPayload(user, storageKey, phone) {
  return {
    platform: 'telegram',
    storageKey,
    providerUserId: user ? String(user.id) : null,
    username: user?.username || null,
    displayName: user?.displayName || user?.firstName || null,
    phone: phone || user?.phoneNumber || null,
    savedAt: new Date().toISOString(),
  };
}

async function destroyClient(client) {
  if (!client) return;
  try {
    await client.destroy();
  } catch {
    try {
      await client.close?.();
    } catch {
      // ignore
    }
  }
}

async function abortPendingLogin(accountId) {
  const pending = pendingLogins.get(accountId);
  if (!pending) return;
  pendingLogins.delete(accountId);
  try {
    pending.abort?.();
  } catch {
    // ignore
  }
  await destroyClient(pending.client);
}

function waitForLoginEvent(pending, timeoutMs = LOGIN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.notify = null;
      reject(new TelegramWorkerError('Telegram login timed out', 408));
    }, timeoutMs);

    const finish = (result, err) => {
      clearTimeout(timer);
      pending.notify = null;
      if (err) reject(err);
      else resolve(result);
    };

    const prevNotify = pending.notify;
    pending.notify = (event) => {
      prevNotify?.(event);
      if (event?.type === 'waiting_2fa') {
        finish({ status: 'waiting_2fa' });
      } else if (event?.type === 'waiting_code' && pending.lastInvalid) {
        finish({
          status: 'invalid',
          field: pending.lastInvalid,
        });
      }
    };

    pending.startPromise
      .then((user) => finish({ status: 'ready', user }))
      .catch((err) => finish(null, err));
  });
}

async function startPhoneLogin({ accountId, phone, storageKey, wipeStorage }) {
  if (!accountId || !isValidUuid(accountId)) {
    throw new TelegramWorkerError('Invalid account ID');
  }
  const normalizedPhone = String(phone || '').replace(/[^\d+]/g, '');
  if (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 8) {
    throw new TelegramWorkerError('Enter a valid phone number with country code');
  }

  await abortPendingLogin(accountId);
  if (wipeStorage) {
    removeStorage(storageKey || accountId);
  }

  const key = storageKey || accountId;
  const client = createClient(key);
  const pending = {
    accountId,
    phone: normalizedPhone,
    storageKey: key,
    client,
    state: 'starting',
    lastInvalid: null,
    resolveCode: null,
    resolvePassword: null,
    notify: null,
    startPromise: null,
  };
  pendingLogins.set(accountId, pending);

  let settleFirst;
  const firstEvent = new Promise((resolve) => {
    settleFirst = resolve;
  });
  pending.notify = (event) => {
    if (event?.type === 'waiting_code' || event?.type === 'waiting_2fa') {
      settleFirst({ from: 'wait', event });
    }
  };

  pending.startPromise = client.start({
    phone: () => pending.phone,
    code: () =>
      new Promise((resolve) => {
        pending.state = 'waiting_code';
        pending.resolveCode = resolve;
        pending.notify?.({ type: 'waiting_code' });
      }),
    password: () =>
      new Promise((resolve) => {
        pending.state = 'waiting_2fa';
        pending.resolvePassword = resolve;
        pending.notify?.({ type: 'waiting_2fa' });
      }),
    invalidCodeCallback: (type) => {
      pending.lastInvalid = type;
      pending.state = type === 'password' ? 'waiting_2fa' : 'waiting_code';
      pending.notify?.({ type: 'waiting_code' });
    },
    codeSentCallback: () => {
      pending.state = 'waiting_code';
      pending.notify?.({ type: 'waiting_code' });
    },
  });
  pending.startPromise.catch(() => {});

  const first = await Promise.race([
    firstEvent,
    pending.startPromise.then((user) => ({ from: 'ready', user })),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new TelegramWorkerError('Telegram did not send a code in time', 408)),
        LOGIN_TIMEOUT_MS
      )
    ),
  ]).catch((err) => {
    void abortPendingLogin(accountId);
    throw err instanceof TelegramWorkerError
      ? err
      : new TelegramWorkerError(describeError(err), 400);
  });

  if (first.from === 'ready') {
    pendingLogins.delete(accountId);
    await destroyClient(client);
    throw new TelegramWorkerError(
      'This Telegram session is already authorized. Reconnect from Manage Creators.',
      400
    );
  }

  return { status: first.event?.type === 'waiting_2fa' ? 'waiting_2fa' : 'waiting_code' };
}

async function completePhoneLogin({ accountId, code, password }) {
  const pending = pendingLogins.get(accountId);
  if (!pending) {
    throw new TelegramWorkerError(
      'No Telegram login in progress. Send a code first.',
      400
    );
  }

  if (pending.state === 'waiting_2fa') {
    const pwd = String(password || '');
    if (!pwd) {
      throw new TelegramWorkerError('Two-factor password is required');
    }
    const wait = waitForLoginEvent(pending);
    pending.lastInvalid = null;
    pending.resolvePassword?.(pwd);
    let outcome;
    try {
      outcome = await wait;
    } catch (err) {
      throw err instanceof TelegramWorkerError
        ? err
        : new TelegramWorkerError(describeError(err), 400);
    }
    if (outcome.status === 'invalid') {
      throw new TelegramWorkerError('Invalid two-factor password');
    }
    if (outcome.status === 'waiting_2fa') {
      return { status: 'waiting_2fa' };
    }
    return finishPendingReady(pending, outcome.user);
  }

  const submitted = String(code || '').trim();
  if (!submitted) {
    throw new TelegramWorkerError('Telegram code is required');
  }
  if (typeof pending.resolveCode !== 'function') {
    throw new TelegramWorkerError('Telegram is not waiting for a code yet', 409);
  }

  const wait = waitForLoginEvent(pending);
  pending.lastInvalid = null;
  pending.resolveCode(submitted);
  let outcome;
  try {
    outcome = await wait;
  } catch (err) {
    throw err instanceof TelegramWorkerError
      ? err
      : new TelegramWorkerError(describeError(err), 400);
  }

  if (outcome.status === 'invalid') {
    throw new TelegramWorkerError(
      outcome.field === 'password'
        ? 'Invalid two-factor password'
        : 'Invalid or expired Telegram code'
    );
  }
  if (outcome.status === 'waiting_2fa') {
    return { status: 'waiting_2fa' };
  }
  return finishPendingReady(pending, outcome.user);
}

async function finishPendingReady(pending, user) {
  let avatarUrl = null;
  try {
    avatarUrl = await downloadProfilePhoto(
      pending.client,
      user,
      pending.accountId
    );
  } catch (err) {
    console.warn('[telegram] Avatar download failed:', err.message || err);
  }
  pendingLogins.delete(pending.accountId);
  await destroyClient(pending.client);
  return {
    status: 'ready',
    user: serializeUserPreview(user),
    phone: pending.phone,
    storageKey: pending.storageKey,
    encryptedSession: encryptJson(
      sessionPayload(user, pending.storageKey, pending.phone)
    ),
    avatarUrl,
  };
}

async function persistPendingConnect({
  accountId,
  createdBy,
  user,
  phone,
  storageKey,
  encryptedSession,
  avatarUrl,
}) {
  const accountToken = require('./crypto').generateAccountToken();
  const accountTokenHash = require('./crypto').hashToken(accountToken);
  const partitionId = `telegram:${accountId}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const displayName = user?.displayName || user?.firstName || 'Telegram';
  const username = user?.username || null;
  const postLoginUrl = username
    ? `https://t.me/${username}`
    : 'https://t.me/';
  const providerUserId = user?.telegramUserId || null;

  await pool.query('DELETE FROM creator_connect_pending WHERE "accountId" = $1', [
    accountId,
  ]);

  await pool.query(
    `INSERT INTO creator_connect_pending (
       "accountId", "accountTokenHash", "partitionId", platform,
       "displayName", username, "postLoginUrl", "avatarUrl", "encryptedSession",
       "loginEmail", "providerUserId",
       "createdBy", "expiresAt"
     )
     VALUES ($1, $2, $3, 'telegram', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      accountId,
      accountTokenHash,
      partitionId,
      displayName,
      username,
      postLoginUrl,
      avatarUrl || null,
      encryptedSession,
      phone,
      providerUserId,
      createdBy,
      expiresAt,
    ]
  );

  return {
    accountToken,
    accountId,
    partitionId,
    displayName,
    username,
    postLoginUrl,
    avatarUrl: avatarUrl || null,
    providerUserId,
  };
}

async function attachCreatorClient(creatorId) {
  const existing = hotClients.get(creatorId);
  if (existing?.client) return existing.client;

  const result = await pool.query(
    `SELECT id, platform, "encryptedSession", "connectionStatus"
     FROM creators WHERE id = $1 AND platform = 'telegram'`,
    [creatorId]
  );
  if (result.rows.length === 0) {
    throw new TelegramWorkerError('Creator not found', 404);
  }
  return connectHotClient(result.rows[0]);
}

async function connectHotClient(row) {
  const creatorId = row.id;
  await disconnectCreator(creatorId);

  let session = {};
  try {
    if (row.encryptedSession) session = decryptJson(row.encryptedSession) || {};
  } catch {
    session = {};
  }

  const storageKey = session.storageKey || creatorId;
  const client = createClient(storageKey);
  try {
    const self = await client.start();
    subscribeUpdates(creatorId, client);
    hotClients.set(creatorId, { client, self });
    await pool.query(
      `UPDATE creators
       SET "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "updatedAt" = NOW()
       WHERE id = $1`,
      [creatorId]
    );
    return client;
  } catch (err) {
    await destroyClient(client);
    await pool.query(
      `UPDATE creators
       SET "connectionStatus" = 'error',
           "authRefreshState" = 'needs_reauth',
           "updatedAt" = NOW()
       WHERE id = $1`,
      [creatorId]
    );
    throw new TelegramWorkerError(describeError(err), 400);
  }
}

async function disconnectCreator(creatorId) {
  const existing = hotClients.get(creatorId);
  if (!existing) return;
  hotClients.delete(creatorId);
  await destroyClient(existing.client);
}

async function onCreatorSaved(creatorId, accountId) {
  try {
    if (accountId && accountId !== creatorId) {
      moveStorage(accountId, creatorId);
      const encryptedSession = encryptJson(
        sessionPayload(null, creatorId, null)
      );
      const current = await pool.query(
        `SELECT "encryptedSession" FROM creators WHERE id = $1`,
        [creatorId]
      );
      let session = {};
      try {
        if (current.rows[0]?.encryptedSession) {
          session = decryptJson(current.rows[0].encryptedSession) || {};
        }
      } catch {
        session = {};
      }
      session.storageKey = creatorId;
      session.savedAt = new Date().toISOString();
      await pool.query(
        `UPDATE creators SET "encryptedSession" = $2, "updatedAt" = NOW() WHERE id = $1`,
        [creatorId, encryptJson(session)]
      );
      void encryptedSession;
    }
    const client = await attachCreatorClient(creatorId);
    const self = hotClients.get(creatorId)?.self || null;
    await cacheTelegramSelfAvatar(creatorId, client, self);
  } catch (err) {
    console.warn('[telegram] Failed to start client after save:', err.message || err);
  }
}

async function applyReconnectReady(creatorId, loginResult) {
  await disconnectCreator(creatorId);
  moveStorage(loginResult.storageKey, creatorId);
  const session = sessionPayload(
    loginResult.user
      ? {
          id: loginResult.user.telegramUserId,
          username: loginResult.user.username,
          displayName: loginResult.user.displayName,
          phoneNumber: loginResult.phone,
        }
      : null,
    creatorId,
    loginResult.phone
  );
  const updated = await pool.query(
    `UPDATE creators
     SET "encryptedSession" = $2,
         username = COALESCE($3, username),
         "displayName" = COALESCE($4, "displayName"),
         "loginEmail" = COALESCE($5, "loginEmail"),
         "providerUserId" = COALESCE($6, "providerUserId"),
         "postLoginUrl" = COALESCE($7, "postLoginUrl"),
         "connectionStatus" = 'connected',
         "authRefreshState" = 'active',
         "lastValidatedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "displayName", username, platform, "connectionStatus",
               "postLoginUrl", "avatarUrl", "avatarSource", "staffCount", "accountId",
               "partitionId", "loginEmail", "lastValidatedAt", "authRefreshState",
               "accessTokenExpiresAt", "createdAt", "updatedAt"`,
    [
      creatorId,
      encryptJson(session),
      loginResult.user?.username || null,
      loginResult.user?.displayName || null,
      loginResult.phone || null,
      loginResult.user?.telegramUserId || null,
      loginResult.user?.username
        ? `https://t.me/${loginResult.user.username}`
        : null,
    ]
  );
  const client = await attachCreatorClient(creatorId);
  const self = hotClients.get(creatorId)?.self || null;
  const avatarUrl = await cacheTelegramSelfAvatar(creatorId, client, self);
  if (avatarUrl && updated.rows[0]) {
    updated.rows[0].avatarUrl = avatarUrl;
    updated.rows[0].avatarSource = 'telegram';
  }
  return updated.rows[0];
}

async function getClient(creatorId) {
  const existing = hotClients.get(creatorId);
  if (existing?.client) return existing.client;
  return attachCreatorClient(creatorId);
}

async function listDialogs(creatorId, { limit = 80 } = {}) {
  const client = await getClient(creatorId);
  const dialogs = [];
  const peers = [];
  const cap = Math.min(Math.max(Number(limit) || 80, 1), 200);
  for await (const dialog of client.iterDialogs({ limit: cap })) {
    const peer = dialog.peer;
    if (!isInboxPeer(peer)) continue;
    peers.push(peer);
    const kind = peerKind(peer);
    dialogs.push({
      peerId: String(peer.id),
      kind,
      title: peerTitle(peer),
      unreadCount: Number(dialog.unreadCount) || 0,
      lastMessage: serializeMessage(dialog.lastMessage),
      user: kind === 'dm' ? serializeUserPreview(peer) : null,
    });
  }
  await Promise.all(peers.map((peer) => upsertFanProfile(creatorId, peer)));
  const profiles = await loadProfiles(
    creatorId,
    dialogs.map((d) => d.peerId)
  );
  scheduleFanAvatarPrefetch(creatorId, client, peers, profiles);
  return dialogs.map((dialog) => {
    const profile = profiles.get(dialog.peerId);
    return {
      ...dialog,
      nickname: profile?.nickname || '',
      notes: profile?.notes || '',
      displayName:
        (profile?.nickname && profile.nickname.trim()) ||
        profile?.displayName ||
        dialog.title ||
        dialog.user?.displayName ||
        'Fan',
      username: profile?.username || dialog.user?.username || null,
      avatarUrl: profile?.avatarUrl || null,
    };
  });
}

async function listMessages(creatorId, peerId, { limit = 50 } = {}) {
  const client = await getClient(creatorId);
  const numericId = Number(peerId);
  if (!Number.isFinite(numericId)) {
    throw new TelegramWorkerError('Invalid chat id');
  }
  const history = await client.getHistory(numericId, {
    limit: Math.min(Math.max(Number(limit) || 50, 1), 100),
  });
  const messages = [...history]
    .map(serializeMessage)
    .filter(Boolean)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  let peer = null;
  try {
    const users = await client.getUsers(numericId);
    if (users[0] && users[0].type === 'user') peer = users[0];
  } catch {
    peer = null;
  }
  if (!peer) {
    try {
      peer = await client.getChat(numericId);
    } catch {
      peer = null;
    }
  }
  if (peer) {
    await upsertFanProfile(creatorId, peer);
    await cachePeerAvatar(creatorId, client, peer);
  }
  const profiles = await loadProfiles(creatorId, [String(numericId)]);
  const profile = profiles.get(String(numericId));
  const kind = peerKind(peer);
  return {
    peerId: String(numericId),
    kind,
    fan: {
      telegramUserId: String(numericId),
      kind,
      displayName:
        (profile?.nickname && profile.nickname.trim()) ||
        profile?.displayName ||
        peerTitle(peer),
      nickname: profile?.nickname || '',
      notes: profile?.notes || '',
      username: profile?.username || peer?.username || null,
      avatarUrl: profile?.avatarUrl || null,
    },
    messages,
  };
}

async function sendText(creatorId, peerId, text) {
  const client = await getClient(creatorId);
  const numericId = Number(peerId);
  if (!Number.isFinite(numericId)) {
    throw new TelegramWorkerError('Invalid chat id');
  }
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new TelegramWorkerError('Message text is required');
  }
  const sent = await client.sendText(numericId, trimmed);
  return serializeMessage(sent);
}

async function resolveUsername(creatorId, username) {
  const client = await getClient(creatorId);
  const handle = String(username || '')
    .trim()
    .replace(/^@/, '');
  if (!handle) {
    throw new TelegramWorkerError('Username is required');
  }
  const [user] = await client.getUsers(handle);
  if (!user || user.type !== 'user' || user.isBot) {
    throw new TelegramWorkerError('Telegram user not found');
  }
  await upsertFanProfile(creatorId, user);
  await cachePeerAvatar(creatorId, client, user);
  const profiles = await loadProfiles(creatorId, [String(user.id)]);
  const profile = profiles.get(String(user.id));
  return {
    peerId: String(user.id),
    fan: {
      telegramUserId: String(user.id),
      kind: 'dm',
      displayName:
        (profile?.nickname && profile.nickname.trim()) ||
        user.displayName ||
        'Fan',
      nickname: profile?.nickname || '',
      notes: profile?.notes || '',
      username: user.username || null,
      avatarUrl: profile?.avatarUrl || null,
    },
  };
}

async function unreadCount(creatorId) {
  const client = await getClient(creatorId);
  let messages = 0;
  for await (const dialog of client.iterDialogs({ limit: 80 })) {
    if (!isInboxPeer(dialog.peer)) continue;
    messages += Number(dialog.unreadCount) || 0;
  }
  return { messages, notifications: 0 };
}

async function startTelegramManager() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FAN_AVATARS_DIR, { recursive: true });
  try {
    getApiCreds();
  } catch (err) {
    console.warn('[telegram]', err.message);
    return;
  }
  const result = await pool.query(
    `SELECT id, platform, "encryptedSession", "connectionStatus"
     FROM creators
     WHERE platform = 'telegram' AND "connectionStatus" = 'connected'`
  );
  for (const row of result.rows) {
    try {
      await connectHotClient(row);
      console.log(`[telegram] Connected creator ${row.id}`);
    } catch (err) {
      console.warn(
        `[telegram] Failed to start creator ${row.id}:`,
        err.message || err
      );
    }
  }
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

module.exports = {
  TelegramWorkerError,
  describeError,
  startPhoneLogin,
  completePhoneLogin,
  abortPendingLogin,
  persistPendingConnect,
  onCreatorSaved,
  applyReconnectReady,
  attachCreatorClient,
  disconnectCreator,
  getClient,
  listDialogs,
  listMessages,
  sendText,
  resolveUsername,
  unreadCount,
  startTelegramManager,
  upsertFanProfile,
};
