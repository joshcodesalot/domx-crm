const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');

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
      conditions.push(`"sentAt"::date >= $${paramIndex}::date`);
      values.push(dateValue);
      paramIndex += 1;
    }

    if (endDate) {
      const dateValue = String(endDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
        return res.status(400).json({ error: 'Invalid endDate' });
      }
      conditions.push(`"sentAt"::date <= $${paramIndex}::date`);
      values.push(dateValue);
      paramIndex += 1;
    }

    if (chatterId) {
      if (!isValidUuid(String(chatterId))) {
        return res.status(400).json({ error: 'Invalid chatterId' });
      }
      conditions.push(`"chatterId" = $${paramIndex}`);
      values.push(chatterId);
      paramIndex += 1;
    }

    if (creatorId) {
      if (!isValidUuid(String(creatorId))) {
        return res.status(400).json({ error: 'Invalid creatorId' });
      }
      conditions.push(`"creatorId" = $${paramIndex}`);
      values.push(creatorId);
      paramIndex += 1;
    }

    if (purchased === 'true' || purchased === 'false') {
      conditions.push(`purchased = $${paramIndex}`);
      values.push(purchased === 'true');
      paramIndex += 1;
    }

    const parsedPage = Math.max(Number.parseInt(String(page), 10) || 1, 1);
    const parsedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
    const offset = (parsedPage - 1) * parsedLimit;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const salesWhereClause = whereClause
      ? `${whereClause} AND purchased = true AND "priceNet" IS NOT NULL`
      : `WHERE purchased = true AND "priceNet" IS NOT NULL`;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM messaging_dashboard_entries
       ${whereClause}`,
      values
    );

    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `SELECT m.*,
              COALESCE(sales."chatterSalesTotal", 0) AS "chatterSalesTotal"
       FROM messaging_dashboard_entries m
       LEFT JOIN (
         SELECT "chatterId", SUM("priceNet") AS "chatterSalesTotal"
         FROM messaging_dashboard_entries
         ${salesWhereClause}
         GROUP BY "chatterId"
       ) sales ON sales."chatterId" = m."chatterId"
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

    res.json({ entry: toDashboardEntry(result.rows[0]) });
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

    const existing = await pool.query(
      `SELECT purchased
       FROM messaging_dashboard_entries
       WHERE "maloumMessageId" = $1`,
      [maloumMessageId]
    );

    if (existing.rows.length === 0) {
      return res.json({
        updated: false,
        reason: 'entry_not_found',
        maloumMessageId,
        notificationId,
      });
    }

    if (existing.rows[0].purchased) {
      return res.json({
        updated: false,
        reason: 'already_purchased',
        maloumMessageId,
        notificationId,
      });
    }

    const parsedPriceNet =
      typeof priceNet === 'number' && Number.isFinite(priceNet) ? priceNet : null;

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
      return res.json({
        updated: false,
        reason: 'already_purchased',
        maloumMessageId,
        notificationId,
      });
    }

    res.json({
      updated: true,
      entry: toDashboardEntry({
        ...result.rows[0],
        chatterSalesTotal: null,
      }),
      notificationId,
    });
  }
);

router.patch(
  '/:maloumMessageId/purchased',
  authenticate,
  requirePermission('analytics.view'),
  async (req, res) => {
    const { maloumMessageId } = req.params;
    const { purchased } = req.body || {};

    if (!maloumMessageId) {
      return res.status(400).json({ error: 'maloumMessageId is required' });
    }

    if (typeof purchased !== 'boolean') {
      return res.status(400).json({ error: 'purchased boolean is required' });
    }

    const result = await pool.query(
      `UPDATE messaging_dashboard_entries
       SET purchased = $1, "updatedAt" = NOW()
       WHERE "maloumMessageId" = $2
       RETURNING *`,
      [purchased, maloumMessageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json({ entry: toDashboardEntry(result.rows[0]) });
  }
);

module.exports = router;
