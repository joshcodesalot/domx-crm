const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { decryptJson, decryptSecret } = require('./crypto');
const fourBasedClient = require('./fourBasedClient');

const COMMENT_DELAY_MS = 1200;
const STEP_DELAY_MS = 400;
const TRENDING_PAGE_SIZE = 60;
const COMMENT_PAGE_SIZE = 20;

/** @type {Map<string, { generation: number }>} */
const activeRuns = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultCheckpoint() {
  return {
    trendingOffset: 0,
    currentPagePostIds: [],
    postIndex: 0,
    commentOffset: 0,
    processedFans: 0,
    skippedFans: 0,
    failedFans: 0,
    lastError: null,
    currentPostId: null,
    statusMessage: null,
    trendingExhausted: false,
  };
}

function normalizeCheckpoint(raw) {
  const base = defaultCheckpoint();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    currentPagePostIds: Array.isArray(raw.currentPagePostIds)
      ? raw.currentPagePostIds.map(String).filter(Boolean)
      : [],
    trendingOffset: Number(raw.trendingOffset) || 0,
    postIndex: Number(raw.postIndex) || 0,
    commentOffset: Number(raw.commentOffset) || 0,
    processedFans: Number(raw.processedFans) || 0,
    skippedFans: Number(raw.skippedFans) || 0,
    failedFans: Number(raw.failedFans) || 0,
    trendingExhausted: Boolean(raw.trendingExhausted),
    statusMessage:
      typeof raw.statusMessage === 'string' ? raw.statusMessage : null,
    currentPostId:
      raw.currentPostId == null ? null : String(raw.currentPostId),
    lastError: raw.lastError == null ? null : String(raw.lastError),
  };
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function isNotContactable(status) {
  if (!status || typeof status !== 'string') return false;
  return status.includes('not_contactable');
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
    throw new Error('Creator not found');
  }

  const row = result.rows[0];
  if (row.platform !== '4based') {
    throw new Error('Creator is not a 4based account');
  }

  let session = {};
  try {
    if (row.encryptedSession) {
      session = decryptJson(row.encryptedSession) || {};
    }
  } catch {
    throw new Error('Failed to decrypt 4based session');
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
    throw new Error('4based account is missing auth credentials. Please reconnect.');
  }
  if (!proxyUrl) {
    throw new Error(
      '4based proxy is required. Set FOURBASED_PROXY_URL in backend .env or reconnect with a proxy.'
    );
  }

  return {
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
  };
}

async function loadJobRow(motherCreatorId) {
  const result = await pool.query(
    `SELECT * FROM fourbased_fan_scrape_jobs WHERE "motherCreatorId" = $1`,
    [motherCreatorId]
  );
  return result.rows[0] || null;
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    motherCreatorId: row.motherCreatorId,
    status: row.status,
    messageText: row.messageText || '',
    vaultIds: Array.isArray(row.vaultIds) ? row.vaultIds : [],
    priceCoins: Number(row.priceCoins) || 0,
    checkpoint: normalizeCheckpoint(row.checkpoint),
    startedAt: row.startedAt || null,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId || null,
  };
}

