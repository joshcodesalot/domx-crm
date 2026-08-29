const pool = require('../db/pool');
const {
  TelegramWorkerError,
  sendText,
  sendVaultToPeer,
  deleteText,
  isTelegramServiceDialog,
} = require('./telegramWorker');

const DEFAULT_UNSEND_CAP = 30;
const SEND_GAP_MIN_MS = 5000;
const SEND_GAP_MAX_MS = 12000;
const UNSEND_GAP_MIN_MS = 5000;
const UNSEND_GAP_MAX_MS = 10000;

/** @typedef {{ abort: boolean, kind: string, status: string, done: number, failed: number, skipped: number, total: number, currentPeerId: string | null, lastError: string | null, campaignId: string | null, startedAt: number }} MmRun */

/** @type {Map<string, MmRun>} */
const runs = new Map();

function sendKey(campaignId) {
  return `send:${campaignId}`;
}

function unsendKey(campaignId) {
  return `unsend:${campaignId}`;
}

function unsendLastKey(creatorId) {
  return `unsendLast:${creatorId}`;
}

function randomGapMs(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function parseUuidList(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((id) => String(id || '').trim())
        .filter((id) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            id
          )
        )
    ),
  ];
}

function parseMessageIds(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  return [...new Set(source.map((id) => String(id || '').trim()).filter(Boolean))];
}

function parseFloodWaitSeconds(err) {
  const raw = String(err?.text || err?.message || err || '');
  const match = raw.match(/FLOOD_WAIT[_ ]?(\d+)/i) || raw.match(/Try again in (\d+)s/i);
  if (!match) return 0;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function sleep(ms, shouldAbort) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if ((shouldAbort && shouldAbort()) || Date.now() >= end) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(200, end - Date.now()));
    };
    tick();
  });
}

function idleSnapshot() {
  return {
    status: 'idle',
    kind: null,
    done: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    currentPeerId: null,
    lastError: null,
    campaignId: null,
  };
}

function snapshotFrom(run) {
  if (!run) return idleSnapshot();
  return {
    status: run.status,
    kind: run.kind,
    done: run.done,
    failed: run.failed,
    skipped: run.skipped,
    total: run.total,
    currentPeerId: run.currentPeerId,
    lastError: run.lastError,
    campaignId: run.campaignId,
    startedAt: run.startedAt,
  };
}

function findRun(predicate) {
  for (const run of runs.values()) {
    if (predicate(run)) return run;
  }
  return null;
}

function snapshotForCampaign(campaignId) {
  return snapshotFrom(
    runs.get(sendKey(campaignId)) || runs.get(unsendKey(campaignId))
  );
}

function snapshotForCreator(creatorId) {
  return snapshotFrom(
    findRun((run) => run.creatorId === creatorId) || runs.get(unsendLastKey(creatorId))
  );
}

function stopCampaign(campaignId) {
  const run = runs.get(sendKey(campaignId)) || runs.get(unsendKey(campaignId));
  if (run && (run.status === 'running' || run.status === 'waiting')) {
    run.abort = true;
    run.status = 'paused';
  }
  return snapshotFrom(run);
}

function stopCreator(creatorId) {
  const run = findRun((item) => item.creatorId === creatorId);
  if (run && (run.status === 'running' || run.status === 'waiting')) {
    run.abort = true;
    run.status = 'paused';
  }
  return snapshotFrom(run);
}

function isServiceOrGroup(peerId, kind) {
  if (kind === 'group') return true;
  return isTelegramServiceDialog({ peerId, kind: 'dm' });
}

