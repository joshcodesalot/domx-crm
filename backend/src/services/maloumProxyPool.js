const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { encryptSecret, decryptSecret } = require('./crypto');
const { parseProxyLines, parseProxyParts } = require('./proxyUrl');

const BAN_MS = 45 * 60 * 1000;
const ROTATE_DEBOUNCE_MS = 10 * 1000;

class MaloumPoolError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MaloumPoolError';
    this.status = status;
  }
}

const lastRotateByCreator = new Map();

function resetPoolRotateDebounceForTests() {
  lastRotateByCreator.clear();
}

function isBanned(row, now) {
  if (!row?.bannedUntil) return false;
  return new Date(row.bannedUntil).getTime() > now;
}

function hostPortFromUrl(proxyUrl) {
  return parseProxyParts(proxyUrl)?.hostPort || null;
}

function selectKeepOrFree(rows, creatorId, now) {
  const assigned = rows.find((row) => row.assignedCreatorId === creatorId) || null;
  if (assigned && !isBanned(assigned, now)) {
    return { action: 'keep', row: assigned, release: null };
  }
  const free = rows.find(
    (row) =>
      !row.assignedCreatorId &&
      !isBanned(row, now) &&
      (!assigned || row.id !== assigned.id)
  );
  if (assigned && isBanned(assigned, now)) {
    return {
      action: free ? 'reassign' : 'none',
      row: free || null,
      release: assigned,
    };
  }
  if (free) {
    return { action: 'assign', row: free, release: null };
  }
  return { action: 'none', row: null, release: null };
}

function selectRotateTarget(rows, creatorId, currentHostPort, now) {
  const current =
    rows.find((row) => row.assignedCreatorId === creatorId) ||
    rows.find((row) => row.hostPort === currentHostPort) ||
    null;
  const next = rows.find(
    (row) =>
      (!current || row.id !== current.id) &&
      !row.assignedCreatorId &&
      !isBanned(row, now)
  );
  return { current, next };
}

function rowFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    proxyUrl: decryptSecret(row.encryptedUrl),
    hostPort: row.hostPort,
    bannedUntil: row.bannedUntil || null,
    assignedCreatorId: row.assignedCreatorId || null,
  };
}

async function listRows(client = pool) {
  const result = await client.query(
    `SELECT id, "encryptedUrl", "hostPort", "bannedUntil", "assignedCreatorId"
     FROM maloum_proxy_pool
     ORDER BY "createdAt" ASC`
  );
  return result.rows.map(rowFromDb).filter((row) => row.proxyUrl);
}

async function hasPoolEntries(client = pool) {
  const result = await client.query(
    `SELECT EXISTS (SELECT 1 FROM maloum_proxy_pool) AS present`
  );
  return Boolean(result.rows[0]?.present);
}

async function listPoolPublic(client = pool) {
  const result = await client.query(
    `SELECT p.id, p."hostPort", p."bannedUntil", p."assignedCreatorId",
            c."displayName" AS "assignedCreatorName"
     FROM maloum_proxy_pool p
     LEFT JOIN creators c ON c.id = p."assignedCreatorId"
     ORDER BY p."createdAt" ASC`
  );
  const now = Date.now();
  return result.rows.map((row) => ({
    id: row.id,
    hostPort: row.hostPort,
    bannedUntil: row.bannedUntil || null,
    banned: isBanned(row, now),
    assignedCreatorId: row.assignedCreatorId || null,
    assignedCreatorName: row.assignedCreatorName || null,
  }));
}

async function replacePoolFromText(text, client = pool) {
  const parsed = parseProxyLines(text);
  const incoming = new Map(parsed.map((item) => [item.hostPort, item]));
  const existing = await client.query(
    `SELECT id, "hostPort", "bannedUntil", "assignedCreatorId"
     FROM maloum_proxy_pool`
  );
  const existingByHost = new Map(
    existing.rows.map((row) => [row.hostPort, row])
  );

  const keepHosts = new Set(incoming.keys());
  const toDelete = existing.rows.filter((row) => !keepHosts.has(row.hostPort));
  if (toDelete.length > 0) {
    await client.query(
      `DELETE FROM maloum_proxy_pool WHERE id = ANY($1::uuid[])`,
      [toDelete.map((row) => row.id)]
    );
  }

  for (const item of parsed) {
    const prev = existingByHost.get(item.hostPort);
    const encryptedUrl = encryptSecret(item.proxyUrl);
    if (prev) {
      await client.query(
        `UPDATE maloum_proxy_pool
         SET "encryptedUrl" = $2, "updatedAt" = NOW()
         WHERE id = $1`,
        [prev.id, encryptedUrl]
      );
    } else {
      await client.query(
        `INSERT INTO maloum_proxy_pool (id, "encryptedUrl", "hostPort")
         VALUES ($1, $2, $3)`,
        [randomUUID(), encryptedUrl, item.hostPort]
      );
    }
  }

  return listPoolPublic(client);
}