async function saveCheckpoint(motherCreatorId, checkpoint, status) {
  const result = await pool.query(
    `UPDATE fourbased_fan_scrape_jobs
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
    `SELECT status FROM fourbased_fan_scrape_jobs WHERE "motherCreatorId" = $1`,
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
    `SELECT 1 FROM fourbased_fan_scrape_fans
     WHERE "motherCreatorId" = $1 AND "fanId" = $2
     LIMIT 1`,
    [motherCreatorId, fanId]
  );
  return result.rows.length > 0;
}

async function upsertFan(motherCreatorId, payload) {
  await pool.query(
    `INSERT INTO fourbased_fan_scrape_fans (
       id, "motherCreatorId", "fanId", "chatId", username,
       "sourcePostId", "messageId"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ("motherCreatorId", "fanId") DO UPDATE SET
       "chatId" = COALESCE(EXCLUDED."chatId", fourbased_fan_scrape_fans."chatId"),
       username = COALESCE(EXCLUDED.username, fourbased_fan_scrape_fans.username),
       "sourcePostId" = COALESCE(
         EXCLUDED."sourcePostId",
         fourbased_fan_scrape_fans."sourcePostId"
       ),
       "messageId" = COALESCE(EXCLUDED."messageId", fourbased_fan_scrape_fans."messageId"),
       "scrapedAt" = NOW()`,
    [
      randomUUID(),
      motherCreatorId,
      payload.fanId,
      payload.chatId || null,
      payload.username || null,
      payload.sourcePostId || null,
      payload.messageId || null,
    ]
  );
}

function extractChatId(chatPayload) {
  const list = asArray(chatPayload);
  if (list.length > 0 && list[0]?._id) return String(list[0]._id);
  if (chatPayload?._id) return String(chatPayload._id);
  if (chatPayload?.chat?._id) return String(chatPayload.chat._id);
  return null;
}

async function processFan(creator, job, fan, sourcePostId, cp) {
  const fanId = fan?._id;
  if (!fanId || fan.own) {
    return { ...cp, skippedFans: cp.skippedFans + 1 };
  }
  if (isNotContactable(fan.cold_communication_status)) {
    return { ...cp, skippedFans: cp.skippedFans + 1 };
  }

  if (await fanExists(job.motherCreatorId, fanId)) {
    return { ...cp, skippedFans: cp.skippedFans + 1 };
  }

  try {
    const chatPayload = await fourBasedClient.getChatByUser(creator, fanId);
    const chatId = extractChatId(chatPayload);
    if (!chatId) {
      return {
        ...cp,
        failedFans: cp.failedFans + 1,
        lastError: `No chat opened for fan ${fanId}`,
      };
    }

    let messageId = null;
    const messageText = job.messageText || '';
    const vaultIds = job.vaultIds || [];

    if (vaultIds.length > 0) {
      const sent = await fourBasedClient.sendPpv(creator, chatId, {
        message: messageText,
        vaults: vaultIds.map((id, index) => ({
          id: String(id),
          position: index,
          is_teaser: false,
        })),
        priceCoins: Number(job.priceCoins) || 0,
      });
      messageId = sent?.message?._id || null;
    } else {
      const sent = await fourBasedClient.sendText(creator, chatId, {
        message: messageText,
      });
      messageId = sent?._id || null;
    }

    await upsertFan(job.motherCreatorId, {
      fanId: String(fanId),
      chatId,
      username: fan.name || null,
      sourcePostId,
      messageId,
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
      lastError: err?.message || 'Failed to message fan',
    };
  }
}

async function ensureTrendingPage(creator, motherCreatorId, cp, generation) {
  if (cp.currentPagePostIds.length > 0 && cp.postIndex < cp.currentPagePostIds.length) {
    return cp;
  }
  if (cp.trendingExhausted) {
    return cp;
  }

  await assertStillRunning(motherCreatorId, generation);
  cp = {
    ...cp,
    statusMessage: `Loading trending posts @ offset ${cp.trendingOffset}…`,
  };
  await saveCheckpoint(motherCreatorId, cp, 'running');

  const page = await fourBasedClient.listTrendingFileStacks(creator, {
    offset: cp.trendingOffset,
    limit: TRENDING_PAGE_SIZE,
  });
  const items = asArray(page);
  const postIds = items.map((item) => item?._id).filter(Boolean).map(String);

  if (postIds.length === 0 || postIds.length < TRENDING_PAGE_SIZE) {
    cp = {
      ...cp,
      currentPagePostIds: postIds,
      postIndex: 0,
      commentOffset: 0,
      trendingExhausted: postIds.length === 0 || postIds.length < TRENDING_PAGE_SIZE,
      statusMessage:
        postIds.length === 0
          ? 'No more trending posts'
          : `Loaded final trending page (${postIds.length} posts)`,
    };
  } else {
    cp = {
      ...cp,
      currentPagePostIds: postIds,
      postIndex: 0,
      commentOffset: 0,
      trendingExhausted: false,
      statusMessage: `Loaded trending page @ ${cp.trendingOffset} (${postIds.length} posts)`,
    };
  }

  await saveCheckpoint(motherCreatorId, cp, 'running');
  return cp;
}

async function runJob(motherCreatorId, generation) {
  try {
    const row = await loadJobRow(motherCreatorId);
    if (!row) return;
    let job = rowToJob(row);
    if (job.status !== 'running') return;

    const hasMessage = Boolean((job.messageText || '').trim());
    const hasVault = (job.vaultIds || []).length > 0;
    if (!hasMessage && !hasVault) {
      await saveCheckpoint(
        motherCreatorId,
        {
          ...job.checkpoint,
          lastError: 'Add a message or vault media before starting',
          statusMessage: 'Missing message/media',
        },
        'failed'
      );
      return;
    }

    const creator = await loadFourBasedCreator(motherCreatorId);
    let cp = normalizeCheckpoint(job.checkpoint);

    while (true) {
      await assertStillRunning(motherCreatorId, generation);
      cp = await ensureTrendingPage(creator, motherCreatorId, cp, generation);

      if (cp.currentPagePostIds.length === 0) {
        cp = {
          ...cp,
          lastError: null,
          statusMessage: `Completed · ${cp.processedFans} messaged · ${cp.skippedFans} skipped · ${cp.failedFans} failed`,
        };
        await saveCheckpoint(motherCreatorId, cp, 'completed');
        console.log(
          `[4based-fan-scrape] completed mother=${motherCreatorId} processed=${cp.processedFans}`
        );
        return;
      }

      while (cp.postIndex < cp.currentPagePostIds.length) {
        await assertStillRunning(motherCreatorId, generation);
        const postId = cp.currentPagePostIds[cp.postIndex];
        cp = {
          ...cp,
          currentPostId: postId,
          statusMessage: `Post ${cp.postIndex + 1}/${cp.currentPagePostIds.length} @ offset ${cp.trendingOffset} · fans ${cp.processedFans}`,
        };
        await saveCheckpoint(motherCreatorId, cp, 'running');

        let commentsDone = false;
        while (!commentsDone) {
          await assertStillRunning(motherCreatorId, generation);
          await sleep(COMMENT_DELAY_MS);
          const page = await fourBasedClient.listFileStackComments(creator, postId, {
            offset: cp.commentOffset,
            limit: COMMENT_PAGE_SIZE,
          });
          const comments = asArray(page);

          for (const comment of comments) {
            await assertStillRunning(motherCreatorId, generation);
            cp = await processFan(creator, job, comment?.user, postId, cp);
            cp = {
              ...cp,
              statusMessage: `Post ${cp.postIndex + 1}/${cp.currentPagePostIds.length} @ offset ${cp.trendingOffset} · fans ${cp.processedFans}`,
            };
            await saveCheckpoint(motherCreatorId, cp, 'running');
            await sleep(STEP_DELAY_MS);
          }

          if (comments.length < COMMENT_PAGE_SIZE) {
            commentsDone = true;
            cp = { ...cp, commentOffset: 0 };
          } else {
            cp = {
              ...cp,
              commentOffset: cp.commentOffset + comments.length,
            };
            await saveCheckpoint(motherCreatorId, cp, 'running');
          }
        }

        cp = {
          ...cp,
          postIndex: cp.postIndex + 1,
          commentOffset: 0,
          currentPostId: null,
        };
        await saveCheckpoint(motherCreatorId, cp, 'running');
      }

      // Advance trending pagination
      const pageLen = cp.currentPagePostIds.length;
      const wasLastPage = cp.trendingExhausted || pageLen < TRENDING_PAGE_SIZE;
      cp = {
        ...cp,
        trendingOffset: cp.trendingOffset + pageLen,
        currentPagePostIds: [],
        postIndex: 0,
        commentOffset: 0,
        trendingExhausted: wasLastPage,
      };
      await saveCheckpoint(motherCreatorId, cp, 'running');

      if (wasLastPage) {
        cp = {
          ...cp,
          lastError: null,
          statusMessage: `Completed · ${cp.processedFans} messaged · ${cp.skippedFans} skipped · ${cp.failedFans} failed`,
        };
        await saveCheckpoint(motherCreatorId, cp, 'completed');
        console.log(
          `[4based-fan-scrape] completed mother=${motherCreatorId} processed=${cp.processedFans}`
        );
        return;
      }
    }
  } catch (err) {
    if (err?.code === 'ABORTED') {
      const row = await loadJobRow(motherCreatorId);
      if (row && row.status === 'paused') {
        const cp = normalizeCheckpoint(row.checkpoint);
        await saveCheckpoint(
          motherCreatorId,
          {
            ...cp,
            statusMessage: `Paused · ${cp.processedFans} messaged`,
          },
          'paused'
        );
      }
      console.log(`[4based-fan-scrape] paused/stopped mother=${motherCreatorId}`);
      return;
    }

    console.error(`[4based-fan-scrape] failed mother=${motherCreatorId}`, err);
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
      console.error('[4based-fan-scrape] failed to persist error state', saveErr);
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

async function startJob(motherCreatorId) {
  const row = await loadJobRow(motherCreatorId);
  if (!row) {
    throw Object.assign(new Error('Fan scrape job not found'), { status: 404 });
  }
  const job = rowToJob(row);
  const hasMessage = Boolean((job.messageText || '').trim());
  const hasVault = (job.vaultIds || []).length > 0;
  if (!hasMessage && !hasVault) {
    throw Object.assign(new Error('Add a message or vault media before starting'), {
      status: 400,
    });
  }

  const updated = await pool.query(
    `UPDATE fourbased_fan_scrape_jobs
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
    console.log(`[4based-fan-scrape] started mother=${motherCreatorId}`);
  } else {
    console.log(`[4based-fan-scrape] already running in-process mother=${motherCreatorId}`);
  }

  return rowToJob(updated.rows[0]);
}

async function stopJob(motherCreatorId) {
  const updated = await pool.query(
    `UPDATE fourbased_fan_scrape_jobs
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
  return rowToJob(updated.rows[0]);
}

async function resumeRunningJobs() {
  try {
    const result = await pool.query(
      `SELECT "motherCreatorId"
       FROM fourbased_fan_scrape_jobs
       WHERE status = 'running'`
    );
    for (const row of result.rows) {
      const motherCreatorId = row.motherCreatorId;
      if (activeRuns.has(motherCreatorId)) continue;
      const generation = Date.now() + Math.floor(Math.random() * 1000);
      activeRuns.set(motherCreatorId, { generation });
      console.log(`[4based-fan-scrape] resuming mother=${motherCreatorId}`);
      setImmediate(() => {
        void runJob(motherCreatorId, generation);
      });
    }
  } catch (err) {
    console.error('[4based-fan-scrape] resumeRunningJobs failed', err);
  }
}

module.exports = {
  startJob,
  stopJob,
  resumeRunningJobs,
  isActive,
  normalizeCheckpoint,
  defaultCheckpoint,
  rowToJob,
};