async function resolveRecipients(creatorId, includeListIds, excludeListIds) {
  const include = parseUuidList(includeListIds);
  const exclude = parseUuidList(excludeListIds);
  if (include.length === 0) {
    throw new Error('Select at least one include list');
  }

  const owned = await pool.query(
    `SELECT id FROM telegram_lists WHERE "creatorId" = $1 AND id = ANY($2::uuid[])`,
    [creatorId, [...include, ...exclude]]
  );
  const ownedSet = new Set(owned.rows.map((row) => row.id));
  if (include.some((id) => !ownedSet.has(id))) {
    throw new Error('One or more include lists were not found');
  }
  if (exclude.some((id) => !ownedSet.has(id))) {
    throw new Error('One or more exclude lists were not found');
  }

  const includeRows = await pool.query(
    `SELECT DISTINCT m."telegramUserId" AS "peerId", COALESCE(p.kind, 'dm') AS kind
     FROM telegram_list_members m
     JOIN telegram_lists l ON l.id = m."listId"
     LEFT JOIN telegram_fan_profiles p
       ON p."creatorId" = l."creatorId" AND p."telegramUserId" = m."telegramUserId"
     WHERE l."creatorId" = $1 AND m."listId" = ANY($2::uuid[])`,
    [creatorId, include]
  );

  const excludeSet = new Set();
  if (exclude.length > 0) {
    const excludeRows = await pool.query(
      `SELECT DISTINCT m."telegramUserId" AS "peerId"
       FROM telegram_list_members m
       WHERE m."listId" = ANY($1::uuid[])`,
      [exclude]
    );
    for (const row of excludeRows.rows) excludeSet.add(String(row.peerId));
  }

  const recipients = [];
  const seen = new Set();
  for (const row of includeRows.rows) {
    const peerId = String(row.peerId || '').trim();
    if (!peerId || seen.has(peerId)) continue;
    seen.add(peerId);
    if (excludeSet.has(peerId) || isServiceOrGroup(peerId, row.kind)) {
      continue;
    }
    recipients.push(peerId);
  }
  return recipients;
}

async function recordVaultSent({ creatorId, fanId, itemIds, userId }) {
  const ids = parseUuidList(itemIds);
  if (!ids.length) return;
  await pool.query(
    `INSERT INTO telegram_vault_sent ("creatorId", "fanId", "itemId", "sentByUserId")
     SELECT $1, $2, x.item_id, $3
     FROM unnest($4::uuid[]) AS x(item_id)
     ON CONFLICT ("creatorId", "fanId", "itemId")
     DO UPDATE SET
       "sentByUserId" = COALESCE(EXCLUDED."sentByUserId", telegram_vault_sent."sentByUserId"),
       "sentAt" = NOW()`,
    [creatorId, String(fanId), userId || null, ids]
  );
}

async function refreshCampaignCounts(campaignId) {
  await pool.query(
    `UPDATE telegram_mm_campaigns c
     SET total = s.total,
         sent = s.sent,
         failed = s.failed,
         skipped = s.skipped,
         unsent = s.unsent,
         "unsendFailed" = s.unsend_failed
     FROM (
       SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE status = 'unsent')::int AS unsent,
         COUNT(*) FILTER (WHERE status = 'unsend_failed')::int AS unsend_failed
       FROM telegram_mm_recipients
       WHERE "campaignId" = $1
     ) s
     WHERE c.id = $1`,
    [campaignId]
  );
}

async function loadCampaign(campaignId) {
  const result = await pool.query(
    `SELECT * FROM telegram_mm_campaigns WHERE id = $1`,
    [campaignId]
  );
  return result.rows[0] || null;
}

