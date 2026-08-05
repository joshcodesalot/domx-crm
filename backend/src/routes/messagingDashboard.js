const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  getUserIdsWithCreatorAccess,
  userCanAccessCreator,
} = require('../services/creatorAccess');
const { emitToUsers } = require('../services/userEventBus');
const {
  getAnalyticsScope,
  TRACKED_STAFF_ROLES,
} = require('../services/analyticsScope');
const {
  maskMoneyAmounts,
  maskDuration,
  maskPercent,
  maskCount,
} = require('../services/leaderboardMask');

const { requireElectronServiceKey } = require('../middleware/electronServiceKey');

/** UTC date when activity tracking shipped (v1.6.27). Used for rate metrics only. */
const ACTIVITY_METRICS_CUTOVER =
  process.env.ACTIVITY_METRICS_CUTOVER || '2026-08-04';

function ratePercent(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  return Math.round((n / d) * 10000) / 100;
}

function perHourRate(value, activeSeconds) {
  const hours = (Number(activeSeconds) || 0) / 3600;
  if (hours <= 0) return 0;
  return Math.round(((Number(value) || 0) / hours) * 100) / 100;
}

function revenuePerHourAmounts(amounts, activeSeconds) {
  const hours = (Number(activeSeconds) || 0) / 3600;
  if (hours <= 0 || !amounts || amounts.length === 0) {
    return [];
  }
  return amounts
    .map((item) => ({
      currency: item.currency,
      amount: Math.round(((Number(item.amount) || 0) / hours) * 100) / 100,
    }))
    .filter((item) => item.amount > 0);
}

