const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const multer = require('multer');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator, userSeesAllCreators } = require('../services/creatorAccess');
const {
  parseBusinessDateTime,
  normalizeTimeZone,
  calendarDateString,
  calendarTimeString,
} = require('../services/businessTimezone');
const {
  ensureMediaDir,
  resolveStoredPath,
  isInsideMediaDir,
} = require('../services/scheduledMedia');
const { DEFAULT_AUDIENCE } = require('../services/contentScheduleRunner');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function staffTimeZone(req) {
  return normalizeTimeZone(req.user?.timezone);
}

const imageUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, ensureMediaDir());
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 80 },
  fileFilter(_req, file, cb) {
    const ok =
      typeof file.mimetype === 'string' &&
      /^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.mimetype);
    if (!ok) {
      return cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
    }
    return cb(null, true);
  },
});

function asIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function mapJob(row) {
  return {
    id: row.id,
    kind: row.kind,
    creatorId: row.creatorId,
    creatorName: row.displayName || null,
    platform: row.platform,
    runAt: row.runAt,
    status: row.status,
    bodyText: row.bodyText,
    imageFileName: row.imageFileName,
    hasImage: Boolean(row.storedPath),
    payload: row.payload || {},
    lastError: row.lastError,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapSettings(row, creatorId) {
  return {
    creatorId,
    audienceFilters: asIdList(row?.audienceFilters).length
      ? asIdList(row.audienceFilters)
      : DEFAULT_AUDIENCE,
    includeListIds: asIdList(row?.includeListIds),
    excludeListIds: asIdList(row?.excludeListIds),
    categoryIds: asIdList(row?.categoryIds).slice(0, 3),
  };
}

async function accessibleCreatorIds(user) {
  if (userSeesAllCreators(user)) return null;
  const result = await pool.query(
    `SELECT "creatorId" FROM creator_staff_assignments WHERE "userId" = $1`,
    [user.id]
  );
  return result.rows.map((row) => row.creatorId);
}

function normalizePlatform(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === '4based' || raw === 'fourbased') return '4based';
  if (raw === 'maloum') return 'maloum';
  return null;
}

function detectKind(entry) {
  const explicit = String(entry?.type || entry?.kind || '').trim().toLowerCase();
  if (explicit === 'mass_message' || explicit === 'mass-message') return 'mass_message';
  if (explicit === 'feed_post' || explicit === 'feed' || explicit === 'post') {
    return 'feed_post';
  }
  if (entry?.image_file || entry?.imageFile || entry?.caption) return 'feed_post';
  if (entry?.mass_message || entry?.message || entry?.massMessage) {
    return 'mass_message';
  }
  return null;
}

function parseImportEntries(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    parsed = JSON.parse(raw);
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) {
    return parsed.jobs;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  throw new Error('JSON must be an array of jobs');
}

async function resolveCreator(modelName, platform) {
  const name = String(modelName || '').trim();
  if (!name || !platform) return { error: 'model and platform are required' };
  const result = await pool.query(
    `SELECT id, "displayName", platform
     FROM creators
     WHERE platform = $1 AND lower(trim("displayName")) = lower(trim($2::text))`,
    [platform, name]
  );
  if (result.rows.length === 0) {
    return { error: `No ${platform} creator named "${name}"` };
  }
  if (result.rows.length > 1) {
    return { error: `Multiple ${platform} creators named "${name}"` };
  }
  return { creator: result.rows[0] };
}

async function insertJob({
  kind,
  creatorId,
  platform,
  runAt,
  bodyText,
  imageFileName,
  storedPath,
  payload,
  userId,
}) {
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO scheduled_content_jobs (
       id, kind, "creatorId", platform, "runAt", status, "bodyText",
       "imageFileName", "storedPath", payload, "createdByUserId"
     ) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9::jsonb,$10)
     RETURNING *`,
    [
      id,
      kind,
      creatorId,
      platform,
      runAt,
      bodyText || '',
      imageFileName || null,
      storedPath || null,
      JSON.stringify(payload || {}),
      userId || null,
    ]
  );
  return result.rows[0];
}

async function insertAsset({ originalFileName, storedPath, mimeType, userId }) {
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO scheduled_content_assets (
       id, "originalFileName", "storedPath", "mimeType", "createdByUserId"
     ) VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [id, originalFileName || 'image', storedPath, mimeType || null, userId || null]
  );
  return result.rows[0];
}

function mapAsset(row) {
  return {
    id: row.id,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    createdAt: row.createdAt,
  };
}

function collectRowErrors(entry, {
  kind,
  platform,
  runAt,
  creator,
  creatorError,
  allowed,
  assetId,
  vaultPayload,
}) {
  const errors = [];
  if (!kind) {
    errors.push('Could not tell if this row is a mass message or feed post');
  }
  if (!platform) {
    errors.push('platform must be 4based or maloum');
  }
  if (!runAt) {
    errors.push('datetime is required');
  }
  if (creatorError) errors.push(creatorError);
  if (creator && allowed === false) {
    errors.push(`No access to ${creator.displayName}`);
  }
  if (kind === 'feed_post') {
    const hasVault =
      (platform === '4based' && vaultPayload?.vaultId) ||
      (platform === 'maloum' && (vaultPayload?.mediaId || vaultPayload?.uploadId));
    if (!assetId && !hasVault) {
      errors.push('Pick an uploaded image or a vault item');
    }
  }
  return errors;
}

router.use(authenticate, requirePermission('mass_messages.send'));

router.get('/', async (req, res) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const creatorId =
      typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';

    const allowedIds = await accessibleCreatorIds(req.user);
    const params = [];
    const where = [];
    if (allowedIds) {
      if (allowedIds.length === 0) {
        return res.json({ jobs: [] });
      }
      params.push(allowedIds);
      where.push(`j."creatorId" = ANY($${params.length}::uuid[])`);
    }
    if (from && !Number.isNaN(from.getTime())) {
      params.push(from.toISOString());
      where.push(`j."runAt" >= $${params.length}`);
    }
    if (to && !Number.isNaN(to.getTime())) {
      params.push(to.toISOString());
      where.push(`j."runAt" <= $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`j.status = $${params.length}`);
    }
    if (creatorId) {
      if (!isValidUuid(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID' });
      }
      const allowed = await userCanAccessCreator(req.user, creatorId);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      params.push(creatorId);
      where.push(`j."creatorId" = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT j.*, c."displayName"
       FROM scheduled_content_jobs j
       JOIN creators c ON c.id = j."creatorId"
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY j."runAt" ASC
       LIMIT 2000`,
      params
    );
    res.json({ jobs: result.rows.map(mapJob) });
  } catch (err) {
    console.error('List scheduled content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/settings', async (req, res) => {
  try {
    const allowedIds = await accessibleCreatorIds(req.user);
    const params = [];
    let where = '';
    if (allowedIds) {
      if (allowedIds.length === 0) {
        return res.json({ settings: [] });
      }
      params.push(allowedIds);
      where = `WHERE c.id = ANY($1::uuid[])`;
    }
    const result = await pool.query(
      `SELECT c.id, c."displayName", c.platform, s."audienceFilters",
              s."includeListIds", s."excludeListIds", s."categoryIds"
       FROM creators c
       LEFT JOIN creator_schedule_settings s ON s."creatorId" = c.id
       ${where}
       ORDER BY c."displayName" ASC`,
      params
    );
    res.json({
      settings: result.rows.map((row) => ({
        ...mapSettings(row, row.id),
        displayName: row.displayName,
        platform: row.platform,
      })),
    });
  } catch (err) {
    console.error('List schedule settings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/settings/:creatorId', async (req, res) => {
  const { creatorId } = req.params;
  if (!isValidUuid(creatorId)) {
    return res.status(400).json({ error: 'Invalid creator ID' });
  }
  try {
    const allowed = await userCanAccessCreator(req.user, creatorId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }
    const body = req.body || {};
    const audienceFilters = asIdList(body.audienceFilters);
    const includeListIds = asIdList(body.includeListIds);
    const excludeListIds = asIdList(body.excludeListIds);
    const categoryIds = asIdList(body.categoryIds).slice(0, 3);
    const result = await pool.query(
      `INSERT INTO creator_schedule_settings (
         "creatorId", "audienceFilters", "includeListIds", "excludeListIds", "categoryIds"
       ) VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb)
       ON CONFLICT ("creatorId") DO UPDATE SET
         "audienceFilters" = EXCLUDED."audienceFilters",
         "includeListIds" = EXCLUDED."includeListIds",
         "excludeListIds" = EXCLUDED."excludeListIds",
         "categoryIds" = EXCLUDED."categoryIds",
         "updatedAt" = NOW()
       RETURNING *`,
      [
        creatorId,
        JSON.stringify(audienceFilters.length ? audienceFilters : DEFAULT_AUDIENCE),
        JSON.stringify(includeListIds),
        JSON.stringify(excludeListIds),
        JSON.stringify(categoryIds),
      ]
    );
    res.json({ settings: mapSettings(result.rows[0], creatorId) });
  } catch (err) {
    console.error('Update schedule settings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/asset', async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }
  try {
    const result = await pool.query(
      `SELECT "creatorId", "storedPath", "imageFileName"
       FROM scheduled_content_jobs WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Job not found' });
    const allowed = await userCanAccessCreator(req.user, row.creatorId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }
    if (!row.storedPath || !isInsideMediaDir(row.storedPath) || !fs.existsSync(row.storedPath)) {
      return res.status(404).json({ error: 'Image not found' });
    }
    res.sendFile(path.resolve(row.storedPath));
  } catch (err) {
    console.error('Get scheduled asset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', (req, res, next) => {
  imageUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    return next();
  });
}, async (req, res) => {
  try {
    const body = req.body || {};
    const kind = body.kind === 'feed_post' ? 'feed_post' : 'mass_message';
    const platform = normalizePlatform(body.platform);
    const creatorId = String(body.creatorId || '').trim();
    const runAt = parseBusinessDateTime(body.runAt || body.datetime, staffTimeZone(req));
    if (!isValidUuid(creatorId)) {
      return res.status(400).json({ error: 'creatorId is required' });
    }
    if (!platform) {
      return res.status(400).json({ error: 'platform must be 4based or maloum' });
    }
    if (!runAt) {
      return res.status(400).json({ error: 'runAt / datetime is required' });
    }
    const allowed = await userCanAccessCreator(req.user, creatorId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }
    const creator = await pool.query(
      `SELECT id, platform, "displayName" FROM creators WHERE id = $1`,
      [creatorId]
    );
    if (!creator.rows[0] || creator.rows[0].platform !== platform) {
      return res.status(400).json({ error: 'Creator does not match platform' });
    }

    let payload = {};
    if (typeof body.payload === 'string' && body.payload.trim()) {
      try {
        payload = JSON.parse(body.payload);
      } catch {
        return res.status(400).json({ error: 'payload must be JSON' });
      }
    } else if (body.payload && typeof body.payload === 'object') {
      payload = body.payload;
    }

    const row = await insertJob({
      kind,
      creatorId,
      platform,
      runAt,
      bodyText: String(body.bodyText || body.message || body.caption || ''),
      imageFileName: req.file?.originalname || body.imageFileName || null,
      storedPath: req.file?.path || null,
      payload,
      userId: req.user.id,
    });
    res.status(201).json({ job: mapJob({ ...row, displayName: creator.rows[0].displayName }) });
  } catch (err) {
    console.error('Create scheduled content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/assets/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid asset ID' });
  }
  try {
    const result = await pool.query(
      `SELECT * FROM scheduled_content_assets WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Asset not found' });
    if (row.createdByUserId && row.createdByUserId !== req.user.id) {
      return res.status(403).json({ error: 'You do not have access to this asset' });
    }
    if (!row.storedPath || !isInsideMediaDir(row.storedPath) || !fs.existsSync(row.storedPath)) {
      return res.status(404).json({ error: 'Image not found' });
    }
    res.sendFile(path.resolve(row.storedPath));
  } catch (err) {
    console.error('Get scheduled preview asset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/assets', (req, res, next) => {
  imageUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    return next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }
    const row = await insertAsset({
      originalFileName: req.file.originalname,
      storedPath: req.file.path,
      mimeType: req.file.mimetype,
      userId: req.user.id,
    });
    res.status(201).json({ asset: mapAsset(row) });
  } catch (err) {
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        // ignore
      }
    }
    console.error('Upload scheduled asset error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/import', (req, res, next) => {
  imageUpload.array('files', 80)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    return next();
  });
}, async (req, res) => {
  const uploaded = Array.isArray(req.files) ? req.files : [];
  const tz = staffTimeZone(req);
  try {
    let rawJobs = req.body?.jobs;
    if (!rawJobs && req.body?.json) rawJobs = req.body.json;
    if (!rawJobs) {
      return res.status(400).json({ error: 'jobs JSON is required' });
    }
    const entries = parseImportEntries(rawJobs);
    const assets = [];
    const filesByName = new Map();
    for (const file of uploaded) {
      const row = await insertAsset({
        originalFileName: file.originalname,
        storedPath: file.path,
        mimeType: file.mimetype,
        userId: req.user.id,
      });
      const mapped = mapAsset(row);
      assets.push(mapped);
      const key = String(file.originalname || '').trim().toLowerCase();
      if (key && !filesByName.has(key)) filesByName.set(key, mapped);
    }

    const rows = [];
    const usedNames = new Set();

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] || {};
      const platform = normalizePlatform(entry.platform);
      const kind = detectKind(entry);
      const rawDate = entry.datetime || entry.runAt || entry.date;
      const runAt = parseBusinessDateTime(rawDate, tz);
      const model = String(entry.model || entry.creator || entry.displayName || '').trim();
      const resolved = platform ? await resolveCreator(model, platform) : { error: null, creator: null };
      const creator = resolved.creator || null;
      let allowed = null;
      if (creator) {
        allowed = await userCanAccessCreator(req.user, creator.id);
      }

      const bodyText =
        kind === 'feed_post'
          ? String(entry.caption || entry.bodyText || '')
          : String(entry.mass_message || entry.message || entry.bodyText || '');

      const fileName = String(entry.image_file || entry.imageFile || '').trim();
      const matched = fileName ? filesByName.get(fileName.toLowerCase()) : null;
      if (matched) usedNames.add(fileName.toLowerCase());

      const errors = collectRowErrors(entry, {
        kind,
        platform,
        runAt,
        creator,
        creatorError: resolved.error || (!model && platform ? 'model is required' : null),
        allowed,
        assetId: matched?.id || null,
        vaultPayload: null,
      });

      rows.push({
        index,
        included: errors.length === 0,
        kind,
        platform,
        model,
        creatorId: creator && allowed ? creator.id : null,
        creatorName: creator && allowed ? creator.displayName : null,
        date: runAt ? calendarDateString(runAt, tz) : '',
        time: runAt ? calendarTimeString(runAt, tz) : '',
        runAt: runAt ? runAt.toISOString() : null,
        bodyText,
        imageFileName: fileName || matched?.originalFileName || null,
        assetId: kind === 'feed_post' ? matched?.id || null : null,
        errors,
      });
    }

    const unusedFiles = assets
      .filter((asset) => !usedNames.has(String(asset.originalFileName || '').toLowerCase()))
      .map((asset) => asset.originalFileName);

    res.json({
      rows,
      assets,
      unusedFiles,
      timeZone: tz,
    });
  } catch (err) {
    for (const file of uploaded) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        // ignore
      }
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    console.error('Preview scheduled content import error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.post('/import/commit', async (req, res) => {
  const tz = staffTimeZone(req);
  try {
    const incoming = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (incoming.length === 0) {
      return res.status(400).json({ error: 'rows are required' });
    }

    const created = [];
    const errors = [];

    for (let index = 0; index < incoming.length; index += 1) {
      const entry = incoming[index] || {};
      if (entry.included === false || entry.include === false) continue;

      const kind = entry.kind === 'feed_post' ? 'feed_post' : entry.kind === 'mass_message' ? 'mass_message' : null;
      const platform = normalizePlatform(entry.platform);
      const creatorId = String(entry.creatorId || '').trim();
      const runAt = parseBusinessDateTime(
        entry.runAt ||
          (entry.date && entry.time ? `${entry.date} ${entry.time}` : entry.datetime),
        tz
      );
      const bodyText = String(entry.bodyText || entry.caption || entry.message || '');
      let payload = {};
      if (entry.payload && typeof entry.payload === 'object') {
        payload = entry.payload;
      }

      if (!kind || !platform || !isValidUuid(creatorId) || !runAt) {
        errors.push({
          index,
          error: !runAt ? 'datetime is required' : 'kind, platform, and creator are required',
        });
        continue;
      }

      const allowed = await userCanAccessCreator(req.user, creatorId);
      if (!allowed) {
        errors.push({ index, error: 'You do not have access to this creator' });
        continue;
      }
      const creator = await pool.query(
        `SELECT id, platform, "displayName" FROM creators WHERE id = $1`,
        [creatorId]
      );
      if (!creator.rows[0] || creator.rows[0].platform !== platform) {
        errors.push({ index, error: 'Creator does not match platform' });
        continue;
      }

      let storedPath = null;
      let imageFileName = null;
      const assetId = typeof entry.assetId === 'string' ? entry.assetId.trim() : '';
      const hasVault =
        (platform === '4based' && payload.vaultId) ||
        (platform === 'maloum' && (payload.mediaId || payload.uploadId));

      if (kind === 'feed_post') {
        if (assetId) {
          if (!isValidUuid(assetId)) {
            errors.push({ index, error: 'Invalid asset ID' });
            continue;
          }
          const asset = await pool.query(
            `SELECT * FROM scheduled_content_assets WHERE id = $1`,
            [assetId]
          );
          const row = asset.rows[0];
          if (
            !row ||
            (row.createdByUserId && row.createdByUserId !== req.user.id) ||
            !row.storedPath ||
            !isInsideMediaDir(row.storedPath) ||
            !fs.existsSync(row.storedPath)
          ) {
            errors.push({ index, error: 'Uploaded image not found' });
            continue;
          }
          const dest = resolveStoredPath(`${randomUUID()}${path.extname(row.storedPath)}`);
          fs.copyFileSync(row.storedPath, dest);
          storedPath = dest;
          imageFileName = row.originalFileName;
        } else if (!hasVault) {
          errors.push({ index, error: 'Pick an uploaded image or a vault item' });
          continue;
        }
      }

      const row = await insertJob({
        kind,
        creatorId,
        platform,
        runAt,
        bodyText,
        imageFileName,
        storedPath,
        payload: kind === 'feed_post' ? payload : {},
        userId: req.user.id,
      });
      created.push(mapJob({ ...row, displayName: creator.rows[0].displayName }));
    }

    res.status(201).json({ jobs: created, errors });
  } catch (err) {
    console.error('Commit scheduled content import error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }
  try {
    const existing = await pool.query(
      `SELECT j.*, c."displayName", c.platform AS "creatorPlatform"
       FROM scheduled_content_jobs j
       JOIN creators c ON c.id = j."creatorId"
       WHERE j.id = $1`,
      [id]
    );
    const row = existing.rows[0];
    if (!row) return res.status(404).json({ error: 'Job not found' });
    const allowed = await userCanAccessCreator(req.user, row.creatorId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }
    if (row.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending jobs can be updated' });
    }
    const runAt = req.body?.runAt
      ? parseBusinessDateTime(req.body.runAt, staffTimeZone(req))
      : row.runAt;
    if (!runAt) {
      return res.status(400).json({ error: 'Invalid runAt' });
    }
    const bodyText =
      req.body?.bodyText != null ? String(req.body.bodyText) : row.bodyText;
    const updated = await pool.query(
      `UPDATE scheduled_content_jobs
       SET "runAt" = $2, "bodyText" = $3, "updatedAt" = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, runAt, bodyText]
    );
    res.json({ job: mapJob({ ...updated.rows[0], displayName: row.displayName }) });
  } catch (err) {
    console.error('Update scheduled content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/cancel', async (req, res) => {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }
  try {
    const existing = await pool.query(
      `SELECT * FROM scheduled_content_jobs WHERE id = $1`,
      [id]
    );
    const row = existing.rows[0];
    if (!row) return res.status(404).json({ error: 'Job not found' });
    const allowed = await userCanAccessCreator(req.user, row.creatorId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have access to this creator' });
    }
    if (row.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending jobs can be cancelled' });
    }
    await pool.query(
      `UPDATE scheduled_content_jobs
       SET status = 'cancelled', "updatedAt" = NOW()
       WHERE id = $1`,
      [id]
    );
    if (row.storedPath && isInsideMediaDir(row.storedPath)) {
      try {
        fs.unlinkSync(row.storedPath);
      } catch {
        // ignore
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Cancel scheduled content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
