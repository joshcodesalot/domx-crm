const pool = require('../db/pool');
const { startHeartbeat, noteTickFailure } = require('./opsEvents');
const { translateDeToEn: translateDeToEnGoogle } = require('./googleTranslate');

const PLATFORMS = new Set(['maloum', '4based', 'telegram', 'fansly']);
const GERMAN_PLATFORMS = new Set(['maloum', '4based', 'telegram']);
const TRANSLATE_BATCH = 8;
const TRANSLATE_INTERVAL_MS = 4000;
const ARCHIVE_TRANSLATE_WINDOW = 20;
const COINS_PER_DOLLAR = 121;
const TELEGRAM_PLACEHOLDERS = new Set([
  'Photo',
  'GIF',
  'Video',
  'Voice note',
  'Audio',
  'Sticker',
  'File',
  'Media',
]);

let translateTimer = null;
let draining = false;

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCompare(value) {
  return textValue(value).replace(/\s+/g, ' ').toLowerCase();
}

function buildSearchText(textEn, textDe, textSent) {
  const seen = new Set();
  const parts = [];
  for (const value of [textEn, textDe, textSent]) {
    const trimmed = textValue(value);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(key);
  }
  return parts.join('\n');
}

function parseSentAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return new Date().toISOString();
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  if (value == null || value === '') return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseDeletedAt(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  if (typeof value === 'number' && value > 0) return parseSentAt(value);
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    return numeric > 0 ? parseSentAt(numeric) : null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sameParty(left, right) {
  const a = left == null ? '' : String(left).trim();
  const b = right == null ? '' : String(right).trim();
  return Boolean(a) && a === b;
}

function mediaEntries(items, idKeys, typeKey) {
  const rows = Array.isArray(items) ? items : [];
  const out = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    let id = '';
    for (const key of idKeys) {
      if (item[key] != null && String(item[key]).trim()) {
        id = String(item[key]).trim();
        break;
      }
    }
    const type = typeKey && item[typeKey] != null ? String(item[typeKey]) : 'media';
    if (!id && !type) continue;
    out.push({ id: id || null, type: type || 'media' });
  }
  return out.length > 0 ? out : null;
}

function applyLanguageFields({
  direction,
  platform,
  textSent,
  englishDraft,
  skipTranslation,
}) {
  const sent = textValue(textSent);
  const english = textValue(englishDraft);
  const fansly = platform === 'fansly';

  if (skipTranslation) {
    return {
      textSent: sent || english,
      textEn: english || sent,
      textDe: null,
      translationStatus: 'skipped',
    };
  }

  if (direction === 'outbound') {
    if (!fansly && english && normalizeCompare(english) !== normalizeCompare(sent)) {
      return {
        textSent: sent,
        textEn: english,
        textDe: sent,
        translationStatus: 'done',
      };
    }
    return {
      textSent: sent || english,
      textEn: english || sent,
      textDe: null,
      translationStatus: 'skipped',
    };
  }

  if (fansly || !GERMAN_PLATFORMS.has(platform) || !sent) {
    return {
      textSent: sent,
      textEn: sent,
      textDe: null,
      translationStatus: 'skipped',
    };
  }

  return {
    textSent: sent,
    textEn: null,
    textDe: null,
    translationStatus: 'pending',
  };
}

function applyInboundTranslation(textSent, translated) {
  const source = textValue(textSent);
  const next = textValue(translated);
  if (!next || normalizeCompare(next) === normalizeCompare(source)) {
    return { textEn: source || null, textDe: null };
  }
  return { textEn: next, textDe: source || null };
}

