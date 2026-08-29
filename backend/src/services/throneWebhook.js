const { createPublicKey, verify } = require('crypto');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { emitToUsers } = require('./userEventBus');
const {
  ROLES_SEEING_ALL_CREATORS,
} = require('./creatorAccess');

const THRONE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPXbUfxh7XL4SYUVcfhmYMIbxvtR9E9LDd8gPJ1PwSD8=
-----END PUBLIC KEY-----`;

const THRONE_TIMESTAMP_MAX_SKEW_SEC = 300;
const DEFAULT_PUBLIC_API_URL = 'https://api.low7labs.cloud';

const thronePublicKey = createPublicKey(THRONE_PUBLIC_KEY_PEM);

function getPublicApiUrl() {
  const fromEnv = String(process.env.PUBLIC_API_URL || '')
    .trim()
    .replace(/\/+$/, '');
  return fromEnv || DEFAULT_PUBLIC_API_URL;
}

function getThroneWebhookUrl() {
  return `${getPublicApiUrl()}/api/webhooks/throne`;
}

let throneNotificationsReady = false;

async function ensureThroneNotificationsTable() {
  if (throneNotificationsReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS throne_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "eventId" TEXT NOT NULL UNIQUE,
      "eventType" TEXT NOT NULL,
      "throneCreatorId" TEXT,
      "throneCreatorUsername" TEXT,
      "gifterUsername" TEXT,
      message TEXT,
      "itemName" TEXT,
      "itemThumbnailUrl" TEXT,
      amount NUMERIC,
      currency TEXT,
      "isSurpriseGift" BOOLEAN,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      "isRead" BOOLEAN NOT NULL DEFAULT false,
      "claimedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
      "claimedByUserName" TEXT,
      "claimedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_throne_notifications_created
      ON throne_notifications ("createdAt" DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_throne_notifications_unread
      ON throne_notifications ("isRead")
      WHERE "isRead" = false
  `);
  throneNotificationsReady = true;
}

function minorToMajor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n) / 100;
}

function asTrimmedString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function dashboardMessageId(eventId) {
  return `throne:${eventId}`;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    throneCreatorId: row.throneCreatorId || null,
    throneCreatorUsername: row.throneCreatorUsername || null,
    gifterUsername: row.gifterUsername || null,
    message: row.message || null,
    itemName: row.itemName || null,
    itemThumbnailUrl: row.itemThumbnailUrl || null,
    amount: row.amount != null ? Number(row.amount) : null,
    currency: row.currency || null,
    isSurpriseGift: row.isSurpriseGift === true,
    isRead: row.isRead === true,
    claimedByUserId: row.claimedByUserId || null,
    claimedByUserName: row.claimedByUserName || null,
    claimedAt: toIso(row.claimedAt),
    createdAt: toIso(row.createdAt),
  };
}

