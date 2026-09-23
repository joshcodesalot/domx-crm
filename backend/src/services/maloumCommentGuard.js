const pool = require('../db/pool');
const maloumClient = require('./maloumClient');
const { keywordMatches } = require('./contentModeration');
const { loadMaloumCreator } = require('./platformCreatorSession');

const GUARD_TERMS = ['AI', 'KI', 'A.I.', 'K.I.'];
const INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_GAP_MS = 350;
const PAGE_LIMIT = 15;

let schedulerTimer = null;
let ticking = false;
const scanning = new Set();

function pause(ms = REQUEST_GAP_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchCommentText(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) return null;
  for (const term of GUARD_TERMS) {
    if (keywordMatches(value, term, 'whole_word', false)) {
      return term;
    }
  }
  return null;
}

function pageRows(page) {
  if (Array.isArray(page?.data)) return page.data;
  if (Array.isArray(page)) return page;
  return [];
}

function pageNext(page) {
  const next = page?.next;
  return typeof next === 'string' && next.trim() ? next.trim() : null;
}

function toSettings(row, creatorId) {
  return {
    creatorId,
    enabled: Boolean(row?.enabled),
    lastScanAt: row?.lastScanAt || null,
    lastError: row?.lastError || null,
    scanning: scanning.has(creatorId),
  };
}

function toEvent(row) {
  return {
    id: row.id,
    creatorId: row.creatorId,
    postId: row.postId || null,
    commentId: row.commentId || null,
    memberId: row.memberId,
    username: row.username || null,
    commentText: row.commentText || null,
    matchedTerm: row.matchedTerm || null,
    status: row.status,
    error: row.error || null,
    createdAt: row.createdAt,
  };
}

async function getSettings(creatorId) {
  const result = await pool.query(
    `SELECT "creatorId", enabled, "lastScanAt", "lastError"
     FROM maloum_comment_guard_settings
     WHERE "creatorId" = $1`,
    [creatorId]
  );
  return toSettings(result.rows[0], creatorId);
}

async function setEnabled(creatorId, enabled) {
  const result = await pool.query(
    `INSERT INTO maloum_comment_guard_settings ("creatorId", enabled, "updatedAt")
     VALUES ($1, $2, NOW())
     ON CONFLICT ("creatorId") DO UPDATE
     SET enabled = EXCLUDED.enabled, "updatedAt" = NOW()
     RETURNING "creatorId", enabled, "lastScanAt", "lastError"`,
    [creatorId, Boolean(enabled)]
  );
  return toSettings(result.rows[0], creatorId);
}

async function listEvents(creatorId, limit = 30) {
  const capped = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const result = await pool.query(
    `SELECT id, "creatorId", "postId", "commentId", "memberId", username,
            "commentText", "matchedTerm", status, error, "createdAt"
     FROM maloum_comment_guard_events
     WHERE "creatorId" = $1
     ORDER BY "createdAt" DESC
     LIMIT $2`,
    [creatorId, capped]
  );
  return result.rows.map(toEvent);
}

async function findBlocked(creatorId, memberId) {
  const result = await pool.query(
    `SELECT id, "creatorId", "postId", "commentId", "memberId", username,
            "commentText", "matchedTerm", status, error, "createdAt"
     FROM maloum_comment_guard_events
     WHERE "creatorId" = $1 AND "memberId" = $2 AND status = 'blocked'
     LIMIT 1`,
    [creatorId, memberId]
  );
  return result.rows[0] ? toEvent(result.rows[0]) : null;
}