async function persistAssignment(client, { assignId, creatorId, releaseId, bannedUntil }) {
  if (releaseId) {
    await client.query(
      `UPDATE maloum_proxy_pool
       SET "assignedCreatorId" = NULL,
           "bannedUntil" = COALESCE($2, "bannedUntil"),
           "updatedAt" = NOW()
       WHERE id = $1`,
      [releaseId, bannedUntil || null]
    );
  }
  if (assignId && creatorId) {
    await client.query(
      `UPDATE maloum_proxy_pool
       SET "assignedCreatorId" = $2, "updatedAt" = NOW()
       WHERE id = $1`,
      [assignId, creatorId]
    );
  }
}

async function resolveProxyForCreator(creatorId, fallbackUrl, { client = pool, now = Date.now() } = {}) {
  if (!(await hasPoolEntries(client))) {
    return fallbackUrl || null;
  }
  if (!creatorId) {
    const claimed = await claimUnassignedPoolProxy({ client, now });
    if (claimed) return claimed;
    if (await hasPoolEntries(client)) {
      throw new MaloumPoolError(
        'All Maloum pool proxies are banned. Add more or wait.',
        403
      );
    }
    return fallbackUrl || null;
  }

  const rows = await listRows(client);
  const picked = selectKeepOrFree(rows, creatorId, now);
  if (picked.action === 'keep') {
    return picked.row.proxyUrl;
  }
  if (picked.action === 'none') {
    throw new MaloumPoolError(
      'All Maloum pool proxies are banned. Add more or wait.',
      403
    );
  }

  const bannedUntil =
    picked.release && isBanned(picked.release, now)
      ? picked.release.bannedUntil
      : null;
  await persistAssignment(client, {
    assignId: picked.row.id,
    creatorId,
    releaseId: picked.release?.id || null,
    bannedUntil,
  });
  return picked.row.proxyUrl;
}

async function claimUnassignedPoolProxy({ client = pool, now = Date.now() } = {}) {
  if (!(await hasPoolEntries(client))) {
    return null;
  }
  const rows = await listRows(client);
  const free = rows.find((row) => !row.assignedCreatorId && !isBanned(row, now));
  return free?.proxyUrl || null;
}

async function rotatePoolProxy(
  creatorId,
  currentProxyUrl,
  { client = pool, now = Date.now() } = {}
) {
  if (!(await hasPoolEntries(client))) {
    return null;
  }

  if (creatorId) {
    const recent = lastRotateByCreator.get(creatorId);
    if (recent && now - recent.at < ROTATE_DEBOUNCE_MS && recent.proxyUrl) {
      return recent.proxyUrl;
    }
  }

  const currentHostPort = hostPortFromUrl(currentProxyUrl);
  const rows = await listRows(client);
  const { current, next } = selectRotateTarget(
    rows,
    creatorId || null,
    currentHostPort,
    now
  );
  if (!next) {
    if (current) {
      await persistAssignment(client, {
        assignId: null,
        creatorId: null,
        releaseId: current.id,
        bannedUntil: new Date(now + BAN_MS).toISOString(),
      });
    }
    throw new MaloumPoolError(
      'All Maloum pool proxies are banned. Add more or wait.',
      403
    );
  }

  await persistAssignment(client, {
    assignId: creatorId ? next.id : null,
    creatorId: creatorId || null,
    releaseId: current?.id || null,
    bannedUntil: new Date(now + BAN_MS).toISOString(),
  });

  if (creatorId) {
    lastRotateByCreator.set(creatorId, { at: now, proxyUrl: next.proxyUrl });
  }
  return next.proxyUrl;
}

module.exports = {
  BAN_MS,
  ROTATE_DEBOUNCE_MS,
  MaloumPoolError,
  isBanned,
  selectKeepOrFree,
  selectRotateTarget,
  parseProxyLines,
  hasPoolEntries,
  listPoolPublic,
  replacePoolFromText,
  resolveProxyForCreator,
  claimUnassignedPoolProxy,
  rotatePoolProxy,
  resetPoolRotateDebounceForTests,
};