async function createCampaign({
  creatorId,
  bodyText,
  vaultIds,
  includeListIds,
  excludeListIds,
  createdBy,
}) {
  const include = parseUuidList(includeListIds);
  const exclude = parseUuidList(excludeListIds);
  const vault = parseUuidList(vaultIds);
  const text = String(bodyText || '').trim();
  if (include.length === 0) {
    throw new Error('Select at least one include list');
  }
  if (!text && vault.length === 0) {
    throw new Error('Add text or vault media');
  }
  if (vault.length > 0) {
    const items = await pool.query(
      `SELECT id FROM telegram_vault_items
       WHERE "creatorId" = $1 AND id = ANY($2::uuid[])`,
      [creatorId, vault]
    );
    if (items.rows.length !== vault.length) {
      throw new Error('One or more vault items were not found');
    }
  }

  const peerIds = await resolveRecipients(creatorId, include, exclude);
  const client = await pool.connect();
  let campaignId = null;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO telegram_mm_campaigns (
         "creatorId", "bodyText", "vaultIds", "includeListIds", "excludeListIds",
         status, total, "createdBy"
       ) VALUES ($1, $2, $3::jsonb, $4::uuid[], $5::uuid[], 'queued', $6, $7)
       RETURNING id`,
      [
        creatorId,
        text,
        JSON.stringify(vault),
        include,
        exclude,
        peerIds.length,
        createdBy || null,
      ]
    );
    campaignId = inserted.rows[0].id;
    for (const peerId of peerIds) {
      await client.query(
        `INSERT INTO telegram_mm_recipients ("campaignId", "peerId")
         VALUES ($1, $2)`,
        [campaignId, peerId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return loadCampaign(campaignId);
}

async function sendToPeer(creatorId, peerId, text, vaultIds, userId) {
  const ids = parseUuidList(vaultIds);
  if (ids.length === 0) {
    const message = await sendText(creatorId, peerId, text);
    return message?.id ? [String(message.id)] : [];
  }
  const items = await pool.query(
    `SELECT id, "savedMessageId"
     FROM telegram_vault_items
     WHERE "creatorId" = $1 AND id = ANY($2::uuid[])`,
    [creatorId, ids]
  );
  if (items.rows.length !== ids.length) {
    throw new Error('One or more vault items were not found');
  }
  const byId = new Map(items.rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const sent = await sendVaultToPeer(creatorId, peerId, {
    itemMessageIds: ordered.map((row) => row.savedMessageId),
    caption: text,
  });
  await recordVaultSent({
    creatorId,
    fanId: peerId,
    itemIds: ordered.map((row) => row.id),
    userId,
  });
  return (Array.isArray(sent) ? sent : [])
    .map((msg) => (msg?.id != null ? String(msg.id) : ''))
    .filter(Boolean);
}

async function sendWithFloodRetry(creatorId, peerId, text, vaultIds, userId, run) {
  try {
    return await sendToPeer(creatorId, peerId, text, vaultIds, userId);
  } catch (err) {
    const wait = parseFloodWaitSeconds(err);
    if (!wait || run.abort) throw err;
    run.status = 'waiting';
    run.lastError = err?.message || String(err);
    await sleep((wait + 1) * 1000, () => run.abort);
    if (run.abort) throw err;
    run.status = 'running';
    return sendToPeer(creatorId, peerId, text, vaultIds, userId);
  }
}

async function executeSend(campaignId, run) {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) {
    throw new Error('Campaign not found');
  }
  const vaultIds = parseUuidList(campaign.vaultIds);
  const text = String(campaign.bodyText || '').trim();
  const pending = await pool.query(
    `SELECT id, "peerId" FROM telegram_mm_recipients
     WHERE "campaignId" = $1 AND status = 'pending'
     ORDER BY "peerId" ASC`,
    [campaignId]
  );
  run.total = pending.rows.length + (Number(campaign.sent) || 0) + (Number(campaign.failed) || 0);
  await pool.query(
    `UPDATE telegram_mm_campaigns
     SET status = 'running', "startedAt" = COALESCE("startedAt", NOW()), "lastError" = NULL
     WHERE id = $1`,
    [campaignId]
  );

  for (const row of pending.rows) {
    if (run.abort) break;
    run.currentPeerId = row.peerId;
    try {
      const messageIds = await sendWithFloodRetry(
        campaign.creatorId,
        row.peerId,
        text,
        vaultIds,
        campaign.createdBy,
        run
      );
      await pool.query(
        `UPDATE telegram_mm_recipients
         SET status = 'sent',
             "telegramMessageIds" = $1::jsonb,
             error = NULL,
             "sentAt" = NOW()
         WHERE id = $2`,
        [JSON.stringify(messageIds), row.id]
      );
      run.done += 1;
    } catch (err) {
      const message =
        err instanceof TelegramWorkerError
          ? err.message
          : err?.message || 'Failed to send';
      await pool.query(
        `UPDATE telegram_mm_recipients
         SET status = 'failed', error = $1
         WHERE id = $2`,
        [String(message).slice(0, 240), row.id]
      );
      run.failed += 1;
      run.lastError = message;
    }
    await refreshCampaignCounts(campaignId);
    if (run.abort) break;
    run.status = 'waiting';
    await sleep(randomGapMs(SEND_GAP_MIN_MS, SEND_GAP_MAX_MS), () => run.abort);
    if (!run.abort) run.status = 'running';
  }

  await refreshCampaignCounts(campaignId);
  const next = await loadCampaign(campaignId);
  const remaining = await pool.query(
    `SELECT COUNT(*)::int AS count FROM telegram_mm_recipients
     WHERE "campaignId" = $1 AND status = 'pending'`,
    [campaignId]
  );
  const leftover = Number(remaining.rows[0]?.count) || 0;
  let status = 'done';
  if (run.abort && leftover > 0) status = 'paused';
  else if (leftover > 0) status = 'paused';
  else if ((Number(next?.sent) || 0) === 0 && (Number(next?.failed) || 0) > 0) {
    status = 'failed';
  }
  await pool.query(
    `UPDATE telegram_mm_campaigns
     SET status = $2,
         "finishedAt" = CASE WHEN $2 IN ('done', 'failed') THEN NOW() ELSE "finishedAt" END,
         "lastError" = $3
     WHERE id = $1`,
    [campaignId, status, run.lastError || null]
  );
  run.status = status === 'paused' ? 'paused' : status;
  run.currentPeerId = null;
}

function startSend(campaignId, creatorId) {
  const key = sendKey(campaignId);
  const existing = runs.get(key);
  if (existing && (existing.status === 'running' || existing.status === 'waiting')) {
    return { started: false, progress: snapshotFrom(existing) };
  }
  const run = {
    abort: false,
    kind: 'send',
    status: 'running',
    done: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    currentPeerId: null,
    lastError: null,
    campaignId,
    creatorId,
    startedAt: Date.now(),
  };
  runs.set(key, run);
  const finished = executeSend(campaignId, run)
    .catch(async (err) => {
      run.status = 'failed';
      run.lastError = err?.message || 'Send failed';
      await pool.query(
        `UPDATE telegram_mm_campaigns
         SET status = 'failed', "lastError" = $2, "finishedAt" = NOW()
         WHERE id = $1`,
        [campaignId, String(run.lastError).slice(0, 240)]
      );
    })
    .finally(() => {
      setTimeout(() => {
        if (runs.get(key) === run) runs.delete(key);
      }, 30_000);
    });
  run.finished = finished;
  return { started: true, progress: snapshotFrom(run), finished };
}

async function runSendAndWait(campaignId, creatorId) {
  const started = startSend(campaignId, creatorId);
  if (started.finished) await started.finished;
  const campaign = await loadCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status === 'failed') {
    throw new Error(campaign.lastError || 'Telegram mass message failed');
  }
  return campaign;
}

async function deleteWithFloodRetry(creatorId, peerId, messageId, run) {
  try {
    await deleteText(creatorId, peerId, messageId);
  } catch (err) {
    const wait = parseFloodWaitSeconds(err);
    if (!wait || run.abort) throw err;
    run.status = 'waiting';
    run.lastError = err?.message || String(err);
    await sleep((wait + 1) * 1000, () => run.abort);
    if (run.abort) throw err;
    run.status = 'running';
    await deleteText(creatorId, peerId, messageId);
  }
}

async function executeUnsendCampaign(campaignId, run) {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  const rows = await pool.query(
    `SELECT id, "peerId", "telegramMessageIds"
     FROM telegram_mm_recipients
     WHERE "campaignId" = $1
       AND status IN ('sent', 'unsend_failed')
     ORDER BY "sentAt" DESC NULLS LAST`,
    [campaignId]
  );
  run.total = rows.rows.length;
  await pool.query(
    `UPDATE telegram_mm_campaigns SET status = 'unsending', "lastError" = NULL WHERE id = $1`,
    [campaignId]
  );

  for (const row of rows.rows) {
    if (run.abort) break;
    run.currentPeerId = row.peerId;
    const ids = parseMessageIds(row.telegramMessageIds);
    if (ids.length === 0) {
      await pool.query(
        `UPDATE telegram_mm_recipients
         SET status = 'unsend_failed', error = $1
         WHERE id = $2`,
        ['No stored Telegram message ids', row.id]
      );
      run.failed += 1;
      continue;
    }
    try {
      for (const messageId of ids) {
        await deleteWithFloodRetry(campaign.creatorId, row.peerId, messageId, run);
      }
      await pool.query(
        `UPDATE telegram_mm_recipients
         SET status = 'unsent', error = NULL
         WHERE id = $1`,
        [row.id]
      );
      run.done += 1;
    } catch (err) {
      const message = err?.message || 'Failed to unsend';
      await pool.query(
        `UPDATE telegram_mm_recipients
         SET status = 'unsend_failed', error = $1
         WHERE id = $2`,
        [String(message).slice(0, 240), row.id]
      );
      run.failed += 1;
      run.lastError = message;
    }
    await refreshCampaignCounts(campaignId);
    if (run.abort) break;
    run.status = 'waiting';
    await sleep(randomGapMs(UNSEND_GAP_MIN_MS, UNSEND_GAP_MAX_MS), () => run.abort);
    if (!run.abort) run.status = 'running';
  }

  await refreshCampaignCounts(campaignId);
  const leftover = await pool.query(
    `SELECT COUNT(*)::int AS count FROM telegram_mm_recipients
     WHERE "campaignId" = $1 AND status IN ('sent', 'unsend_failed')`,
    [campaignId]
  );
  const status =
    run.abort && Number(leftover.rows[0]?.count) > 0 ? 'paused' : 'unsent';
  await pool.query(
    `UPDATE telegram_mm_campaigns
     SET status = $2, "lastError" = $3
     WHERE id = $1`,
    [campaignId, status === 'paused' ? 'paused' : 'unsent', run.lastError || null]
  );
  run.status = status;
  run.currentPeerId = null;
}

function startUnsend(campaignId, creatorId) {
  const key = unsendKey(campaignId);
  const existing = runs.get(key);
  if (existing && (existing.status === 'running' || existing.status === 'waiting')) {
    return { started: false, progress: snapshotFrom(existing) };
  }
  const run = {
    abort: false,
    kind: 'unsend',
    status: 'running',
    done: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    currentPeerId: null,
    lastError: null,
    campaignId,
    creatorId,
    startedAt: Date.now(),
  };
  runs.set(key, run);
  const finished = executeUnsendCampaign(campaignId, run)
    .catch(async (err) => {
      run.status = 'failed';
      run.lastError = err?.message || 'Unsend failed';
      await pool.query(
        `UPDATE telegram_mm_campaigns SET "lastError" = $2 WHERE id = $1`,
        [campaignId, String(run.lastError).slice(0, 240)]
      );
    })
    .finally(() => {
      setTimeout(() => {
        if (runs.get(key) === run) runs.delete(key);
      }, 30_000);
    });
  run.finished = finished;
  return { started: true, progress: snapshotFrom(run), finished };
}

async function runUnsendAndWait(campaignId, creatorId) {
  const started = startUnsend(campaignId, creatorId);
  if (started.finished) await started.finished;
  return loadCampaign(campaignId);
}

async function executeUnsendLast(creatorId, cap, run) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_UNSEND_CAP;
  const campaigns = await pool.query(
    `SELECT id FROM telegram_mm_campaigns
     WHERE "creatorId" = $1
       AND status IN ('done', 'failed', 'paused', 'unsent')
     ORDER BY "createdAt" DESC
     LIMIT $2`,
    [creatorId, limit]
  );
  run.total = campaigns.rows.length;
  for (const row of campaigns.rows) {
    if (run.abort) break;
    run.campaignId = row.id;
    const inner = {
      get abort() {
        return run.abort;
      },
      set abort(value) {
        run.abort = Boolean(value);
      },
      status: 'running',
      lastError: null,
      currentPeerId: null,
      done: 0,
      failed: 0,
    };
    try {
      await executeUnsendCampaign(row.id, inner);
      run.done += 1;
    } catch (err) {
      run.failed += 1;
      run.lastError = err?.message || 'Unsend failed';
    }
    if (inner.lastError) run.lastError = inner.lastError;
  }
  run.status = run.abort ? 'paused' : 'done';
  run.campaignId = null;
}

function startUnsendLast(creatorId, cap = DEFAULT_UNSEND_CAP) {
  const key = unsendLastKey(creatorId);
  const existing = runs.get(key);
  if (existing && (existing.status === 'running' || existing.status === 'waiting')) {
    return { started: false, progress: snapshotFrom(existing) };
  }
  const run = {
    abort: false,
    kind: 'unsendLast',
    status: 'running',
    done: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    currentPeerId: null,
    lastError: null,
    campaignId: null,
    creatorId,
    startedAt: Date.now(),
  };
  runs.set(key, run);
  const finished = executeUnsendLast(creatorId, cap, run)
    .catch((err) => {
      run.status = 'failed';
      run.lastError = err?.message || 'Unsend last failed';
    })
    .finally(() => {
      setTimeout(() => {
        if (runs.get(key) === run) runs.delete(key);
      }, 30_000);
    });
  run.finished = finished;
  return { started: true, progress: snapshotFrom(run), finished };
}

async function runUnsendLastAndWait(creatorId, cap = DEFAULT_UNSEND_CAP) {
  const started = startUnsendLast(creatorId, cap);
  if (started.finished) await started.finished;
  if (started.progress && !started.started) {
    const existing = runs.get(unsendLastKey(creatorId));
    if (existing?.finished) await existing.finished;
  }
  const run = runs.get(unsendLastKey(creatorId));
  if (run?.status === 'failed') {
    throw new Error(run.lastError || 'Failed to unsend last Telegram mass messages');
  }
  return snapshotFrom(run) || started.progress;
}

module.exports = {
  DEFAULT_UNSEND_CAP,
  resolveRecipients,
  createCampaign,
  loadCampaign,
  startSend,
  runSendAndWait,
  startUnsend,
  runUnsendAndWait,
  startUnsendLast,
  runUnsendLastAndWait,
  snapshotForCampaign,
  snapshotForCreator,
  stopCampaign,
  stopCreator,
  parseUuidList,
};