function verifyThroneWebhook(rawBody, timestamp, signatureHex) {
  if (!timestamp || !/^\d+$/.test(String(timestamp))) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const ts = Number(timestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > THRONE_TIMESTAMP_MAX_SKEW_SEC) {
    return { ok: false, reason: 'timestamp_skew' };
  }
  if (!signatureHex || typeof signatureHex !== 'string') {
    return { ok: false, reason: 'invalid_signature' };
  }
  let signature;
  try {
    signature = Buffer.from(signatureHex, 'hex');
  } catch {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (signature.length !== 64) {
    return { ok: false, reason: 'invalid_signature' };
  }
  const body = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ''), 'utf8');
  const message = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
  try {
    const ok = verify(null, message, thronePublicKey, signature);
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

function parseEventPayload(rawBody) {
  const text = Buffer.isBuffer(rawBody)
    ? rawBody.toString('utf8')
    : String(rawBody || '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'invalid_json' };
  }
  const eventId = asTrimmedString(parsed.event_id);
  const eventType = asTrimmedString(parsed.event_type);
  if (!eventId || !eventType) {
    return { error: 'missing_event' };
  }
  const data =
    parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      ? parsed.data
      : {};
  const priceMinor =
    eventType === 'contribution_purchased' ? data.amount : data.price;
  return {
    eventId,
    eventType,
    data,
    payload: parsed,
    throneCreatorId: asTrimmedString(data.creator_id),
    throneCreatorUsername: asTrimmedString(data.creator_username),
    gifterUsername: asTrimmedString(data.gifter_username),
    message: asTrimmedString(data.message),
    itemName: asTrimmedString(data.item_name),
    itemThumbnailUrl: asTrimmedString(data.item_thumbnail_url),
    amount: minorToMajor(priceMinor),
    currency: asTrimmedString(data.currency)
      ? String(data.currency).trim().toUpperCase()
      : null,
    isSurpriseGift: data.is_surprise_gift === true,
  };
}

function buildEnglishMessage(event) {
  const item = event.itemName || 'gift';
  const gifter = event.gifterUsername || 'Someone';
  if (event.eventType === 'contribution_purchased') {
    return event.message
      ? `${gifter} contributed to ${item}: ${event.message}`
      : `${gifter} contributed to ${item}`;
  }
  if (event.eventType === 'gift_crowdfunded') {
    return `${item} was fully funded`;
  }
  return event.message
    ? `${gifter} bought ${item}: ${event.message}`
    : `${gifter} bought ${item}`;
}

async function getUserIdsForThroneFeed() {
  const [assigned, managers] = await Promise.all([
    pool.query(
      `SELECT DISTINCT a."userId"
       FROM creator_staff_assignments a
       JOIN creators c ON c.id = a."creatorId"
       WHERE c.platform = 'telegram'`
    ),
    pool.query(
      `SELECT id FROM users
       WHERE status = 'active' AND role = ANY($1::text[])`,
      [ROLES_SEEING_ALL_CREATORS]
    ),
  ]);
  return [
    ...new Set([
      ...assigned.rows.map((row) => row.userId),
      ...managers.rows.map((row) => row.id),
    ]),
  ];
}

async function emitThroneEvent(eventName, notification) {
  try {
    const userIds = await getUserIdsForThroneFeed();
    emitToUsers(userIds, {
      type: 'telegram:throne',
      event: eventName,
      notification,
    });
  } catch (err) {
    console.warn('[throne] SSE relay failed', err.message || err);
  }
}

async function insertDashboardTip(event, sentAt) {
  const maloumMessageId = dashboardMessageId(event.eventId);
  const chatId = event.throneCreatorId
    ? `throne:${event.throneCreatorId}`
    : 'throne:gift';
  const creatorName = event.throneCreatorUsername || 'Throne';
  const sentAtDate =
    sentAt instanceof Date && !Number.isNaN(sentAt.getTime())
      ? sentAt
      : new Date();
  await pool.query(
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
      "optimisticMessageId",
      "contentType",
      "englishMessage",
      "germanTranslatedMessage",
      "actualSentText",
      "priceNet",
      currency,
      purchased,
      "mediaCount",
      "pictureCount",
      "videoCount",
      "mediaJson",
      "previousFanMessageAt",
      "responseTimeSeconds",
      "sentAt"
    ) VALUES (
      $1, NULL, $2, $3, NULL, 'telegram',
      NULL, 'Throne', NULL, $4,
      NULL, $5, $6, NULL, 'tip',
      $7, NULL, NULL, $8, $9,
      true, 0, 0, 0, NULL, NULL, NULL, $10
    )
    ON CONFLICT ("maloumMessageId") DO NOTHING`,
    [
      randomUUID(),
      creatorName,
      event.throneCreatorUsername,
      chatId,
      event.gifterUsername,
      maloumMessageId,
      buildEnglishMessage(event),
      event.amount,
      event.currency || 'USD',
      sentAtDate.toISOString(),
    ]
  );
}

async function ingestThroneWebhook(rawBody, timestamp, signatureHex) {
  await ensureThroneNotificationsTable();
  const verified = verifyThroneWebhook(rawBody, timestamp, signatureHex);
  if (!verified.ok) {
    return { status: 401, body: { error: 'Invalid webhook signature' } };
  }

  const parsed = parseEventPayload(rawBody);
  if (parsed.error) {
    return { status: 400, body: { error: 'Invalid webhook payload' } };
  }

  const existing = await pool.query(
    `SELECT * FROM throne_notifications WHERE "eventId" = $1`,
    [parsed.eventId]
  );
  if (existing.rows[0]) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, id: existing.rows[0].id },
    };
  }

  const inserted = await pool.query(
    `INSERT INTO throne_notifications (
      "eventId",
      "eventType",
      "throneCreatorId",
      "throneCreatorUsername",
      "gifterUsername",
      message,
      "itemName",
      "itemThumbnailUrl",
      amount,
      currency,
      "isSurpriseGift",
      payload
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
    )
    ON CONFLICT ("eventId") DO NOTHING
    RETURNING *`,
    [
      parsed.eventId,
      parsed.eventType,
      parsed.throneCreatorId,
      parsed.throneCreatorUsername,
      parsed.gifterUsername,
      parsed.message,
      parsed.itemName,
      parsed.itemThumbnailUrl,
      parsed.amount,
      parsed.currency,
      parsed.isSurpriseGift,
      JSON.stringify(parsed.payload),
    ]
  );

  if (inserted.rows.length === 0) {
    const again = await pool.query(
      `SELECT id FROM throne_notifications WHERE "eventId" = $1`,
      [parsed.eventId]
    );
    return {
      status: 200,
      body: { ok: true, duplicate: true, id: again.rows[0]?.id || null },
    };
  }

  const notification = toNotification(inserted.rows[0]);
  const sentAt = new Date(Number(timestamp) * 1000);
  try {
    await insertDashboardTip(parsed, sentAt);
  } catch (err) {
    console.warn('[throne] Dashboard insert failed', err.message || err);
  }
  void emitThroneEvent('created', notification);

  return { status: 200, body: { ok: true, id: notification.id } };
}

async function listNotifications({ limit = 30, before } = {}) {
  await ensureThroneNotificationsTable();
  const parsedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const values = [];
  let where = '';
  if (before) {
    const date = new Date(before);
    if (Number.isNaN(date.getTime())) {
      return { error: 'Invalid before cursor', status: 400 };
    }
    values.push(date.toISOString());
    where = `WHERE "createdAt" < $1`;
  }
  values.push(parsedLimit + 1);
  const limitParam = `$${values.length}`;
  const result = await pool.query(
    `SELECT * FROM throne_notifications
     ${where}
     ORDER BY "createdAt" DESC
     LIMIT ${limitParam}`,
    values
  );
  const hasMore = result.rows.length > parsedLimit;
  const rows = hasMore ? result.rows.slice(0, parsedLimit) : result.rows;
  const last = rows[rows.length - 1];
  const next =
    hasMore && last?.createdAt
      ? new Date(last.createdAt).toISOString()
      : null;
  return {
    notifications: rows.map(toNotification),
    next,
    webhookUrl: getThroneWebhookUrl(),
  };
}

async function unreadCount() {
  await ensureThroneNotificationsTable();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM throne_notifications
     WHERE "isRead" = false`
  );
  return {
    unreadCount: result.rows[0]?.count || 0,
    webhookUrl: getThroneWebhookUrl(),
  };
}

