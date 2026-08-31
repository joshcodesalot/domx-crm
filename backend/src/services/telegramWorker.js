const fs = require('fs');
const os = require('os');
const path = require('path');
const { TelegramClient } = require('@mtcute/node');
const sharp = require('sharp');
const pool = require('../db/pool');
const { encryptJson, decryptJson } = require('./crypto');
const { emitToUsers } = require('./userEventBus');
const { getUserIdsWithCreatorAccess } = require('./creatorAccess');
const { saveCreatorAvatarFromBuffer } = require('./creatorAvatar');
const { dataPath } = require('./dataDir');

const DATA_DIR = dataPath('telegram');
const FAN_AVATARS_DIR = dataPath('telegram-fans');
const FAN_AVATARS_PUBLIC = '/uploads/telegram-fans';
const VAULT_CACHE_DIR = dataPath('telegram-vault');
const LOGIN_TIMEOUT_MS = 90_000;
const VAULT_ALBUM_MAX = 10;
const FAN_AVATAR_PREFETCH_CONCURRENCY = 3;
const MEDIA_DOWNLOAD_CONCURRENCY = 3;

/** @type {Map<string, Promise<string | null>>} */
const fanAvatarInFlight = new Map();

/** @type {Map<string, Promise<{ filePath: string, mimeType: string, kind: string }>>} */
const mediaInFlight = new Map();

let mediaDownloadActive = 0;
/** @type {Array<() => void>} */
const mediaDownloadWaiters = [];

/** @type {Map<string, { client: import('@mtcute/node').TelegramClient, self: object | null }>} */
const hotClients = new Map();

/** @type {Map<string, object>} */
const pendingLogins = new Map();

const READ_COOLDOWN_MS = 60_000;
/** @type {Map<string, number>} */
const lastReadAt = new Map();

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
    const peerId = String(msg.chat?.id || '');
    const messageId = msg.id;
    void relayUpdate(creatorId, 'new_message', {
      peerId,
      messageId,
    });
    if (peerId && messageId != null && mediaPlaceholder(msg.media)) {
      void prewarmChatThumb(creatorId, peerId, messageId);
    }
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

const TELEGRAM_SERVICE_IDS = new Set(['777000', '42777']);

function isTelegramServicePeer(peer) {
  if (!peer) return false;
  if (peer.type === 'chat' || peerKind(peer) === 'group') return false;
  const id = String(peer.id || '');
  if (TELEGRAM_SERVICE_IDS.has(id)) return true;
  const phone = String(peer.phone || peer.phoneNumber || peer.username || '').replace(
    /\D/g,
    ''
  );
  if (TELEGRAM_SERVICE_IDS.has(phone)) return true;
  const name = String(peer.displayName || peer.firstName || '')
    .trim()
    .toLowerCase();
  return name === 'telegram';
}

