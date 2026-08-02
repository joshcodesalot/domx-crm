const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { decryptJson, decryptSecret } = require('../services/crypto');
const { decryptAccessToken } = require('../services/maloumAuthTokens');
const { userCanAccessCreator } = require('../services/creatorAccess');
const maloumClient = require('../services/maloumClient');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function maloumClientHttpStatus(err) {
  const status = err?.status >= 400 && err.status < 600 ? err.status : 502;
  return status === 401 ? 502 : status;
}

function maloumClientHttpMessage(err, fallback = 'Maloum request failed') {
  if (err?.status === 401) {
    return 'Maloum session expired. Reconnect this creator.';
  }
  return err?.message || fallback;
}

function handleMaloumError(res, err, label) {
  if (err instanceof maloumClient.MaloumApiError) {
    return res
      .status(maloumClientHttpStatus(err))
      .json({ error: maloumClientHttpMessage(err) });
  }
  console.error(label, err);
  return res.status(500).json({ error: 'Internal server error' });
}

async function loadMaloumCreator(creatorId) {
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
  if (row.platform !== 'maloum') {
    return { error: { status: 400, message: 'Creator is not a Maloum account' } };
  }

  let session = {};
  try {
    if (row.encryptedSession) {
      session = decryptJson(row.encryptedSession) || {};
    }
  } catch {
    return { error: { status: 500, message: 'Failed to decrypt Maloum session' } };
  }

  const accessToken =
    decryptAccessToken(row.encryptedAccessToken) ||
    decryptSecret(row.encryptedAccessToken) ||
    null;
  let proxyUrl = decryptSecret(row.encryptedProxy) || null;
  if (!proxyUrl) {
    try {
      proxyUrl = maloumClient.resolveMaloumProxyUrl(null);
    } catch {
      proxyUrl = null;
    }
  }

  if (!accessToken) {
    return {
      error: {
        status: 400,
        message: 'Maloum account is missing auth credentials. Please reconnect.',
      },
    };
  }
  if (!proxyUrl) {
    return {
      error: {
        status: 400,
        message:
          'Maloum proxy is required. Set MALOUM_PROXY_URL in backend .env or reconnect with a proxy.',
      },
    };
  }

  return {
    creator: {
      id: row.id,
      displayName: row.displayName,
      accountId: row.accountId,
      providerUserId: row.providerUserId || null,
      accessToken,
      proxyUrl,
      timezone: 'UTC',
      session: {
        ...session,
        providerUserId: row.providerUserId || null,
        accessToken,
      },
    },
  };
}

function defaultCheckpoint() {
  return {
    sourceCreators: [],
    creatorIndex: 0,
    postIndex: 0,
    posts: [],
    commentNext: null,
    processedFans: 0,
    skippedFans: 0,
    failedFans: 0,
    invalidUsernames: [],
    lastError: null,
    currentCreatorUsername: null,
    currentPostId: null,
  };
}

function normalizeCheckpoint(raw) {
  const base = defaultCheckpoint();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    sourceCreators: Array.isArray(raw.sourceCreators) ? raw.sourceCreators : [],
    posts: Array.isArray(raw.posts) ? raw.posts : [],
    invalidUsernames: Array.isArray(raw.invalidUsernames)
      ? raw.invalidUsernames
      : [],
    creatorIndex: Number(raw.creatorIndex) || 0,
    postIndex: Number(raw.postIndex) || 0,
    processedFans: Number(raw.processedFans) || 0,
    skippedFans: Number(raw.skippedFans) || 0,
    failedFans: Number(raw.failedFans) || 0,
    commentNext:
      raw.commentNext === undefined || raw.commentNext === null
        ? null
        : String(raw.commentNext),
  };
}

function rowToJob(row) {
  return {
    id: row.id,
    motherCreatorId: row.motherCreatorId,
    targetListId: row.targetListId || null,
    targetListName: row.targetListName || null,
    status: row.status,
    sourceMode: row.sourceMode,
    topCreatorsLimit: row.topCreatorsLimit,
    postsPerCreator: row.postsPerCreator,
    customUsernames: Array.isArray(row.customUsernames) ? row.customUsernames : [],
    checkpoint: normalizeCheckpoint(row.checkpoint),
    startedAt: row.startedAt || null,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId || null,
  };
}