function finalizeMessage(message, platform) {
  const prepared = message.prepared === true;
  const language = prepared
    ? {
        textSent: textValue(message.textSent),
        textEn: message.textEn == null ? null : textValue(message.textEn) || null,
        textDe: message.textDe == null ? null : textValue(message.textDe) || null,
        translationStatus: message.translationStatus || 'skipped',
      }
    : applyLanguageFields({
        direction: message.direction,
        platform,
        textSent: message.textSent,
        englishDraft: message.englishDraft,
        skipTranslation: message.skipTranslation === true,
      });
  return {
    platformMessageId: String(message.platformMessageId),
    direction: message.direction === 'outbound' ? 'outbound' : 'inbound',
    senderRole: message.senderRole === 'creator' || message.senderRole === 'system' ? message.senderRole : 'fan',
    chatterId: message.chatterId || null,
    chatterName: textValue(message.chatterName) || null,
    kind: message.kind === 'ppv' || message.kind === 'mass' || message.kind === 'system' ? message.kind : 'dm',
    textSent: language.textSent,
    textEn: language.textEn,
    textDe: language.textDe,
    searchText: buildSearchText(language.textEn, language.textDe, language.textSent),
    hasMedia: message.hasMedia === true,
    isPpv: message.isPpv === true || message.kind === 'ppv',
    priceNet: message.priceNet == null || message.priceNet === '' ? null : Number(message.priceNet),
    currency: textValue(message.currency) || null,
    mediaJson: message.mediaJson || null,
    sentAt: parseSentAt(message.sentAt),
    deletedAt: message.deletedAt ? parseDeletedAt(message.deletedAt) || new Date().toISOString() : null,
    translationStatus: language.translationStatus,
  };
}

function mergeArchiveMessage(existing, incoming) {
  if (!existing) return incoming;
  const chatterId = incoming.chatterId || existing.chatterId || null;
  const chatterName = incoming.chatterName || existing.chatterName || null;
  const textSent = textValue(incoming.textSent) || textValue(existing.textSent);
  let textEn = incoming.textEn;
  let textDe = incoming.textDe;
  let translationStatus = incoming.translationStatus;

  if (incoming.translationStatus === 'done') {
    textEn = incoming.textEn;
    textDe = incoming.textDe;
    translationStatus = 'done';
  } else if (existing.translationStatus === 'done') {
    textEn = existing.textEn;
    textDe = existing.textDe;
    translationStatus = 'done';
  } else if (existing.translationStatus === 'skipped' && incoming.translationStatus !== 'done') {
    textEn = existing.textEn || incoming.textEn;
    textDe = existing.textDe || incoming.textDe;
    translationStatus = 'skipped';
  } else {
    textEn = incoming.textEn || existing.textEn;
    textDe = incoming.textDe || existing.textDe;
    translationStatus = incoming.translationStatus || existing.translationStatus;
  }

  const kind =
    existing.kind === 'mass' || incoming.kind === 'mass'
      ? 'mass'
      : existing.kind === 'ppv' || incoming.kind === 'ppv'
        ? 'ppv'
        : incoming.kind || existing.kind;

  return {
    ...incoming,
    direction: incoming.direction || existing.direction,
    senderRole: incoming.senderRole || existing.senderRole,
    chatterId,
    chatterName,
    kind,
    textSent,
    textEn,
    textDe,
    searchText: buildSearchText(textEn, textDe, textSent),
    hasMedia: existing.hasMedia === true || incoming.hasMedia === true,
    isPpv: existing.isPpv === true || incoming.isPpv === true || kind === 'ppv',
    priceNet: incoming.priceNet != null ? incoming.priceNet : existing.priceNet,
    currency: incoming.currency || existing.currency || null,
    mediaJson: incoming.mediaJson || existing.mediaJson || null,
    sentAt: incoming.sentAt || existing.sentAt,
    deletedAt: existing.deletedAt || incoming.deletedAt || null,
    translationStatus,
  };
}

function mapMaloumMessage(message, context = {}) {
  if (!message || message._id == null || message._id === '') return null;
  const content = message.content && typeof message.content === 'object' ? message.content : {};
  const priceNetRaw = content.price && typeof content.price === 'object' ? content.price.net : content.priceNet;
  const priceNet = Number(priceNetRaw);
  const hasPrice = Number.isFinite(priceNet) && priceNet > 0;
  const media = mediaEntries(content.media, ['uploadId', 'mediaId', 'id', '_id'], 'type');
  const outbound = sameParty(message.senderId, context.providerUserId);
  return {
    platformMessageId: String(message._id),
    direction: outbound ? 'outbound' : 'inbound',
    senderRole: outbound ? 'creator' : 'fan',
    kind: message.isBroadcasted ? 'mass' : hasPrice ? 'ppv' : 'dm',
    textSent: textValue(content.text),
    hasMedia: Boolean(media),
    isPpv: hasPrice,
    priceNet: hasPrice ? priceNet : null,
    currency: textValue(content.price?.currency) || (hasPrice ? 'EUR' : null),
    mediaJson: media,
    sentAt: message.sentAt || message.createdAt,
    deletedAt: message.domxUnsent ? new Date().toISOString() : null,
  };
}