async function markAllRead() {
  await ensureThroneNotificationsTable();
  await pool.query(
    `UPDATE throne_notifications SET "isRead" = true WHERE "isRead" = false`
  );
  return { ok: true };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

async function claimNotification(id, user) {
  await ensureThroneNotificationsTable();
  if (!user?.id) {
    return { status: 401, body: { error: 'Authentication required' } };
  }
  if (!isUuid(id)) {
    return { status: 400, body: { error: 'Invalid notification id' } };
  }

  const current = await pool.query(
    `SELECT * FROM throne_notifications WHERE id = $1`,
    [id]
  );
  if (!current.rows[0]) {
    return { status: 404, body: { error: 'Notification not found' } };
  }

  const existing = current.rows[0];
  if (existing.claimedByUserId) {
    if (existing.claimedByUserId === user.id) {
      return {
        status: 200,
        body: { notification: toNotification(existing) },
      };
    }
    return {
      status: 409,
      body: {
        error: `Already taken by ${existing.claimedByUserName || 'another chatter'}`,
        notification: toNotification(existing),
      },
    };
  }

  const claimed = await pool.query(
    `UPDATE throne_notifications
     SET "claimedByUserId" = $2,
         "claimedByUserName" = $3,
         "claimedAt" = NOW()
     WHERE id = $1 AND "claimedByUserId" IS NULL
     RETURNING *`,
    [id, user.id, user.name || 'Staff']
  );

  if (claimed.rows.length === 0) {
    const raced = await pool.query(
      `SELECT * FROM throne_notifications WHERE id = $1`,
      [id]
    );
    const row = raced.rows[0];
    if (row?.claimedByUserId === user.id) {
      return { status: 200, body: { notification: toNotification(row) } };
    }
    return {
      status: 409,
      body: {
        error: `Already taken by ${row?.claimedByUserName || 'another chatter'}`,
        notification: toNotification(row),
      },
    };
  }

  const notification = toNotification(claimed.rows[0]);
  await pool.query(
    `UPDATE messaging_dashboard_entries
     SET "chatterId" = $2,
         "chatterName" = $3,
         "chatterEmail" = $4,
         "updatedAt" = NOW()
     WHERE "maloumMessageId" = $1
       AND "chatterId" IS NULL`,
    [
      dashboardMessageId(existing.eventId),
      user.id,
      user.name || 'Staff',
      user.email || null,
    ]
  );
  void emitThroneEvent('claimed', notification);
  return { status: 200, body: { notification } };
}

module.exports = {
  getThroneWebhookUrl,
  verifyThroneWebhook,
  ingestThroneWebhook,
  listNotifications,
  unreadCount,
  markAllRead,
  claimNotification,
};