function isTelegramServiceDialog(dialog) {
  if (!dialog || dialog.kind === 'group') return false;
  return isTelegramServicePeer({
    type: 'user',
    id: dialog.peerId,
    displayName: dialog.displayName,
    username: dialog.username,
    phone: dialog.phone,
    phoneNumber: dialog.phoneNumber,
  });
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

const VIDEO_FILE_RE = /\.(mp4|mov|webm|m4v)$/i;

function mediaMime(media) {
  if (!media || typeof media !== 'object') return '';
  return String(media.mimeType || media.mime || media.fileMime || '').toLowerCase();
}

function mediaFileName(media) {
  if (!media || typeof media !== 'object') return '';
  return String(media.fileName || '');
}

function isChatVideoMedia(media) {
  if (!media || typeof media !== 'object') return false;
  const type = String(media.type || '').toLowerCase();
  if (type === 'video' || type === 'video_note' || type === 'round') return true;
  const mime = mediaMime(media);
  const name = mediaFileName(media);
  const looksVideo = mime.startsWith('video/') || VIDEO_FILE_RE.test(name);
  if (type === 'animation') return !mime.startsWith('image/');
  if (type === 'document') return looksVideo;
  return false;
}

function mediaPlaceholder(media) {
  const type = media && typeof media === 'object' ? media.type : null;
  if (type === 'photo') return { kind: 'photo', text: 'Photo' };
  if (isChatVideoMedia(media)) return { kind: 'video', text: 'Video' };
  if (type === 'voice' || type === 'audio') return { kind: 'audio', text: 'Audio' };
  if (type === 'sticker') return { kind: 'sticker', text: 'Sticker' };
  if (type === 'document') return { kind: 'document', text: 'File' };
  if (type) return { kind: 'media', text: 'Media' };
  return null;
}

function serializeMessage(msg) {
  if (!msg) return null;
  const text = typeof msg.text === 'string' ? msg.text : '';
  const mediaInfo = mediaPlaceholder(msg.media);
  const sender = msg.sender;
  return {
    id: String(msg.id),
    peerId: String(msg.chat?.id || ''),
    isOutgoing: Boolean(msg.isOutgoing),
    date: msg.date instanceof Date ? msg.date.toISOString() : null,
    text,
    kind: mediaInfo?.kind || (text ? 'text' : 'empty'),
    placeholder: text ? null : mediaInfo?.text || null,
    hasMedia: Boolean(mediaInfo),
    senderId: sender?.id != null ? String(sender.id) : null,
    senderName: sender
      ? sender.displayName || sender.title || sender.firstName || null
      : null,
    senderUsername: sender?.username || null,
    senderAvatarUrl: null,
  };
}

function vaultKindFromMedia(media) {
  const type = media && typeof media === 'object' ? media.type : null;
  if (type === 'photo') return 'photo';
  if (type === 'video') return 'video';
  return null;
}

function extractVaultFields(msg) {
  if (!msg) return null;
  const media = msg.media;
  const kind = vaultKindFromMedia(media);
  if (!kind) return null;
  const duration = Number(media.duration);
  const width = Number(media.width);
  const height = Number(media.height);
  return {
    savedMessageId: String(msg.id),
    fileUniqueId: media.uniqueFileId ? String(media.uniqueFileId) : null,
    kind,
    fileName: typeof media.fileName === 'string' ? media.fileName : null,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
  };
}

function asMessageList(fetched) {
  if (Array.isArray(fetched)) return fetched.filter(Boolean);
  return fetched ? [fetched] : [];
}

function inputMediaFromMessage(msg, caption) {
  const media = msg?.media;
  if (!media) return null;
  const kind = vaultKindFromMedia(media);
  if (!kind) return null;
  const file = media.inputMedia || media;
  if (caption) {
    return { type: kind, file, caption };
  }
  return media.inputMedia || { type: kind, file };
}

function vaultCacheRel(creatorId, ...parts) {
  const safeCreator = String(creatorId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const safeParts = parts.map((part) =>
    String(part || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  );
  return path.join(safeCreator, ...safeParts);
}

function vaultCacheAbs(rel) {
  return path.join(VAULT_CACHE_DIR, rel);
}

function vaultThumbAbs(creatorId, savedMessageId) {
  return vaultCacheAbs(
    vaultCacheRel(creatorId, 'me', `${savedMessageId}_thumb.jpg`)
  );
}

function chatThumbAbs(creatorId, peerId, messageId) {
  return vaultCacheAbs(
    vaultCacheRel(creatorId, String(peerId), `${messageId}_thumb.jpg`)
  );
}

const FULL_CACHE_EXTS = [
  { ext: 'jpg', mimeType: 'image/jpeg', kind: 'photo' },
  { ext: 'mp4', mimeType: 'video/mp4', kind: 'video' },
  { ext: 'webm', mimeType: 'video/webm', kind: 'video' },
  { ext: 'mov', mimeType: 'video/quicktime', kind: 'video' },
];

function cachedFileReady(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).size);
  } catch {
    return false;
  }
}

function findCachedFullMedia(creatorId, peerId, messageId) {
  for (const { ext, mimeType, kind } of FULL_CACHE_EXTS) {
    const dest = vaultCacheAbs(
      vaultCacheRel(creatorId, String(peerId), `${messageId}_full.${ext}`)
    );
    if (cachedFileReady(dest)) {
      return { filePath: dest, mimeType, kind };
    }
  }
  return null;
}

function cachedJpegReady(filePath) {
  try {
    return Boolean(
      filePath &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).size &&
        fileLooksLikeJpeg(filePath)
    );
  } catch {
    return false;
  }
}

function copyVaultThumbToChat(creatorId, savedMessageId, peerId, sentMessageId) {
  const fromPath = vaultThumbAbs(creatorId, savedMessageId);
  const toPath = chatThumbAbs(creatorId, peerId, sentMessageId);
  if (!cachedJpegReady(fromPath) || !sentMessageId) return false;
  try {
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.copyFileSync(fromPath, toPath);
    return true;
  } catch (err) {
    console.warn('[telegram] Vault thumb copy failed:', err.message || err);
    return false;
  }
}

