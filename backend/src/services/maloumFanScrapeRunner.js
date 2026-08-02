const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { decryptJson, decryptSecret } = require('./crypto');
const { decryptAccessToken } = require('./maloumAuthTokens');
const maloumClient = require('./maloumClient');

const COMMENT_DELAY_MS = 1200;
const STEP_DELAY_MS = 350;

/** @type {Map<string, { generation: number }>} */
const activeRuns = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    statusMessage: null,
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
    statusMessage:
      typeof raw.statusMessage === 'string' ? raw.statusMessage : null,
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

async function loadMaloumCreator(creatorId) {
  const result = await pool.query(
    `SELECT id, platform, "displayName", "providerUserId", "encryptedSession",
            "encryptedAccessToken", "encryptedProxy", "connectionStatus", "accountId"
     FROM creators
     WHERE id = $1`,
    [creatorId]
  );

  if (result.rows.length === 0) {
    throw new Error('Creator not found');
  }

  const row = result.rows[0];
  if (row.platform !== 'maloum') {
    throw new Error('Creator is not a Maloum account');
  }

  let session = {};
  try {
    if (row.encryptedSession) {
      session = decryptJson(row.encryptedSession) || {};
    }
  } catch {
    throw new Error('Failed to decrypt Maloum session');
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
    throw new Error('Maloum account is missing auth credentials. Please reconnect.');
  }
  if (!proxyUrl) {
    throw new Error(
      'Maloum proxy is required. Set MALOUM_PROXY_URL in backend .env or reconnect with a proxy.'
    );
  }

  return {
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
  };
}

async function loadJobRow(motherCreatorId) {
  const result = await pool.query(
    `SELECT * FROM maloum_fan_scrape_jobs WHERE "motherCreatorId" = $1`,
    [motherCreatorId]
  );
  return result.rows[0] || null;
}

