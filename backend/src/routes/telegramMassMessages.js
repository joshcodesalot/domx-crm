const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator } = require('../services/creatorAccess');
const { applyModeration } = require('../services/contentModeration');
const {
  DEFAULT_UNSEND_CAP,
  resolveRecipients,
  createCampaign,
  loadCampaign,
  startSend,
  startUnsend,
  startUnsendLast,
  snapshotForCampaign,
  snapshotForCreator,
  stopCampaign,
  stopCreator,
  parseUuidList,
} = require('../services/telegramMassMessageRunner');

const router = express.Router();

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
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
  const result = await pool.query(
    `SELECT id, "displayName", platform FROM creators WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Creator not found' });
    return null;
  }
  if (result.rows[0].platform !== 'telegram') {
    res.status(400).json({ error: 'Creator is not a Telegram account' });
    return null;
  }
  return result.rows[0];
}

function serializeCampaign(row, extras = {}) {
  return {
    id: row.id,
    creatorId: row.creatorId,
    bodyText: row.bodyText,
    vaultIds: parseUuidList(row.vaultIds),
    includeListIds: row.includeListIds || [],
    excludeListIds: row.excludeListIds || [],
    status: row.status,
    total: Number(row.total) || 0,
    sent: Number(row.sent) || 0,
    failed: Number(row.failed) || 0,
    skipped: Number(row.skipped) || 0,
    unsent: Number(row.unsent) || 0,
    unsendFailed: Number(row.unsendFailed) || 0,
    lastError: row.lastError,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    ...extras,
  };
}

function serializeRecipient(row) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    peerId: row.peerId,
    status: row.status,
    telegramMessageIds: Array.isArray(row.telegramMessageIds)
      ? row.telegramMessageIds.map(String)
      : [],
    error: row.error,
    sentAt: row.sentAt,
  };
}

router.get(
  '/:id/telegram/mass-messages/recipients/count',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const includeListIds = parseUuidList(
        req.body?.includeListIds ||
          (typeof req.query.includeListIds === 'string'
            ? req.query.includeListIds.split(',')
            : req.query.includeListIds)
      );
      const excludeListIds = parseUuidList(
        req.body?.excludeListIds ||
          (typeof req.query.excludeListIds === 'string'
            ? req.query.excludeListIds.split(',')
            : req.query.excludeListIds)
      );
      if (includeListIds.length === 0) {
        return res.status(400).json({ error: 'Select at least one include list' });
      }
      const peerIds = await resolveRecipients(
        creator.id,
        includeListIds,
        excludeListIds
      );
      return res.json({ count: peerIds.length });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Failed to count recipients' });
    }
  }
);

router.post(
  '/:id/telegram/mass-messages/recipients/count',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const includeListIds = parseUuidList(req.body?.includeListIds);
      const excludeListIds = parseUuidList(req.body?.excludeListIds);
      if (includeListIds.length === 0) {
        return res.status(400).json({ error: 'Select at least one include list' });
      }
      const peerIds = await resolveRecipients(
        creator.id,
        includeListIds,
        excludeListIds
      );
      return res.json({ count: peerIds.length });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Failed to count recipients' });
    }
  }
);

router.get(
  '/:id/telegram/mass-messages',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      const result = await pool.query(
        `SELECT * FROM telegram_mm_campaigns
         WHERE "creatorId" = $1
         ORDER BY "createdAt" DESC
         LIMIT $2`,
        [creator.id, limit]
      );
      return res.json({
        campaigns: result.rows.map((row) =>
          serializeCampaign(row, { progress: snapshotForCampaign(row.id) })
        ),
        progress: snapshotForCreator(creator.id),
      });
    } catch (err) {
      console.error('List Telegram mass messages error:', err);
      return res.status(500).json({ error: 'Failed to load mass messages' });
    }
  }
);

router.get(
  '/:id/telegram/mass-messages/:campaignId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { campaignId } = req.params;
    if (!isValidUuid(campaignId)) {
      return res.status(400).json({ error: 'Invalid campaign ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const campaign = await loadCampaign(campaignId);
      if (!campaign || campaign.creatorId !== creator.id) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      const recipients = await pool.query(
        `SELECT * FROM telegram_mm_recipients
         WHERE "campaignId" = $1
         ORDER BY "sentAt" DESC NULLS LAST, "peerId" ASC`,
        [campaignId]
      );
      return res.json({
        campaign: serializeCampaign(campaign, {
          progress: snapshotForCampaign(campaignId),
        }),
        recipients: recipients.rows.map(serializeRecipient),
      });
    } catch (err) {
      console.error('Get Telegram mass message error:', err);
      return res.status(500).json({ error: 'Failed to load campaign' });
    }
  }
);

router.post(
  '/:id/telegram/mass-messages',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const englishText = typeof body.englishText === 'string' ? body.englishText : text;
    const vaultIds = parseUuidList(body.vaultIds);
    const includeListIds = parseUuidList(body.includeListIds);
    const excludeListIds = parseUuidList(body.excludeListIds);
    if (includeListIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one include list' });
    }
    if (!text && vaultIds.length === 0) {
      return res.status(400).json({ error: 'Add text or vault media' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;

      if (text) {
        const moderation = await applyModeration({
          germanText: text,
          englishText,
          userId: req.user.id,
          creatorId: creator.id,
          platform: 'telegram',
          chatId: 'mass-message',
          fanId: 'mass-message',
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

      const campaign = await createCampaign({
        creatorId: creator.id,
        bodyText: text,
        vaultIds,
        includeListIds,
        excludeListIds,
        createdBy: req.user.id,
      });
      if ((Number(campaign.total) || 0) === 0) {
        await pool.query(
          `UPDATE telegram_mm_campaigns
           SET status = 'done', "finishedAt" = NOW(), "lastError" = $2
           WHERE id = $1`,
          [campaign.id, 'No recipients in the selected lists']
        );
        return res.status(201).json({
          campaign: serializeCampaign({
            ...campaign,
            status: 'done',
            lastError: 'No recipients in the selected lists',
          }),
          progress: snapshotForCampaign(campaign.id),
        });
      }
      const started = startSend(campaign.id, creator.id);
      return res.status(201).json({
        campaign: serializeCampaign(campaign),
        progress: started.progress,
      });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Failed to send mass message' });
    }
  }
);

router.post(
  '/:id/telegram/mass-messages/:campaignId/stop',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { campaignId } = req.params;
    if (!isValidUuid(campaignId)) {
      return res.status(400).json({ error: 'Invalid campaign ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const campaign = await loadCampaign(campaignId);
      if (!campaign || campaign.creatorId !== creator.id) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      return res.json({ progress: stopCampaign(campaignId) });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Failed to stop' });
    }
  }
);

router.post(
  '/:id/telegram/mass-messages/stop',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      return res.json({ progress: stopCreator(creator.id) });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Failed to stop' });
    }
  }
);

router.post(
  '/:id/telegram/mass-messages/:campaignId/unsend',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { campaignId } = req.params;
    if (!isValidUuid(campaignId)) {
      return res.status(400).json({ error: 'Invalid campaign ID' });
    }
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const campaign = await loadCampaign(campaignId);
      if (!campaign || campaign.creatorId !== creator.id) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      const started = startUnsend(campaignId, creator.id);
      return res.json({
        campaign: serializeCampaign(campaign),
        progress: started.progress,
      });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Failed to unsend' });
    }
  }
);

router.post(
  '/:id/telegram/mass-messages/unsend-last',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    try {
      const creator = await requireTelegramCreator(req, res);
      if (!creator) return undefined;
      const cap = Number(req.body?.cap);
      const started = startUnsendLast(
        creator.id,
        Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_UNSEND_CAP
      );
      return res.json({ progress: started.progress });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Failed to unsend last campaigns' });
    }
  }
);

module.exports = router;