function acquireMediaDownloadSlot() {
  if (mediaDownloadActive < MEDIA_DOWNLOAD_CONCURRENCY) {
    mediaDownloadActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    mediaDownloadWaiters.push(resolve);
  });
}

function releaseMediaDownloadSlot() {
  const next = mediaDownloadWaiters.shift();
  if (next) {
    next();
    return;
  }
  mediaDownloadActive = Math.max(0, mediaDownloadActive - 1);
}

function fileLooksLikeJpeg(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(3);
    fs.readSync(fd, buf, 0, 3, 0);
    fs.closeSync(fd);
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  } catch {
    return false;
  }
}

function pickMediaThumb(media) {
  if (!media || typeof media !== 'object') return null;
  if (typeof media.getThumbnail === 'function') {
    const thumb =
      media.getThumbnail('m') ||
      media.getThumbnail('x') ||
      media.getThumbnail('s') ||
      (Array.isArray(media.thumbnails) ? media.thumbnails[0] : null);
    if (thumb) return thumb;
  }
  if (media.videoCover) return media.videoCover;
  if (Array.isArray(media.thumbnails) && media.thumbnails[0]) {
    return media.thumbnails[0];
  }
  return media.type === 'photo' ? media : null;
}

function pickMediaFull(media) {
  if (!media || typeof media !== 'object') return null;
  return media;
}

function guessMediaMime(kind, variant, media) {
  if (variant === 'thumb' || kind === 'photo') return 'image/jpeg';
  if (kind === 'video') {
    const mime = mediaMime(media);
    if (mime.startsWith('video/')) return mime;
    const name = mediaFileName(media).toLowerCase();
    if (name.endsWith('.webm')) return 'video/webm';
    if (name.endsWith('.mov')) return 'video/quicktime';
    return 'video/mp4';
  }
  return 'application/octet-stream';
}