function rowToJob(row) {
  if (!row) return null;
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

async function saveCheckpoint(motherCreatorId, checkpoint, status) {
  const result = await pool.query(
    `UPDATE maloum_fan_scrape_jobs
     SET checkpoint = $2::jsonb,
         status = COALESCE($3, status),
         "updatedAt" = NOW()
     WHERE "motherCreatorId" = $1
     RETURNING *`,
    [motherCreatorId, JSON.stringify(normalizeCheckpoint(checkpoint)), status || null]
  );
  return rowToJob(result.rows[0]);
}

async function getJobStatus(motherCreatorId) {
  const result = await pool.query(
    `SELECT status FROM maloum_fan_scrape_jobs WHERE "motherCreatorId" = $1`,
    [motherCreatorId]
  );
  return result.rows[0]?.status || null;
}

async function assertStillRunning(motherCreatorId, generation) {
  const active = activeRuns.get(motherCreatorId);
  if (!active || active.generation !== generation) {
    const err = new Error('ABORTED');
    err.code = 'ABORTED';
    throw err;
  }
  const status = await getJobStatus(motherCreatorId);
  if (status !== 'running') {
    const err = new Error('ABORTED');
    err.code = 'ABORTED';
    throw err;
  }
}

async function fanExists(motherCreatorId, fanId) {
  const result = await pool.query(
    `SELECT 1 FROM maloum_fan_scrape_fans
     WHERE "motherCreatorId" = $1 AND "fanId" = $2
     LIMIT 1`,
    [motherCreatorId, fanId]
  );
  return result.rows.length > 0;
}

async function upsertFan(motherCreatorId, payload) {
  await pool.query(
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
       "scrapedAt" = NOW()`,
    [
      randomUUID(),
      motherCreatorId,
      payload.fanId,
      payload.chatId || null,
      payload.username || null,
      payload.sourceCreatorUsername || null,
      payload.sourcePostId || null,
      payload.listId || null,
    ]
  );
}

async function resolveSourceCreators(creator, job, generation) {
  let cp = { ...job.checkpoint };
  if (cp.sourceCreators.length > 0) return cp;

  if (job.sourceMode === 'top_creators') {
    cp = {
      ...cp,
      statusMessage: 'Loading top creators…',
    };
    await saveCheckpoint(job.motherCreatorId, cp, 'running');

    const usernames = [];
    let next;
    const limit = job.topCreatorsLimit || 50;
    while (usernames.length < limit) {
      await assertStillRunning(job.motherCreatorId, generation);
      const pageLimit = Math.min(15, limit - usernames.length);
      const page = await maloumClient.listTopCreators(creator, {
        limit: pageLimit,
        next,
      });
      const data = Array.isArray(page?.data)
        ? page.data
        : Array.isArray(page)
          ? page
          : [];
      for (const item of data) {
        const username = item?.user?.username?.trim().toLowerCase();
        if (username && !usernames.includes(username)) usernames.push(username);
        if (usernames.length >= limit) break;
      }
      if (page?.next == null || data.length === 0) break;
      next = page.next;
      await sleep(STEP_DELAY_MS);
    }

    cp = {
      ...cp,
      sourceCreators: usernames,
      creatorIndex: 0,
      postIndex: 0,
      posts: [],
      commentNext: null,
      statusMessage: `Loaded ${usernames.length} top creators`,
    };
    await saveCheckpoint(job.motherCreatorId, cp, 'running');
    return cp;
  }

  cp = {
    ...cp,
    statusMessage: 'Resolving custom usernames…',
  };
  await saveCheckpoint(job.motherCreatorId, cp, 'running');

  const usernames = normalizeUsernameList(job.customUsernames || []);
  const valid = [];
  const invalid = [...(cp.invalidUsernames || [])];
  for (const username of usernames) {
    await assertStillRunning(job.motherCreatorId, generation);
    try {
      const profile = await maloumClient.getUserProfile(creator, username);
      const resolved = profile?.username?.trim().toLowerCase() || username;
      if (!valid.includes(resolved)) valid.push(resolved);
    } catch {
      if (!invalid.includes(username)) invalid.push(username);
    }
    await sleep(STEP_DELAY_MS);
  }

  cp = {
    ...cp,
    sourceCreators: valid,
    invalidUsernames: invalid,
    creatorIndex: 0,
    postIndex: 0,
    posts: [],
    commentNext: null,
    statusMessage: `Resolved ${valid.length} creators (${invalid.length} invalid)`,
  };
  await saveCheckpoint(job.motherCreatorId, cp, 'running');
  return cp;
}

async function ensureCreatorPosts(creator, motherCreatorId, username, postsLimit, cp, generation) {
  if (cp.posts.length > 0) return cp;

  cp = {
    ...cp,
    statusMessage: `Loading posts for @${username}…`,
    currentCreatorUsername: username,
  };
  await saveCheckpoint(motherCreatorId, cp, 'running');

  const postIds = [];
  let next;
  while (postIds.length < postsLimit) {
    await assertStillRunning(motherCreatorId, generation);
    const page = await maloumClient.listUserPosts(creator, username, {
      limit: Math.min(15, postsLimit - postIds.length),
      next,
    });
    const data = Array.isArray(page?.data)
      ? page.data
      : Array.isArray(page)
        ? page
        : [];
    for (const post of data) {
      if (post?._id && !postIds.includes(post._id)) postIds.push(post._id);
      if (postIds.length >= postsLimit) break;
    }
    if (!page?.next || data.length === 0) break;
    next = page.next;
    await sleep(STEP_DELAY_MS);
  }

  cp = {
    ...cp,
    posts: postIds,
    postIndex: 0,
    commentNext: null,
    currentCreatorUsername: username,
    statusMessage: `@${username} · ${postIds.length} posts`,
  };
  await saveCheckpoint(motherCreatorId, cp, 'running');
  return cp;
}

async function processFan(creator, motherCreatorId, listId, fan, sourceCreatorUsername, sourcePostId, cp) {
  const fanId = fan?._id;
  if (!fanId || fan.isCreator) {
    return { ...cp, skippedFans: cp.skippedFans + 1 };
  }

  if (await fanExists(motherCreatorId, fanId)) {
    return { ...cp, skippedFans: cp.skippedFans + 1 };
  }

  try {
    const chat = await maloumClient.createChat(creator, fanId);
    const chatId = chat?._id || null;
    const assignedRaw = await maloumClient.getMemberChatLists(creator, fanId);
    const assigned = Array.isArray(assignedRaw)
      ? assignedRaw
      : Array.isArray(assignedRaw?.data)
        ? assignedRaw.data
        : [];
    const currentIds = assigned.map((list) => list._id).filter(Boolean);
    if (!currentIds.includes(listId)) {
      await maloumClient.setMemberChatLists(creator, fanId, [...currentIds, listId]);
    }
    await upsertFan(motherCreatorId, {
      fanId,
      chatId,
      username: fan.username || null,
      sourceCreatorUsername,
      sourcePostId,
      listId,
    });
    return {
      ...cp,
      processedFans: cp.processedFans + 1,
      lastError: null,
    };
  } catch (err) {
    return {
      ...cp,
      failedFans: cp.failedFans + 1,
      lastError: err?.message || 'Failed to process fan',
    };
  }
}

async function runJob(motherCreatorId, generation) {
  try {
    const row = await loadJobRow(motherCreatorId);
    if (!row) return;
    let job = rowToJob(row);
    if (job.status !== 'running') return;

    const creator = await loadMaloumCreator(motherCreatorId);
    if (!job.targetListId) {
      await saveCheckpoint(
        motherCreatorId,
        { ...job.checkpoint, lastError: 'Select or create a target list first', statusMessage: 'Missing target list' },
        'failed'
      );
      return;
    }

    let cp = await resolveSourceCreators(creator, job, generation);
    if (cp.sourceCreators.length === 0) {
      await saveCheckpoint(
        motherCreatorId,
        {
          ...cp,
          lastError: 'No source creators to scrape',
          statusMessage: 'No source creators found',
        },
        'failed'
      );
      return;
    }

    while (cp.creatorIndex < cp.sourceCreators.length) {
      await assertStillRunning(motherCreatorId, generation);
      const username = cp.sourceCreators[cp.creatorIndex];
      cp = {
        ...cp,
        currentCreatorUsername: username,
      };
      cp = await ensureCreatorPosts(
        creator,
        motherCreatorId,
        username,
        job.postsPerCreator || 50,
        cp,
        generation
      );

      while (cp.postIndex < cp.posts.length) {
        await assertStillRunning(motherCreatorId, generation);
        const postId = cp.posts[cp.postIndex];
        cp = {
          ...cp,
          currentPostId: postId,
          statusMessage: `@${username} · post ${cp.postIndex + 1}/${cp.posts.length} · fans ${cp.processedFans}`,
        };
        await saveCheckpoint(motherCreatorId, cp, 'running');

        let commentNext = cp.commentNext || undefined;
        let pageDone = false;
        while (!pageDone) {
          await assertStillRunning(motherCreatorId, generation);
          await sleep(COMMENT_DELAY_MS);
          const page = await maloumClient.listPostComments(creator, postId, {
            limit: 15,
            next: commentNext,
          });
          const comments = Array.isArray(page?.data)
            ? page.data
            : Array.isArray(page)
              ? page
              : [];

          for (const comment of comments) {
            await assertStillRunning(motherCreatorId, generation);
            cp = await processFan(
              creator,
              motherCreatorId,
              job.targetListId,
              comment?.user,
              username,
              postId,
              cp
            );
            cp = {
              ...cp,
              commentNext: page?.next || null,
              statusMessage: `@${username} · post ${cp.postIndex + 1}/${cp.posts.length} · fans ${cp.processedFans}`,
            };
            await saveCheckpoint(motherCreatorId, cp, 'running');
            await sleep(STEP_DELAY_MS);
          }

          if (!page?.next || comments.length === 0) {
            pageDone = true;
            commentNext = undefined;
          } else {
            commentNext = page.next;
            cp = { ...cp, commentNext: page.next };
            await saveCheckpoint(motherCreatorId, cp, 'running');
          }
        }

        cp = {
          ...cp,
          postIndex: cp.postIndex + 1,
          commentNext: null,
        };
        await saveCheckpoint(motherCreatorId, cp, 'running');
      }

      cp = {
        ...cp,
        creatorIndex: cp.creatorIndex + 1,
        postIndex: 0,
        posts: [],
        commentNext: null,
        currentPostId: null,
      };
      await saveCheckpoint(motherCreatorId, cp, 'running');
    }

    cp = {
      ...cp,
      lastError: null,
      statusMessage: `Completed · ${cp.processedFans} added · ${cp.skippedFans} skipped · ${cp.failedFans} failed`,
    };
    await saveCheckpoint(motherCreatorId, cp, 'completed');
    console.log(`[fan-scrape] completed mother=${motherCreatorId} processed=${cp.processedFans}`);
  } catch (err) {
    if (err?.code === 'ABORTED') {
      const row = await loadJobRow(motherCreatorId);
      if (row && row.status === 'running') {
        // Stop was requested via status change; leave as-is if already paused.
      } else if (row && row.status === 'paused') {
        const cp = normalizeCheckpoint(row.checkpoint);
        await saveCheckpoint(
          motherCreatorId,
          {
            ...cp,
            statusMessage: `Paused · ${cp.processedFans} added`,
          },
          'paused'
        );
      }
      console.log(`[fan-scrape] paused/stopped mother=${motherCreatorId}`);
      return;
    }

    console.error(`[fan-scrape] failed mother=${motherCreatorId}`, err);
    try {
      const row = await loadJobRow(motherCreatorId);
      const cp = normalizeCheckpoint(row?.checkpoint);
      await saveCheckpoint(
        motherCreatorId,
        {
          ...cp,
          lastError: err?.message || 'Scrape failed',
          statusMessage: err?.message || 'Scrape failed',
        },
        'failed'
      );
    } catch (saveErr) {
      console.error('[fan-scrape] failed to persist error state', saveErr);
    }
  } finally {
    const active = activeRuns.get(motherCreatorId);
    if (active && active.generation === generation) {
      activeRuns.delete(motherCreatorId);
    }
  }
}

function isActive(motherCreatorId) {
  return activeRuns.has(motherCreatorId);
}

/**
 * Mark job running (if needed) and ensure a server loop is active.
 */
async function startJob(motherCreatorId) {
  const row = await loadJobRow(motherCreatorId);
  if (!row) {
    throw Object.assign(new Error('Fan scrape job not found'), { status: 404 });
  }
  const job = rowToJob(row);
  if (!job.targetListId) {
    throw Object.assign(new Error('Select or create a target list first'), {
      status: 400,
    });
  }
  if (
    job.sourceMode === 'custom_usernames' &&
    (!job.customUsernames || job.customUsernames.length === 0) &&
    (!job.checkpoint.sourceCreators || job.checkpoint.sourceCreators.length === 0)
  ) {
    throw Object.assign(new Error('Add at least one creator username'), {
      status: 400,
    });
  }

  const updated = await pool.query(
    `UPDATE maloum_fan_scrape_jobs
     SET status = 'running',
         "startedAt" = COALESCE("startedAt", NOW()),
         checkpoint = jsonb_set(
           COALESCE(checkpoint, '{}'::jsonb),
           '{statusMessage}',
           '"Starting…"'::jsonb,
           true
         ),
         "updatedAt" = NOW()
     WHERE "motherCreatorId" = $1
     RETURNING *`,
    [motherCreatorId]
  );

  if (!activeRuns.has(motherCreatorId)) {
    const generation = Date.now();
    activeRuns.set(motherCreatorId, { generation });
    setImmediate(() => {
      void runJob(motherCreatorId, generation);
    });
    console.log(`[fan-scrape] started mother=${motherCreatorId}`);
  } else {
    console.log(`[fan-scrape] already running in-process mother=${motherCreatorId}`);
  }

  return rowToJob(updated.rows[0]);
}

async function stopJob(motherCreatorId) {
  const updated = await pool.query(
    `UPDATE maloum_fan_scrape_jobs
     SET status = CASE
           WHEN status = 'completed' THEN 'completed'
           WHEN status = 'failed' THEN 'failed'
           ELSE 'paused'
         END,
         checkpoint = CASE
           WHEN status IN ('completed', 'failed') THEN checkpoint
           ELSE jsonb_set(
             COALESCE(checkpoint, '{}'::jsonb),
             '{statusMessage}',
             '"Stopping…"'::jsonb,
             true
           )
         END,
         "updatedAt" = NOW()
     WHERE "motherCreatorId" = $1
     RETURNING *`,
    [motherCreatorId]
  );

  // In-flight loop exits on next assertStillRunning (DB status !== running).
  return rowToJob(updated.rows[0]);
}

async function resumeRunningJobs() {
  try {
    const result = await pool.query(
      `SELECT "motherCreatorId"
       FROM maloum_fan_scrape_jobs
       WHERE status = 'running'`
    );
    for (const row of result.rows) {
      const motherCreatorId = row.motherCreatorId;
      if (activeRuns.has(motherCreatorId)) continue;
      const generation = Date.now() + Math.floor(Math.random() * 1000);
      activeRuns.set(motherCreatorId, { generation });
      console.log(`[fan-scrape] resuming mother=${motherCreatorId}`);
      setImmediate(() => {
        void runJob(motherCreatorId, generation);
      });
    }
  } catch (err) {
    console.error('[fan-scrape] resumeRunningJobs failed', err);
  }
}

module.exports = {
  startJob,
  stopJob,
  resumeRunningJobs,
  isActive,
  normalizeCheckpoint,
  defaultCheckpoint,
  normalizeUsernameList,
  rowToJob,
};