async function insertEvent(fields) {
  const result = await pool.query(
    `INSERT INTO maloum_comment_guard_events (
       "creatorId", "postId", "commentId", "memberId", username,
       "commentText", "matchedTerm", status, error
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ("creatorId", "memberId") WHERE status = 'blocked' DO NOTHING
     RETURNING id, "creatorId", "postId", "commentId", "memberId", username,
               "commentText", "matchedTerm", status, error, "createdAt"`,
    [
      fields.creatorId,
      fields.postId || null,
      fields.commentId || null,
      fields.memberId,
      fields.username || null,
      fields.commentText || null,
      fields.matchedTerm || null,
      fields.status,
      fields.error || null,
    ]
  );
  if (result.rows[0]) return toEvent(result.rows[0]);
  return findBlocked(fields.creatorId, fields.memberId);
}

async function markScanFinished(creatorId, lastError) {
  await pool.query(
    `INSERT INTO maloum_comment_guard_settings (
       "creatorId", enabled, "lastScanAt", "lastError", "updatedAt"
     ) VALUES ($1, FALSE, NOW(), $2, NOW())
     ON CONFLICT ("creatorId") DO UPDATE
     SET "lastScanAt" = NOW(),
         "lastError" = EXCLUDED."lastError",
         "updatedAt" = NOW()`,
    [creatorId, lastError || null]
  );
}

function isOwnComment(comment, providerUserId) {
  const memberId = comment?.user?._id || comment?.user?.id;
  if (!memberId || !providerUserId) return false;
  return String(memberId) === String(providerUserId);
}

async function blockAndRecord(creator, fields) {
  const memberId = String(fields.memberId || '').trim();
  if (!memberId) {
    const err = new Error('memberId is required');
    err.status = 400;
    throw err;
  }
  const existing = await findBlocked(creator.id, memberId);
  if (existing) {
    return { alreadyBlocked: true, event: existing };
  }
  const payload = {
    creatorId: creator.id,
    postId: fields.postId || null,
    commentId: fields.commentId || null,
    memberId,
    username: fields.username || null,
    commentText: fields.commentText || null,
    matchedTerm: fields.matchedTerm || matchCommentText(fields.commentText) || null,
  };
  try {
    await maloumClient.blockChatMember(creator, memberId, { deleteComments: true });
    const event = await insertEvent({ ...payload, status: 'blocked', error: null });
    const preview = String(payload.commentText || '').replace(/\s+/g, ' ').slice(0, 180);
    console.log(
      `[maloumCommentGuard] blocked member ${memberId} (${payload.username || 'unknown'}) creator ${creator.id} term=${payload.matchedTerm || 'manual'} comment="${preview}"`
    );
    return { alreadyBlocked: false, event };
  } catch (err) {
    const message = err?.message || 'Block failed';
    const event = await insertEvent({
      ...payload,
      status: 'failed',
      error: message,
    });
    console.error(
      `[maloumCommentGuard] block failed member ${memberId} creator ${creator.id}:`,
      message
    );
    const wrapped = new Error(message);
    wrapped.status = err?.status && err.status !== 401 ? err.status : 502;
    wrapped.event = event;
    throw wrapped;
  }
}

async function scanPostComments(creator, postId, blockedThisRun, summary) {
  let next;
  const seen = new Set();
  for (;;) {
    if (next) {
      if (seen.has(next)) break;
      seen.add(next);
    }
    await pause();
    const page = await maloumClient.listPostComments(creator, postId, {
      limit: PAGE_LIMIT,
      next,
    });
    const comments = pageRows(page);
    for (const comment of comments) {
      if (comment?.isAuthorBlockedByCurrentUser) continue;
      if (isOwnComment(comment, creator.providerUserId)) continue;
      const memberId = String(comment?.user?._id || comment?.user?.id || '').trim();
      if (!memberId) continue;
      const text = typeof comment?.text === 'string' ? comment.text : '';
      const matchedTerm = matchCommentText(text);
      if (!matchedTerm) continue;
      summary.matched += 1;
      if (blockedThisRun.has(memberId)) continue;
      blockedThisRun.add(memberId);
      const already = await findBlocked(creator.id, memberId);
      if (already) continue;
      try {
        await pause();
        const result = await blockAndRecord(creator, {
          memberId,
          postId,
          commentId: comment?._id || comment?.id || null,
          username: comment?.user?.username || null,
          commentText: text,
          matchedTerm,
        });
        if (!result.alreadyBlocked) summary.blocked += 1;
      } catch {
        summary.failed += 1;
      }
    }
    const cursor = pageNext(page);
    if (!cursor || comments.length === 0) break;
    next = cursor;
  }
}