function normalizeUsernameList(input) {
  const raw = Array.isArray(input)
    ? input.join('\n')
    : typeof input === 'string'
      ? input
      : '';
  const parts = raw
    .split(/[\n,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      let value = part.replace(/^@+/, '');
      const urlMatch = value.match(
        /(?:https?:\/\/)?(?:app\.)?maloum\.com\/creator\/([^/?#]+)/i
      );
      if (urlMatch) value = urlMatch[1];
      return value.trim().toLowerCase();
    })
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const username of parts) {
    if (seen.has(username)) continue;
    seen.add(username);
    out.push(username);
  }
  return out;
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
  const loaded = await loadMaloumCreator(creatorId);
  if (loaded.error) {
    res.status(loaded.error.status).json({ error: loaded.error.message });
    return null;
  }
  return loaded;
}

async function getOrCreateJob(motherCreatorId, userId) {
  const existing = await pool.query(
    `SELECT * FROM maloum_fan_scrape_jobs WHERE "motherCreatorId" = $1`,
    [motherCreatorId]
  );
  if (existing.rows.length > 0) {
    return rowToJob(existing.rows[0]);
  }

  const inserted = await pool.query(
    `INSERT INTO maloum_fan_scrape_jobs (
       id, "motherCreatorId", status, "sourceMode",
       "topCreatorsLimit", "postsPerCreator", "customUsernames",
       checkpoint, "createdByUserId"
     ) VALUES ($1, $2, 'idle', 'top_creators', 50, 50, '{}', $3::jsonb, $4)
     RETURNING *`,
    [randomUUID(), motherCreatorId, JSON.stringify(defaultCheckpoint()), userId || null]
  );
  return rowToJob(inserted.rows[0]);
}

router.get(
  '/:id/maloum/fan-scrape/job',
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
         FROM maloum_fan_scrape_fans
         WHERE "motherCreatorId" = $1`,
        [id]
      );
      return res.json({
        job,
        scrapedFanCount: fanCount.rows[0]?.count || 0,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Get fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/fan-scrape/job',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      const job = await getOrCreateJob(id, req.user.id);
      return res.status(201).json({
        job,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Create fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch(
  '/:id/maloum/fan-scrape/job',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const {
      targetListId,
      targetListName,
      sourceMode,
      topCreatorsLimit,
      postsPerCreator,
      customUsernames,
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

      const nextSourceMode =
        sourceMode === 'custom_usernames' || sourceMode === 'top_creators'
          ? sourceMode
          : job.sourceMode;
      const nextTopLimit = Math.min(
        Math.max(
          Number(topCreatorsLimit != null ? topCreatorsLimit : job.topCreatorsLimit) || 50,
          1
        ),
        200
      );
      const nextPostsLimit = Math.min(
        Math.max(
          Number(postsPerCreator != null ? postsPerCreator : job.postsPerCreator) || 50,
          1
        ),
        200
      );
      const nextUsernames =
        customUsernames !== undefined
          ? normalizeUsernameList(customUsernames)
          : job.customUsernames;

      let checkpoint = job.checkpoint;
      let status = job.status;
      if (resetCheckpoint) {
        checkpoint = defaultCheckpoint();
        status = 'idle';
      }

      const updated = await pool.query(
        `UPDATE maloum_fan_scrape_jobs
         SET "targetListId" = $2,
             "targetListName" = $3,
             "sourceMode" = $4,
             "topCreatorsLimit" = $5,
             "postsPerCreator" = $6,
             "customUsernames" = $7,
             checkpoint = $8::jsonb,
             status = $9,
             "updatedAt" = NOW()
         WHERE "motherCreatorId" = $1
         RETURNING *`,
        [
          id,
          targetListId !== undefined
            ? targetListId
              ? String(targetListId)
              : null
            : job.targetListId,
          targetListName !== undefined
            ? targetListName
              ? String(targetListName)
              : null
            : job.targetListName,
          nextSourceMode,
          nextTopLimit,
          nextPostsLimit,
          nextUsernames,
          JSON.stringify(checkpoint),
          status,
        ]
      );

      return res.json({
        job: rowToJob(updated.rows[0]),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Patch fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/fan-scrape/job/start',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      const job = await getOrCreateJob(id, req.user.id);
      if (!job.targetListId) {
        return res.status(400).json({ error: 'Select or create a target list first' });
      }
      if (
        job.sourceMode === 'custom_usernames' &&
        (!job.customUsernames || job.customUsernames.length === 0) &&
        (!job.checkpoint.sourceCreators ||
          job.checkpoint.sourceCreators.length === 0)
      ) {
        return res.status(400).json({ error: 'Add at least one creator username' });
      }

      const updated = await pool.query(
        `UPDATE maloum_fan_scrape_jobs
         SET status = 'running',
             "startedAt" = COALESCE("startedAt", NOW()),
             "updatedAt" = NOW()
         WHERE "motherCreatorId" = $1
         RETURNING *`,
        [id]
      );

      return res.json({
        job: rowToJob(updated.rows[0]),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Start fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/fan-scrape/job/stop',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      await getOrCreateJob(id, req.user.id);
      const updated = await pool.query(
        `UPDATE maloum_fan_scrape_jobs
         SET status = CASE
               WHEN status = 'completed' THEN 'completed'
               WHEN status = 'failed' THEN 'failed'
               ELSE 'paused'
             END,
             "updatedAt" = NOW()
         WHERE "motherCreatorId" = $1
         RETURNING *`,
        [id]
      );

      return res.json({
        job: rowToJob(updated.rows[0]),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Stop fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/fan-scrape/job/checkpoint',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const { checkpoint, status } = req.body || {};

    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      const job = await getOrCreateJob(id, req.user.id);
      const nextCheckpoint = normalizeCheckpoint({
        ...job.checkpoint,
        ...(checkpoint && typeof checkpoint === 'object' ? checkpoint : {}),
      });

      const allowedStatus = [
        'idle',
        'running',
        'paused',
        'completed',
        'failed',
      ];
      const nextStatus =
        typeof status === 'string' && allowedStatus.includes(status)
          ? status
          : job.status;

      const updated = await pool.query(
        `UPDATE maloum_fan_scrape_jobs
         SET checkpoint = $2::jsonb,
             status = $3,
             "updatedAt" = NOW()
         WHERE "motherCreatorId" = $1
         RETURNING *`,
        [id, JSON.stringify(nextCheckpoint), nextStatus]
      );

      return res.json({
        job: rowToJob(updated.rows[0]),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Checkpoint fan scrape job error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/:id/maloum/fan-scrape/fans/exists',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const fanId =
      typeof req.query.fanId === 'string' ? req.query.fanId.trim() : '';
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      const result = await pool.query(
        `SELECT "fanId", "chatId", username
         FROM maloum_fan_scrape_fans
         WHERE "motherCreatorId" = $1 AND "fanId" = $2
         LIMIT 1`,
        [id, fanId]
      );

      return res.json({
        exists: result.rows.length > 0,
        fan: result.rows[0] || null,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Fan scrape exists error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/fan-scrape/fans/exists',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const fanIds = Array.isArray(req.body?.fanIds)
      ? req.body.fanIds.map(String).filter(Boolean)
      : [];

    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      if (fanIds.length === 0) {
        return res.json({
          existing: [],
          providerUserId: loaded.creator.providerUserId,
        });
      }

      const result = await pool.query(
        `SELECT "fanId"
         FROM maloum_fan_scrape_fans
         WHERE "motherCreatorId" = $1 AND "fanId" = ANY($2::text[])`,
        [id, fanIds]
      );

      return res.json({
        existing: result.rows.map((row) => row.fanId),
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Fan scrape batch exists error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/maloum/fan-scrape/fans',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const {
      fanId,
      chatId,
      username,
      sourceCreatorUsername,
      sourcePostId,
      listId,
    } = req.body || {};

    if (!fanId || !String(fanId).trim()) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const loaded = await ensureAccess(req, res, id);
      if (!loaded) return;

      const result = await pool.query(
        `INSERT INTO maloum_fan_scrape_fans (
           id, "motherCreatorId", "fanId", "chatId", username,
           "sourceCreatorUsername", "sourcePostId", "listId"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT ("motherCreatorId", "fanId") DO UPDATE SET
           "chatId" = COALESCE(EXCLUDED."chatId", maloum_fan_scrape_fans."chatId"),
           username = COALESCE(EXCLUDED.username, maloum_fan_scrape_fans.username),
           "sourceCreatorUsername" = COALESCE(
             EXCLUDED."sourceCreatorUsername",
             maloum_fan_scrape_fans."sourceCreatorUsername"
           ),
           "sourcePostId" = COALESCE(
             EXCLUDED."sourcePostId",
             maloum_fan_scrape_fans."sourcePostId"
           ),
           "listId" = COALESCE(EXCLUDED."listId", maloum_fan_scrape_fans."listId"),
           "scrapedAt" = NOW()
         RETURNING *`,
        [
          randomUUID(),
          id,
          String(fanId).trim(),
          chatId ? String(chatId) : null,
          username ? String(username) : null,
          sourceCreatorUsername ? String(sourceCreatorUsername) : null,
          sourcePostId ? String(sourcePostId) : null,
          listId ? String(listId) : null,
        ]
      );

      return res.status(201).json({
        fan: result.rows[0],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      console.error('Upsert fan scrape fan error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
