const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { prepareFeedPhoto } = require('../services/imageOrient');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
} = require('../services/crypto');
const {
  userCanAccessCreator,
  getUserIdsWithCreatorAccess,
} = require('../services/creatorAccess');
const fourBasedClient = require('../services/fourBasedClient');
const {
  scheduleHistoryArchive,
  scheduleSentArchive,
} = require('../services/fanChatArchive');
const { applyModeration } = require('../services/contentModeration');
const { upsertMessageUnsend } = require('../services/messageUnsend');
const messagingDashboard = require('./messagingDashboard');
const {
  scheduleThrottledReconcile,
} = require('../services/salePayoutReconciler');
const massMessageUnsendAllRunner = require('../services/massMessageUnsendAllRunner');
const {
  isLocked: isMassMessageLocked,
  isChatCopyLocked,
  LOCKED_MESSAGE,
} = require('../services/massMessageLocks');
const {
  connectCreatorById,
  ensureCreatorSocket,
} = require('../services/fourBasedSocket');
const fourBasedMediaCache = require('../services/fourBasedMediaCache');
const { randomUUID } = require('crypto');
const fanCrmActivity = require('../services/fanCrmActivity');
const {
  isValidUuid,
  readCustomProxy,
  toCreator,
  connectLimiter,
  encryptCustomProxy,
  decryptStoredProxy,
  encryptOptionalLoginPassword,
  CREATOR_SELECT_COLUMNS,
  emitCreatorSessionUpdated,
} = require('./creators');

const router = express.Router();

const BADGE_SIDE_EFFECT_MIN_MS = 60_000;
const lastBadgeSideEffectAt = new Map();

function scheduleBadgeSideEffects(creatorId, work) {
  if (!creatorId) return;
  const last = lastBadgeSideEffectAt.get(creatorId) || 0;
  if (Date.now() - last < BADGE_SIDE_EFFECT_MIN_MS) return;
  lastBadgeSideEffectAt.set(creatorId, Date.now());
  setImmediate(() => {
    Promise.resolve()
      .then(work)
      .catch((err) => {
        console.warn(
          'Badge side effects failed:',
          creatorId,
          err.message || err
        );
      });
  });
}

const fourBasedPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
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
  } catch (err) {
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

function extractFourBasedChat(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload._id) return payload;
  if (payload.chat && payload.chat._id) return payload.chat;
  if (payload.data && payload.data._id) return payload.data;
  if (Array.isArray(payload) && payload[0]?._id) return payload[0];
  if (Array.isArray(payload.items) && payload.items[0]?._id) return payload.items[0];
  return null;
}

function handleFourBasedError(res, err, label) {
  if (err instanceof fourBasedClient.WrongPasswordError) {
    return res.status(400).json({ error: 'Password not correct' });
  }
  if (err instanceof fourBasedClient.FourBasedApiError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({ error: err.message || '4based request failed' });
  }
  console.error(label, err);
  return res.status(500).json({ error: 'Internal server error' });
}

/** Single-flight media-session refresh per creator (mint fresh media_jwt via re-login). */
const fourBasedMediaSessionRefreshInflight = new Map();

/**
 * Re-login with saved credentials and persist cookies (including media_jwt).
 * Returns a fresh loadFourBasedCreator() result or { error }.
 */
async function refreshFourBasedSessionFromSaved(creatorId) {
  const existing = fourBasedMediaSessionRefreshInflight.get(creatorId);
  if (existing) return existing;

  const promise = (async () => {
    const result = await pool.query(
      `SELECT id, platform, "loginEmail", "encryptedLoginPassword", "encryptedProxy",
              "accountId"
       FROM creators WHERE id = $1`,
      [creatorId]
    );
    if (result.rows.length === 0) {
      return { error: { status: 404, message: 'Creator not found' } };
    }
    const row = result.rows[0];
    if (row.platform !== '4based') {
      return { error: { status: 400, message: 'Creator is not a 4based account' } };
    }
    if (!row.loginEmail || !row.encryptedLoginPassword) {
      return {
        error: {
          status: 401,
          message:
            'Protected media auth expired and no saved credentials to refresh. Reconnect the 4based account.',
        },
      };
    }

    const loginPassword = decryptSecret(row.encryptedLoginPassword);
    if (!loginPassword) {
      return {
        error: {
          status: 401,
          message:
            'Protected media auth expired and saved credentials are unreadable. Reconnect the 4based account.',
        },
      };
    }

    const storedProxy = row.encryptedProxy ? decryptSecret(row.encryptedProxy) : null;
    let resolvedProxy;
    try {
      resolvedProxy = fourBasedClient.resolveFourBasedProxyUrl(storedProxy);
    } catch (err) {
      if (err instanceof fourBasedClient.FourBasedApiError) {
        return { error: { status: err.status || 400, message: err.message } };
      }
      throw err;
    }

    let loginResult;
    try {
      loginResult = await fourBasedClient.login({
        identifier: row.loginEmail.trim(),
        password: loginPassword,
        proxyUrl: resolvedProxy,
      });
    } catch (err) {
      if (err instanceof fourBasedClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
        return { error: { status: 400, message: 'Password not correct' } };
      }
      if (err instanceof fourBasedClient.FourBasedApiError) {
        return {
          error: {
            status: err.status >= 400 && err.status < 600 ? err.status : 502,
            message: err.message || '4based login failed',
          },
        };
      }
      throw err;
    }

    if (!fourBasedClient.hasMediaJwt(loginResult.cookies)) {
      console.warn(
        `[4based] media session refresh for ${creatorId} still missing media_jwt`
      );
    }

    const loginEmail = row.loginEmail.trim();
    const sessionPayload = {
      cookies: loginResult.cookies,
      token: loginResult.token,
      resource: loginResult.resource,
      providerUserId: loginResult.providerUserId,
      loginEmail,
      savedAt: new Date().toISOString(),
      platform: '4based',
    };
    const encryptedSession = encryptJson(sessionPayload);
    const encryptedAccessToken = encryptSecret(loginResult.token);

    await pool.query(
      `UPDATE creators SET
         "encryptedSession" = $1,
         "encryptedAccessToken" = $2,
         "providerUserId" = $3,
         "loginEmail" = $4,
         username = COALESCE($5, username),
         "avatarUrl" = COALESCE($6, "avatarUrl"),
         "postLoginUrl" = $7,
         "connectionStatus" = 'connected',
         "lastValidatedAt" = NOW(),
         "authRefreshState" = 'active',
         "updatedAt" = NOW()
       WHERE id = $8`,
      [
        encryptedSession,
        encryptedAccessToken,
        loginResult.providerUserId,
        loginEmail,
        loginResult.username,
        loginResult.avatarUrl,
        loginResult.postLoginUrl,
        creatorId,
      ]
    );

    const accessUserIds = await getUserIdsWithCreatorAccess(creatorId);
    emitCreatorSessionUpdated(accessUserIds, {
      creatorId,
      accountId: row.accountId,
      sessionUpdatedAt: sessionPayload.savedAt,
    });

    return loadFourBasedCreator(creatorId);
  })();

  fourBasedMediaSessionRefreshInflight.set(creatorId, promise);
  try {
    return await promise;
  } finally {
    fourBasedMediaSessionRefreshInflight.delete(creatorId);
  }
}