function fullMediaExt(kind, mimeType) {
  if (kind === 'photo') return 'jpg';
  if (kind === 'video') {
    if (mimeType === 'video/webm') return 'webm';
    if (mimeType === 'video/quicktime') return 'mov';
    return 'mp4';
  }
  return 'bin';
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
  const kind = peerKind(peer);
  await pool.query(
    `INSERT INTO telegram_fan_profiles (
       "creatorId", "telegramUserId", username, "displayName", kind
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ("creatorId", "telegramUserId")
     DO UPDATE SET
       username = EXCLUDED.username,
       "displayName" = EXCLUDED."displayName",
       kind = EXCLUDED.kind,
       "updatedAt" = NOW()`,
    [creatorId, telegramUserId, username, displayName, kind]
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

const ALL_DM_DIALOG_CAP = 10_000;
const PROFILE_UPSERT_BATCH = 20;

async function listAllDmPeers(creatorId) {
  const client = await getClient(creatorId);
  const peers = [];
  const seen = new Set();
  for await (const dialog of client.iterDialogs({ limit: ALL_DM_DIALOG_CAP })) {
    const peer = dialog.peer;
    if (!isInboxPeer(peer)) continue;
    if (peerKind(peer) !== 'dm') continue;
    if (isTelegramServicePeer(peer)) continue;
    const peerId = String(peer.id || '').trim();
    if (!peerId || seen.has(peerId)) continue;
    seen.add(peerId);
    peers.push(peer);
  }
  for (let index = 0; index < peers.length; index += PROFILE_UPSERT_BATCH) {
    const batch = peers.slice(index, index + PROFILE_UPSERT_BATCH);
    await Promise.all(batch.map((peer) => upsertFanProfile(creatorId, peer)));
  }
  return peers.map((peer) => ({
    peerId: String(peer.id),
    peer,
  }));
}

async function markPeerRead(client, peerId, { creatorId, force = false } = {}) {
  const key = `${creatorId || ''}:${peerId}`;
  if (!force) {
    const prev = lastReadAt.get(key) || 0;
    if (Date.now() - prev < READ_COOLDOWN_MS) return;
  }
  try {
    await client.readHistory(peerId, { clearMentions: true });
    lastReadAt.set(key, Date.now());
  } catch (err) {
    console.warn('[telegram] readHistory failed:', err.message || err);
  }
}

async function listMessages(
  creatorId,
  peerId,
  { limit = 50, offsetId, offsetDate } = {}
) {
  const client = await getClient(creatorId);
  const numericId = Number(peerId);
  if (!Number.isFinite(numericId)) {
    throw new TelegramWorkerError('Invalid chat id');
  }
  const clamped = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const numericOffsetId = Number(offsetId);
  const hasOffset = Number.isFinite(numericOffsetId) && numericOffsetId > 0;
  const numericOffsetDate = Number(offsetDate);
  const history = await client.getHistory(numericId, {
    limit: clamped,
    ...(hasOffset
      ? {
          offset: {
            id: numericOffsetId,
            date: Number.isFinite(numericOffsetDate) ? numericOffsetDate : 0,
          },
        }
      : {}),
  });
  const nextRaw = history.next || null;
  const messages = [...history]
    .map(serializeMessage)
    .filter(Boolean)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const next =
    nextRaw && nextRaw.id != null
      ? { id: String(nextRaw.id), date: Number(nextRaw.date) || 0 }
      : null;
  const hasMore = Boolean(next) && messages.length >= clamped;
  let peer = null;
  if (!hasOffset) {
    try {
      const users = await client.getUsers(numericId);
      if (users[0] && users[0].type === 'user') peer = users[0];
    } catch {
      peer = null;
    }
  }
  if (!peer) {
    try {
      peer = await client.getChat(numericId);
    } catch {
      peer = null;
    }
  }
  if (peer && !hasOffset) {
    await upsertFanProfile(creatorId, peer);
    void cachePeerAvatar(creatorId, client, peer).catch(() => undefined);
  }
  if (!hasOffset) {
    await markPeerRead(client, numericId, { creatorId });
  }
  const profiles = await loadProfiles(creatorId, [String(numericId)]);
  const profile = profiles.get(String(numericId));
  const kind = peerKind(peer);
  const withSenders =
    kind === 'group'
      ? await attachSenderAvatars(creatorId, client, messages)
      : messages;
  scheduleChatThumbPrewarm(creatorId, String(numericId), withSenders);
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
    messages: withSenders,
    next,
    hasMore,
  };
}

function isListedChatMember(member) {
  const status = member?.status;
  if (status === 'creator' || status === 'admin' || status === 'member') return true;
  if (status === 'restricted') return Boolean(member.isMember);
  return false;
}

function serializeChatMember(member) {
  const user = member?.user;
  if (!user) return null;
  const status = member.status;
  return {
    telegramUserId: String(user.id),
    displayName: user.displayName || user.firstName || 'Fan',
    username: user.username || null,
    isBot: Boolean(user.isBot),
    isSelf: Boolean(user.isSelf),
    status:
      status === 'creator' || status === 'admin' || status === 'member'
        ? status
        : 'member',
    title: member.title || null,
    avatarUrl: null,
  };
}

async function listChatMembers(creatorId, peerId) {
  const client = await getClient(creatorId);
  const numericId = Number(peerId);
  if (!Number.isFinite(numericId)) {
    throw new TelegramWorkerError('Invalid chat id');
  }

  let peer = null;
  try {
    peer = await client.getChat(numericId);
  } catch {
    peer = null;
  }
  if (!peer || peerKind(peer) !== 'group') {
    throw new TelegramWorkerError('Not a group chat');
  }

  let fetched = [];
  try {
    fetched = await client.getChatMembers(numericId, {
      type: 'recent',
      limit: 200,
    });
  } catch (err) {
    throw new TelegramWorkerError(
      err?.message ? String(err.message).slice(0, 240) : 'Failed to list group members'
    );
  }

  const rawList = Array.isArray(fetched) ? fetched : fetched ? [fetched] : [];
  const listed = rawList.filter(isListedChatMember);
  const members = listed.map(serializeChatMember).filter(Boolean);
  const users = listed.map((member) => member.user).filter(Boolean);

  let memberCount = Number(fetched?.total);
  if (!Number.isFinite(memberCount) || memberCount <= 0) {
    try {
      const full = await client.getFullChat(numericId);
      memberCount = Number(full?.membersCount);
    } catch {
      memberCount = NaN;
    }
  }
  if (!Number.isFinite(memberCount) || memberCount <= 0) {
    memberCount = members.length;
  }
  await Promise.all(users.map((user) => upsertFanProfile(creatorId, user)));
  const profiles = await loadProfiles(
    creatorId,
    members.map((m) => m.telegramUserId)
  );
  scheduleFanAvatarPrefetch(creatorId, client, users, profiles);

  return {
    peerId: String(numericId),
    memberCount,
    members: members.map((member) => ({
      ...member,
      avatarUrl: profiles.get(member.telegramUserId)?.avatarUrl || null,
    })),
  };
}

async function attachSenderAvatars(creatorId, client, messages) {
  const senderIds = [
    ...new Set(
      messages
        .filter((msg) => !msg.isOutgoing && msg.senderId)
        .map((msg) => msg.senderId)
    ),
  ];
  if (!senderIds.length) return messages;

  const numericIds = senderIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
  let users = [];
  try {
    users = numericIds.length ? await client.getUsers(numericIds) : [];
  } catch {
    users = [];
  }
  const userList = Array.isArray(users) ? users : users ? [users] : [];
  await Promise.all(
    userList.map(async (user) => {
      if (!user) return;
      try {
        await upsertFanProfile(creatorId, user);
        await cachePeerAvatar(creatorId, client, user);
      } catch {
        // best-effort
      }
    })
  );
  const senderProfiles = await loadProfiles(creatorId, senderIds);
  return messages.map((msg) => {
    if (msg.isOutgoing || !msg.senderId) return msg;
    return {
      ...msg,
      senderAvatarUrl: senderProfiles.get(msg.senderId)?.avatarUrl || null,
    };
  });
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
  await markPeerRead(client, numericId, { creatorId, force: true });
  return serializeMessage(sent);
}

async function fetchSavedMessages(client, messageIds) {
  const numericIds = messageIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
  if (!numericIds.length) return [];
  const fetched = await client.getMessages('me', numericIds);
  const list = asMessageList(fetched);
  const byId = new Map(list.map((msg) => [Number(msg.id), msg]));
  return numericIds.map((id) => byId.get(id) || null);
}

async function uploadVaultMedia(creatorId, { filePath, mimeType, fileName, thumbPath }) {
  const client = await getClient(creatorId);
  const abs = path.resolve(String(filePath || ''));
  if (!abs || !fs.existsSync(abs)) {
    throw new TelegramWorkerError('Upload file is missing', 400);
  }
  const mime = String(mimeType || '').toLowerCase();
  const isVideo = mime.startsWith('video/');
  const isPhoto = mime.startsWith('image/');
  if (!isVideo && !isPhoto) {
    throw new TelegramWorkerError('Only photos and videos can be added to the vault');
  }
  const thumbAbs = thumbPath ? path.resolve(String(thumbPath)) : '';
  try {
    const sent = await client.sendMedia('me', {
      type: isVideo ? 'video' : 'photo',
      // mtcute treats a bare string as a File ID; local paths need the file: prefix.
      file: `file:${abs}`,
      fileName: fileName || path.basename(abs),
      fileMime: mime || undefined,
    });
    const fields = extractVaultFields(sent);
    if (!fields) {
      throw new TelegramWorkerError('Telegram did not return vault media', 502);
    }
    let wroteThumb = false;
    try {
      if (thumbAbs && fs.existsSync(thumbAbs)) {
        wroteThumb = await writePhotoThumbFromFile(
          creatorId,
          fields.savedMessageId,
          thumbAbs
        );
      }
      if (!wroteThumb && isPhoto) {
        wroteThumb = await writePhotoThumbFromFile(
          creatorId,
          fields.savedMessageId,
          abs
        );
      }
      if (!wroteThumb) {
        wroteThumb = await writeVaultThumbFromMedia(
          creatorId,
          client,
          fields.savedMessageId,
          sent.media
        );
      }
      if (!wroteThumb) {
        const fetched = await fetchSavedMessages(client, [fields.savedMessageId]);
        wroteThumb = await writeVaultThumbFromMedia(
          creatorId,
          client,
          fields.savedMessageId,
          fetched[0]?.media
        );
      }
    } catch (err) {
      console.warn('[telegram] Vault thumb write failed:', err.message || err);
    }
    if (!wroteThumb) {
      void prewarmVaultThumb(creatorId, fields.savedMessageId);
    }
    return fields;
  } catch (err) {
    if (err instanceof TelegramWorkerError) throw err;
    throw new TelegramWorkerError(describeError(err), 400);
  }
}

async function sendVaultToPeer(creatorId, peerId, { itemMessageIds, caption }) {
  const client = await getClient(creatorId);
  const numericPeer = Number(peerId);
  if (!Number.isFinite(numericPeer)) {
    throw new TelegramWorkerError('Invalid chat id');
  }
  const ids = (Array.isArray(itemMessageIds) ? itemMessageIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
  if (!ids.length) {
    throw new TelegramWorkerError('vaultIds are required');
  }
  const captionText = typeof caption === 'string' ? caption.trim() : '';
  const sentMessages = [];

  try {
    if (ids.length === 1) {
      const sent = await client.sendCopy({
        fromChatId: 'me',
        message: ids[0],
        toChatId: numericPeer,
        caption: captionText || undefined,
      });
      const serialized = serializeMessage(sent);
      if (serialized) {
        copyVaultThumbToChat(creatorId, ids[0], numericPeer, serialized.id);
        sentMessages.push(serialized);
      }
      await markPeerRead(client, numericPeer, { creatorId, force: true });
      return sentMessages;
    }

    for (let offset = 0; offset < ids.length; offset += VAULT_ALBUM_MAX) {
      const chunk = ids.slice(offset, offset + VAULT_ALBUM_MAX);
      const source = await fetchSavedMessages(client, chunk);
      const medias = [];
      for (let i = 0; i < source.length; i += 1) {
        const msg = source[i];
        if (!msg) {
          throw new TelegramWorkerError('A vault item is missing from Saved Messages', 404);
        }
        const useCaption = offset === 0 && i === 0 ? captionText : '';
        const input = inputMediaFromMessage(msg, useCaption);
        if (!input) {
          throw new TelegramWorkerError('Vault item is not a photo or video', 400);
        }
        medias.push(input);
      }
      const sent = await client.sendMediaGroup(numericPeer, medias);
      const sentList = asMessageList(sent);
      for (let i = 0; i < sentList.length; i += 1) {
        const serialized = serializeMessage(sentList[i]);
        if (!serialized) continue;
        if (chunk[i] != null) {
          copyVaultThumbToChat(creatorId, chunk[i], numericPeer, serialized.id);
        }
        sentMessages.push(serialized);
      }
    }
    await markPeerRead(client, numericPeer, { creatorId, force: true });
    return sentMessages;
  } catch (err) {
    if (err instanceof TelegramWorkerError) throw err;
    throw new TelegramWorkerError(describeError(err), 400);
  }
}

async function deleteClientMessages(client, chatId, ids, foundMessages = []) {
  const idList = (ids || []).map((id) => Number(id)).filter(Number.isFinite);
  if (idList.length === 0) return;

  if (typeof client.deleteMessagesById === 'function') {
    await client.deleteMessagesById(chatId, idList, { revoke: true });
    return;
  }

  if (typeof client.deleteMessages === 'function') {
    let msgs = (foundMessages || []).filter(Boolean);
    if (msgs.length === 0) {
      const fetched = await client.getMessages(chatId, idList);
      msgs = asMessageList(fetched);
    }
    if (msgs.length === 0) {
      throw new TelegramWorkerError('Message not found', 404);
    }
    await client.deleteMessages(msgs, { revoke: true });
    return;
  }

  throw new TelegramWorkerError('Telegram delete is not available', 500);
}

async function deleteSavedVaultMessage(creatorId, savedMessageId) {
  const client = await getClient(creatorId);
  const msgId = Number(savedMessageId);
  if (!Number.isFinite(msgId)) {
    throw new TelegramWorkerError('Invalid vault message id');
  }
  try {
    await deleteClientMessages(client, 'me', [msgId]);
  } catch (err) {
    throw new TelegramWorkerError(describeError(err), 400);
  }
}

async function writePhotoThumbFromFile(creatorId, savedMessageId, filePath) {
  const dest = vaultThumbAbs(creatorId, savedMessageId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${Date.now()}.tmp`;
  try {
    await sharp(filePath, { failOn: 'none' })
      .rotate()
      .resize(320, 320, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(tmp);
    if (!fs.existsSync(tmp) || !fs.statSync(tmp).size || !fileLooksLikeJpeg(tmp)) {
      return false;
    }
    fs.copyFileSync(tmp, dest);
    return true;
  } catch (err) {
    console.warn('[telegram] Local vault thumb failed:', err.message || err);
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

async function ensureJpegThumb(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).size) {
    return false;
  }
  if (fileLooksLikeJpeg(filePath)) return true;
  const tmp = `${filePath}.${Date.now()}.jpg`;
  try {
    await sharp(filePath, { failOn: 'none' })
      .rotate()
      .resize(320, 320, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(tmp);
    if (!fs.existsSync(tmp) || !fs.statSync(tmp).size || !fileLooksLikeJpeg(tmp)) {
      return false;
    }
    fs.copyFileSync(tmp, filePath);
    return true;
  } catch (err) {
    console.warn('[telegram] Thumb convert failed:', err.message || err);
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

async function writeVaultThumbFromMedia(creatorId, client, savedMessageId, media) {
  const location = pickMediaThumb(media);
  if (!location) return false;
  const dest = vaultThumbAbs(creatorId, savedMessageId);
  const saved = await downloadLocationToFile(client, location, dest);
  if (!saved) return false;
  return ensureJpegThumb(dest);
}

async function downloadLocationToFile(client, location, destPath) {
  if (!client || !location || !destPath) return false;
  const tmp = path.join(
    os.tmpdir(),
    `tg-media-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    await client.downloadToFile(tmp, location);
    if (!fs.existsSync(tmp) || !fs.statSync(tmp).size) return false;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(tmp, destPath);
    return true;
  } catch (err) {
    console.warn('[telegram] Media download failed:', err.message || err);
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

async function resolveChatMessage(client, peerId, messageId) {
  const numericPeer = peerId === 'me' || peerId === 'self' ? 'me' : Number(peerId);
  const msgId = Number(messageId);
  if (numericPeer !== 'me' && !Number.isFinite(numericPeer)) {
    throw new TelegramWorkerError('Invalid chat id');
  }
  if (!Number.isFinite(msgId)) {
    throw new TelegramWorkerError('Invalid message id');
  }
  const fetched = await client.getMessages(numericPeer, [msgId]);
  const found = asMessageList(fetched)[0] || null;
  if (found) return found;
  if (numericPeer === 'me') return null;
  try {
    const history = await client.getHistory(numericPeer, { limit: 100 });
    return [...history].find((msg) => Number(msg.id) === msgId) || null;
  } catch {
    return null;
  }
}

async function fetchAndCacheMessageMedia(creatorId, peerId, messageId, variant) {
  const client = await getClient(creatorId);
  const wantThumb = variant !== 'full';
  const msg = await resolveChatMessage(client, peerId, messageId);
  if (!msg) {
    throw new TelegramWorkerError('Message not found', 404);
  }
  const media = msg.media;
  const kind =
    vaultKindFromMedia(media) ||
    (isChatVideoMedia(media) ? 'video' : null) ||
    mediaPlaceholder(media)?.kind ||
    'media';
  const location = wantThumb ? pickMediaThumb(media) : pickMediaFull(media);
  if (!location) {
    throw new TelegramWorkerError('No media on this message', 404);
  }
  const mimeType = guessMediaMime(kind, wantThumb ? 'thumb' : 'full', media);
  const ext = wantThumb || kind === 'photo' ? 'jpg' : fullMediaExt(kind, mimeType);
  const rel = vaultCacheRel(
    creatorId,
    String(peerId),
    `${messageId}_${wantThumb ? 'thumb' : 'full'}.${ext}`
  );
  const dest = vaultCacheAbs(rel);
  if (wantThumb && fs.existsSync(dest) && fs.statSync(dest).size && !fileLooksLikeJpeg(dest)) {
    if (!(await ensureJpegThumb(dest))) {
      try {
        fs.unlinkSync(dest);
      } catch {
        // ignore
      }
    }
  }
  if (!fs.existsSync(dest) || !fs.statSync(dest).size) {
    const saved = await downloadLocationToFile(client, location, dest);
    if (!saved) {
      throw new TelegramWorkerError('Failed to download media', 502);
    }
    if (wantThumb && !(await ensureJpegThumb(dest))) {
      try {
        fs.unlinkSync(dest);
      } catch {
        // ignore
      }
      throw new TelegramWorkerError('Failed to download media', 502);
    }
  }
  return {
    filePath: dest,
    mimeType,
    kind,
  };
}

async function getCachedMessageMedia(creatorId, peerId, messageId, variant) {
  const wantThumb = variant !== 'full';
  if (wantThumb) {
    const dest = chatThumbAbs(creatorId, peerId, messageId);
    if (cachedJpegReady(dest)) {
      return { filePath: dest, mimeType: 'image/jpeg', kind: 'photo' };
    }
  } else {
    const cached = findCachedFullMedia(creatorId, peerId, messageId);
    if (cached) return cached;
  }

  const cacheKey = `${creatorId}:${peerId}:${messageId}:${wantThumb ? 'thumb' : 'full'}`;
  const pending = mediaInFlight.get(cacheKey);
  if (pending) return pending;

  const work = (async () => {
    await acquireMediaDownloadSlot();
    try {
      if (wantThumb) {
        const dest = chatThumbAbs(creatorId, peerId, messageId);
        if (cachedJpegReady(dest)) {
          return { filePath: dest, mimeType: 'image/jpeg', kind: 'photo' };
        }
      } else {
        const cached = findCachedFullMedia(creatorId, peerId, messageId);
        if (cached) return cached;
      }
      return await fetchAndCacheMessageMedia(creatorId, peerId, messageId, variant);
    } finally {
      releaseMediaDownloadSlot();
    }
  })();

  mediaInFlight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    mediaInFlight.delete(cacheKey);
  }
}

async function getCachedVaultMedia(creatorId, savedMessageId, variant) {
  return getCachedMessageMedia(creatorId, 'me', savedMessageId, variant);
}

async function prewarmVaultThumb(creatorId, savedMessageId) {
  try {
    await getCachedVaultMedia(creatorId, savedMessageId, 'thumb');
  } catch (err) {
    console.warn('[telegram] Vault thumb prewarm failed:', err.message || err);
  }
}

async function prewarmChatThumb(creatorId, peerId, messageId) {
  try {
    await getCachedMessageMedia(creatorId, peerId, messageId, 'thumb');
  } catch (err) {
    console.warn('[telegram] Chat thumb prewarm failed:', err.message || err);
  }
}

function scheduleChatThumbPrewarm(creatorId, peerId, messages) {
  const ids = (Array.isArray(messages) ? messages : [])
    .filter((msg) => msg && msg.hasMedia && msg.id)
    .map((msg) => msg.id);
  if (!ids.length) return;
  void Promise.all(ids.map((id) => prewarmChatThumb(creatorId, peerId, id)));
}

async function deleteText(creatorId, peerId, messageId) {
  const client = await getClient(creatorId);
  const numericId = Number(peerId);
  const msgId = Number(messageId);
  if (!Number.isFinite(numericId) || !Number.isFinite(msgId)) {
    throw new TelegramWorkerError('Invalid chat or message id');
  }

  let found = null;
  try {
    const fetched = await client.getMessages(numericId, [msgId]);
    found = Array.isArray(fetched) ? fetched[0] : fetched;
  } catch {
    found = null;
  }
  if (!found) {
    try {
      const history = await client.getHistory(numericId, { limit: 100 });
      found = [...history].find((msg) => Number(msg.id) === msgId) || null;
    } catch {
      found = null;
    }
  }
  if (!found) {
    throw new TelegramWorkerError('Message not found', 404);
  }
  if (!found.isOutgoing) {
    throw new TelegramWorkerError('Only outgoing messages can be unsent', 400);
  }

  try {
    await deleteClientMessages(client, numericId, [msgId], found ? [found] : []);
  } catch (err) {
    if (err instanceof TelegramWorkerError) throw err;
    throw new TelegramWorkerError(describeError(err), 400);
  }
  return serializeMessage(found);
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

async function unreadCount(creatorId, { hideService = false } = {}) {
  const client = await getClient(creatorId);
  let messages = 0;
  for await (const dialog of client.iterDialogs({ limit: 80 })) {
    if (!isInboxPeer(dialog.peer)) continue;
    if (hideService && isTelegramServicePeer(dialog.peer)) continue;
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
  listAllDmPeers,
  listMessages,
  listChatMembers,
  sendText,
  sendVaultToPeer,
  uploadVaultMedia,
  deleteSavedVaultMessage,
  getCachedMessageMedia,
  getCachedVaultMedia,
  prewarmVaultThumb,
  deleteText,
  resolveUsername,
  unreadCount,
  startTelegramManager,
  upsertFanProfile,
  isTelegramServicePeer,
  isTelegramServiceDialog,
};