function mapFourBasedMessage(message, context = {}) {
  if (!message || message._id == null || message._id === '') return null;
  const stack = message.file_stack && typeof message.file_stack === 'object' ? message.file_stack : null;
  const coins = Number(stack?.price);
  const priceNet = Number.isFinite(coins) && coins > 0 ? Math.round((coins / COINS_PER_DOLLAR) * 100) / 100 : null;
  const outbound = sameParty(message.user_id, context.providerUserId);
  const media = message.file_stack_id || stack
    ? [{ id: message.file_stack_id ? String(message.file_stack_id) : null, type: 'media' }]
    : null;
  return {
    platformMessageId: String(message._id),
    direction: outbound ? 'outbound' : 'inbound',
    senderRole: outbound ? 'creator' : 'fan',
    kind: priceNet ? 'ppv' : 'dm',
    textSent: textValue(message.message),
    hasMedia: Boolean(media),
    isPpv: Boolean(priceNet),
    priceNet,
    currency: priceNet ? 'USD' : null,
    mediaJson: media,
    sentAt: message.created_at || message.createdAt,
    deletedAt: null,
  };
}

function mapFanslyMessage(message, context = {}) {
  if (!message || message.id == null || message.id === '') return null;
  const locked = Array.isArray(message.lockedText) ? message.lockedText : [];
  const media = Array.isArray(message.media) ? message.media : [];
  const parts = [];
  const content = textValue(message.content);
  if (content) parts.push(content);
  for (const row of locked) {
    const lockedContent = textValue(row?.content);
    if (lockedContent) parts.push(lockedContent);
  }
  const prices = [
    ...media.map((item) => Number(item?.price)),
    ...locked.map((item) => Number(item?.price)),
  ].filter((price) => Number.isFinite(price) && price > 0);
  const priceNet = prices.length > 0 ? prices[0] : null;
  const outbound = sameParty(message.senderId, context.providerUserId);
  const mediaJson = mediaEntries(media, ['mediaId', 'id'], 'kind');
  return {
    platformMessageId: String(message.id),
    direction: outbound ? 'outbound' : 'inbound',
    senderRole: outbound ? 'creator' : 'fan',
    kind: priceNet ? 'ppv' : 'dm',
    textSent: parts.join('\n'),
    hasMedia: media.length > 0 || (Array.isArray(message.attachments) && message.attachments.length > 0),
    isPpv: Boolean(priceNet),
    priceNet,
    currency: priceNet ? 'USD' : null,
    mediaJson,
    sentAt: message.createdAt,
    deletedAt: parseDeletedAt(message.deletedAt),
    skipTranslation: true,
  };
}

function mapTelegramMessage(message) {
  if (!message || message.id == null || message.id === '') return null;
  const caption = textValue(message.text);
  const placeholder = textValue(message.placeholder);
  const textSent = caption || placeholder;
  const outbound = message.isOutgoing === true;
  return {
    platformMessageId: String(message.id),
    direction: outbound ? 'outbound' : 'inbound',
    senderRole: outbound ? 'creator' : 'fan',
    kind: 'dm',
    textSent,
    hasMedia: message.hasMedia === true || Boolean(placeholder),
    isPpv: false,
    priceNet: null,
    currency: null,
    mediaJson: message.hasMedia || placeholder
      ? [{ id: String(message.id), type: textValue(message.kind) || 'media' }]
      : null,
    sentAt: message.date,
    deletedAt: message.deleted ? new Date().toISOString() : null,
    skipTranslation: !caption && TELEGRAM_PLACEHOLDERS.has(placeholder),
  };
}