/**
 * Ensure creator has a usable media_jwt.
 * - force: always re-login (e.g. after upstream 401)
 * - otherwise: only refresh when media_jwt exists but is within 1h of expiry
 *   (missing media_jwt is not re-logged on every request — that would spam if proxy strips cookies)
 */
async function ensureFourBasedMediaAuth(creatorId, creator, { force = false } = {}) {
  const cookies = creator?.session?.cookies || {};
  if (!force) {
    const hasJwt = fourBasedClient.hasMediaJwt(cookies);
    if (!hasJwt || !fourBasedClient.isMediaJwtStale(cookies)) {
      return { creator };
    }
  }
  console.info(
    `[4based] refreshing media session for ${creatorId} (force=${force}, hasMediaJwt=${fourBasedClient.hasMediaJwt(cookies)})`
  );
  return refreshFourBasedSessionFromSaved(creatorId);
}

/** Max concurrent upstream media fetches per creator (cache hits unaffected). */
const FOURBASED_MEDIA_UPSTREAM_CONCURRENCY = Math.max(
  1,
  Number(process.env.FOURBASED_MEDIA_UPSTREAM_CONCURRENCY) || 5
);

/** @type {Map<string, { active: number, queue: Array<() => void> }>} */
const fourBasedMediaSemaphores = new Map();

/** In-flight full-file downloads keyed by creatorId\\npath — single-flight de-dupe. */
const fourBasedMediaInflight = new Map();

function acquireFourBasedMediaSlot(creatorId) {
  let state = fourBasedMediaSemaphores.get(creatorId);
  if (!state) {
    state = { active: 0, queue: [] };
    fourBasedMediaSemaphores.set(creatorId, state);
  }
  if (state.active < FOURBASED_MEDIA_UPSTREAM_CONCURRENCY) {
    state.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.queue.push(resolve);
  }).then(() => {
    state.active += 1;
  });
}