function buildUtcDateRange(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

const router = express.Router();

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function toDashboardEntry(row) {
  return {
    id: row.id,
    creatorId: row.creatorId,
    creatorName: row.creatorName,
    creatorUsername: row.creatorUsername,
    creatorAvatarUrl: row.creatorAvatarUrl,
    platform: row.platform || null,
    chatterId: row.chatterId,
    chatterName: row.chatterName,
    chatterEmail: row.chatterEmail,
    chatId: row.chatId,
    fanId: row.fanId,
    fanUsername: row.fanUsername,
    maloumMessageId: row.maloumMessageId,
    optimisticMessageId: row.optimisticMessageId,
    contentType: row.contentType,
    englishMessage: row.englishMessage,
    germanTranslatedMessage: row.germanTranslatedMessage,
    actualSentText: row.actualSentText,
    priceNet: row.priceNet != null ? Number(row.priceNet) : null,
    currency: row.currency,
    purchased: row.purchased,
    mediaCount: row.mediaCount,
    pictureCount: row.pictureCount,
    videoCount: row.videoCount,
    mediaJson: row.mediaJson,
    previousFanMessageAt: row.previousFanMessageAt,
    responseTimeSeconds: row.responseTimeSeconds,
    chatterSalesTotal:
      row.chatterSalesTotal != null ? Number(row.chatterSalesTotal) : 0,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function enrichCreatorFields(creatorId) {
  const result = await pool.query(
    `SELECT "displayName", username, "avatarUrl"
     FROM creators
     WHERE id = $1`,
    [creatorId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    creatorName: row.displayName,
    creatorUsername: row.username,
    creatorAvatarUrl: row.avatarUrl,
  };
}

async function enrichChatterEmail(chatterId) {
  const result = await pool.query('SELECT email FROM users WHERE id = $1', [chatterId]);
  return result.rows[0]?.email || null;
}

function parsePriceNet(priceNet) {
  if (typeof priceNet === 'number' && Number.isFinite(priceNet)) {
    return priceNet;
  }
  if (typeof priceNet === 'string' && priceNet.trim() !== '') {
    const parsed = Number.parseFloat(priceNet);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function unlockSaleByMessageId({
  maloumMessageId,
  priceNet = null,
  notificationId = null,
} = {}) {
  if (!maloumMessageId || typeof maloumMessageId !== 'string') {
    return {
      updated: false,
      reason: 'maloumMessageId_required',
      maloumMessageId: maloumMessageId || null,
      notificationId,
    };
  }

  const existing = await pool.query(
    `SELECT purchased
     FROM messaging_dashboard_entries
     WHERE "maloumMessageId" = $1`,
    [maloumMessageId]
  );

  if (existing.rows.length === 0) {
    return {
      updated: false,
      reason: 'entry_not_found',
      maloumMessageId,
      notificationId,
    };
  }

  if (existing.rows[0].purchased) {
    return {
      updated: false,
      reason: 'already_purchased',
      maloumMessageId,
      notificationId,
    };
  }

  const parsedPriceNet = parsePriceNet(priceNet);

  const result = await pool.query(
    `UPDATE messaging_dashboard_entries
     SET purchased = true,
         "priceNet" = COALESCE("priceNet", $1),
         "updatedAt" = NOW()
     WHERE "maloumMessageId" = $2
       AND purchased = false
     RETURNING *`,
    [parsedPriceNet, maloumMessageId]
  );

  if (result.rows.length === 0) {
    return {
      updated: false,
      reason: 'already_purchased',
      maloumMessageId,
      notificationId,
    };
  }

  return {
    updated: true,
    entry: toDashboardEntry({
      ...result.rows[0],
      chatterSalesTotal: null,
    }),
    notificationId,
  };
}

async function resolveTipContext(creatorId, fanId) {
  if (fanId) {
    const fanRow = await pool.query(
      `SELECT "chatId", "chatterId", "chatterName", "chatterEmail"
       FROM messaging_dashboard_entries
       WHERE "creatorId" = $1 AND "fanId" = $2
       ORDER BY "sentAt" DESC
       LIMIT 1`,
      [creatorId, fanId]
    );
    if (fanRow.rows.length > 0) {
      return {
        chatId: fanRow.rows[0].chatId,
        chatterId: fanRow.rows[0].chatterId,
        chatterName: fanRow.rows[0].chatterName,
        chatterEmail: fanRow.rows[0].chatterEmail,
      };
    }
  }

  const creatorRow = await pool.query(
    `SELECT "chatId", "chatterId", "chatterName", "chatterEmail"
     FROM messaging_dashboard_entries
     WHERE "creatorId" = $1
     ORDER BY "sentAt" DESC
     LIMIT 1`,
    [creatorId]
  );
  if (creatorRow.rows.length > 0) {
    return {
      chatId: fanId ? `maloum-tip:${fanId}` : creatorRow.rows[0].chatId,
      chatterId: creatorRow.rows[0].chatterId,
      chatterName: creatorRow.rows[0].chatterName,
      chatterEmail: creatorRow.rows[0].chatterEmail,
    };
  }

  const staffRow = await pool.query(
    `SELECT u.id, u.name, u.email
     FROM creator_staff_assignments a
     JOIN users u ON u.id = a."userId"
     WHERE a."creatorId" = $1
     ORDER BY a."assignedAt" ASC
     LIMIT 1`,
    [creatorId]
  );
  if (staffRow.rows.length > 0) {
    return {
      chatId: fanId ? `maloum-tip:${fanId}` : `maloum-tip:${creatorId}`,
      chatterId: staffRow.rows[0].id,
      chatterName: staffRow.rows[0].name || 'Staff',
      chatterEmail: staffRow.rows[0].email || null,
    };
  }

  const adminRow = await pool.query(
    `SELECT id, name, email
     FROM users
     WHERE role = 'owner'
     ORDER BY "createdAt" ASC
     LIMIT 1`
  );
  if (adminRow.rows.length > 0) {
    return {
      chatId: fanId ? `maloum-tip:${fanId}` : `maloum-tip:${creatorId}`,
      chatterId: adminRow.rows[0].id,
      chatterName: adminRow.rows[0].name || 'System',
      chatterEmail: adminRow.rows[0].email || null,
    };
  }

  return null;
}

async function logTip({
  creatorId,
  fanId = null,
  fanUsername = null,
  maloumMessageId,
  priceNet = null,
  notificationId = null,
  createdAt = null,
  currency = 'EUR',
} = {}) {
  if (!creatorId || !isValidUuid(creatorId)) {
    return {
      updated: false,
      reason: 'creatorId_required',
      maloumMessageId: maloumMessageId || null,
      notificationId,
    };
  }

  if (!maloumMessageId || typeof maloumMessageId !== 'string') {
    return {
      updated: false,
      reason: 'maloumMessageId_required',
      maloumMessageId: maloumMessageId || null,
      notificationId,
    };
  }

  const existing = await pool.query(
    `SELECT *
     FROM messaging_dashboard_entries
     WHERE "maloumMessageId" = $1`,
    [maloumMessageId]
  );

  if (existing.rows.length > 0) {
    return {
      updated: false,
      reason: 'already_logged',
      entry: toDashboardEntry({
        ...existing.rows[0],
        chatterSalesTotal: null,
      }),
      maloumMessageId,
      notificationId,
    };
  }

  const enriched = await enrichCreatorFields(creatorId);
  if (!enriched) {
    return {
      updated: false,
      reason: 'creator_not_found',
      maloumMessageId,
      notificationId,
    };
  }

  const tipContext = await resolveTipContext(creatorId, fanId);
  if (!tipContext) {
    return {
      updated: false,
      reason: 'no_chatter_context',
      maloumMessageId,
      notificationId,
    };
  }

  const parsedPriceNet = parsePriceNet(priceNet);
  const sentAt =
    createdAt && !Number.isNaN(Date.parse(createdAt))
      ? new Date(createdAt).toISOString()
      : new Date().toISOString();

  const result = await pool.query(
    `INSERT INTO messaging_dashboard_entries (
      id,
      "creatorId",
      "creatorName",
      "creatorUsername",
      "creatorAvatarUrl",
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
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27
    )
    ON CONFLICT ("maloumMessageId") DO NOTHING
    RETURNING *`,
    [
      randomUUID(),
      creatorId,
      enriched.creatorName,
      enriched.creatorUsername,
      enriched.creatorAvatarUrl,
      tipContext.chatterId,
      tipContext.chatterName,
      tipContext.chatterEmail,
      tipContext.chatId,
      fanId,
      fanUsername,
      maloumMessageId,
      null,
      'tip',
      null,
      null,
      null,
      parsedPriceNet,
      typeof currency === 'string' && currency ? currency : 'EUR',
      true,
      0,
      0,
      0,
      null,
      null,
      null,
      sentAt,
    ]
  );

  if (result.rows.length === 0) {
    return {
      updated: false,
      reason: 'already_logged',
      maloumMessageId,
      notificationId,
    };
  }

  return {
    updated: true,
    entry: toDashboardEntry({
      ...result.rows[0],
      chatterSalesTotal: null,
    }),
    notificationId,
  };
}

async function processMaloumSaleAndTipNotifications(creatorId, notifications) {
  const list = Array.isArray(notifications) ? notifications : [];
  const results = [];

  for (const entry of list) {
    const type = entry?.type;
    const messageId = entry?.messageId ? String(entry.messageId) : null;
    const notificationId = entry?._id || entry?.id ? String(entry._id || entry.id) : null;

    if (!messageId) {
      continue;
    }

    if (type === 'CHAT_PRODUCT_SOLD') {
      const result = await unlockSaleByMessageId({
        maloumMessageId: messageId,
        priceNet: entry.net,
        notificationId,
      });
      results.push({ type, ...result });
      continue;
    }

    if (type === 'FAN_TIPPED') {
      const result = await logTip({
        creatorId,
        fanId: entry.fanId ? String(entry.fanId) : null,
        fanUsername: entry.fanUsername
          ? String(entry.fanUsername)
          : entry.fanNickname
            ? String(entry.fanNickname)
            : null,
        maloumMessageId: messageId,
        priceNet: entry.net,
        notificationId,
        createdAt: entry.createdAt || null,
      });
      results.push({ type, ...result });
    }
  }

  return results;
}

/** 4based coin amounts → USD (same divisor as chat UI: coins / 121). */
const FOURBASED_COINS_PER_DOLLAR = 121;

function fourBasedCoinsToDollars(coins) {
  const n = Number(coins);
  if (!Number.isFinite(n) || n === 0) return null;
  // 4based activity ledger often signs tip/sale credits as negative.
  return Math.abs(n) / FOURBASED_COINS_PER_DOLLAR;
}

function activityAmountDollars(entry) {
  // Sale activities often have process: null; price is on file_stack.price (coins).
  const amount =
    entry?.process?.amount ??
    entry?.process?.value ??
    entry?.amount ??
    entry?.file_stack?.price;
  return fourBasedCoinsToDollars(amount);
}

function activityCreatedAt(entry) {
  const raw = entry?.created_at || entry?.createdAt || null;
  if (!raw) return null;
  const normalized = typeof raw === 'string' ? raw.replace(' ', 'T') : raw;
  return Number.isNaN(Date.parse(normalized)) ? null : new Date(normalized).toISOString();
}

async function backfillEntryPriceNet(maloumMessageId, priceNet, notificationId = null) {
  const parsedPriceNet = parsePriceNet(priceNet);
  if (!maloumMessageId || parsedPriceNet == null) {
    return {
      updated: false,
      reason: 'nothing_to_backfill',
      maloumMessageId: maloumMessageId || null,
      notificationId,
    };
  }

  const result = await pool.query(
    `UPDATE messaging_dashboard_entries
     SET "priceNet" = COALESCE("priceNet", $1),
         purchased = true,
         "updatedAt" = NOW()
     WHERE "maloumMessageId" = $2
       AND ("priceNet" IS NULL OR purchased = false)
     RETURNING *`,
    [parsedPriceNet, maloumMessageId]
  );

  if (result.rows.length === 0) {
    return {
      updated: false,
      reason: 'nothing_to_backfill',
      maloumMessageId,
      notificationId,
    };
  }

  return {
    updated: true,
    reason: 'backfilled',
    entry: toDashboardEntry({
      ...result.rows[0],
      chatterSalesTotal: null,
    }),
    maloumMessageId,
    notificationId,
  };
}

const FOURBASED_SEND_ROW_BASE = `
  "creatorId" = $1
  AND "fanId" = $2
  AND "maloumMessageId" LIKE '4based:%'
  AND "maloumMessageId" NOT LIKE '4based-sale:%'
  AND "maloumMessageId" NOT LIKE '4based-tip:%'
`;

function fourBasedSendOrderSql(soldAtParam) {
  // Prefer real send logs (have message/media), then unpurchased, then closest to sale time.
  return `
    ORDER BY
      CASE
        WHEN COALESCE("englishMessage", '') <> '' OR COALESCE("mediaCount", 0) > 0 THEN 0
        ELSE 1
      END,
      CASE WHEN purchased = false THEN 0 ELSE 1 END,
      ABS(EXTRACT(EPOCH FROM ("sentAt" - ${soldAtParam}::timestamptz))) ASC,
      "sentAt" DESC
  `;
}

/**
 * Match a 4based sale activity to the original DomX PPV send log row.
 * Strategies: media ids → price+fan+time → single recent unpaid PPV for fan.
 */
async function findFourBasedSendRow({
  creatorId,
  fanId,
  vaultFileStackId = null,
  fileStackId = null,
  priceNet = null,
  soldAt = null,
} = {}) {
  if (!creatorId || !isValidUuid(creatorId) || !fanId) return null;

  const soldAtIso =
    soldAt && !Number.isNaN(Date.parse(soldAt))
      ? new Date(soldAt).toISOString()
      : new Date().toISOString();
  const windowStart = new Date(
    new Date(soldAtIso).getTime() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();
  // Allow small clock skew after sale timestamp.
  const windowEnd = new Date(
    new Date(soldAtIso).getTime() + 2 * 60 * 60 * 1000
  ).toISOString();

  // Strategy 1: media / file-stack ids stored on the send log.
  if (vaultFileStackId || fileStackId) {
    const values = [creatorId, fanId];
    const mediaConds = [];
    let paramIndex = 3;

    if (vaultFileStackId) {
      const vaultId = String(vaultFileStackId);
      mediaConds.push(`"mediaJson" @> $${paramIndex}::jsonb`);
      values.push(JSON.stringify([{ mediaId: vaultId }]));
      paramIndex += 1;
      mediaConds.push(`"mediaJson" @> $${paramIndex}::jsonb`);
      values.push(JSON.stringify([{ vaultFileStackId: vaultId }]));
      paramIndex += 1;
      mediaConds.push(`"mediaJson"::text LIKE $${paramIndex}`);
      values.push(`%${vaultId}%`);
      paramIndex += 1;
    }

    if (fileStackId) {
      const stackId = String(fileStackId);
      mediaConds.push(`"mediaJson" @> $${paramIndex}::jsonb`);
      values.push(JSON.stringify([{ fileStackId: stackId }]));
      paramIndex += 1;
      mediaConds.push(`"mediaJson"::text LIKE $${paramIndex}`);
      values.push(`%${stackId}%`);
      paramIndex += 1;
    }

    values.push(soldAtIso);
    const soldAtParam = `$${paramIndex}`;

    const byMedia = await pool.query(
      `SELECT *
       FROM messaging_dashboard_entries
       WHERE ${FOURBASED_SEND_ROW_BASE}
         AND (${mediaConds.join(' OR ')})
       ${fourBasedSendOrderSql(soldAtParam)}
       LIMIT 1`,
      values
    );
    if (byMedia.rows[0]) return byMedia.rows[0];
  }

  // Strategy 2: same fan + same price within a send window before the sale.
  const parsedPrice = parsePriceNet(priceNet);
  if (parsedPrice != null && parsedPrice > 0) {
    const byPrice = await pool.query(
      `SELECT *
       FROM messaging_dashboard_entries
       WHERE ${FOURBASED_SEND_ROW_BASE}
         AND "contentType" IN ('chat_product', 'media')
         AND "priceNet" IS NOT NULL
         AND ABS("priceNet"::numeric - $3::numeric) < 0.051
         AND "sentAt" >= $4::timestamptz
         AND "sentAt" <= $5::timestamptz
       ${fourBasedSendOrderSql('$6')}
       LIMIT 1`,
      [creatorId, fanId, parsedPrice, windowStart, windowEnd, soldAtIso]
    );
    if (byPrice.rows[0]) return byPrice.rows[0];
  }

  // Strategy 3: exactly one recent unpaid chat PPV for this fan.
  const unpaid = await pool.query(
    `SELECT *
     FROM messaging_dashboard_entries
     WHERE ${FOURBASED_SEND_ROW_BASE}
       AND "contentType" = 'chat_product'
       AND purchased = false
       AND "sentAt" >= $3::timestamptz
       AND "sentAt" <= $4::timestamptz
     ORDER BY "sentAt" DESC`,
    [creatorId, fanId, windowStart, windowEnd]
  );
  if (unpaid.rows.length === 1) return unpaid.rows[0];

  // Strategy 4: priced unpaid/paid send for fan in window when price unknown,
  // or single priced send in window (handles missing mediaJson on older logs).
  if (parsedPrice == null) {
    const recent = await pool.query(
      `SELECT *
       FROM messaging_dashboard_entries
       WHERE ${FOURBASED_SEND_ROW_BASE}
         AND "contentType" = 'chat_product'
         AND "sentAt" >= $3::timestamptz
         AND "sentAt" <= $4::timestamptz
         AND (
           COALESCE("englishMessage", '') <> ''
           OR COALESCE("mediaCount", 0) > 0
           OR "priceNet" IS NOT NULL
         )
       ${fourBasedSendOrderSql('$5')}
       LIMIT 2`,
      [creatorId, fanId, windowStart, windowEnd, soldAtIso]
    );
    if (recent.rows.length === 1) return recent.rows[0];
  }

  return null;
}

/**
 * Merge leftover orphan sale stubs into DomX send rows when activities
 * are no longer in the recent feed.
 */
async function repairFourBasedSaleOrphans(creatorId) {
  if (!creatorId || !isValidUuid(creatorId)) return [];

  const orphans = await pool.query(
    `SELECT *
     FROM messaging_dashboard_entries
     WHERE "creatorId" = $1
       AND "maloumMessageId" LIKE '4based-sale:%'
       AND COALESCE("mediaCount", 0) = 0
       AND COALESCE("englishMessage", '') = ''
     ORDER BY "sentAt" DESC
     LIMIT 100`,
    [creatorId]
  );

  const results = [];

  for (const orphan of orphans.rows) {
    const activityId = String(orphan.maloumMessageId || '').replace(
      /^4based-sale:/,
      ''
    );
    const fanId = orphan.fanId ? String(orphan.fanId) : null;
    if (!fanId || !activityId) continue;

    const priceNet =
      orphan.priceNet != null ? Number(orphan.priceNet) : null;
    const match = await findFourBasedSendRow({
      creatorId,
      fanId,
      priceNet: Number.isFinite(priceNet) ? priceNet : null,
      soldAt: orphan.sentAt || orphan.createdAt || null,
    });

    if (!match?.maloumMessageId) continue;

    const unlocked = await ensureFourBasedSaleUnlocked({
      maloumMessageId: match.maloumMessageId,
      priceNet: Number.isFinite(priceNet) ? priceNet : null,
      notificationId: activityId,
    });
    await deleteFourBasedSaleOrphan(activityId);
    results.push({
      type: 'sale_repair',
      ...unlocked,
      matchedMaloumMessageId: match.maloumMessageId,
      orphanMaloumMessageId: orphan.maloumMessageId,
    });
  }

  return results;
}

async function ensureFourBasedSaleUnlocked({
  maloumMessageId,
  priceNet = null,
  notificationId = null,
} = {}) {
  const unlock = await unlockSaleByMessageId({
    maloumMessageId,
    priceNet,
    notificationId,
  });

  if (unlock.updated) return unlock;

  if (unlock.reason === 'already_purchased') {
    const backfill = await backfillEntryPriceNet(
      maloumMessageId,
      priceNet,
      notificationId
    );
    if (backfill.updated) return backfill;
    return {
      ...unlock,
      maloumMessageId,
    };
  }

  return unlock;
}

async function deleteFourBasedSaleOrphan(activityId) {
  if (!activityId) return;
  await pool.query(
    `DELETE FROM messaging_dashboard_entries
     WHERE "maloumMessageId" = $1`,
    [`4based-sale:${activityId}`]
  );
}

async function logFourBasedSale({
  creatorId,
  fanId = null,
  fanUsername = null,
  maloumMessageId,
  priceNet = null,
  notificationId = null,
  createdAt = null,
} = {}) {
  if (!creatorId || !isValidUuid(creatorId)) {
    return {
      updated: false,
      reason: 'creatorId_required',
      maloumMessageId: maloumMessageId || null,
      notificationId,
    };
  }

  if (!maloumMessageId || typeof maloumMessageId !== 'string') {
    return {
      updated: false,
      reason: 'maloumMessageId_required',
      maloumMessageId: maloumMessageId || null,
      notificationId,
    };
  }

  const existing = await pool.query(
    `SELECT *
     FROM messaging_dashboard_entries
     WHERE "maloumMessageId" = $1`,
    [maloumMessageId]
  );

  if (existing.rows.length > 0) {
    const backfill = await backfillEntryPriceNet(
      maloumMessageId,
      priceNet,
      notificationId
    );
    if (backfill.updated) return backfill;

    return {
      updated: false,
      reason: 'already_logged',
      entry: toDashboardEntry({
        ...existing.rows[0],
        chatterSalesTotal: null,
      }),
      maloumMessageId,
      notificationId,
    };
  }

  const enriched = await enrichCreatorFields(creatorId);
  if (!enriched) {
    return {
      updated: false,
      reason: 'creator_not_found',
      maloumMessageId,
      notificationId,
    };
  }

  const tipContext = await resolveTipContext(creatorId, fanId);
  if (!tipContext) {
    return {
      updated: false,
      reason: 'no_chatter_context',
      maloumMessageId,
      notificationId,
    };
  }

  const parsedPriceNet = parsePriceNet(priceNet);
  const sentAt =
    createdAt && !Number.isNaN(Date.parse(createdAt))
      ? new Date(createdAt).toISOString()
      : new Date().toISOString();

  const chatId = fanId ? `4based-sale:${fanId}` : tipContext.chatId;

  const result = await pool.query(
    `INSERT INTO messaging_dashboard_entries (
      id,
      "creatorId",
      "creatorName",
      "creatorUsername",
      "creatorAvatarUrl",
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
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27
    )
    ON CONFLICT ("maloumMessageId") DO NOTHING
    RETURNING *`,
    [
      randomUUID(),
      creatorId,
      enriched.creatorName,
      enriched.creatorUsername,
      enriched.creatorAvatarUrl,
      tipContext.chatterId,
      tipContext.chatterName,
      tipContext.chatterEmail,
      chatId,
      fanId,
      fanUsername,
      maloumMessageId,
      null,
      'chat_product',
      null,
      null,
      null,
      parsedPriceNet,
      'USD',
      true,
      0,
      0,
      0,
      null,
      null,
      null,
      sentAt,
    ]
  );

  if (result.rows.length === 0) {
    return {
      updated: false,
      reason: 'already_logged',
      maloumMessageId,
      notificationId,
    };
  }

  return {
    updated: true,
    entry: toDashboardEntry({
      ...result.rows[0],
      chatterSalesTotal: null,
    }),
    notificationId,
  };
}

async function processFourBasedSaleAndTipNotifications(creatorId, activities) {
  const list = Array.isArray(activities) ? activities : [];
  const results = [];

  for (const entry of list) {
    const type = entry?.type ? String(entry.type) : null;
    const activityId = entry?._id || entry?.id ? String(entry._id || entry.id) : null;
    if (!activityId || !type) continue;

    const fanId = entry?.user_id || entry?.user?._id
      ? String(entry.user_id || entry.user._id)
      : null;
    const fanUsername =
      typeof entry?.user?.name === 'string' && entry.user.name.trim()
        ? entry.user.name.trim()
        : null;
    const priceNet = activityAmountDollars(entry);
    const createdAt = activityCreatedAt(entry);

    if (type === 'tip') {
      const result = await logTip({
        creatorId,
        fanId,
        fanUsername,
        maloumMessageId: `4based-tip:${activityId}`,
        priceNet,
        notificationId: activityId,
        createdAt,
        currency: 'USD',
      });
      results.push({ type, ...result });
      continue;
    }

    if (type === 'sale') {
      const vaultFileStackId = entry?.file_stack?.vault_file_stack_id
        ? String(entry.file_stack.vault_file_stack_id)
        : null;
      const fileStackId =
        entry?.file_stack_id || entry?.file_stack?._id
          ? String(entry.file_stack_id || entry.file_stack._id)
          : null;

      const match = await findFourBasedSendRow({
        creatorId,
        fanId,
        vaultFileStackId,
        fileStackId,
        priceNet,
        soldAt: createdAt,
      });

      if (match?.maloumMessageId) {
        const result = await ensureFourBasedSaleUnlocked({
          maloumMessageId: match.maloumMessageId,
          priceNet,
          notificationId: activityId,
        });
        // Drop orphan stub so Chatter Sales does not double-count.
        await deleteFourBasedSaleOrphan(activityId);
        results.push({
          type,
          ...result,
          matchedMaloumMessageId: match.maloumMessageId,
        });
        continue;
      }

      const result = await logFourBasedSale({
        creatorId,
        fanId,
        fanUsername,
        maloumMessageId: `4based-sale:${activityId}`,
        priceNet,
        notificationId: activityId,
        createdAt,
      });
      results.push({ type, ...result });
    }
  }

  try {
    const repaired = await repairFourBasedSaleOrphans(creatorId);
    results.push(...repaired);
  } catch (err) {
    console.warn('4based sale orphan repair failed:', err.message || err);
  }

  return results;
}

router.get(
  '/fan-stats',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { creatorId, chatId, fanId } = req.query;

    if (!creatorId || !isValidUuid(String(creatorId))) {
      return res.status(400).json({ error: 'Valid creatorId is required' });
    }

    const chatIdValue =
      typeof chatId === 'string' && chatId.trim() ? chatId.trim() : null;
    const fanIdValue =
      typeof fanId === 'string' && fanId.trim() ? fanId.trim() : null;

    if (!chatIdValue && !fanIdValue) {
      return res.status(400).json({ error: 'chatId or fanId is required' });
    }

    const allowed = await userCanAccessCreator(req.user, String(creatorId));
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }

    const conditions = ['"creatorId" = $1'];
    const values = [String(creatorId)];
    let paramIndex = 2;

    if (chatIdValue && fanIdValue) {
      conditions.push(`("chatId" = $${paramIndex} OR "fanId" = $${paramIndex + 1})`);
      values.push(chatIdValue, fanIdValue);
      paramIndex += 2;
    } else if (chatIdValue) {
      conditions.push(`"chatId" = $${paramIndex}`);
      values.push(chatIdValue);
      paramIndex += 1;
    } else {
      conditions.push(`"fanId" = $${paramIndex}`);
      values.push(fanIdValue);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const result = await pool.query(
      `SELECT
         id,
         "maloumMessageId",
         "contentType",
         "priceNet",
         currency,
         purchased,
         "mediaCount",
         "pictureCount",
         "videoCount",
         "mediaJson",
         "sentAt",
         "fanId",
         "fanUsername",
         "chatId"
       FROM messaging_dashboard_entries
       WHERE ${whereClause}
         AND "contentType" IN ('chat_product', 'tip')
       ORDER BY "sentAt" DESC
       LIMIT 500`,
      values
    );

    const ppvEntries = [];
    const tips = [];
    let unlockedCount = 0;
    let highestPrice = null;
    let lowestPrice = null;

    for (const row of result.rows) {
      const priceNet = row.priceNet != null ? Number(row.priceNet) : null;
      const messageId =
        typeof row.maloumMessageId === 'string' ? row.maloumMessageId : '';
      const chatId = typeof row.chatId === 'string' ? row.chatId : '';
      const isFourBased =
        messageId.startsWith('4based') || chatId.startsWith('4based');
      const currency =
        row.currency === 'USD' || row.currency === 'EUR'
          ? row.currency
          : isFourBased
            ? 'USD'
            : 'EUR';
      const absPriceNet =
        priceNet != null && Number.isFinite(priceNet) ? Math.abs(priceNet) : priceNet;

      if (row.contentType === 'tip') {
        tips.push({
          id: row.id,
          maloumMessageId: row.maloumMessageId,
          priceNet: absPriceNet,
          currency,
          sentAt: row.sentAt,
          fanId: row.fanId,
          fanUsername: row.fanUsername,
        });
        continue;
      }

      const entry = {
        id: row.id,
        maloumMessageId: row.maloumMessageId,
        priceNet: absPriceNet,
        currency,
        purchased: Boolean(row.purchased),
        mediaCount: row.mediaCount != null ? Number(row.mediaCount) : 0,
        pictureCount: row.pictureCount != null ? Number(row.pictureCount) : 0,
        videoCount: row.videoCount != null ? Number(row.videoCount) : 0,
        mediaJson: row.mediaJson,
        sentAt: row.sentAt,
      };
      ppvEntries.push(entry);

      if (entry.purchased) {
        unlockedCount += 1;
        if (absPriceNet != null && Number.isFinite(absPriceNet)) {
          if (highestPrice == null || absPriceNet > highestPrice) {
            highestPrice = absPriceNet;
          }
          if (lowestPrice == null || absPriceNet < lowestPrice) {
            lowestPrice = absPriceNet;
          }
        }
      }
    }

    const sentCount = ppvEntries.length;
    const ratePercent =
      sentCount > 0 ? Math.round((unlockedCount / sentCount) * 100) : 0;

    res.json({
      ppv: {
        sent: sentCount,
        unlocked: unlockedCount,
        ratePercent,
        highestPrice,
        lowestPrice,
      },
      ppvEntries,
      tips,
    });
  }
);

router.get(
  '/senders',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { creatorId, chatId, limit = '200' } = req.query;

    if (!creatorId || !isValidUuid(String(creatorId))) {
      return res.status(400).json({ error: 'Valid creatorId is required' });
    }

    if (!chatId || typeof chatId !== 'string' || !String(chatId).trim()) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    const allowed = await userCanAccessCreator(req.user, String(creatorId));
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }

    const parsedLimit = Math.min(
      Math.max(Number.parseInt(String(limit), 10) || 200, 1),
      500
    );

    const result = await pool.query(
      `SELECT "maloumMessageId", "optimisticMessageId", "chatterName"
       FROM messaging_dashboard_entries
       WHERE "creatorId" = $1 AND "chatId" = $2
       ORDER BY "sentAt" DESC
       LIMIT $3`,
      [creatorId, String(chatId), parsedLimit]
    );

    const senders = {};
    for (const row of result.rows) {
      if (row.maloumMessageId && row.chatterName) {
        senders[row.maloumMessageId] = row.chatterName;
      }
      if (row.optimisticMessageId && row.chatterName) {
        senders[row.optimisticMessageId] = row.chatterName;
      }
    }

    res.json({ senders });
  }
);

function currencyAmountRowsToList(rows) {
  return rows.map((row) => ({
    currency: String(row.currency || 'EUR').toUpperCase() === 'USD' ? 'USD' : 'EUR',
    amount: Number(row.amount) || 0,
  }));
}

function mergeCurrencyAmounts(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const currency = item.currency === 'USD' ? 'USD' : 'EUR';
      map.set(currency, (map.get(currency) || 0) + (Number(item.amount) || 0));
    }
  }
  return Array.from(map.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

router.get(
  '/overview',
  authenticate,
  requirePermission('analytics.view', 'analytics.self'),
  async (req, res) => {
    try {
      const scope = getAnalyticsScope(req.user);
      const { startDate, endDate } = req.query;

      let responseStart = null;
      let responseEnd = null;

      if (startDate) {
        const dateValue = String(startDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
          return res.status(400).json({ error: 'Invalid startDate' });
        }
        responseStart = dateValue;
      }

      if (endDate) {
        const dateValue = String(endDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
          return res.status(400).json({ error: 'Invalid endDate' });
        }
        responseEnd = dateValue;
      }

      // Default avg response window: last 30 days (UTC dates)
      if (!responseStart || !responseEnd) {
        const end = new Date();
        const start = new Date();
        start.setUTCDate(start.getUTCDate() - 30);
        responseEnd = responseEnd || end.toISOString().slice(0, 10);
        responseStart = responseStart || start.toISOString().slice(0, 10);
      }

      const chatterClause =
        scope.mode === 'self' ? ' AND "chatterId" = ANY($1::uuid[])' : '';
      const mChatterClause =
        scope.mode === 'self' ? ' AND m."chatterId" = ANY($1::uuid[])' : '';
      const selfParams = scope.mode === 'self' ? [scope.userIds] : [];

      const staffListQuery =
        scope.mode === 'team'
          ? pool.query(
              `SELECT u.id AS "chatterId", u.name AS "chatterName"
               FROM users u
               WHERE u.role = ANY($1::text[]) AND u.status = 'active'
               ORDER BY u.name ASC`,
              [TRACKED_STAFF_ROLES]
            )
          : pool.query(
              `SELECT u.id AS "chatterId", u.name AS "chatterName"
               FROM users u
               WHERE u.id = ANY($1::uuid[])
               ORDER BY u.name ASC`,
              [scope.userIds]
            );

      const [
        dailySalesResult,
        totalSalesResult,
        monthlySalesResult,
        avgResponseResult,
        dailyByDayResult,
        messageStatsResult,
        cutoverSalesResult,
        cutoverMessagesResult,
        chatterAvgResult,
        chatterSalesResult,
        chatterMessageStatsResult,
        chatterCutoverSalesResult,
        chatterCutoverMessagesResult,
        chatterNamesResult,
        keystrokesResult,
        chatterActiveResult,
      ] = await Promise.all([
        pool.query(
          `SELECT UPPER(COALESCE(NULLIF(TRIM(currency), ''), 'EUR')) AS currency,
                  COALESCE(SUM(ABS("priceNet")), 0)::float AS amount
           FROM messaging_dashboard_entries
           WHERE purchased = true
             AND "priceNet" IS NOT NULL
             AND ("sentAt" AT TIME ZONE 'UTC')::date = (NOW() AT TIME ZONE 'UTC')::date
             ${chatterClause}
           GROUP BY 1`,
          selfParams
        ),
        pool.query(
          `SELECT UPPER(COALESCE(NULLIF(TRIM(currency), ''), 'EUR')) AS currency,
                  COALESCE(SUM(ABS("priceNet")), 0)::float AS amount
           FROM messaging_dashboard_entries
           WHERE purchased = true
             AND "priceNet" IS NOT NULL
             ${chatterClause}
           GROUP BY 1`,
          selfParams
        ),
        pool.query(
          `SELECT UPPER(COALESCE(NULLIF(TRIM(currency), ''), 'EUR')) AS currency,
                  COALESCE(SUM(ABS("priceNet")), 0)::float AS amount
           FROM messaging_dashboard_entries
           WHERE purchased = true
             AND "priceNet" IS NOT NULL
             AND date_trunc('month', "sentAt" AT TIME ZONE 'UTC')
                 = date_trunc('month', NOW() AT TIME ZONE 'UTC')
             ${chatterClause}
           GROUP BY 1`,
          selfParams
        ),
        pool.query(
          scope.mode === 'self'
            ? `SELECT AVG("responseTimeSeconds")::float AS avg
               FROM messaging_dashboard_entries
               WHERE "responseTimeSeconds" IS NOT NULL
                 AND ("sentAt" AT TIME ZONE 'UTC')::date >= $2::date
                 AND ("sentAt" AT TIME ZONE 'UTC')::date <= $3::date
                 AND "chatterId" = ANY($1::uuid[])`
            : `SELECT AVG("responseTimeSeconds")::float AS avg
               FROM messaging_dashboard_entries
               WHERE "responseTimeSeconds" IS NOT NULL
                 AND ("sentAt" AT TIME ZONE 'UTC')::date >= $1::date
                 AND ("sentAt" AT TIME ZONE 'UTC')::date <= $2::date`,
          scope.mode === 'self'
            ? [scope.userIds, responseStart, responseEnd]
            : [responseStart, responseEnd]
        ),
        pool.query(
          scope.mode === 'self'
            ? `WITH days AS (
                 SELECT generate_series(
                   ((NOW() AT TIME ZONE 'UTC')::date - 13),
                   (NOW() AT TIME ZONE 'UTC')::date,
                   '1 day'::interval
                 )::date AS day
               )
               SELECT d.day::text AS date,
                      UPPER(COALESCE(NULLIF(TRIM(m.currency), ''), 'EUR')) AS currency,
                      COALESCE(SUM(ABS(m."priceNet")), 0)::float AS amount
               FROM days d
               LEFT JOIN messaging_dashboard_entries m
                 ON (m."sentAt" AT TIME ZONE 'UTC')::date = d.day
                AND m.purchased = true
                AND m."priceNet" IS NOT NULL
                AND m."chatterId" = ANY($1::uuid[])
               GROUP BY d.day, 2
               ORDER BY d.day ASC`
            : `WITH days AS (
                 SELECT generate_series(
                   ((NOW() AT TIME ZONE 'UTC')::date - 13),
                   (NOW() AT TIME ZONE 'UTC')::date,
                   '1 day'::interval
                 )::date AS day
               )
               SELECT d.day::text AS date,
                      UPPER(COALESCE(NULLIF(TRIM(m.currency), ''), 'EUR')) AS currency,
                      COALESCE(SUM(ABS(m."priceNet")), 0)::float AS amount
               FROM days d
               LEFT JOIN messaging_dashboard_entries m
                 ON (m."sentAt" AT TIME ZONE 'UTC')::date = d.day
                AND m.purchased = true
                AND m."priceNet" IS NOT NULL
               GROUP BY d.day, 2
               ORDER BY d.day ASC`,
          selfParams
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (
               WHERE "contentType" IN ('text', 'media', 'chat_product')
             )::int AS "messagesSent",
             COUNT(*) FILTER (WHERE "contentType" = 'chat_product')::int AS "ppvsSent",
             COUNT(*) FILTER (
               WHERE "contentType" = 'chat_product' AND purchased = true
             )::int AS "ppvsUnlocked"
           FROM messaging_dashboard_entries
           WHERE TRUE ${chatterClause}`,
          selfParams
        ),
        // Cutover revenue for per-hour rates only
        scope.mode === 'self'
          ? pool.query(
              `SELECT UPPER(COALESCE(NULLIF(TRIM(currency), ''), 'EUR')) AS currency,
                      COALESCE(SUM(ABS("priceNet")), 0)::float AS amount
               FROM messaging_dashboard_entries
               WHERE purchased = true
                 AND "priceNet" IS NOT NULL
                 AND ("sentAt" AT TIME ZONE 'UTC')::date >= $2::date
                 AND "chatterId" = ANY($1::uuid[])
               GROUP BY 1`,
              [scope.userIds, ACTIVITY_METRICS_CUTOVER]
            )
          : pool.query(
              `SELECT UPPER(COALESCE(NULLIF(TRIM(currency), ''), 'EUR')) AS currency,
                      COALESCE(SUM(ABS("priceNet")), 0)::float AS amount
               FROM messaging_dashboard_entries
               WHERE purchased = true
                 AND "priceNet" IS NOT NULL
                 AND ("sentAt" AT TIME ZONE 'UTC')::date >= $1::date
               GROUP BY 1`,
              [ACTIVITY_METRICS_CUTOVER]
            ),
        scope.mode === 'self'
          ? pool.query(
              `SELECT COUNT(*)::int AS "messagesSent"
               FROM messaging_dashboard_entries
               WHERE "contentType" IN ('text', 'media', 'chat_product')
                 AND ("sentAt" AT TIME ZONE 'UTC')::date >= $2::date
                 AND "chatterId" = ANY($1::uuid[])`,
              [scope.userIds, ACTIVITY_METRICS_CUTOVER]
            )
          : pool.query(
              `SELECT COUNT(*)::int AS "messagesSent"
               FROM messaging_dashboard_entries
               WHERE "contentType" IN ('text', 'media', 'chat_product')
                 AND ("sentAt" AT TIME ZONE 'UTC')::date >= $1::date`,
              [ACTIVITY_METRICS_CUTOVER]
            ),
        pool.query(
          scope.mode === 'self'
            ? `SELECT m."chatterId",
                      AVG(m."responseTimeSeconds")::float AS "avgResponseTimeSeconds"
               FROM messaging_dashboard_entries m
               WHERE m."responseTimeSeconds" IS NOT NULL
                 AND (m."sentAt" AT TIME ZONE 'UTC')::date >= $2::date
                 AND (m."sentAt" AT TIME ZONE 'UTC')::date <= $3::date
                 AND m."chatterId" = ANY($1::uuid[])
               GROUP BY m."chatterId"`
            : `SELECT m."chatterId",
                      AVG(m."responseTimeSeconds")::float AS "avgResponseTimeSeconds"
               FROM messaging_dashboard_entries m
               WHERE m."responseTimeSeconds" IS NOT NULL
                 AND (m."sentAt" AT TIME ZONE 'UTC')::date >= $1::date
                 AND (m."sentAt" AT TIME ZONE 'UTC')::date <= $2::date
               GROUP BY m."chatterId"`,
          scope.mode === 'self'
            ? [scope.userIds, responseStart, responseEnd]
            : [responseStart, responseEnd]
        ),
        pool.query(
          `SELECT m."chatterId",
                  UPPER(COALESCE(NULLIF(TRIM(m.currency), ''), 'EUR')) AS currency,
                  COALESCE(SUM(ABS(m."priceNet")) FILTER (
                    WHERE m.purchased = true
                      AND m."priceNet" IS NOT NULL
                      AND (m."sentAt" AT TIME ZONE 'UTC')::date = (NOW() AT TIME ZONE 'UTC')::date
                  ), 0)::float AS "dailySales",
                  COALESCE(SUM(ABS(m."priceNet")) FILTER (
                    WHERE m.purchased = true AND m."priceNet" IS NOT NULL
                  ), 0)::float AS "totalSales",
                  COALESCE(SUM(ABS(m."priceNet")) FILTER (
                    WHERE m.purchased = true
                      AND m."priceNet" IS NOT NULL
                      AND date_trunc('month', m."sentAt" AT TIME ZONE 'UTC')
                          = date_trunc('month', NOW() AT TIME ZONE 'UTC')
                  ), 0)::float AS "monthlySales"
           FROM messaging_dashboard_entries m
           WHERE TRUE ${mChatterClause}
           GROUP BY m."chatterId", 2`,
          selfParams
        ),
        pool.query(
          `SELECT m."chatterId",
                  COUNT(*) FILTER (
                    WHERE m."contentType" IN ('text', 'media', 'chat_product')
                  )::int AS "messagesSent",
                  COUNT(*) FILTER (WHERE m."contentType" = 'chat_product')::int AS "ppvsSent",
                  COUNT(*) FILTER (
                    WHERE m."contentType" = 'chat_product' AND m.purchased = true
                  )::int AS "ppvsUnlocked"
           FROM messaging_dashboard_entries m
           WHERE TRUE ${mChatterClause}
           GROUP BY m."chatterId"`,
          selfParams
        ),
        scope.mode === 'self'
          ? pool.query(
              `SELECT m."chatterId",
                      UPPER(COALESCE(NULLIF(TRIM(m.currency), ''), 'EUR')) AS currency,
                      COALESCE(SUM(ABS(m."priceNet")), 0)::float AS amount
               FROM messaging_dashboard_entries m
               WHERE m.purchased = true
                 AND m."priceNet" IS NOT NULL
                 AND (m."sentAt" AT TIME ZONE 'UTC')::date >= $2::date
                 AND m."chatterId" = ANY($1::uuid[])
               GROUP BY m."chatterId", 2`,
              [scope.userIds, ACTIVITY_METRICS_CUTOVER]
            )
          : pool.query(
              `SELECT m."chatterId",
                      UPPER(COALESCE(NULLIF(TRIM(m.currency), ''), 'EUR')) AS currency,
                      COALESCE(SUM(ABS(m."priceNet")), 0)::float AS amount
               FROM messaging_dashboard_entries m
               WHERE m.purchased = true
                 AND m."priceNet" IS NOT NULL
                 AND (m."sentAt" AT TIME ZONE 'UTC')::date >= $1::date
               GROUP BY m."chatterId", 2`,
              [ACTIVITY_METRICS_CUTOVER]
            ),
        scope.mode === 'self'
          ? pool.query(
              `SELECT m."chatterId",
                      COUNT(*)::int AS "messagesSent"
               FROM messaging_dashboard_entries m
               WHERE m."contentType" IN ('text', 'media', 'chat_product')
                 AND (m."sentAt" AT TIME ZONE 'UTC')::date >= $2::date
                 AND m."chatterId" = ANY($1::uuid[])
               GROUP BY m."chatterId"`,
              [scope.userIds, ACTIVITY_METRICS_CUTOVER]
            )
          : pool.query(
              `SELECT m."chatterId",
                      COUNT(*)::int AS "messagesSent"
               FROM messaging_dashboard_entries m
               WHERE m."contentType" IN ('text', 'media', 'chat_product')
                 AND (m."sentAt" AT TIME ZONE 'UTC')::date >= $1::date
               GROUP BY m."chatterId"`,
              [ACTIVITY_METRICS_CUTOVER]
            ),
        staffListQuery,
        scope.mode === 'self'
          ? pool.query(
              `SELECT COALESCE(SUM(keystrokes), 0)::int AS keystrokes,
                      COALESCE(SUM("activeSeconds"), 0)::int AS "activeSeconds"
               FROM user_activity_daily
               WHERE "userId" = ANY($1::uuid[])
                 AND day >= $2::date`,
              [scope.userIds, ACTIVITY_METRICS_CUTOVER]
            )
          : pool.query(
              `SELECT COALESCE(SUM(d.keystrokes), 0)::int AS keystrokes,
                      COALESCE(SUM(d."activeSeconds"), 0)::int AS "activeSeconds"
               FROM user_activity_daily d
               JOIN users u ON u.id = d."userId"
               WHERE u.role = ANY($1::text[])
                 AND d.day >= $2::date`,
              [TRACKED_STAFF_ROLES, ACTIVITY_METRICS_CUTOVER]
            ),
        scope.mode === 'self'
          ? pool.query(
              `SELECT d."userId" AS "chatterId",
                      COALESCE(SUM(d."activeSeconds"), 0)::int AS "activeSeconds"
               FROM user_activity_daily d
               WHERE d."userId" = ANY($1::uuid[])
                 AND d.day >= $2::date
               GROUP BY d."userId"`,
              [scope.userIds, ACTIVITY_METRICS_CUTOVER]
            )
          : pool.query(
              `SELECT d."userId" AS "chatterId",
                      COALESCE(SUM(d."activeSeconds"), 0)::int AS "activeSeconds"
               FROM user_activity_daily d
               JOIN users u ON u.id = d."userId"
               WHERE u.role = ANY($1::text[])
                 AND d.day >= $2::date
               GROUP BY d."userId"`,
              [TRACKED_STAFF_ROLES, ACTIVITY_METRICS_CUTOVER]
            ),
      ]);

      const dailySales = currencyAmountRowsToList(dailySalesResult.rows);
      const totalSales = currencyAmountRowsToList(totalSalesResult.rows);
      const monthlyRevenue = currencyAmountRowsToList(monthlySalesResult.rows);
      const cutoverSales = currencyAmountRowsToList(cutoverSalesResult.rows);
      const cutoverMessagesSent =
        Number(cutoverMessagesResult.rows[0]?.messagesSent) || 0;

      const msgStats = messageStatsResult.rows[0] || {};
      const messagesSent = Number(msgStats.messagesSent) || 0;
      const ppvsSent = Number(msgStats.ppvsSent) || 0;
      const ppvsUnlocked = Number(msgStats.ppvsUnlocked) || 0;
      const goldenRatio = ratePercent(ppvsSent, messagesSent);
      const ppvConversionRate = ratePercent(ppvsUnlocked, ppvsSent);
      const keystrokesTotal = Number(keystrokesResult.rows[0]?.keystrokes) || 0;
      const activeSecondsTotal = Number(keystrokesResult.rows[0]?.activeSeconds) || 0;
      const revenuePerHour = revenuePerHourAmounts(cutoverSales, activeSecondsTotal);
      const messagesPerHour = perHourRate(cutoverMessagesSent, activeSecondsTotal);

      const activeSecondsByChatter = new Map();
      for (const row of chatterActiveResult.rows) {
        activeSecondsByChatter.set(
          row.chatterId,
          Number(row.activeSeconds) || 0
        );
      }

      const cutoverSalesByChatter = new Map();
      for (const row of chatterCutoverSalesResult.rows) {
        if (!cutoverSalesByChatter.has(row.chatterId)) {
          cutoverSalesByChatter.set(row.chatterId, []);
        }
        const amount = Number(row.amount) || 0;
        if (amount > 0) {
          cutoverSalesByChatter.get(row.chatterId).push({
            currency:
              String(row.currency || 'EUR').toUpperCase() === 'USD' ? 'USD' : 'EUR',
            amount,
          });
        }
      }

      const cutoverMessagesByChatter = new Map();
      for (const row of chatterCutoverMessagesResult.rows) {
        cutoverMessagesByChatter.set(
          row.chatterId,
          Number(row.messagesSent) || 0
        );
      }

      const dayMap = new Map();
      for (const row of dailyByDayResult.rows) {
        const date = String(row.date).slice(0, 10);
        if (!dayMap.has(date)) {
          dayMap.set(date, []);
        }
        if (row.currency != null && Number(row.amount) > 0) {
          dayMap.get(date).push({
            currency:
              String(row.currency).toUpperCase() === 'USD' ? 'USD' : 'EUR',
            amount: Number(row.amount) || 0,
          });
        }
      }

      const dailySalesByDay = [];
      for (let i = 13; i >= 0; i -= 1) {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - i);
        const date = d.toISOString().slice(0, 10);
        dailySalesByDay.push({
          date,
          amounts: mergeCurrencyAmounts(dayMap.get(date) || []),
        });
      }

      const statsByChatter = new Map();
      for (const row of chatterAvgResult.rows) {
        statsByChatter.set(row.chatterId, {
          avgResponseTimeSeconds:
            row.avgResponseTimeSeconds != null
              ? Number(row.avgResponseTimeSeconds)
              : null,
          dailySales: [],
          totalSales: [],
          monthlyRevenue: [],
          messagesSent: 0,
          ppvsSent: 0,
          ppvsUnlocked: 0,
          goldenRatio: 0,
          ppvConversionRate: 0,
        });
      }
      for (const row of chatterSalesResult.rows) {
        if (!statsByChatter.has(row.chatterId)) {
          statsByChatter.set(row.chatterId, {
            avgResponseTimeSeconds: null,
            dailySales: [],
            totalSales: [],
            monthlyRevenue: [],
            messagesSent: 0,
            ppvsSent: 0,
            ppvsUnlocked: 0,
            goldenRatio: 0,
            ppvConversionRate: 0,
          });
        }
        const entry = statsByChatter.get(row.chatterId);
        const currency =
          String(row.currency || 'EUR').toUpperCase() === 'USD' ? 'USD' : 'EUR';
        const daily = Number(row.dailySales) || 0;
        const total = Number(row.totalSales) || 0;
        const monthly = Number(row.monthlySales) || 0;
        if (daily > 0) {
          entry.dailySales.push({ currency, amount: daily });
        }
        if (total > 0) {
          entry.totalSales.push({ currency, amount: total });
        }
        if (monthly > 0) {
          entry.monthlyRevenue.push({ currency, amount: monthly });
        }
      }
      for (const row of chatterMessageStatsResult.rows) {
        if (!statsByChatter.has(row.chatterId)) {
          statsByChatter.set(row.chatterId, {
            avgResponseTimeSeconds: null,
            dailySales: [],
            totalSales: [],
            monthlyRevenue: [],
            messagesSent: 0,
            ppvsSent: 0,
            ppvsUnlocked: 0,
            goldenRatio: 0,
            ppvConversionRate: 0,
          });
        }
        const entry = statsByChatter.get(row.chatterId);
        entry.messagesSent = Number(row.messagesSent) || 0;
        entry.ppvsSent = Number(row.ppvsSent) || 0;
        entry.ppvsUnlocked = Number(row.ppvsUnlocked) || 0;
        entry.goldenRatio = ratePercent(entry.ppvsSent, entry.messagesSent);
        entry.ppvConversionRate = ratePercent(entry.ppvsUnlocked, entry.ppvsSent);
      }

      const namedIds = new Set(chatterNamesResult.rows.map((r) => r.chatterId));
      const chatters = chatterNamesResult.rows.map((row) => {
        const stats = statsByChatter.get(row.chatterId);
        const activeSeconds = activeSecondsByChatter.get(row.chatterId) || 0;
        const totalSalesMerged = mergeCurrencyAmounts(stats?.totalSales || []);
        const cutoverSalesMerged = mergeCurrencyAmounts(
          cutoverSalesByChatter.get(row.chatterId) || []
        );
        const messagesSentForChatter = stats?.messagesSent || 0;
        const cutoverMessages = cutoverMessagesByChatter.get(row.chatterId) || 0;
        return {
          chatterId: row.chatterId,
          chatterName: row.chatterName,
          avgResponseTimeSeconds: stats?.avgResponseTimeSeconds ?? null,
          dailySales: mergeCurrencyAmounts(stats?.dailySales || []),
          totalSales: totalSalesMerged,
          monthlyRevenue: mergeCurrencyAmounts(stats?.monthlyRevenue || []),
          messagesSent: messagesSentForChatter,
          ppvsSent: stats?.ppvsSent || 0,
          ppvsUnlocked: stats?.ppvsUnlocked || 0,
          goldenRatio: stats?.goldenRatio || 0,
          ppvConversionRate: stats?.ppvConversionRate || 0,
          activeSecondsTotal: activeSeconds,
          revenuePerHour: revenuePerHourAmounts(cutoverSalesMerged, activeSeconds),
          messagesPerHour: perHourRate(cutoverMessages, activeSeconds),
        };
      });

      const missingIds = [...statsByChatter.keys()].filter((id) => !namedIds.has(id));
      if (missingIds.length > 0) {
        const nameResult = await pool.query(
          `SELECT id AS "chatterId", name AS "chatterName"
           FROM users
           WHERE id = ANY($1::uuid[])`,
          [missingIds]
        );
        const nameById = new Map(
          nameResult.rows.map((row) => [row.chatterId, row.chatterName])
        );
        for (const chatterId of missingIds) {
          const stats = statsByChatter.get(chatterId);
          const activeSeconds = activeSecondsByChatter.get(chatterId) || 0;
          const totalSalesMerged = mergeCurrencyAmounts(stats.totalSales);
          const cutoverSalesMerged = mergeCurrencyAmounts(
            cutoverSalesByChatter.get(chatterId) || []
          );
          const cutoverMessages = cutoverMessagesByChatter.get(chatterId) || 0;
          chatters.push({
            chatterId,
            chatterName: nameById.get(chatterId) || 'Unknown',
            avgResponseTimeSeconds: stats.avgResponseTimeSeconds,
            dailySales: mergeCurrencyAmounts(stats.dailySales),
            totalSales: totalSalesMerged,
            monthlyRevenue: mergeCurrencyAmounts(stats.monthlyRevenue),
            messagesSent: stats.messagesSent,
            ppvsSent: stats.ppvsSent,
            ppvsUnlocked: stats.ppvsUnlocked,
            goldenRatio: stats.goldenRatio,
            ppvConversionRate: stats.ppvConversionRate,
            activeSecondsTotal: activeSeconds,
            revenuePerHour: revenuePerHourAmounts(cutoverSalesMerged, activeSeconds),
            messagesPerHour: perHourRate(cutoverMessages, activeSeconds),
          });
        }
      }

      chatters.sort((a, b) => a.chatterName.localeCompare(b.chatterName));

      const avgRaw = avgResponseResult.rows[0]?.avg;
      res.json({
        scope: scope.mode,
        dailySales,
        totalSales,
        totalRevenue: totalSales,
        monthlyRevenue,
        totalMessagesSent: messagesSent,
        ppvsSent,
        ppvsUnlocked,
        goldenRatio,
        ppvConversionRate,
        keystrokesTotal,
        activeSecondsTotal,
        revenuePerHour,
        messagesPerHour,
        activityMetricsCutover: ACTIVITY_METRICS_CUTOVER,
        avgResponseTimeSeconds:
          avgRaw != null && !Number.isNaN(Number(avgRaw))
            ? Number(avgRaw)
            : null,
        dailySalesByDay,
        chatters,
        responseWindow: { startDate: responseStart, endDate: responseEnd },
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error('messaging dashboard overview failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/leaderboard',
  authenticate,
  requirePermission('analytics.view', 'analytics.self'),
  async (req, res) => {
    try {
      const viewerId = req.user.id;
      const end = new Date();
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - 30);
      const responseStart = start.toISOString().slice(0, 10);
      const responseEnd = end.toISOString().slice(0, 10);

      const [
        staffResult,
        responseResult,
        salesResult,
        messageStatsResult,
      ] = await Promise.all([
        pool.query(
          `SELECT u.id AS "userId", u.name AS "userName"
           FROM users u
           WHERE u.role = ANY($1::text[]) AND u.status = 'active'
           ORDER BY u.name ASC`,
          [TRACKED_STAFF_ROLES]
        ),
        pool.query(
          `SELECT m."chatterId" AS "userId",
                  AVG(m."responseTimeSeconds")::float AS "avgResponseTimeSeconds"
           FROM messaging_dashboard_entries m
           JOIN users u ON u.id = m."chatterId"
           WHERE u.role = ANY($1::text[])
             AND m."responseTimeSeconds" IS NOT NULL
             AND (m."sentAt" AT TIME ZONE 'UTC')::date >= $2::date
             AND (m."sentAt" AT TIME ZONE 'UTC')::date <= $3::date
           GROUP BY m."chatterId"`,
          [TRACKED_STAFF_ROLES, responseStart, responseEnd]
        ),
        pool.query(
          `SELECT m."chatterId" AS "userId",
                  UPPER(COALESCE(NULLIF(TRIM(m.currency), ''), 'EUR')) AS currency,
                  COALESCE(SUM(ABS(m."priceNet")), 0)::float AS amount
           FROM messaging_dashboard_entries m
           JOIN users u ON u.id = m."chatterId"
           WHERE u.role = ANY($1::text[])
             AND m.purchased = true
             AND m."priceNet" IS NOT NULL
           GROUP BY m."chatterId", 2`,
          [TRACKED_STAFF_ROLES]
        ),
        pool.query(
          `SELECT m."chatterId" AS "userId",
                  COUNT(*) FILTER (
                    WHERE m."contentType" IN ('text', 'media', 'chat_product')
                  )::int AS "messagesSent",
                  COUNT(*) FILTER (WHERE m."contentType" = 'chat_product')::int AS "ppvsSent",
                  COUNT(*) FILTER (
                    WHERE m."contentType" = 'chat_product' AND m.purchased = true
                  )::int AS "ppvsUnlocked"
           FROM messaging_dashboard_entries m
           JOIN users u ON u.id = m."chatterId"
           WHERE u.role = ANY($1::text[])
           GROUP BY m."chatterId"`,
          [TRACKED_STAFF_ROLES]
        ),
      ]);

      const byId = new Map();
      for (const row of staffResult.rows) {
        byId.set(row.userId, {
          userId: row.userId,
          userName: row.userName,
          avgResponseTimeSeconds: null,
          sales: [],
          salesTotal: 0,
          messagesSent: 0,
          ppvsSent: 0,
          ppvsUnlocked: 0,
          goldenRatio: 0,
        });
      }

      for (const row of responseResult.rows) {
        const entry = byId.get(row.userId);
        if (!entry) continue;
        entry.avgResponseTimeSeconds =
          row.avgResponseTimeSeconds != null
            ? Number(row.avgResponseTimeSeconds)
            : null;
      }

      for (const row of salesResult.rows) {
        const entry = byId.get(row.userId);
        if (!entry) continue;
        const currency =
          String(row.currency || 'EUR').toUpperCase() === 'USD' ? 'USD' : 'EUR';
        const amount = Number(row.amount) || 0;
        if (amount > 0) {
          entry.sales.push({ currency, amount });
          entry.salesTotal += amount;
        }
      }

      for (const row of messageStatsResult.rows) {
        const entry = byId.get(row.userId);
        if (!entry) continue;
        entry.messagesSent = Number(row.messagesSent) || 0;
        entry.ppvsSent = Number(row.ppvsSent) || 0;
        entry.ppvsUnlocked = Number(row.ppvsUnlocked) || 0;
        entry.goldenRatio = ratePercent(entry.ppvsSent, entry.messagesSent);
      }

      const staff = [...byId.values()];

      function toEntry(rank, person, maskedValue) {
        return {
          rank,
          userId: person.userId,
          userName: person.userName,
          maskedValue,
        };
      }

      function buildTop(list, limit = 5) {
        return list.slice(0, limit).map((person, index) =>
          toEntry(index + 1, person, person._masked)
        );
      }

      function findViewer(list, maskFn) {
        const idx = list.findIndex((p) => p.userId === viewerId);
        if (idx < 0) return null;
        return {
          rank: idx + 1,
          maskedValue: maskFn(list[idx]),
        };
      }

      const responseSorted = staff
        .filter((p) => p.avgResponseTimeSeconds != null)
        .sort(
          (a, b) =>
            a.avgResponseTimeSeconds - b.avgResponseTimeSeconds ||
            a.userName.localeCompare(b.userName)
        )
        .map((p) => ({
          ...p,
          _masked: maskDuration(p.avgResponseTimeSeconds),
        }));

      const salesSorted = staff
        .filter((p) => p.salesTotal > 0)
        .sort(
          (a, b) =>
            b.salesTotal - a.salesTotal || a.userName.localeCompare(b.userName)
        )
        .map((p) => ({
          ...p,
          sales: mergeCurrencyAmounts(p.sales),
          _masked: maskMoneyAmounts(mergeCurrencyAmounts(p.sales)),
        }));

      const ppvSorted = staff
        .filter((p) => p.ppvsUnlocked > 0)
        .sort(
          (a, b) =>
            b.ppvsUnlocked - a.ppvsUnlocked ||
            a.userName.localeCompare(b.userName)
        )
        .map((p) => ({
          ...p,
          _masked: maskCount(p.ppvsUnlocked),
        }));

      const goldenSorted = staff
        .filter((p) => p.messagesSent > 0)
        .sort(
          (a, b) =>
            b.goldenRatio - a.goldenRatio || a.userName.localeCompare(b.userName)
        )
        .map((p) => ({
          ...p,
          _masked: maskPercent(p.goldenRatio),
        }));

      res.json({
        topResponseTime: buildTop(responseSorted),
        topSales: buildTop(salesSorted),
        topPpvsUnlocked: buildTop(ppvSorted),
        topGoldenRatio: buildTop(goldenSorted),
        viewerRank: {
          responseTime: findViewer(responseSorted, (p) =>
            maskDuration(p.avgResponseTimeSeconds)
          ),
          sales: findViewer(salesSorted, (p) =>
            maskMoneyAmounts(mergeCurrencyAmounts(p.sales))
          ),
          ppvsUnlocked: findViewer(ppvSorted, (p) => maskCount(p.ppvsUnlocked)),
          goldenRatio: findViewer(goldenSorted, (p) =>
            maskPercent(p.goldenRatio)
          ),
        },
        responseWindow: { startDate: responseStart, endDate: responseEnd },
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error('messaging dashboard leaderboard failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/series',
  authenticate,
  requirePermission('analytics.view', 'analytics.self'),
  async (req, res) => {
    try {
      const scope = getAnalyticsScope(req.user);
      const parsedDays = Math.min(
        Math.max(Number.parseInt(String(req.query.days || '7'), 10) || 7, 1),
        90
      );
      const dateRange = buildUtcDateRange(parsedDays);
      const startDate = dateRange[0];
      const endDate = dateRange[dateRange.length - 1];

      const chatterClause =
        scope.mode === 'self' ? ' AND m."chatterId" = ANY($3::uuid[])' : '';
      const messageParams =
        scope.mode === 'self'
          ? [startDate, endDate, scope.userIds]
          : [startDate, endDate];

      const [messageSeriesResult, activitySeriesResult] = await Promise.all([
        pool.query(
          `SELECT (m."sentAt" AT TIME ZONE 'UTC')::date::text AS date,
                  COUNT(*) FILTER (
                    WHERE m."contentType" IN ('text', 'media', 'chat_product')
                  )::int AS "messagesSent",
                  COUNT(*) FILTER (WHERE m."contentType" = 'chat_product')::int AS "ppvsSent",
                  COUNT(*) FILTER (
                    WHERE m."contentType" = 'chat_product' AND m.purchased = true
                  )::int AS "ppvsUnlocked",
                  UPPER(COALESCE(NULLIF(TRIM(m.currency), ''), 'EUR')) AS currency,
                  COALESCE(SUM(ABS(m."priceNet")) FILTER (
                    WHERE m.purchased = true AND m."priceNet" IS NOT NULL
                  ), 0)::float AS revenue
           FROM messaging_dashboard_entries m
           WHERE (m."sentAt" AT TIME ZONE 'UTC')::date >= $1::date
             AND (m."sentAt" AT TIME ZONE 'UTC')::date <= $2::date
             ${chatterClause}
           GROUP BY 1, 5
           ORDER BY 1 ASC`,
          messageParams
        ),
        scope.mode === 'self'
          ? pool.query(
              `SELECT d.day::text AS date,
                      COALESCE(SUM(d."activeSeconds"), 0)::int AS "activeSeconds",
                      COALESCE(SUM(d."idleSeconds"), 0)::int AS "idleSeconds",
                      COALESCE(SUM(d.keystrokes), 0)::int AS keystrokes
               FROM user_activity_daily d
               WHERE d."userId" = ANY($1::uuid[])
                 AND d.day >= $2::date
                 AND d.day <= $3::date
               GROUP BY d.day
               ORDER BY d.day ASC`,
              [scope.userIds, startDate, endDate]
            )
          : pool.query(
              `SELECT d.day::text AS date,
                      COALESCE(SUM(d."activeSeconds"), 0)::int AS "activeSeconds",
                      COALESCE(SUM(d."idleSeconds"), 0)::int AS "idleSeconds",
                      COALESCE(SUM(d.keystrokes), 0)::int AS keystrokes
               FROM user_activity_daily d
               JOIN users u ON u.id = d."userId"
               WHERE u.role = ANY($1::text[])
                 AND d.day >= $2::date
                 AND d.day <= $3::date
               GROUP BY d.day
               ORDER BY d.day ASC`,
              [TRACKED_STAFF_ROLES, startDate, endDate]
            ),
      ]);

      const messageAgg = new Map();
      for (const row of messageSeriesResult.rows) {
        const date = String(row.date).slice(0, 10);
        if (!messageAgg.has(date)) {
          messageAgg.set(date, {
            messagesSent: 0,
            ppvsSent: 0,
            ppvsUnlocked: 0,
            revenue: [],
          });
        }
        const entry = messageAgg.get(date);
        // Counts are partitioned by currency in GROUP BY — sum across currencies
        entry.messagesSent += Number(row.messagesSent) || 0;
        entry.ppvsSent += Number(row.ppvsSent) || 0;
        entry.ppvsUnlocked += Number(row.ppvsUnlocked) || 0;
        const amount = Number(row.revenue) || 0;
        if (amount > 0) {
          entry.revenue.push({
            currency:
              String(row.currency || 'EUR').toUpperCase() === 'USD' ? 'USD' : 'EUR',
            amount,
          });
        }
      }

      const activityByDay = new Map();
      for (const row of activitySeriesResult.rows) {
        const date = String(row.date).slice(0, 10);
        activityByDay.set(date, {
          activeSeconds: Number(row.activeSeconds) || 0,
          idleSeconds: Number(row.idleSeconds) || 0,
          keystrokes: Number(row.keystrokes) || 0,
        });
      }

      const days = dateRange.map((date) => {
        const msg = messageAgg.get(date) || {
          messagesSent: 0,
          ppvsSent: 0,
          ppvsUnlocked: 0,
          revenue: [],
        };
        const act = activityByDay.get(date) || {
          activeSeconds: 0,
          idleSeconds: 0,
          keystrokes: 0,
        };
        return {
          date,
          messagesSent: msg.messagesSent,
          ppvsSent: msg.ppvsSent,
          ppvsUnlocked: msg.ppvsUnlocked,
          goldenRatio: ratePercent(msg.ppvsSent, msg.messagesSent),
          ppvConversionRate: ratePercent(msg.ppvsUnlocked, msg.ppvsSent),
          revenue: mergeCurrencyAmounts(msg.revenue),
          activeSeconds: act.activeSeconds,
          idleSeconds: act.idleSeconds,
          keystrokes: act.keystrokes,
        };
      });

      res.json({
        scope: scope.mode,
        days: parsedDays,
        startDate,
        endDate,
        series: days,
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error('messaging dashboard series failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/',
  authenticate,
  requirePermission('analytics.view'),
  async (req, res) => {
    const {
      startDate,
      endDate,
      chatterId,
      creatorId,
      platform,
      purchased,
      contentType,
      page = '1',
      limit = '20',
    } = req.query;

    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (startDate) {
      const dateValue = String(startDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
        return res.status(400).json({ error: 'Invalid startDate' });
      }
      conditions.push(`m."sentAt"::date >= $${paramIndex}::date`);
      values.push(dateValue);
      paramIndex += 1;
    }

    if (endDate) {
      const dateValue = String(endDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
        return res.status(400).json({ error: 'Invalid endDate' });
      }
      conditions.push(`m."sentAt"::date <= $${paramIndex}::date`);
      values.push(dateValue);
      paramIndex += 1;
    }

    if (chatterId) {
      if (!isValidUuid(String(chatterId))) {
        return res.status(400).json({ error: 'Invalid chatterId' });
      }
      conditions.push(`m."chatterId" = $${paramIndex}`);
      values.push(chatterId);
      paramIndex += 1;
    }

    if (creatorId) {
      if (!isValidUuid(String(creatorId))) {
        return res.status(400).json({ error: 'Invalid creatorId' });
      }
      conditions.push(`m."creatorId" = $${paramIndex}`);
      values.push(creatorId);
      paramIndex += 1;
    }

    if (platform === 'maloum' || platform === '4based') {
      conditions.push(`c.platform = $${paramIndex}`);
      values.push(platform);
      paramIndex += 1;
    } else if (platform != null && String(platform).trim() !== '') {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    if (purchased === 'true' || purchased === 'false') {
      conditions.push(`m.purchased = $${paramIndex}`);
      values.push(purchased === 'true');
      paramIndex += 1;
    }

    if (contentType != null && String(contentType).trim() !== '') {
      const typeValue = String(contentType).trim();
      if (typeValue !== 'chat_product') {
        return res.status(400).json({ error: 'Invalid contentType' });
      }
      conditions.push(`m."contentType" = $${paramIndex}`);
      values.push(typeValue);
      paramIndex += 1;
    }

    const parsedPage = Math.max(Number.parseInt(String(page), 10) || 1, 1);
    const parsedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
    const offset = (parsedPage - 1) * parsedLimit;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const salesWhereClause = whereClause
      ? `${whereClause} AND m.purchased = true AND m."priceNet" IS NOT NULL`
      : `WHERE m.purchased = true AND m."priceNet" IS NOT NULL`;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM messaging_dashboard_entries m
       JOIN creators c ON c.id = m."creatorId"
       ${whereClause}`,
      values
    );

    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `SELECT m.*,
              c.platform AS platform,
              COALESCE(sales."chatterSalesTotal", 0) AS "chatterSalesTotal"
       FROM messaging_dashboard_entries m
       JOIN creators c ON c.id = m."creatorId"
       LEFT JOIN (
         SELECT m."chatterId", c.platform, SUM(ABS(m."priceNet")) AS "chatterSalesTotal"
         FROM messaging_dashboard_entries m
         JOIN creators c ON c.id = m."creatorId"
         ${salesWhereClause}
         GROUP BY m."chatterId", c.platform
       ) sales ON sales."chatterId" = m."chatterId" AND sales.platform = c.platform
       ${whereClause}
       ORDER BY m."sentAt" DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, parsedLimit, offset]
    );

    const from = total === 0 ? 0 : offset + 1;
    const to = total === 0 ? 0 : Math.min(offset + dataResult.rows.length, total);

    res.json({
      data: dataResult.rows.map(toDashboardEntry),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        from,
        to,
      },
      lastUpdated: new Date().toISOString(),
    });
  }
);

router.post(
  '/',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const body = req.body || {};

    const {
      id,
      creatorId,
      creatorName,
      creatorUsername = null,
      creatorAvatarUrl = null,
      chatterId,
      chatterName,
      chatterEmail = null,
      chatId,
      fanId = null,
      fanUsername = null,
      maloumMessageId,
      optimisticMessageId = null,
      contentType,
      englishMessage = null,
      germanTranslatedMessage = null,
      actualSentText = null,
      priceNet = null,
      currency = 'EUR',
      purchased = false,
      mediaCount = 0,
      pictureCount = 0,
      videoCount = 0,
      mediaJson = null,
      previousFanMessageAt = null,
      responseTimeSeconds = null,
      sentAt,
    } = body;

    if (!id || !isValidUuid(id)) {
      return res.status(400).json({ error: 'Valid message record id is required' });
    }

    if (!creatorId || !isValidUuid(creatorId)) {
      return res.status(400).json({ error: 'Valid creatorId is required' });
    }

    if (!chatterId || !isValidUuid(chatterId)) {
      return res.status(400).json({ error: 'Valid chatterId is required' });
    }

    if (chatterId !== req.user.id) {
      return res.status(403).json({ error: 'chatterId must match authenticated user' });
    }

    if (!chatterName || typeof chatterName !== 'string') {
      return res.status(400).json({ error: 'chatterName is required' });
    }

    if (!chatId || typeof chatId !== 'string') {
      return res.status(400).json({ error: 'chatId is required' });
    }

    if (!maloumMessageId || typeof maloumMessageId !== 'string') {
      return res.status(400).json({ error: 'maloumMessageId is required' });
    }

    if (!contentType || typeof contentType !== 'string') {
      return res.status(400).json({ error: 'contentType is required' });
    }

    if (!sentAt) {
      return res.status(400).json({ error: 'sentAt is required' });
    }

    const creatorCheck = await pool.query('SELECT id FROM creators WHERE id = $1', [creatorId]);
    if (creatorCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    let resolvedCreatorName = creatorName;
    let resolvedCreatorUsername = creatorUsername;
    let resolvedCreatorAvatarUrl = creatorAvatarUrl;

    if (!resolvedCreatorName) {
      const enriched = await enrichCreatorFields(creatorId);
      if (!enriched) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      resolvedCreatorName = enriched.creatorName;
      resolvedCreatorUsername = resolvedCreatorUsername || enriched.creatorUsername;
      resolvedCreatorAvatarUrl = resolvedCreatorAvatarUrl || enriched.creatorAvatarUrl;
    }

    const resolvedChatterEmail = chatterEmail || (await enrichChatterEmail(chatterId));

    const result = await pool.query(
      `INSERT INTO messaging_dashboard_entries (
        id,
        "creatorId",
        "creatorName",
        "creatorUsername",
        "creatorAvatarUrl",
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
        "sentAt",
        "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, NOW()
      )
      ON CONFLICT ("maloumMessageId") DO UPDATE SET
        "creatorName" = EXCLUDED."creatorName",
        "creatorUsername" = EXCLUDED."creatorUsername",
        "creatorAvatarUrl" = EXCLUDED."creatorAvatarUrl",
        "chatterName" = EXCLUDED."chatterName",
        "chatterEmail" = EXCLUDED."chatterEmail",
        "fanId" = COALESCE(EXCLUDED."fanId", messaging_dashboard_entries."fanId"),
        "fanUsername" = COALESCE(EXCLUDED."fanUsername", messaging_dashboard_entries."fanUsername"),
        "optimisticMessageId" = COALESCE(EXCLUDED."optimisticMessageId", messaging_dashboard_entries."optimisticMessageId"),
        "contentType" = COALESCE(EXCLUDED."contentType", messaging_dashboard_entries."contentType"),
        "englishMessage" = COALESCE(EXCLUDED."englishMessage", messaging_dashboard_entries."englishMessage"),
        "germanTranslatedMessage" = COALESCE(EXCLUDED."germanTranslatedMessage", messaging_dashboard_entries."germanTranslatedMessage"),
        "actualSentText" = COALESCE(EXCLUDED."actualSentText", messaging_dashboard_entries."actualSentText"),
        "priceNet" = COALESCE(EXCLUDED."priceNet", messaging_dashboard_entries."priceNet"),
        currency = COALESCE(EXCLUDED.currency, messaging_dashboard_entries.currency),
        "mediaCount" = COALESCE(EXCLUDED."mediaCount", messaging_dashboard_entries."mediaCount"),
        "pictureCount" = COALESCE(EXCLUDED."pictureCount", messaging_dashboard_entries."pictureCount"),
        "videoCount" = COALESCE(EXCLUDED."videoCount", messaging_dashboard_entries."videoCount"),
        "mediaJson" = COALESCE(EXCLUDED."mediaJson", messaging_dashboard_entries."mediaJson"),
        "previousFanMessageAt" = COALESCE(EXCLUDED."previousFanMessageAt", messaging_dashboard_entries."previousFanMessageAt"),
        "responseTimeSeconds" = CASE
          WHEN EXCLUDED."responseTimeSeconds" IS NOT NULL THEN EXCLUDED."responseTimeSeconds"
          ELSE messaging_dashboard_entries."responseTimeSeconds"
        END,
        "sentAt" = EXCLUDED."sentAt",
        "updatedAt" = NOW()
      RETURNING *`,
      [
        id,
        creatorId,
        resolvedCreatorName,
        resolvedCreatorUsername,
        resolvedCreatorAvatarUrl,
        chatterId,
        chatterName,
        resolvedChatterEmail,
        chatId,
        fanId,
        fanUsername,
        maloumMessageId,
        optimisticMessageId,
        contentType,
        englishMessage,
        germanTranslatedMessage,
        actualSentText,
        priceNet,
        currency,
        Boolean(purchased),
        mediaCount,
        pictureCount,
        videoCount,
        mediaJson ? JSON.stringify(mediaJson) : null,
        previousFanMessageAt,
        responseTimeSeconds,
        sentAt,
      ]
    );

    const entry = toDashboardEntry(result.rows[0]);

    try {
      const accessUserIds = await getUserIdsWithCreatorAccess(creatorId);
      emitToUsers(accessUserIds, {
        type: 'messaging:sent',
        creatorId,
        chatId,
        maloumMessageId,
        optimisticMessageId: optimisticMessageId || null,
        chatterId,
        chatterName,
      });
    } catch (err) {
      console.warn('messaging:sent emit failed:', err.message);
    }

    res.json({ entry });
  }
);

router.post(
  '/internal/unlock-sale',
  requireElectronServiceKey,
  async (req, res) => {
    const { maloumMessageId, priceNet = null, notificationId = null } = req.body || {};

    if (!maloumMessageId || typeof maloumMessageId !== 'string') {
      return res.status(400).json({ error: 'maloumMessageId is required' });
    }

    const result = await unlockSaleByMessageId({
      maloumMessageId,
      priceNet,
      notificationId,
    });

    res.json(result);
  }
);

router.post(
  '/internal/log-tip',
  requireElectronServiceKey,
  async (req, res) => {
    const {
      creatorId,
      fanId = null,
      fanUsername = null,
      maloumMessageId,
      priceNet = null,
      notificationId = null,
      createdAt = null,
      currency = 'EUR',
    } = req.body || {};

    if (!creatorId || !isValidUuid(String(creatorId))) {
      return res.status(400).json({ error: 'Valid creatorId is required' });
    }

    if (!maloumMessageId || typeof maloumMessageId !== 'string') {
      return res.status(400).json({ error: 'maloumMessageId is required' });
    }

    const result = await logTip({
      creatorId,
      fanId,
      fanUsername,
      maloumMessageId,
      priceNet,
      notificationId,
      createdAt,
      currency,
    });

    res.json(result);
  }
);

router.patch(
  '/:maloumMessageId/purchased',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { maloumMessageId } = req.params;
    const { purchased, priceNet = null } = req.body || {};

    if (!maloumMessageId) {
      return res.status(400).json({ error: 'maloumMessageId is required' });
    }

    if (typeof purchased !== 'boolean') {
      return res.status(400).json({ error: 'purchased boolean is required' });
    }

    const parsedPriceNet = parsePriceNet(priceNet);

    const result = await pool.query(
      `UPDATE messaging_dashboard_entries
       SET purchased = $1,
           "priceNet" = CASE
             WHEN $1 = true THEN COALESCE("priceNet", $2)
             ELSE "priceNet"
           END,
           "updatedAt" = NOW()
       WHERE "maloumMessageId" = $3
       RETURNING *`,
      [purchased, parsedPriceNet, maloumMessageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json({ entry: toDashboardEntry(result.rows[0]) });
  }
);

module.exports = router;
module.exports.unlockSaleByMessageId = unlockSaleByMessageId;
module.exports.logTip = logTip;
module.exports.processMaloumSaleAndTipNotifications = processMaloumSaleAndTipNotifications;
module.exports.processFourBasedSaleAndTipNotifications =
  processFourBasedSaleAndTipNotifications;
