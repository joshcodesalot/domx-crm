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

const { requireElectronServiceKey } = require('../middleware/electronServiceKey');

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