function mapPlatformMessage(platform, message, context) {
  if (platform === 'maloum') return mapMaloumMessage(message, context);
  if (platform === '4based') return mapFourBasedMessage(message, context);
  if (platform === 'fansly') return mapFanslyMessage(message, context);
  if (platform === 'telegram') return mapTelegramMessage(message);
  return null;
}

async function archiveThread(input) {
  const creatorId = input?.creatorId;
  const platform = input?.platform;
  const platformChatId = input?.platformChatId == null ? '' : String(input.platformChatId).trim();
  if (!creatorId || !PLATFORMS.has(platform) || !platformChatId) return null;

  const seen = new Set();
  const messages = [];
  for (const message of input.messages || []) {
    if (!message || message.platformMessageId == null || message.platformMessageId === '') continue;
    const id = String(message.platformMessageId);
    if (seen.has(id)) continue;
    seen.add(id);
    messages.push(finalizeMessage(message, platform));
  }
  if (messages.length === 0) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversation = await client.query(
      `INSERT INTO fan_conversations (
         "creatorId", platform, "platformChatId", "platformFanId", "fanUsername", "fanLabel"
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("creatorId", platform, "platformChatId") DO UPDATE SET
         "platformFanId" = COALESCE(NULLIF(EXCLUDED."platformFanId", ''), fan_conversations."platformFanId"),
         "fanUsername" = COALESCE(NULLIF(EXCLUDED."fanUsername", ''), fan_conversations."fanUsername"),
         "fanLabel" = CASE
           WHEN NULLIF(EXCLUDED."fanLabel", '') IS NOT NULL THEN EXCLUDED."fanLabel"
           ELSE fan_conversations."fanLabel"
         END,
         "updatedAt" = NOW()
       RETURNING id`,
      [
        creatorId,
        platform,
        platformChatId,
        textValue(input.platformFanId),
        textValue(input.fanUsername) || null,
        textValue(input.fanLabel),
      ]
    );
    const conversationId = conversation.rows[0].id;
    const existingResult = await client.query(
      `SELECT "platformMessageId", direction, "senderRole", "chatterId", "chatterName",
              kind, "textSent", "textEn", "textDe", "hasMedia", "isPpv", "priceNet",
              currency, "mediaJson", "sentAt", "deletedAt", "translationStatus"
       FROM fan_messages
       WHERE "conversationId" = $1 AND "platformMessageId" = ANY($2::text[])`,
      [conversationId, messages.map((message) => message.platformMessageId)]
    );
    const existingById = new Map(existingResult.rows.map((row) => [row.platformMessageId, row]));

    for (const message of messages) {
      const merged = mergeArchiveMessage(existingById.get(message.platformMessageId), message);
      await client.query(
        `INSERT INTO fan_messages (
           "conversationId", "platformMessageId", direction, "senderRole", "chatterId", "chatterName",
           kind, "textSent", "textEn", "textDe", "searchText", "hasMedia", "isPpv", "priceNet",
           currency, "mediaJson", "sentAt", "deletedAt", "translationStatus"
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16::jsonb, $17, $18, $19
         )
         ON CONFLICT ("conversationId", "platformMessageId") DO UPDATE SET
           direction = EXCLUDED.direction,
           "senderRole" = EXCLUDED."senderRole",
           "chatterId" = COALESCE(EXCLUDED."chatterId", fan_messages."chatterId"),
           "chatterName" = COALESCE(NULLIF(EXCLUDED."chatterName", ''), fan_messages."chatterName"),
           kind = CASE
             WHEN fan_messages.kind = 'mass' OR EXCLUDED.kind = 'mass' THEN 'mass'
             WHEN fan_messages.kind = 'ppv' OR EXCLUDED.kind = 'ppv' THEN 'ppv'
             ELSE EXCLUDED.kind
           END,
           "textSent" = CASE
             WHEN EXCLUDED."textSent" <> '' THEN EXCLUDED."textSent"
             ELSE fan_messages."textSent"
           END,
           "textEn" = CASE
             WHEN EXCLUDED."translationStatus" = 'done' THEN EXCLUDED."textEn"
             WHEN fan_messages."translationStatus" = 'done' THEN fan_messages."textEn"
             ELSE COALESCE(fan_messages."textEn", EXCLUDED."textEn")
           END,
           "textDe" = CASE
             WHEN EXCLUDED."translationStatus" = 'done' THEN EXCLUDED."textDe"
             WHEN fan_messages."translationStatus" = 'done' THEN fan_messages."textDe"
             ELSE COALESCE(fan_messages."textDe", EXCLUDED."textDe")
           END,
           "translationStatus" = CASE
             WHEN EXCLUDED."translationStatus" = 'done' THEN 'done'
             WHEN fan_messages."translationStatus" = 'done' THEN 'done'
             WHEN fan_messages."translationStatus" = 'skipped' AND EXCLUDED."translationStatus" = 'pending'
               THEN 'skipped'
             ELSE EXCLUDED."translationStatus"
           END,
           "searchText" = fan_archive_search_text(
             CASE
               WHEN EXCLUDED."translationStatus" = 'done' THEN EXCLUDED."textEn"
               WHEN fan_messages."translationStatus" = 'done' THEN fan_messages."textEn"
               ELSE COALESCE(fan_messages."textEn", EXCLUDED."textEn")
             END,
             CASE
               WHEN EXCLUDED."translationStatus" = 'done' THEN EXCLUDED."textDe"
               WHEN fan_messages."translationStatus" = 'done' THEN fan_messages."textDe"
               ELSE COALESCE(fan_messages."textDe", EXCLUDED."textDe")
             END,
             CASE
               WHEN EXCLUDED."textSent" <> '' THEN EXCLUDED."textSent"
               ELSE fan_messages."textSent"
             END
           ),
           "hasMedia" = fan_messages."hasMedia" OR EXCLUDED."hasMedia",
           "isPpv" = fan_messages."isPpv" OR EXCLUDED."isPpv",
           "priceNet" = COALESCE(EXCLUDED."priceNet", fan_messages."priceNet"),
           currency = COALESCE(EXCLUDED.currency, fan_messages.currency),
           "mediaJson" = COALESCE(EXCLUDED."mediaJson", fan_messages."mediaJson"),
           "sentAt" = COALESCE(EXCLUDED."sentAt", fan_messages."sentAt"),
           "deletedAt" = COALESCE(fan_messages."deletedAt", EXCLUDED."deletedAt")`,
        [
          conversationId,
          merged.platformMessageId,
          merged.direction,
          merged.senderRole,
          merged.chatterId,
          merged.chatterName,
          merged.kind,
          merged.textSent,
          merged.textEn,
          merged.textDe,
          merged.searchText,
          merged.hasMedia,
          merged.isPpv,
          Number.isFinite(merged.priceNet) ? merged.priceNet : null,
          merged.currency,
          merged.mediaJson ? JSON.stringify(merged.mediaJson) : null,
          merged.sentAt,
          merged.deletedAt,
          merged.translationStatus,
        ]
      );
    }

    await client.query(
      `UPDATE fan_conversations
       SET "messageCount" = (
             SELECT COUNT(*)::int FROM fan_messages WHERE "conversationId" = $1
           ),
           "lastMessageAt" = (
             SELECT MAX("sentAt") FROM fan_messages WHERE "conversationId" = $1
           ),
           "lastMessagePreview" = COALESCE((
             SELECT left(COALESCE(NULLIF("textSent", ''), NULLIF("textEn", ''), ''), 180)
             FROM fan_messages
             WHERE "conversationId" = $1
             ORDER BY "sentAt" DESC NULLS LAST
             LIMIT 1
           ), ''),
           "updatedAt" = NOW()
       WHERE id = $1`,
      [conversationId]
    );
    await client.query('COMMIT');
    return conversationId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function archiveInBackground(input) {
  void archiveThread(input).catch((err) => {
    console.warn('[fanChatArchive]', err.message);
  });
}

function dedupedRawMessages(rawMessages) {
  const seen = new Set();
  const rows = [];
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  for (const message of list) {
    if (!message) continue;
    const id = message._id != null ? message._id : message.id;
    const key = id == null ? '' : String(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(message);
  }
  return rows;
}

function scheduleHistoryArchive(input) {
  if (!input || !PLATFORMS.has(input.platform)) return;
  const messages = [];
  for (const raw of dedupedRawMessages(input.rawMessages)) {
    const mapped = mapPlatformMessage(input.platform, raw, input);
    if (mapped) messages.push(mapped);
  }
  if (messages.length === 0) return;
  archiveInBackground({
    creatorId: input.creatorId,
    platform: input.platform,
    platformChatId: input.platformChatId,
    platformFanId: input.platformFanId,
    fanUsername: input.fanUsername,
    fanLabel: input.fanLabel,
    messages,
  });
}

function scheduleSentArchive(input) {
  if (!input || !PLATFORMS.has(input.platform)) return;
  const rawMessages = dedupedRawMessages(
    input.rawMessages || (input.rawMessage ? [input.rawMessage] : [])
  );
  const messages = [];
  let attachedEnglish = false;
  const englishDraft = textValue(input.englishDraft);
  for (const raw of rawMessages) {
    const mapped = mapPlatformMessage(input.platform, raw, input);
    if (!mapped) continue;
    mapped.direction = 'outbound';
    mapped.senderRole = 'creator';
    if (input.chatter?.id) {
      mapped.chatterId = input.chatter.id;
      mapped.chatterName = input.chatter.name || null;
    }
    const priceNet = Number(input.priceNet);
    if (Number.isFinite(priceNet) && priceNet > 0) {
      mapped.isPpv = true;
      mapped.priceNet = priceNet;
      mapped.currency = input.currency || mapped.currency;
      if (mapped.kind !== 'mass') mapped.kind = 'ppv';
    }
    if (!attachedEnglish && englishDraft && (mapped.textSent || rawMessages.length === 1)) {
      mapped.englishDraft = englishDraft;
      attachedEnglish = true;
    }
    messages.push(mapped);
  }
  if (!attachedEnglish && englishDraft && messages[0]) {
    messages[0].englishDraft = englishDraft;
  }
  if (messages.length === 0) return;
  archiveInBackground({
    creatorId: input.creatorId,
    platform: input.platform,
    platformChatId: input.platformChatId,
    platformFanId: input.platformFanId,
    fanUsername: input.fanUsername,
    fanLabel: input.fanLabel,
    messages,
  });
}

async function markArchivedMessageDeleted({
  creatorId,
  platform,
  platformChatId,
  platformMessageId,
  originalText,
  messageSentAt,
  chatter,
}) {
  const messageId = platformMessageId == null ? '' : String(platformMessageId).trim();
  const chatId = platformChatId == null ? '' : String(platformChatId).trim();
  if (!creatorId || !PLATFORMS.has(platform) || !chatId || !messageId) return;

  const updated = await pool.query(
    `UPDATE fan_messages AS m
     SET "deletedAt" = COALESCE(m."deletedAt", NOW())
     FROM fan_conversations AS c
     WHERE m."conversationId" = c.id
       AND c."creatorId" = $1
       AND c.platform = $2
       AND c."platformChatId" = $3
       AND m."platformMessageId" = $4`,
    [creatorId, platform, chatId, messageId]
  );
  if (updated.rowCount > 0) return;

  const text = textValue(originalText);
  const fansly = platform === 'fansly';
  await archiveThread({
    creatorId,
    platform,
    platformChatId: chatId,
    messages: [
      {
        prepared: true,
        platformMessageId: messageId,
        direction: 'outbound',
        senderRole: 'creator',
        chatterId: chatter?.id || null,
        chatterName: chatter?.name || null,
        kind: 'dm',
        textSent: text,
        textEn: fansly ? text || null : null,
        textDe: null,
        translationStatus: !fansly && text ? 'pending' : 'skipped',
        sentAt: messageSentAt || new Date().toISOString(),
        deletedAt: new Date().toISOString(),
      },
    ],
  });
}

function markArchivedMessageDeletedInBackground(input) {
  void markArchivedMessageDeleted(input).catch((err) => {
    console.warn('[fanChatArchive] delete:', err.message);
  });
}

function splitPendingByWindow(rows, limit = ARCHIVE_TRANSLATE_WINDOW) {
  const cap = Number(limit);
  const translate = [];
  const skip = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!row || row.translationStatus !== 'pending') continue;
    if (!textValue(row.textSent)) continue;
    const rank = Number(row.rn);
    if (Number.isFinite(cap) && cap > 0 && Number.isFinite(rank) && rank >= 1 && rank <= cap) {
      translate.push(row);
    } else {
      skip.push(row);
    }
  }
  return { translate, skip };
}

