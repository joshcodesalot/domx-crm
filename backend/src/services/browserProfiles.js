const crypto = require('crypto');
const fs = require('fs');
const pool = require('../db/pool');
const { dataPath } = require('./dataDir');
const { encryptSecret, decryptSecret, hashToken } = require('./crypto');
const { userCanAccessCreator, userSeesAllCreators } = require('./creatorAccess');
const { buildProxyUrl, parseProxyParts, InvalidProxyError } = require('./proxyUrl');
const { lookupGeo } = require('./browserProfileGeo');
const { startRemoteSession, stopRemoteSession } = require('./browserHostClient');

const LOCK_STALE_MS = 45_000;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class BrowserProfileError extends Error {
  constructor(message, status = 400, extras = {}) {
    super(message);
    this.status = status;
    this.code = extras.code;
    this.lockedByName = extras.lockedByName;
  }
}

function isLockActive(row, now = Date.now()) {
  if (!row?.lockedBy) return false;
  const beat = row.heartbeatAt || row.lockedAt;
  if (!beat) return false;
  const at = new Date(beat).getTime();
  if (Number.isNaN(at)) return false;
  return now - at < LOCK_STALE_MS;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function archiveRelativePath(creatorId) {
  return `browser-profiles/${creatorId}.zip`;
}

function archiveFile(creatorId) {
  return dataPath('browser-profiles', `${creatorId}.zip`);
}

function archiveExists(creatorId) {
  try {
    return fs.existsSync(archiveFile(creatorId));
  } catch {
    return false;
  }
}

function tokenMatches(row, viewToken) {
  if (!row?.viewTokenHash || !viewToken) return false;
  const got = hashToken(String(viewToken));
  const stored = Buffer.from(String(row.viewTokenHash));
  const next = Buffer.from(got);
  if (stored.length !== next.length) return false;
  return crypto.timingSafeEqual(stored, next);
}

function hostSecretOk(headerValue) {
  const expected = process.env.BROWSER_HOST_SECRET || '';
  const got = typeof headerValue === 'string' ? headerValue : '';
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function apiBaseFromRequest(req) {
  const configured = process.env.DOMX_API_URL || process.env.BROWSER_PROFILE_API_URL;
  if (configured) return String(configured).replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

async function holderName(client, userId) {
  const result = await client.query('SELECT name FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.name || 'another chatter';
}

async function readCreator(client, creatorId) {
  const result = await client.query(
    'SELECT id, "displayName", "encryptedProxy" FROM creators WHERE id = $1',
    [creatorId]
  );
  return result.rows[0] || null;
}

async function ensureRow(client, creator) {
  const existing = await client.query(
    'SELECT * FROM browser_profiles WHERE "creatorId" = $1 FOR UPDATE',
    [creator.id]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (!row.encryptedProxy && creator.encryptedProxy) {
      const updated = await client.query(
        `UPDATE browser_profiles
         SET "encryptedProxy" = $2, "updatedAt" = NOW()
         WHERE "creatorId" = $1
         RETURNING *`,
        [creator.id, creator.encryptedProxy]
      );
      return updated.rows[0];
    }
    return row;
  }

  const seed = String(crypto.randomInt(1, 2147483646));
  const profileKey = crypto.randomBytes(32).toString('base64');
  const inserted = await client.query(
    `INSERT INTO browser_profiles (
       "creatorId", "fingerprintSeed", "fingerprintPlatform",
       "encryptedProfileKey", "encryptedProxy", generation
     ) VALUES ($1, $2, 'windows', $3, $4, 1)
     RETURNING *`,
    [creator.id, seed, encryptSecret(profileKey), creator.encryptedProxy]
  );
  return inserted.rows[0];
}

function lockConflict(name) {
  return new BrowserProfileError(`Browser is open for this creator (${name})`, 409, {
    code: 'BROWSER_LOCKED',
    lockedByName: name,
  });
}

async function assertAccess(user, creatorId) {
  if (!isUuid(creatorId) || !(await userCanAccessCreator(user, creatorId))) {
    throw new BrowserProfileError('Creator not found', 404);
  }
}

function publicProfile(row, creator, viewToken) {
  return {
    creatorId: row.creatorId,
    displayName: creator.displayName,
    fingerprintSeed: row.fingerprintSeed,
    fingerprintPlatform: row.fingerprintPlatform || 'windows',
    encryptionKey: decryptSecret(row.encryptedProfileKey),
    proxyUrl: decryptSecret(row.encryptedProxy),
    timezone: row.timezone || null,
    acceptLanguage: row.acceptLanguage || null,
    hasArchive: archiveExists(row.creatorId),
    viewToken,
    generation: row.generation,
  };
}

async function refreshGeo(row, userId) {
  const proxyUrl = decryptSecret(row.encryptedProxy);
  if (!proxyUrl || row.timezone) return row;
  const geo = await lookupGeo(proxyUrl);
  if (!geo) return row;
  const updated = await pool.query(
    `UPDATE browser_profiles
     SET timezone = $2, "acceptLanguage" = $3, "updatedAt" = NOW()
     WHERE "creatorId" = $1 AND "lockedBy" = $4
     RETURNING *`,
    [row.creatorId, geo.timezone, geo.acceptLanguage, userId]
  );
  return updated.rows[0] || row;
}

async function assignLock(creatorId, userId, expectedGeneration) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM browser_profiles WHERE "creatorId" = $1 FOR UPDATE',
      [creatorId]
    );
    const current = locked.rows[0];
    if (!current || Number(current.generation) !== Number(expectedGeneration)) {
      throw lockConflict('another chatter');
    }
    if (isLockActive(current) && current.lockedBy !== userId) {
      throw lockConflict(await holderName(client, current.lockedBy));
    }
    const viewToken = crypto.randomBytes(24).toString('hex');
    const updated = await client.query(
      `UPDATE browser_profiles
       SET "lockedBy" = $2,
           "lockedAt" = NOW(),
           "heartbeatAt" = NOW(),
           "viewTokenHash" = $3,
           "encryptedViewToken" = $4,
           generation = generation + 1,
           "updatedAt" = NOW()
       WHERE "creatorId" = $1
       RETURNING *`,
      [creatorId, userId, hashToken(viewToken), encryptSecret(viewToken)]
    );
    await client.query('COMMIT');
    return { row: updated.rows[0], viewToken };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already done with this transaction.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function openBrowserProfile(user, creatorId, platform, req) {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new BrowserProfileError('Unsupported platform', 400);
  }
  await assertAccess(user, creatorId);

  const client = await pool.connect();
  let creator;
  let row;
  let reuse = false;
  try {
    await client.query('BEGIN');
    creator = await readCreator(client, creatorId);
    if (!creator) throw new BrowserProfileError('Creator not found', 404);
    row = await ensureRow(client, creator);
    if (isLockActive(row) && row.lockedBy !== user.id) {
      throw lockConflict(await holderName(client, row.lockedBy));
    }
    reuse = isLockActive(row) && row.lockedBy === user.id;
    if (reuse) {
      await client.query(
        `UPDATE browser_profiles
         SET "heartbeatAt" = NOW(), "updatedAt" = NOW()
         WHERE "creatorId" = $1`,
        [creatorId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Already rolled back or the connection failed.
    }
    throw err;
  } finally {
    client.release();
  }

  let viewToken = reuse ? decryptSecret(row.encryptedViewToken) : null;
  if (!reuse) {
    try {
      await stopRemoteSession(creatorId);
    } catch (err) {
      console.error('Clearcote host stop before open:', err.message);
    }
    const assigned = await assignLock(creatorId, user.id, row.generation);
    row = assigned.row;
    viewToken = assigned.viewToken;
  }

  if (!viewToken) {
    throw new BrowserProfileError('Browser session could not be resumed', 409, {
      code: 'BROWSER_LOCKED',
    });
  }

  row = await refreshGeo(row, user.id);
  const profile = publicProfile(row, creator, viewToken);

  if (platform === 'darwin') {
    let started;
    try {
      started = await startRemoteSession({
        creatorId,
        viewToken,
        generation: profile.generation,
        fingerprintSeed: profile.fingerprintSeed,
        fingerprintPlatform: profile.fingerprintPlatform,
        encryptionKey: profile.encryptionKey,
        proxyUrl: profile.proxyUrl,
        timezone: profile.timezone,
        acceptLanguage: profile.acceptLanguage,
        hasArchive: profile.hasArchive,
        archiveUrl: `${apiBaseFromRequest(req)}/api/browser-profiles/${creatorId}/archive`,
      });
    } catch (err) {
      if (!reuse) {
        await clearMatchingLock(creatorId, viewToken);
      }
      throw new BrowserProfileError(err.message, err.status || 502, { code: err.code });
    }
    return {
      mode: 'remote',
      alreadyOpen: reuse,
      creatorId,
      displayName: creator.displayName,
      viewToken,
      viewUrl: started.viewUrl,
    };
  }

  return {
    mode: 'local',
    alreadyOpen: reuse,
    ...profile,
  };
}

async function clearMatchingLock(creatorId, viewToken) {
  const hash = hashToken(String(viewToken));
  await pool.query(
    `UPDATE browser_profiles
     SET "lockedBy" = NULL,
         "lockedAt" = NULL,
         "heartbeatAt" = NULL,
         "viewTokenHash" = NULL,
         "encryptedViewToken" = NULL,
         "updatedAt" = NOW()
     WHERE "creatorId" = $1 AND "viewTokenHash" = $2`,
    [creatorId, hash]
  );
}

async function heartbeatBrowserProfile(user, creatorId, viewToken) {
  await assertAccess(user, creatorId);
  const updated = await pool.query(
    `UPDATE browser_profiles
     SET "heartbeatAt" = NOW(), "updatedAt" = NOW()
     WHERE "creatorId" = $1 AND "lockedBy" = $2 AND "viewTokenHash" = $3
     RETURNING "creatorId"`,
    [creatorId, user.id, hashToken(String(viewToken || ''))]
  );
  if (!updated.rows[0]) {
    throw new BrowserProfileError('Browser lock was released', 409, {
      code: 'BROWSER_LOCK_LOST',
    });
  }
  return { ok: true };
}

async function releaseBrowserProfile(user, creatorId, viewToken) {
  await assertAccess(user, creatorId);
  const updated = await pool.query(
    `UPDATE browser_profiles
     SET "lockedBy" = NULL,
         "lockedAt" = NULL,
         "heartbeatAt" = NULL,
         "viewTokenHash" = NULL,
         "encryptedViewToken" = NULL,
         "updatedAt" = NOW()
     WHERE "creatorId" = $1 AND "lockedBy" = $2 AND "viewTokenHash" = $3
     RETURNING "creatorId"`,
    [creatorId, user.id, hashToken(String(viewToken || ''))]
  );
  if (!updated.rows[0]) {
    throw new BrowserProfileError('Browser lock was released', 409, {
      code: 'BROWSER_LOCK_LOST',
    });
  }
  return { ok: true };
}

async function closeBrowserProfile(user, creatorId, viewToken) {
  await assertAccess(user, creatorId);
  const existing = await pool.query(
    'SELECT * FROM browser_profiles WHERE "creatorId" = $1',
    [creatorId]
  );
  const row = existing.rows[0];
  if (!row || row.lockedBy !== user.id || !tokenMatches(row, viewToken)) {
    throw new BrowserProfileError('Browser lock was released', 409, {
      code: 'BROWSER_LOCK_LOST',
    });
  }
  try {
    await stopRemoteSession(creatorId);
  } catch (err) {
    throw new BrowserProfileError(err.message, err.status || 502, { code: err.code });
  }
  await clearMatchingLock(creatorId, viewToken);
  return { ok: true };
}

async function readArchiveRow(creatorId) {
  const result = await pool.query(
    'SELECT * FROM browser_profiles WHERE "creatorId" = $1',
    [creatorId]
  );
  return result.rows[0] || null;
}

async function assertArchiveReader(row, { user, viewToken, host }) {
  if (host) return;
  if (!user || !row || row.lockedBy !== user.id || !tokenMatches(row, viewToken)) {
    throw new BrowserProfileError('Browser lock was released', 409, {
      code: 'BROWSER_LOCK_LOST',
    });
  }
}

async function getArchiveForDownload(creatorId, auth) {
  if (!isUuid(creatorId)) {
    throw new BrowserProfileError('Creator not found', 404);
  }
  if (!auth.host) {
    await assertAccess(auth.user, creatorId);
  }
  const row = await readArchiveRow(creatorId);
  if (!row) throw new BrowserProfileError('Creator not found', 404);
  await assertArchiveReader(row, auth);
  if (!archiveExists(creatorId)) return null;
  return archiveFile(creatorId);
}

async function saveArchive(creatorId, { viewToken, generation, bytes, user, host }) {
  if (!isUuid(creatorId)) {
    throw new BrowserProfileError('Creator not found', 404);
  }
  if (!host && user) {
    await assertAccess(user, creatorId);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) {
    throw new BrowserProfileError('Profile archive is empty', 400);
  }
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new BrowserProfileError('Profile archive is too large', 413);
  }
  const magic = bytes.readUInt32LE(0);
  if (magic !== 0x04034b50 && magic !== 0x06054b50) {
    throw new BrowserProfileError('Profile archive must be a zip file', 400);
  }
  const generationNumber = Number(generation);
  if (!Number.isInteger(generationNumber)) {
    throw new BrowserProfileError('Profile generation is missing', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM browser_profiles WHERE "creatorId" = $1 FOR UPDATE',
      [creatorId]
    );
    const row = locked.rows[0];
    const allowed =
      row &&
      tokenMatches(row, viewToken) &&
      Number(row.generation) === generationNumber &&
      (host || (user && row.lockedBy === user.id));
    if (!allowed) {
      throw new BrowserProfileError('This browser session was replaced', 409, {
        code: 'BROWSER_LOCK_LOST',
      });
    }
    const dest = archiveFile(creatorId);
    const tmp = `${dest}.tmp`;
    fs.mkdirSync(dataPath('browser-profiles'), { recursive: true });
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dest);
    const updated = await client.query(
      `UPDATE browser_profiles
       SET "archivePath" = $2,
           "lockedBy" = NULL,
           "lockedAt" = NULL,
           "heartbeatAt" = NULL,
           "viewTokenHash" = NULL,
           "encryptedViewToken" = NULL,
           "updatedAt" = NOW()
       WHERE "creatorId" = $1 AND "viewTokenHash" = $3 AND generation = $4`,
      [creatorId, archiveRelativePath(creatorId), hashToken(String(viewToken)), generationNumber]
    );
    if (updated.rowCount !== 1) {
      throw new BrowserProfileError('This browser session was replaced', 409, {
        code: 'BROWSER_LOCK_LOST',
      });
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The write may already have been renamed; the token check prevents a stale replace.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function sessionStatus(creatorId, viewToken, generation) {
  if (!isUuid(creatorId)) {
    throw new BrowserProfileError('Creator not found', 404);
  }
  const row = await readArchiveRow(creatorId);
  if (!row) return { matches: false, active: false };
  const matches =
    tokenMatches(row, viewToken) && Number(generation) === Number(row.generation);
  return {
    matches,
    active: matches && isLockActive(row),
  };
}

async function listBrowserProfiles(user) {
  const seesAll = userSeesAllCreators(user);
  const result = await pool.query(
    `SELECT bp."creatorId", bp."lockedBy", bp."heartbeatAt", bp."lockedAt",
            bp."archivePath",
            (bp."encryptedProxy" IS NOT NULL) AS "hasProxy",
            u.name AS "lockedByName"
     FROM browser_profiles bp
     LEFT JOIN users u ON u.id = bp."lockedBy"
     WHERE (
       $1::boolean
       OR EXISTS (
         SELECT 1 FROM creator_staff_assignments a
         WHERE a."creatorId" = bp."creatorId" AND a."userId" = $2
       )
     )`,
    [seesAll, user.id]
  );
  return result.rows.map((row) => {
    const locked = isLockActive(row);
    return {
      creatorId: row.creatorId,
      locked,
      lockedBySelf: locked && row.lockedBy === user.id,
      lockedByName: locked ? row.lockedByName : null,
      hasArchive: Boolean(row.archivePath) && archiveExists(row.creatorId),
      hasProxy: Boolean(row.hasProxy),
    };
  });
}

async function getBrowserProxy(user, creatorId) {
  await assertAccess(user, creatorId);
  const result = await pool.query(
    'SELECT "encryptedProxy" FROM browser_profiles WHERE "creatorId" = $1',
    [creatorId]
  );
  const stored = result.rows[0] ? decryptSecret(result.rows[0].encryptedProxy) : null;
  const parts = stored ? parseProxyParts(stored) : null;
  return {
    hasProxy: Boolean(stored),
    proxyHost: parts?.hostPort || null,
    proxyUsername: parts?.username || null,
  };
}

async function updateBrowserProxy(user, creatorId, body) {
  await assertAccess(user, creatorId);
  const proxyHost = typeof body?.proxyHost === 'string' ? body.proxyHost.trim() : '';
  const proxyUsername = typeof body?.proxyUsername === 'string' ? body.proxyUsername : '';
  const proxyPassword = typeof body?.proxyPassword === 'string' ? body.proxyPassword : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const creator = await readCreator(client, creatorId);
    if (!creator) throw new BrowserProfileError('Creator not found', 404);
    const row = await ensureRow(client, creator);
    let encrypted = null;
    if (proxyHost) {
      let passwordToStore = proxyPassword;
      if (!proxyPassword) {
        const stored = decryptSecret(row.encryptedProxy);
        const parts = stored ? parseProxyParts(stored) : null;
        if (parts?.password) passwordToStore = parts.password;
      }
      const built = buildProxyUrl(proxyHost, proxyUsername, passwordToStore);
      if (!built) {
        throw new InvalidProxyError(
          'Proxy address is invalid. Use host:port (for example 1.2.3.4:8080).'
        );
      }
      encrypted = encryptSecret(built);
    }
    await client.query(
      `UPDATE browser_profiles
       SET "encryptedProxy" = $2,
           timezone = NULL,
           "acceptLanguage" = NULL,
           "updatedAt" = NOW()
       WHERE "creatorId" = $1`,
      [creatorId, encrypted]
    );
    await client.query('COMMIT');
    return { ok: true, hasProxy: Boolean(encrypted) };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The transaction is already closed.
    }
    if (err instanceof InvalidProxyError) {
      throw new BrowserProfileError(err.message, 400);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  LOCK_STALE_MS,
  MAX_ARCHIVE_BYTES,
  BrowserProfileError,
  isLockActive,
  isUuid,
  hostSecretOk,
  openBrowserProfile,
  heartbeatBrowserProfile,
  releaseBrowserProfile,
  closeBrowserProfile,
  getArchiveForDownload,
  saveArchive,
  sessionStatus,
  listBrowserProfiles,
  getBrowserProxy,
  updateBrowserProxy,
};
