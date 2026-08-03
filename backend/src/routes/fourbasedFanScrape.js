const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { decryptJson, decryptSecret } = require('../services/crypto');
const { userCanAccessCreator } = require('../services/creatorAccess');
const fourBasedClient = require('../services/fourBasedClient');
const fanScrapeRunner = require('../services/fourbasedFanScrapeRunner');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

async function loadFourBasedCreator(creatorId) {
  const result = await pool.query(
    `SELECT id, platform, "displayName", "providerUserId", "encryptedSession",
            "encryptedAccessToken", "encryptedProxy", "connectionStatus", "accountId"
     FROM creators
     WHERE id = $1`,
    [creatorId]
  );

  if (result.rows.length === 0) {
    return { error: { status: 404, message: 'Creator not found' } };
  }

  const row = result.rows[0];
  if (row.platform !== '4based') {
    return { error: { status: 400, message: 'Creator is not a 4based account' } };
  }

  let session = {};
  try {
    if (row.encryptedSession) {
      session = decryptJson(row.encryptedSession) || {};
    }
  } catch {
    return { error: { status: 500, message: 'Failed to decrypt 4based session' } };
  }

  const accessToken = decryptSecret(row.encryptedAccessToken) || session.token || null;
  let proxyUrl = decryptSecret(row.encryptedProxy) || null;
  if (!proxyUrl) {
    try {
      proxyUrl = fourBasedClient.resolveFourBasedProxyUrl(null);
    } catch {
      proxyUrl = null;
    }
  }
  const providerUserId = row.providerUserId || session.providerUserId || null;

  if (!accessToken || !providerUserId) {
    return {
      error: {
        status: 400,
        message: '4based account is missing auth credentials. Please reconnect.',
      },
    };
  }
  if (!proxyUrl) {
    return {
      error: {
        status: 400,
        message:
          '4based proxy is required. Set FOURBASED_PROXY_URL in backend .env or reconnect with a proxy.',
      },
    };
  }

  return {
    creator: {
      id: row.id,
      displayName: row.displayName,
      accountId: row.accountId,
      providerUserId,
      accessToken,
      proxyUrl,
      session: {
        ...session,
        providerUserId,
        token: accessToken,
        cookies: session.cookies || {},
        resource: session.resource || null,
      },
    },
  };
}

async function ensureAccess(req, res, creatorId) {
  if (!isValidUuid(creatorId)) {
    res.status(400).json({ error: 'Invalid creator ID' });
    return null;
  }
  const allowed = await userCanAccessCreator(req.user, creatorId);
  if (!allowed) {
    res.status(403).json({ error: 'You do not have access to this creator' });
    return null;
  }
  const loaded = await loadFourBasedCreator(creatorId);
  if (loaded.error) {
    res.status(loaded.error.status).json({ error: loaded.error.message });
    return null;
  }
  return loaded;
}

async function getOrCreateJob(motherCreatorId, userId) {
  const existing = await pool.query(
    `SELECT * FROM fourbased_fan_scrape_jobs WHERE "motherCreatorId" = $1`,
    [motherCreatorId]
  );
  if (existing.rows.length > 0) {
    return fanScrapeRunner.rowToJob(existing.rows[0]);
  }

  const inserted = await pool.query(
    `INSERT INTO fourbased_fan_scrape_jobs (
       id, "motherCreatorId", status, "sourceMode", "messageText", "vaultIds", "priceCoins",
       "importFans", "targetCreatorIds", checkpoint, "createdByUserId"
     ) VALUES ($1, $2, 'idle', 'trending', '', '{}', 0, '{}'::jsonb, '{}', $3::jsonb, $4)
     RETURNING *`,
    [
      randomUUID(),
      motherCreatorId,
      JSON.stringify(fanScrapeRunner.defaultCheckpoint()),
      userId || null,
    ]
  );
  return fanScrapeRunner.rowToJob(inserted.rows[0]);
}

router.get(
  '/:id/4based/fan-scrape/job',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      const job = await getOrCreateJob(id, req.user.id);
      const fanCount = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM fourbased_fan_scrape_fans
         WHERE "motherCreatorId" = $1`,
        [id]
      );
      return res.json({
        job,
        scrapedFanCount: fanCount.rows[0]?.count || 0,
        serverRunning: fanScrapeRunner.isActive(id),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Get 4based fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch(
  '/:id/4based/fan-scrape/job',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const {
      messageText,
      vaultIds,
      priceCoins,
      sourceMode,
      importFans,
      targetCreatorIds,
      resetCheckpoint,
    } = req.body || {};

    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      const job = await getOrCreateJob(id, req.user.id);
      if (job.status === 'running') {
        return res.status(409).json({
          error: 'Stop the running job before changing settings',
        });
      }

      const nextMessage =
        messageText !== undefined
          ? typeof messageText === 'string'
            ? messageText
            : ''
          : job.messageText;
      const nextVaultIds =
        vaultIds !== undefined
          ? (Array.isArray(vaultIds) ? vaultIds : [])
              .map(String)
              .map((v) => v.trim())
              .filter(Boolean)
          : job.vaultIds;
      const nextPrice =
        priceCoins !== undefined
          ? Math.max(0, Math.floor(Number(priceCoins) || 0))
          : job.priceCoins;
      const nextSourceMode =
        sourceMode === 'import_ids' || sourceMode === 'trending'
          ? sourceMode
          : job.sourceMode || 'trending';
      const nextImportFans =
        importFans !== undefined
          ? fanScrapeRunner.normalizeImportFans(importFans)
          : job.importFans || {};
      const nextTargetCreatorIds =
        targetCreatorIds !== undefined
          ? fanScrapeRunner.normalizeUuidList(targetCreatorIds)
          : job.targetCreatorIds || [];

      let checkpoint = job.checkpoint;
      let status = job.status;
      if (resetCheckpoint) {
        checkpoint = fanScrapeRunner.defaultCheckpoint();
        status = 'idle';
      }

      const updated = await pool.query(
        `UPDATE fourbased_fan_scrape_jobs
         SET "messageText" = $2,
             "vaultIds" = $3,
             "priceCoins" = $4,
             "sourceMode" = $5,
             "importFans" = $6::jsonb,
             "targetCreatorIds" = $7,
             checkpoint = $8::jsonb,
             status = $9,
             "updatedAt" = NOW()
         WHERE "motherCreatorId" = $1
         RETURNING *`,
        [
          id,
          nextMessage,
          nextVaultIds,
          nextPrice,
          nextSourceMode,
          JSON.stringify(nextImportFans),
          nextTargetCreatorIds,
          JSON.stringify(checkpoint),
          status,
        ]
      );

      return res.json({
        job: fanScrapeRunner.rowToJob(updated.rows[0]),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Patch 4based fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/4based/fan-scrape/job/start',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      await getOrCreateJob(id, req.user.id);
      const job = await fanScrapeRunner.startJob(id);
      return res.json({
        job,
        serverRunning: fanScrapeRunner.isActive(id),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      if (err?.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('Start 4based fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/4based/fan-scrape/job/stop',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      await getOrCreateJob(id, req.user.id);
      const job = await fanScrapeRunner.stopJob(id);
      return res.json({
        job,
        serverRunning: fanScrapeRunner.isActive(id),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Stop 4based fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