async function translateDeToEn(text) {
  return textValue(await translateDeToEnGoogle(text));
}

async function loadPendingArchiveRanks() {
  const pending = await pool.query(
    `SELECT m.id,
            m."textSent",
            m."capturedAt",
            m."translationStatus",
            ranked.rn
     FROM fan_messages m
     JOIN (
       SELECT id,
              row_number() OVER (
                PARTITION BY "conversationId"
                ORDER BY "sentAt" DESC NULLS LAST, id DESC
              ) AS rn
       FROM fan_messages
       WHERE btrim("textSent") <> ''
         AND "conversationId" IN (
           SELECT DISTINCT "conversationId"
           FROM fan_messages
           WHERE "translationStatus" = 'pending' AND btrim("textSent") <> ''
         )
     ) ranked ON ranked.id = m.id
     WHERE m."translationStatus" = 'pending' AND btrim(m."textSent") <> ''`
  );
  return pending.rows;
}

async function drainPendingTranslations() {
  if (draining) return;
  draining = true;
  try {
    const ranked = await loadPendingArchiveRanks();
    const { translate, skip } = splitPendingByWindow(ranked);
    if (skip.length > 0) {
      await pool.query(
        `UPDATE fan_messages
         SET "translationStatus" = 'skipped',
             "textEn" = "textSent",
             "searchText" = fan_archive_search_text("textSent", NULL, "textSent")
         WHERE id = ANY($1::uuid[]) AND "translationStatus" = 'pending'`,
        [skip.map((row) => row.id)]
      );
    }
    const batch = translate
      .slice()
      .sort((left, right) => {
        const leftAt = new Date(left.capturedAt).getTime() || 0;
        const rightAt = new Date(right.capturedAt).getTime() || 0;
        return leftAt - rightAt;
      })
      .slice(0, TRANSLATE_BATCH);
    for (const row of batch) {
      try {
        const translated = await translateDeToEn(row.textSent);
        if (!translated) continue;
        const fields = applyInboundTranslation(row.textSent, translated);
        await pool.query(
          `UPDATE fan_messages
           SET "textEn" = $2,
               "textDe" = $3,
               "translationStatus" = 'done',
               "searchText" = fan_archive_search_text($2, $3, "textSent")
           WHERE id = $1 AND "translationStatus" = 'pending'`,
          [row.id, fields.textEn, fields.textDe]
        );
      } catch (err) {
        console.warn('[fanChatArchive] translate:', err.message);
      }
    }
  } catch (err) {
    noteTickFailure('fanChatArchive', err);
    console.warn('[fanChatArchive] translate batch:', err.message);
  } finally {
    draining = false;
  }
}

function startFanChatArchiveWorker() {
  if (translateTimer) return;
  startHeartbeat('fanChatArchive');
  translateTimer = setInterval(() => {
    void drainPendingTranslations();
  }, TRANSLATE_INTERVAL_MS);
  if (typeof translateTimer.unref === 'function') translateTimer.unref();
}

module.exports = {
  ARCHIVE_TRANSLATE_WINDOW,
  applyLanguageFields,
  applyInboundTranslation,
  splitPendingByWindow,
  buildSearchText,
  mergeArchiveMessage,
  mapMaloumMessage,
  mapFourBasedMessage,
  mapFanslyMessage,
  mapTelegramMessage,
  archiveThread,
  archiveInBackground,
  scheduleHistoryArchive,
  scheduleSentArchive,
  markArchivedMessageDeleted,
  markArchivedMessageDeletedInBackground,
  startFanChatArchiveWorker,
};