async function scanCreator(creatorId) {
  if (scanning.has(creatorId)) {
    const err = new Error('A comment scan is already running for this creator');
    err.status = 409;
    throw err;
  }
  scanning.add(creatorId);
  const summary = { ok: false, scannedPosts: 0, matched: 0, blocked: 0, failed: 0 };
  try {
    const loaded = await loadMaloumCreator(creatorId);
    if (loaded.error) {
      await markScanFinished(creatorId, loaded.error.message);
      summary.error = loaded.error.message;
      return summary;
    }
    const creator = loaded.creator;
    const blockedThisRun = new Set();
    let next;
    const seen = new Set();
    console.log(`[maloumCommentGuard] scanning creator ${creatorId}`);
    for (;;) {
      if (next) {
        if (seen.has(next)) break;
        seen.add(next);
      }
      await pause();
      const page = await maloumClient.listMyPosts(creator, {
        limit: PAGE_LIMIT,
        next,
      });
      const posts = pageRows(page);
      for (const post of posts) {
        const postId = String(post?._id || post?.id || '').trim();
        if (!postId) continue;
        summary.scannedPosts += 1;
        await scanPostComments(creator, postId, blockedThisRun, summary);
      }
      const cursor = pageNext(page);
      if (!cursor || posts.length === 0) break;
      next = cursor;
    }
    await markScanFinished(creatorId, null);
    summary.ok = true;
    console.log(
      `[maloumCommentGuard] finished creator ${creatorId} posts=${summary.scannedPosts} matched=${summary.matched} blocked=${summary.blocked} failed=${summary.failed}`
    );
    return summary;
  } catch (err) {
    const message = err?.message || 'Comment scan failed';
    console.error(`[maloumCommentGuard] scan failed creator ${creatorId}:`, message);
    try {
      await markScanFinished(creatorId, message);
    } catch (updateErr) {
      console.error('[maloumCommentGuard] failed to store scan error:', updateErr);
    }
    summary.error = message;
    return summary;
  } finally {
    scanning.delete(creatorId);
  }
}

async function listEnabledCreatorIds() {
  const result = await pool.query(
    `SELECT s."creatorId"
     FROM maloum_comment_guard_settings s
     JOIN creators c ON c.id = s."creatorId"
     WHERE s.enabled = TRUE
       AND c.platform = 'maloum'
       AND c."connectionStatus" = 'connected'`
  );
  return result.rows.map((row) => row.creatorId);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const ids = await listEnabledCreatorIds();
    for (const creatorId of ids) {
      try {
        await scanCreator(creatorId);
      } catch (err) {
        if (err?.status === 409) continue;
        console.error('[maloumCommentGuard] tick creator failed:', creatorId, err);
      }
    }
  } catch (err) {
    console.error('[maloumCommentGuard] tick failed:', err);
  } finally {
    ticking = false;
  }
}

function startMaloumCommentGuard() {
  if (schedulerTimer) return;
  const run = () => {
    void tick();
  };
  run();
  schedulerTimer = setInterval(run, INTERVAL_MS);
  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

function stopMaloumCommentGuard() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function isScanning(creatorId) {
  return scanning.has(creatorId);
}

module.exports = {
  GUARD_TERMS,
  INTERVAL_MS,
  matchCommentText,
  getSettings,
  setEnabled,
  listEvents,
  scanCreator,
  blockAndRecord,
  startMaloumCommentGuard,
  stopMaloumCommentGuard,
  isScanning,
};