function releaseFourBasedMediaSlot(creatorId) {
  const state = fourBasedMediaSemaphores.get(creatorId);
  if (!state) return;
  state.active = Math.max(0, state.active - 1);
  const next = state.queue.shift();
  if (next) next();
  if (state.active === 0 && state.queue.length === 0) {
    fourBasedMediaSemaphores.delete(creatorId);
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainUpstreamBody(body) {
  if (!body) return;
  try {
    const { Readable } = require('stream');
    Readable.fromWeb(body).resume();
  } catch {
    // ignore
  }
}

async function fetchFourBasedMediaThrottled(creator, { path, rangeHeader } = {}) {
  await acquireFourBasedMediaSlot(creator.id);
  try {
    let lastErr;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const upstream = await fourBasedClient.fetchMedia(creator, {
          path,
          rangeHeader,
        });
        if (upstream.ok || upstream.status === 206) {
          return upstream;
        }
        const status = upstream.status || 0;
        lastErr = new fourBasedClient.FourBasedApiError(
          `Failed to fetch media (${status || 'no status'})`,
          status || 502
        );
        await drainUpstreamBody(upstream.body);
        // Retry transient upstream / proxy pressure; don't hammer 404s.
        if (status === 404 || status === 400 || status === 401) {
          throw lastErr;
        }
        if (attempt < maxAttempts - 1) {
          await sleepMs(250 * (attempt + 1));
        }
      } catch (err) {
        lastErr = err;
        if (
          err instanceof fourBasedClient.FourBasedApiError &&
          (err.status === 404 || err.status === 400 || err.status === 401)
        ) {
          throw err;
        }
        if (attempt < maxAttempts - 1) {
          await sleepMs(250 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('Failed to fetch media');
  } finally {
    releaseFourBasedMediaSlot(creator.id);
  }
}

function parseBytesRange(rangeHeader, size) {
  if (!rangeHeader || typeof rangeHeader !== 'string' || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start == null && end == null) return null;
  if (start == null) {
    // suffix: last N bytes
    const suffix = end;
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) return null;
    if (end == null || !Number.isFinite(end)) end = size - 1;
    if (end >= size) end = size - 1;
    if (start > end) return null;
  }
  return { start, end };
}

function setFourBasedMediaCommonHeaders(res, { contentType, etag, cacheStatus }) {
  if (contentType) res.setHeader('Content-Type', contentType);
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Cache-Control',
    'private, max-age=86400, stale-while-revalidate=604800'
  );
  res.setHeader('X-DomX-Media-Cache', cacheStatus);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function sendFourBasedCachedFile(res, cached, rangeHeader, cacheStatus = 'HIT') {
  const fs = require('fs');
  const size = cached.size;
  const range = parseBytesRange(rangeHeader, size);
  setFourBasedMediaCommonHeaders(res, {
    contentType: cached.contentType,
    etag: cached.etag,
    cacheStatus,
  });

  if (range) {
    const chunkSize = range.end - range.start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(chunkSize));
    const stream = fs.createReadStream(cached.binPath, {
      start: range.start,
      end: range.end,
    });
    stream.on('error', (err) => {
      console.warn('4based media cache stream error:', err.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(err);
    });
    stream.pipe(res);
    return;
  }

  res.status(200);
  res.setHeader('Content-Length', String(size));
  const stream = fs.createReadStream(cached.binPath);
  stream.on('error', (err) => {
    console.warn('4based media cache stream error:', err.message);
    if (!res.headersSent) res.status(502).end();
    else res.destroy(err);
  });
  stream.pipe(res);
}

async function fetchFourBasedMediaWithAuthRetry(creatorId, creator, { path, rangeHeader } = {}) {
  let activeCreator = creator;
  const ensured = await ensureFourBasedMediaAuth(creatorId, activeCreator);
  if (ensured.error) {
    // Proceed with existing session; may still work via x-auth headers.
    console.warn(
      `[4based] media auth ensure failed for ${creatorId}:`,
      ensured.error.message
    );
  } else if (ensured.creator) {
    activeCreator = ensured.creator;
  }

  let upstream = await fetchFourBasedMediaThrottled(activeCreator, {
    path,
    rangeHeader,
  });

  if (upstream.status === 401) {
    try {
      if (upstream.body) {
        const { Readable } = require('stream');
        Readable.fromWeb(upstream.body).resume();
      }
    } catch {
      // ignore
    }
    const refreshed = await ensureFourBasedMediaAuth(creatorId, activeCreator, {
      force: true,
    });
    if (refreshed.error) {
      throw new fourBasedClient.FourBasedApiError(
        refreshed.error.message ||
          'Failed to refresh 4based media auth (401). Reconnect the account.',
        refreshed.error.status || 401
      );
    }
    activeCreator = refreshed.creator;
    if (!fourBasedClient.hasMediaJwt(activeCreator?.session?.cookies || {})) {
      console.warn(
        `[4based] media_jwt still missing after reconnect for ${creatorId}; retrying with x-auth headers`
      );
    }
    upstream = await fetchFourBasedMediaThrottled(activeCreator, {
      path,
      rangeHeader,
    });
    if (upstream.status === 401) {
      try {
        if (upstream.body) {
          const { Readable } = require('stream');
          Readable.fromWeb(upstream.body).resume();
        }
      } catch {
        // ignore
      }
      throw new fourBasedClient.FourBasedApiError(
        'Failed to fetch media (401). media_jwt missing or rejected — reconnect the account; if login logs show no media_jwt, the proxy may be stripping Set-Cookie.',
        401
      );
    }
  }

  return { upstream, creator: activeCreator };
}

/**
 * Download full media file through residential proxy once, write to disk cache,
 * and resolve with the cached path metadata. Single-flight per creator+path.
 */
async function downloadFourBasedMediaToCache(creator, creatorId, mediaPath) {
  const flightKey = `${creatorId}\n${mediaPath}`;
  const existing = fourBasedMediaInflight.get(flightKey);
  if (existing) return existing;

  const promise = (async () => {
    const fs = require('fs');
    const fsp = require('fs/promises');
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');

    // Re-check cache in case another request finished while we waited for the slot.
    const already = await fourBasedMediaCache.readCachePath(creatorId, mediaPath);
    if (already) return already;

    const { upstream } = await fetchFourBasedMediaWithAuthRetry(creatorId, creator, {
      path: mediaPath,
      rangeHeader: null,
    });
    if (!upstream.ok || !upstream.body) {
      throw new fourBasedClient.FourBasedApiError(
        `Failed to fetch media (${upstream.status || 'no status'})`,
        upstream.status || 502
      );
    }

    const contentType =
      upstream.headers.get('content-type') || 'application/octet-stream';
    const etag = upstream.headers.get('etag') || null;
    const tmpPath = fourBasedMediaCache.tempDownloadPath(creatorId, mediaPath);
    const maxBytes = fourBasedMediaCache.maxBytesForPath(mediaPath);
    let written = 0;

    try {
      const nodeStream = Readable.fromWeb(upstream.body);
      const writeStream = fs.createWriteStream(tmpPath);
      nodeStream.on('data', (chunk) => {
        written += chunk.length;
        if (written > maxBytes) {
          nodeStream.destroy(new Error('Media exceeds cache size limit'));
        }
      });
      await pipeline(nodeStream, writeStream);
      const committed = await fourBasedMediaCache.commitTempFile(
        creatorId,
        mediaPath,
        tmpPath,
        { contentType, etag, size: written }
      );
      if (!committed) {
        throw new Error('Failed to commit media to cache');
      }
      const cached = await fourBasedMediaCache.readCachePath(creatorId, mediaPath);
      if (!cached) {
        throw new Error('Media cache miss after commit');
      }
      return cached;
    } catch (err) {
      void fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }
  })();

  fourBasedMediaInflight.set(flightKey, promise);
  try {
    return await promise;
  } finally {
    fourBasedMediaInflight.delete(flightKey);
  }
}

function fourBasedVaultThumbCandidatePaths(providerUserId, item) {
  const id = item?._id || item?.id;
  if (!id) return [];
  const paths = [];
  const seen = new Set();
  const pushPath = (mediaPath) => {
    if (!mediaPath || typeof mediaPath !== 'string' || seen.has(mediaPath)) return;
    seen.add(mediaPath);
    paths.push(mediaPath);
  };
  const fromPreviewUrl = (url) => {
    if (typeof url !== 'string') return null;
    if (url.includes('/protected/')) {
      const idx = url.indexOf('/protected/');
      return url.slice(idx + 1);
    }
    if (url.startsWith('https://media.4based.com/')) {
      return url.slice('https://media.4based.com/'.length);
    }
    return null;
  };
  const preview = item.preview;
  if (preview && typeof preview === 'object') {
    // Prefer 500x500 (native grid), then smaller fallbacks if that size fails.
    for (const key of [
      '500x500',
      '500x500.jpg',
      '200x200',
      '200x200.jpg',
      '100x100',
      '100x100.jpg',
    ]) {
      pushPath(fromPreviewUrl(preview[key]));
    }
  }
  pushPath(
    fourBasedClient.buildMediaPreviewPath(providerUserId, id, '500x500.jpg')
  );
  pushPath(
    fourBasedClient.buildMediaPreviewPath(providerUserId, id, '200x200.jpg')
  );
  return paths;
}

async function prewarmFourBasedVaultThumbs(creator, creatorId, items) {
  const providerUserId = creator.providerUserId;
  if (!providerUserId || !Array.isArray(items) || items.length === 0) return;

  // Give interactive vault/chat media requests a short head start.
  await sleepMs(150);

  const jobs = items
    .map((item) => fourBasedVaultThumbCandidatePaths(providerUserId, item))
    .filter((candidates) => candidates.length > 0);

  // Keep prewarm quieter than UI clicks so full-image opens win the semaphore.
  const concurrency = 2;
  let index = 0;
  async function worker() {
    while (index < jobs.length) {
      const current = index;
      index += 1;
      const candidates = jobs[current];
      for (const mediaPath of candidates) {
        try {
          const hit = await fourBasedMediaCache.readCachePath(creatorId, mediaPath);
          if (hit) break;
          await downloadFourBasedMediaToCache(creator, creatorId, mediaPath);
          break;
        } catch (err) {
          console.warn(
            '4based vault thumb prewarm failed:',
            mediaPath,
            err?.message || err
          );
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker())
  );
}

router.post(
  '/:id/4based/reconnect',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;
    const { email, password } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!password || typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const customProxy = readCustomProxy(req.body);
    if (!customProxy.ok) {
      return res.status(400).json({ error: customProxy.error });
    }

    try {
      const result = await pool.query(
        `SELECT id, platform, "accountId", "displayName", "encryptedProxy"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      if (result.rows[0].platform !== '4based') {
        return res.status(400).json({ error: 'Creator is not a 4based account' });
      }

      const storedProxy = decryptStoredProxy(result.rows[0].encryptedProxy);
      let resolvedProxy;
      try {
        resolvedProxy = fourBasedClient.resolveFourBasedProxyUrl(
          customProxy.provided ? customProxy.proxyUrl : storedProxy
        );
      } catch (err) {
        if (err instanceof fourBasedClient.FourBasedApiError) {
          return res.status(err.status || 400).json({ error: err.message });
        }
        throw err;
      }

      let loginResult;
      try {
        loginResult = await fourBasedClient.login({
          identifier: email.trim(),
          password,
          proxyUrl: resolvedProxy,
        });
      } catch (err) {
        if (err instanceof fourBasedClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
          return res.status(400).json({ error: 'Password not correct' });
        }
        if (err instanceof fourBasedClient.FourBasedApiError) {
          return res
            .status(err.status >= 400 && err.status < 600 ? err.status : 502)
            .json({ error: err.message || '4based login failed' });
        }
        throw err;
      }

      const loginEmail = email.trim();
      const sessionPayload = {
        cookies: loginResult.cookies,
        token: loginResult.token,
        resource: loginResult.resource,
        providerUserId: loginResult.providerUserId,
        loginEmail,
        savedAt: new Date().toISOString(),
        platform: '4based',
      };
      const encryptedSession = encryptJson(sessionPayload);
      const encryptedAccessToken = encryptSecret(loginResult.token);
      const encryptedProxy = encryptCustomProxy(customProxy.provided, resolvedProxy);
      const encryptedLoginPassword = encryptOptionalLoginPassword(password);

      const updated = await pool.query(
        `UPDATE creators SET
           "encryptedSession" = $1,
           "encryptedAccessToken" = $2,
           "encryptedProxy" = CASE WHEN $3::boolean THEN $4 ELSE "encryptedProxy" END,
           "providerUserId" = $5,
           "loginEmail" = $6,
           "encryptedLoginPassword" = COALESCE($7, "encryptedLoginPassword"),
           username = COALESCE($8, username),
           "avatarUrl" = COALESCE($9, "avatarUrl"),
           "postLoginUrl" = $10,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "updatedAt" = NOW()
         WHERE id = $11
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        [
          encryptedSession,
          encryptedAccessToken,
          customProxy.provided,
          encryptedProxy,
          loginResult.providerUserId,
          loginEmail,
          encryptedLoginPassword ?? null,
          loginResult.username,
          loginResult.avatarUrl,
          loginResult.postLoginUrl,
          id,
        ]
      );

      void connectCreatorById(id).catch((err) => {
        console.warn('[4based] Failed to reopen socket after reconnect:', err.message);
      });

      const accessUserIds = await getUserIdsWithCreatorAccess(id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: id,
        accountId: updated.rows[0].accountId,
        sessionUpdatedAt: sessionPayload.savedAt,
      });

      res.json({ creator: toCreator(updated.rows[0]) });
    } catch (err) {
      console.error('Reconnect 4based creator error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/4based/reconnect-saved',
  authenticate,
  requirePermission('creators.manage'),
  connectLimiter,
  async (req, res) => {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const result = await pool.query(
        `SELECT id, platform, "accountId", "displayName", "loginEmail",
                "encryptedLoginPassword", "encryptedProxy"
         FROM creators WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Creator not found' });
      }
      const row = result.rows[0];
      if (row.platform !== '4based') {
        return res.status(400).json({ error: 'Creator is not a 4based account' });
      }
      if (!row.loginEmail || !row.encryptedLoginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      const loginPassword = decryptSecret(row.encryptedLoginPassword);
      if (!loginPassword) {
        return res.status(404).json({ error: 'No saved credentials for this creator' });
      }

      const storedProxy = row.encryptedProxy ? decryptSecret(row.encryptedProxy) : null;
      let resolvedProxy;
      try {
        resolvedProxy = fourBasedClient.resolveFourBasedProxyUrl(storedProxy);
      } catch (err) {
        if (err instanceof fourBasedClient.FourBasedApiError) {
          return res.status(err.status || 400).json({ error: err.message });
        }
        throw err;
      }

      let loginResult;
      try {
        loginResult = await fourBasedClient.login({
          identifier: row.loginEmail.trim(),
          password: loginPassword,
          proxyUrl: resolvedProxy,
        });
      } catch (err) {
        if (err instanceof fourBasedClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
          return res.status(400).json({ error: 'Password not correct' });
        }
        if (err instanceof fourBasedClient.FourBasedApiError) {
          return res
            .status(err.status >= 400 && err.status < 600 ? err.status : 502)
            .json({ error: err.message || '4based login failed' });
        }
        throw err;
      }

      const loginEmail = row.loginEmail.trim();
      const sessionPayload = {
        cookies: loginResult.cookies,
        token: loginResult.token,
        resource: loginResult.resource,
        providerUserId: loginResult.providerUserId,
        loginEmail,
        savedAt: new Date().toISOString(),
        platform: '4based',
      };
      const encryptedSession = encryptJson(sessionPayload);
      const encryptedAccessToken = encryptSecret(loginResult.token);

      const updated = await pool.query(
        `UPDATE creators SET
           "encryptedSession" = $1,
           "encryptedAccessToken" = $2,
           "providerUserId" = $3,
           "loginEmail" = $4,
           username = COALESCE($5, username),
           "avatarUrl" = COALESCE($6, "avatarUrl"),
           "postLoginUrl" = $7,
           "connectionStatus" = 'connected',
           "lastValidatedAt" = NOW(),
           "authRefreshState" = 'active',
           "updatedAt" = NOW()
         WHERE id = $8
         RETURNING ${CREATOR_SELECT_COLUMNS}`,
        [
          encryptedSession,
          encryptedAccessToken,
          loginResult.providerUserId,
          loginEmail,
          loginResult.username,
          loginResult.avatarUrl,
          loginResult.postLoginUrl,
          id,
        ]
      );

      void connectCreatorById(id).catch((err) => {
        console.warn('[4based] Failed to reopen socket after reconnect-saved:', err.message);
      });

      const accessUserIds = await getUserIdsWithCreatorAccess(id);
      emitCreatorSessionUpdated(accessUserIds, {
        creatorId: id,
        accountId: updated.rows[0].accountId,
        sessionUpdatedAt: sessionPayload.savedAt,
      });

      res.json({ creator: toCreator(updated.rows[0]) });
    } catch (err) {
      console.error('Reconnect-saved 4based creator error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/:id/4based/chats',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      void ensureCreatorSocket(id);
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const searchRaw =
        typeof req.query.search === 'string' ? req.query.search.trim() : '';
      if (searchRaw && searchRaw.length < 3) {
        return res.status(400).json({
          error: 'Search must be at least 3 characters.',
        });
      }
      const userName = searchRaw || undefined;
      const filterRaw =
        typeof req.query.filter === 'string' ? req.query.filter.trim() : '';
      const listId =
        typeof req.query.listId === 'string' && req.query.listId.trim()
          ? req.query.listId.trim()
          : undefined;
      const listName =
        filterRaw && fourBasedClient.BUILTIN_CHAT_FILTERS.has(filterRaw)
          ? filterRaw
          : undefined;
      if (!userName && filterRaw && !listName && !listId) {
        return res.status(400).json({
          error:
            'Invalid filter. Use online, unread, read, follower, subscribers, or listId.',
        });
      }
      const chats = await fourBasedClient.listChats(loaded.creator, {
        limit,
        offset,
        listName: userName ? undefined : listName,
        userListId: userName ? undefined : listId,
        userName,
      });
      res.json({
        chats: Array.isArray(chats) ? chats : chats?.items || chats || [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based chats error:');
    }
  }
);

router.post(
  '/:id/4based/chats/:chatId/pin',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const isPinned =
        req.body?.isPinned === true ||
        req.body?.is_pinned === true ||
        req.body?.isPinned === 'true';
      const result = await fourBasedClient.pinChat(loaded.creator, chatId, isPinned);
      res.json({
        ok: true,
        isPinned,
        result: result || null,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Pin 4based chat error:');
    }
  }
);

router.get(
  '/:id/4based/user-lists',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const lists = await fourBasedClient.listUserLists(loaded.creator, {
        limit,
        offset,
      });
      res.json({ lists: Array.isArray(lists) ? lists : [] });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based user lists error:');
    }
  }
);

router.get(
  '/:id/4based/user-lists/contains/:fanId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const result = await fourBasedClient.getUserListsForFan(loaded.creator, fanId);
      res.json(result);
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based fan lists error:');
    }
  }
);

async function resolveFourBasedListName(creator, listId) {
  const target = String(listId);
  let offset = 0;
  for (let page = 0; page < 5; page += 1) {
    const lists = await fourBasedClient.listUserLists(creator, { limit: 100, offset });
    if (!Array.isArray(lists) || lists.length === 0) return '';
    const match = lists.find((list) => String(list?._id || list?.id || '') === target);
    if (match) return fanCrmActivity.textValue(match.name).trim();
    if (lists.length < 100) return '';
    offset += lists.length;
  }
  return '';
}

async function fourBasedFanListIds(creator, fanId) {
  const membership = await fourBasedClient.getUserListsForFan(creator, fanId);
  const ids = Array.isArray(membership?.userListIds) ? membership.userListIds : [];
  return new Set(ids.map((value) => String(value)));
}

router.post(
  '/:id/4based/user-lists/:listId/add',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, listId } = req.params;
    const fanId = req.body?.fanId;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!listId || !fanId || typeof fanId !== 'string') {
      return res.status(400).json({ error: 'listId and fanId are required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      let wasMember = null;
      try {
        const ids = await fourBasedFanListIds(loaded.creator, fanId);
        wasMember = ids.has(String(listId));
      } catch (err) {
        console.error('fan crm activity: 4based list membership read failed:', err);
      }

      const result = await fourBasedClient.addUserToList(
        loaded.creator,
        listId,
        fanId
      );
      if (wasMember !== true) {
        let listName = '';
        try {
          listName = await resolveFourBasedListName(loaded.creator, listId);
        } catch (err) {
          console.error('fan crm activity: 4based list name lookup failed:', err);
        }
        await fanCrmActivity.recordFanCrmEvents([
          {
            ...fanCrmActivity.actorFrom(req.user),
            creatorId: id,
            platform: '4based',
            fanId,
            action: 'list_add',
            listId: String(listId),
            listName,
            nextValue: listName || String(listId),
          },
        ]);
      }
      res.json({ ok: true, result: result || null });
    } catch (err) {
      return handleFourBasedError(res, err, 'Add 4based fan to list error:');
    }
  }
);

router.post(
  '/:id/4based/user-lists/:listId/remove',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, listId } = req.params;
    const fanId = req.body?.fanId;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!listId || !fanId || typeof fanId !== 'string') {
      return res.status(400).json({ error: 'listId and fanId are required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      let wasMember = null;
      try {
        const ids = await fourBasedFanListIds(loaded.creator, fanId);
        wasMember = ids.has(String(listId));
      } catch (err) {
        console.error('fan crm activity: 4based list membership read failed:', err);
      }

      const result = await fourBasedClient.removeUserFromList(
        loaded.creator,
        listId,
        fanId
      );
      if (wasMember !== false) {
        let listName = '';
        try {
          listName = await resolveFourBasedListName(loaded.creator, listId);
        } catch (err) {
          console.error('fan crm activity: 4based list name lookup failed:', err);
        }
        await fanCrmActivity.recordFanCrmEvents([
          {
            ...fanCrmActivity.actorFrom(req.user),
            creatorId: id,
            platform: '4based',
            fanId,
            action: 'list_remove',
            listId: String(listId),
            listName,
            previousValue: listName || String(listId),
          },
        ]);
      }
      res.json({ ok: true, result: result || null });
    } catch (err) {
      return handleFourBasedError(res, err, 'Remove 4based fan from list error:');
    }
  }
);

router.get(
  '/:id/4based/pivot/:fanId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const pivot = await fourBasedClient.getPivot(loaded.creator, fanId);
      res.json({
        pivot: pivot || null,
        alias: typeof pivot?.alias === 'string' ? pivot.alias : '',
        note: typeof pivot?.note === 'string' ? pivot.note : '',
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based pivot error:');
    }
  }
);

router.put(
  '/:id/4based/pivot/:fanId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const patch = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'alias')) {
        patch.alias = req.body.alias;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) {
        patch.note = req.body.note;
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'alias or note is required' });
      }

      let previousPivot = null;
      try {
        previousPivot = await fourBasedClient.getPivot(loaded.creator, fanId);
      } catch (err) {
        console.error('fan crm activity: 4based pivot read failed:', err);
      }

      const pivot = await fourBasedClient.updatePivot(loaded.creator, fanId, patch);
      const events = [];
      const base = {
        ...fanCrmActivity.actorFrom(req.user),
        creatorId: id,
        platform: '4based',
        fanId,
        chatId:
          typeof previousPivot?.chat_id === 'string'
            ? previousPivot.chat_id
            : typeof pivot?.chat_id === 'string'
              ? pivot.chat_id
              : null,
      };
      if (Object.prototype.hasOwnProperty.call(patch, 'alias')) {
        const previous = fanCrmActivity.textValue(previousPivot?.alias);
        const next = fanCrmActivity.textValue(pivot?.alias ?? patch.alias);
        if (!previousPivot || previous !== next) {
          events.push({
            ...base,
            action: 'rename',
            previousValue: previous,
            nextValue: next,
          });
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
        const previous = fanCrmActivity.textValue(previousPivot?.note);
        const next = fanCrmActivity.textValue(pivot?.note ?? patch.note);
        const action = previousPivot
          ? fanCrmActivity.noteAction(previous, next)
          : next.trim()
            ? 'note_add'
            : 'note_remove';
        if (action) {
          events.push({
            ...base,
            action,
            previousValue: previous,
            nextValue: next,
          });
        }
      }
      await fanCrmActivity.recordFanCrmEvents(events);
      res.json({
        pivot: pivot || null,
        alias: typeof pivot?.alias === 'string' ? pivot.alias : '',
        note: typeof pivot?.note === 'string' ? pivot.note : '',
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Update 4based pivot error:');
    }
  }
);

router.delete(
  '/:id/4based/pivot/:fanId/:field',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId, field } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }
    if (field !== 'alias' && field !== 'note') {
      return res.status(400).json({ error: 'field must be alias or note' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      let previousPivot = null;
      try {
        previousPivot = await fourBasedClient.getPivot(loaded.creator, fanId);
      } catch (err) {
        console.error('fan crm activity: 4based pivot read failed:', err);
      }

      await fourBasedClient.deletePivotField(loaded.creator, fanId, field);
      // Also clear via PUT so subsequent GET is consistent (HAR does both).
      await fourBasedClient.updatePivot(
        loaded.creator,
        fanId,
        field === 'alias' ? { alias: '' } : { note: '' }
      );
      const pivot = await fourBasedClient.getPivot(loaded.creator, fanId);
      const previous =
        field === 'alias'
          ? fanCrmActivity.textValue(previousPivot?.alias)
          : fanCrmActivity.textValue(previousPivot?.note);
      if (!previousPivot || previous.trim()) {
        const base = {
          ...fanCrmActivity.actorFrom(req.user),
          creatorId: id,
          platform: '4based',
          fanId,
          chatId: typeof previousPivot?.chat_id === 'string' ? previousPivot.chat_id : null,
          previousValue: previous,
          nextValue: '',
        };
        await fanCrmActivity.recordFanCrmEvents([
          field === 'alias'
            ? { ...base, action: 'rename' }
            : { ...base, action: 'note_remove' },
        ]);
      }
      res.json({
        ok: true,
        pivot: pivot || null,
        alias: typeof pivot?.alias === 'string' ? pivot.alias : '',
        note: typeof pivot?.note === 'string' ? pivot.note : '',
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Delete 4based pivot field error:');
    }
  }
);

router.get(
  '/:id/4based/unread',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      void ensureCreatorSocket(id);

      const unread = await fourBasedClient.getUnread(loaded.creator);
      res.json({ unread });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based unread error:');
    }
  }
);

router.get(
  '/:id/4based/badges',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      void ensureCreatorSocket(id);
      const badges = await fourBasedClient.getBadges(loaded.creator);
      res.json(badges);

      const creator = loaded.creator;
      scheduleBadgeSideEffects(id, async () => {
        const saleTipActivities = await fourBasedClient
          .listActivities(creator, {
            offset: 0,
            limit: 50,
            types: 'sale,tip',
          })
          .catch((err) => {
            console.warn(
              '4based badge sale/tip fetch failed:',
              err.message || err
            );
            return [];
          });
        try {
          await messagingDashboard.processFourBasedSaleAndTipNotifications(
            id,
            Array.isArray(saleTipActivities) ? saleTipActivities : []
          );
        } catch (err) {
          console.warn('4based sale/tip sync failed:', err.message);
        }
        try {
          await messagingDashboard.repairFourBasedPurchasedFlags(id, {
            seedActivities: Array.isArray(saleTipActivities) ? saleTipActivities : [],
            fetchSalePage: (pageOffset, pageLimit) =>
              fourBasedClient.listActivities(creator, {
                offset: pageOffset,
                limit: pageLimit,
                types: 'sale',
              }),
          });
        } catch (err) {
          console.warn('4based purchased repair failed:', err.message || err);
        }
        scheduleThrottledReconcile(id);
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based badges error:');
    }
  }
);

router.get(
  '/:id/4based/activities',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const types =
        typeof req.query.types === 'string' && req.query.types.trim()
          ? req.query.types.trim()
          : undefined;

      const payload = await fourBasedClient.listActivities(loaded.creator, {
        offset,
        limit,
        types,
      });
      const activities = Array.isArray(payload) ? payload : [];

      try {
        await messagingDashboard.processFourBasedSaleAndTipNotifications(id, activities);
      } catch (err) {
        console.warn('4based sale/tip sync failed:', err.message);
      }

      try {
        await messagingDashboard.repairFourBasedPurchasedFlags(id, {
          seedActivities: activities,
          fetchSalePage: (pageOffset, pageLimit) =>
            fourBasedClient.listActivities(loaded.creator, {
              offset: pageOffset,
              limit: pageLimit,
              types: 'sale',
            }),
        });
      } catch (err) {
        console.warn('4based purchased repair failed:', err.message || err);
      }

      scheduleThrottledReconcile(id);

      res.json({
        activities,
        offset,
        limit,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based activities error:');
    }
  }
);

router.post(
  '/:id/4based/activities/reset',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      await fourBasedClient.resetActivities(loaded.creator);
      res.json({ ok: true });
    } catch (err) {
      return handleFourBasedError(res, err, 'Reset 4based activities error:');
    }
  }
);

router.get(
  '/:id/4based/chats/user/:fanId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, fanId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!fanId) {
      return res.status(400).json({ error: 'fanId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const payload = await fourBasedClient.getChatByUser(loaded.creator, fanId);
      const chat = extractFourBasedChat(payload);
      if (!chat?._id) {
        return res.status(404).json({ error: 'No chat found for this fan' });
      }

      res.json({
        chat,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based chat by user error:');
    }
  }
);

router.get(
  '/:id/4based/chats/:chatId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const chat = await fourBasedClient.getChat(loaded.creator, chatId);
      try {
        await fourBasedClient.markReceived(loaded.creator, chatId);
      } catch (err) {
        console.warn('markReceived failed:', err.message);
      }

      res.json({ chat, providerUserId: loaded.creator.providerUserId });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based chat error:');
    }
  }
);

router.get(
  '/:id/4based/chats/:chatId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const messages = await fourBasedClient.getMessages(loaded.creator, chatId, {
        limit,
        offset,
      });
      const messageList = Array.isArray(messages) ? messages : messages?.items || messages || [];
      scheduleHistoryArchive({
        creatorId: id,
        platform: '4based',
        platformChatId: chatId,
        providerUserId: loaded.creator.providerUserId,
        rawMessages: messageList,
      });
      res.json({
        messages: messageList,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based messages error:');
    }
  }
);

router.post(
  '/:id/4based/chats/:chatId/messages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId } = req.params;
    const {
      message,
      fileStackId,
      vaultId,
      vaultGuid,
      vaults,
      priceCoins,
      localId,
      fanId,
      fanUsername,
      englishText,
    } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const text = typeof message === 'string' ? message : '';
      const englishDraft = typeof englishText === 'string' ? englishText : '';
      const resolvedLocalId =
        typeof localId === 'string' && localId.trim() ? localId.trim() : randomUUID();

      if (text.trim() || englishDraft.trim()) {
        const moderation = await applyModeration({
          germanText: text,
          englishText: englishDraft,
          userId: req.user.id,
          creatorId: id,
          platform: '4based',
          chatId,
          fanId: typeof fanId === 'string' ? fanId : null,
          fanUsername: typeof fanUsername === 'string' ? fanUsername : null,
          creatorName: loaded.creator?.displayName || null,
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

      const hasVaults = Array.isArray(vaults) && vaults.length > 0;

      // PPV / priced vault send (single or multi)
      if (vaultId || hasVaults) {
        const result = await fourBasedClient.sendPpv(loaded.creator, chatId, {
          message: text,
          vaultId,
          vaultGuid,
          vaults: hasVaults ? vaults : undefined,
          priceCoins: Number(priceCoins) || 0,
          localId: resolvedLocalId,
        });
        scheduleSentArchive({
          creatorId: id,
          platform: '4based',
          platformChatId: chatId,
          platformFanId: fanId,
          fanUsername,
          providerUserId: loaded.creator.providerUserId,
          rawMessage: result.message,
          englishDraft,
          chatter: req.user,
          priceNet: Number(priceCoins) > 0 ? Number(priceCoins) / 121 : null,
          currency: 'USD',
        });
        return res.status(201).json({
          message: result.message,
          fileStack: result.fileStack,
          localId: resolvedLocalId,
        });
      }

      // Free media (existing file stack) or plain text
      if (fileStackId) {
        const sent = await fourBasedClient.sendMessage(loaded.creator, chatId, {
          message: text,
          fileStackId,
          localId: resolvedLocalId,
        });
        scheduleSentArchive({
          creatorId: id,
          platform: '4based',
          platformChatId: chatId,
          platformFanId: fanId,
          fanUsername,
          providerUserId: loaded.creator.providerUserId,
          rawMessage: sent,
          englishDraft,
          chatter: req.user,
        });
        return res.status(201).json({ message: sent, localId: resolvedLocalId });
      }

      if (!text.trim()) {
        return res.status(400).json({ error: 'Message text is required' });
      }

      const sent = await fourBasedClient.sendText(loaded.creator, chatId, {
        message: text,
        localId: resolvedLocalId,
      });
      scheduleSentArchive({
        creatorId: id,
        platform: '4based',
        platformChatId: chatId,
        platformFanId: fanId,
        fanUsername,
        providerUserId: loaded.creator.providerUserId,
        rawMessage: sent,
        englishDraft,
        chatter: req.user,
      });
      return res.status(201).json({ message: sent, localId: resolvedLocalId });
    } catch (err) {
      return handleFourBasedError(res, err, 'Send 4based message error:');
    }
  }
);

router.delete(
  '/:id/4based/chats/:chatId/messages/:messageId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, chatId, messageId } = req.params;
    const { originalText, messageSentAt, mediaIds } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }
    if (!messageId) {
      return res.status(400).json({ error: 'messageId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }
      if (
        await isChatCopyLocked(id, '4based', {
          text: originalText,
          mediaIds,
        })
      ) {
        return res.status(409).json({ error: LOCKED_MESSAGE });
      }

      const message = await fourBasedClient.deleteMessage(
        loaded.creator,
        chatId,
        messageId
      );

      let unsend = null;
      try {
        unsend = await upsertMessageUnsend({
          creatorId: id,
          platform: '4based',
          chatId,
          platformMessageId: messageId,
          originalText,
          messageSentAt,
          user: req.user,
        });
      } catch (auditErr) {
        console.error('Persist 4based message unsend error:', auditErr);
      }

      try {
        await messagingDashboard.clearPurchasedForFourBasedMessage(messageId);
      } catch (clearErr) {
        console.warn(
          'Clear 4based purchased on unsend failed:',
          clearErr.message || clearErr
        );
      }

      return res.json({ ok: true, message, unsend });
    } catch (err) {
      return handleFourBasedError(res, err, 'Delete 4based message error:');
    }
  }
);

router.get(
  '/:id/4based/profile',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const profile = await fourBasedClient.getUser(
        loaded.creator,
        loaded.creator.providerUserId
      );
      res.json({
        profile,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based profile error:');
    }
  }
);

router.get(
  '/:id/4based/users/:userId',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id, userId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const user = await fourBasedClient.getUser(loaded.creator, userId);
      res.json({
        user,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based user error:');
    }
  }
);

router.get(
  '/:id/4based/vault',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    const fanId =
      typeof req.query.fanId === 'string' && req.query.fanId.trim()
        ? req.query.fanId.trim()
        : undefined;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 60, 120);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const folder =
        typeof req.query.folder === 'string' && req.query.folder.trim()
          ? req.query.folder.trim()
          : undefined;
      const fileType =
        req.query.fileType === 'image' || req.query.fileType === 'video'
          ? req.query.fileType
          : undefined;
      let sold;
      if (req.query.sold === 'true') sold = true;
      else if (req.query.sold === 'false') sold = false;
      let sent;
      if (req.query.sent === 'true') sent = true;
      else if (req.query.sent === 'false') sent = false;
      let lastPublished;
      if (req.query.lastPublished === 'true') lastPublished = true;
      else if (req.query.lastPublished === 'false') lastPublished = false;

      if ((sold !== undefined || sent !== undefined) && !fanId) {
        return res.status(400).json({
          error: 'fanId query parameter is required when using sold or sent filters',
        });
      }

      const vault = await fourBasedClient.listVault(loaded.creator, {
        fanId,
        limit,
        offset,
        folder,
        fileType,
        sold,
        sent,
        lastPublished,
      });
      const items = Array.isArray(vault) ? vault : vault?.items || vault || [];
      res.json({
        items,
        providerUserId: loaded.creator.providerUserId,
      });
      // Prewarm thumbnails in background so the grid hits disk cache.
      void prewarmFourBasedVaultThumbs(loaded.creator, id, items).catch((err) => {
        console.warn('4based vault prewarm error:', err?.message || err);
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based vault error:');
    }
  }
);

router.get(
  '/:id/4based/mass-messages',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const tab = req.query.tab === 'unsent' ? 'unsent' : 'sent';
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const messages = await fourBasedClient.listMassMessages(loaded.creator, {
        tab,
        limit,
        offset,
      });
      res.json({
        messages: Array.isArray(messages) ? messages : [],
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based mass messages error:');
    }
  }
);

router.post(
  '/:id/4based/mass-messages/receivers/count',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const {
        filter,
        includeUserList,
        excludeUserList,
        excludeFilter,
        include_user_list,
        exclude_user_list,
        exclude_filter,
      } = req.body || {};

      const result = await fourBasedClient.countMassMessageReceivers(loaded.creator, {
        filter,
        includeUserList: includeUserList || include_user_list,
        excludeUserList: excludeUserList || exclude_user_list,
        excludeFilter: excludeFilter || exclude_filter,
      });
      res.json(result);
    } catch (err) {
      return handleFourBasedError(res, err, 'Count 4based mass message receivers error:');
    }
  }
);

router.post(
  '/:id/4based/mass-messages',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const {
        message,
        text,
        includeUserList,
        excludeUserList,
        excludeFilter,
        include_user_list,
        exclude_user_list,
        exclude_filter,
        filter,
        vaults,
        vaultId,
        vaultGuid,
        priceCoins,
        price,
        fileStackId,
        file_stack_id,
      } = req.body || {};

      const bodyText =
        typeof message === 'string' ? message : typeof text === 'string' ? text : '';
      const includeLists = Array.isArray(includeUserList)
        ? includeUserList
        : Array.isArray(include_user_list)
          ? include_user_list
          : [];
      const excludeLists = Array.isArray(excludeUserList)
        ? excludeUserList
        : Array.isArray(exclude_user_list)
          ? exclude_user_list
          : [];

      let resolvedFileStackId =
        typeof fileStackId === 'string' && fileStackId.trim()
          ? fileStackId.trim()
          : typeof file_stack_id === 'string' && file_stack_id.trim()
            ? file_stack_id.trim()
            : null;

      const hasVaults = Array.isArray(vaults) && vaults.length > 0;
      const hasVaultId = typeof vaultId === 'string' && vaultId.trim();
      if (!resolvedFileStackId && (hasVaults || hasVaultId)) {
        const coins =
          priceCoins !== undefined && priceCoins !== null
            ? Number(priceCoins)
            : Number(price) || 0;
        const fileStack = await fourBasedClient.createFileStackFromVault(loaded.creator, {
          vaultId: hasVaultId ? vaultId.trim() : undefined,
          vaultGuid: typeof vaultGuid === 'string' ? vaultGuid : undefined,
          vaults: hasVaults ? vaults : undefined,
          description: bodyText,
          priceCoins: Number.isFinite(coins) ? coins : 0,
        });
        resolvedFileStackId = fileStack?._id || null;
        if (!resolvedFileStackId) {
          return res.status(502).json({ error: 'Failed to create file stack for mass message' });
        }
      }

      if (!bodyText.trim() && !resolvedFileStackId) {
        return res.status(400).json({ error: 'message or media is required' });
      }

      const created = await fourBasedClient.sendMassMessage(loaded.creator, {
        message: bodyText,
        includeUserList: includeLists,
        excludeUserList: excludeLists,
        excludeFilter: excludeFilter || exclude_filter,
        filter,
        fileStackId: resolvedFileStackId,
      });

      return res.status(201).json({
        message: created,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Send 4based mass message error:');
    }
  }
);

router.post(
  '/:id/4based/mass-messages/unsend-all',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }
      const started = massMessageUnsendAllRunner.startUnsendAll('4based', id);
      if (started.error) {
        return res.status(started.error.status).json({ error: started.error.message });
      }
      res.json({ progress: started });
    } catch (err) {
      return handleFourBasedError(res, err, 'Start 4based unsend-all error:');
    }
  }
);

router.get(
  '/:id/4based/mass-messages/unsend-all',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      res.json({ progress: massMessageUnsendAllRunner.snapshot('4based', id) });
    } catch (err) {
      console.error('Get 4based unsend-all error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/:id/4based/mass-messages/unsend-all/stop',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }
      const progress = massMessageUnsendAllRunner.stopUnsendAll('4based', id);
      res.json({ progress });
    } catch (err) {
      console.error('Stop 4based unsend-all error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete(
  '/:id/4based/mass-messages/:massMessageId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, massMessageId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!massMessageId) {
      return res.status(400).json({ error: 'massMessageId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }
      if (await isMassMessageLocked(id, '4based', massMessageId)) {
        return res.status(409).json({ error: LOCKED_MESSAGE });
      }

      const result = await fourBasedClient.deleteMassMessage(loaded.creator, massMessageId);
      res.json({ ok: true, id: result?.id || massMessageId });
    } catch (err) {
      return handleFourBasedError(res, err, 'Delete 4based mass message error:');
    }
  }
);

router.get(
  '/:id/4based/coin-packages',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const packages = await fourBasedClient.getCoinPackages(loaded.creator);
      res.json({
        packages: Array.isArray(packages) ? packages : packages?.items || packages || [],
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Get 4based coin packages error:');
    }
  }
);

router.get(
  '/:id/4based/feed',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const limit = Math.min(Number(req.query.limit) || 24, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const result = await fourBasedClient.listMyFeedPosts(loaded.creator, {
        limit,
        offset,
      });
      res.json({
        posts: result.items || [],
        hasMore: Boolean(result.hasMore),
        offset: result.offset,
        limit: result.limit,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'List 4based feed error:');
    }
  }
);

router.post(
  '/:id/4based/feed',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id } = req.params;
    const { vaultId, vaultGuid, description } = req.body || {};
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!vaultId || typeof vaultId !== 'string') {
      return res.status(400).json({ error: 'vaultId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const post = await fourBasedClient.createFeedPostFromVault(loaded.creator, {
        vaultId: String(vaultId).trim(),
        vaultGuid:
          typeof vaultGuid === 'string' && vaultGuid.trim()
            ? vaultGuid.trim()
            : undefined,
        description: typeof description === 'string' ? description : '',
      });
      return res.status(201).json({
        post,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Create 4based feed post error:');
    }
  }
);

router.delete(
  '/:id/4based/feed/:postId',
  authenticate,
  requirePermission('mass_messages.send'),
  async (req, res) => {
    const { id, postId } = req.params;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!postId) {
      return res.status(400).json({ error: 'postId is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      await fourBasedClient.deleteFeedPost(loaded.creator, postId);
      return res.json({ ok: true });
    } catch (err) {
      return handleFourBasedError(res, err, 'Delete 4based feed post error:');
    }
  }
);

router.post(
  '/:id/4based/feed/uploads/photo',
  authenticate,
  requirePermission('mass_messages.send'),
  (req, res, next) => {
    fourBasedPhotoUpload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      return next();
    });
  },
  async (req, res) => {
    const { id } = req.params;
    const folder =
      typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';
    const description =
      typeof req.body?.description === 'string' ? req.body.description : '';
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!folder) {
      return res.status(400).json({ error: 'folder is required' });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'file is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const prepared = await prepareFeedPhoto(req.file.buffer, {
        mimeType: req.file.mimetype || 'image/jpeg',
        maxEdge: 1440,
      });
      const width = Number(prepared.width);
      const height = Number(prepared.height);
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        return res.status(400).json({ error: 'Invalid image dimensions' });
      }

      const originalName = req.file.originalname || 'upload.jpg';
      const fileName = originalName.replace(/\.[^.]+$/, '') + '.jpg';
      const post = await fourBasedClient.uploadFeedPhoto(loaded.creator, {
        buffer: prepared.buffer,
        width,
        height,
        fileName,
        mimeType: prepared.mimeType || 'image/jpeg',
        description,
        folder,
      });

      return res.status(201).json({
        post,
        width,
        height,
        providerUserId: loaded.creator.providerUserId,
      });
    } catch (err) {
      return handleFourBasedError(res, err, 'Upload 4based feed photo error:');
    }
  }
);

router.get(
  '/:id/4based/media',
  async (req, res, next) => {
    // <img>/<video> cannot send Authorization headers; allow ?access_token=
    if (!req.headers.authorization && typeof req.query.access_token === 'string') {
      req.headers.authorization = `Bearer ${req.query.access_token}`;
    }
    return authenticate(req, res, next);
  },
  requirePermission('creators.view'),
  async (req, res) => {
    const { id } = req.params;
    const mediaPath = req.query.path;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: 'Invalid creator ID' });
    }
    if (!mediaPath || typeof mediaPath !== 'string') {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    try {
      const allowed = await userCanAccessCreator(req.user, id);
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to this creator' });
      }

      const loaded = await loadFourBasedCreator(id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ error: loaded.error.message });
      }

      const rangeHeader = req.headers.range || null;
      const cacheable = fourBasedMediaCache.isCacheablePath(mediaPath);

      // Cacheable paths (thumbs, full previews, videos): serve from disk,
      // including Range/206. On miss, download the full file once (single-flight)
      // through the residential proxy, then serve from disk.
      if (cacheable) {
        let cached = await fourBasedMediaCache.readCachePath(id, mediaPath);
        let cacheStatus = 'HIT';
        if (!cached) {
          cached = await downloadFourBasedMediaToCache(
            loaded.creator,
            id,
            mediaPath
          );
          cacheStatus = 'MISS';
        }
        return sendFourBasedCachedFile(res, cached, rangeHeader, cacheStatus);
      }

      // Non-cacheable paths: stream through with optional Range.
      const { upstream } = await fetchFourBasedMediaWithAuthRetry(
        id,
        loaded.creator,
        {
          path: mediaPath,
          rangeHeader,
        }
      );
      if (!upstream.ok && upstream.status !== 206) {
        return res
          .status(upstream.status || 502)
          .json({
            error:
              upstream.status === 401
                ? 'Failed to fetch media (401). Reconnect the 4based account or check media_jwt cookies.'
                : 'Failed to fetch media',
          });
      }

      const passthrough = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
      ];
      for (const header of passthrough) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-DomX-Media-Cache', 'BYPASS');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.status(upstream.status);
      if (!upstream.body) return res.end();

      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', (err) => {
        console.warn('4based media stream error:', err.message);
        if (!res.headersSent) res.status(502).end();
        else res.destroy(err);
      });
      nodeStream.pipe(res);
    } catch (err) {
      return handleFourBasedError(res, err, 'Proxy 4based media error:');
    }
  }
);

module.exports = router;
