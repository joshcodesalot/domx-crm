const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { decryptJson, decryptSecret } = require('./crypto');
const fourBasedClient = require('./fourBasedClient');

const COMMENT_DELAY_MS = 1200;
const FAN_COOLDOWN_MIN_MS = 45_000;
const FAN_COOLDOWN_MAX_MS = 60_000;
const POST_CHECK_COOLDOWN_MIN_MS = 10_000;
const POST_CHECK_COOLDOWN_MAX_MS = 15_000;
const COOLDOWN_POLL_MS = 500;
const TRENDING_PAGE_SIZE = 60;
const COMMENT_PAGE_SIZE = 20;

/** @type {Map<string, { generation: number }>} */
const activeRuns = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomFanCooldownMs() {
  return (
    FAN_COOLDOWN_MIN_MS +
    Math.floor(Math.random() * (FAN_COOLDOWN_MAX_MS - FAN_COOLDOWN_MIN_MS + 1))
  );
}

function randomPostCheckCooldownMs() {
  return (
    POST_CHECK_COOLDOWN_MIN_MS +
    Math.floor(
      Math.random() * (POST_CHECK_COOLDOWN_MAX_MS - POST_CHECK_COOLDOWN_MIN_MS + 1)
    )
  );
}

function formatCooldownSeconds(ms) {
  return (ms / 1000).toFixed(3);
}

function formatFanLabel(username, fanId) {
  const id = fanId != null && String(fanId).trim() ? String(fanId) : null;
  const name =
    username != null && String(username).trim() ? String(username).trim() : null;
  if (name && id) return `${name}/${id}`;
  return name || id || 'unknown';
}

const MAX_RECENT_LOGS = 200;

function normalizeRecentLogs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ at: 0, text: item.trim() });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) continue;
    out.push({
      at: Number(item.at) || 0,
      text,
    });
  }
  return out.slice(-MAX_RECENT_LOGS);
}

function appendActivityLog(cp, text) {
  const line = String(text || '').trim();
  if (!line) return cp;
  console.log(`[4based-fan-scrape] ${line}`);
  const logs = Array.isArray(cp?.recentLogs) ? cp.recentLogs.slice() : [];
  logs.push({ at: Date.now(), text: line });
  return {
    ...cp,
    recentLogs: logs.length > MAX_RECENT_LOGS ? logs.slice(-MAX_RECENT_LOGS) : logs,
  };
}

function logFanToCheckpoint(cp, sign, label, outcome) {
  return appendActivityLog(cp, `${sign} ${label} - ${outcome}`);
}

async function sleepInterruptible(ms, motherCreatorId, generation) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await assertStillRunning(motherCreatorId, generation);
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(remaining, COOLDOWN_POLL_MS));
  }
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
    skippedPosts: 0,
    importFanIndex: 0,
    importCreatorIndex: 0,
    lastError: null,
    currentPostId: null,
    statusMessage: null,
    trendingExhausted: false,
    recentLogs: [],
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
    skippedPosts: Number(raw.skippedPosts) || 0,
    importFanIndex: Number(raw.importFanIndex) || 0,
    importCreatorIndex: Number(raw.importCreatorIndex) || 0,
    trendingExhausted: Boolean(raw.trendingExhausted),
    statusMessage:
      typeof raw.statusMessage === 'string' ? raw.statusMessage : null,
    currentPostId:
      raw.currentPostId == null ? null : String(raw.currentPostId),
    lastError: raw.lastError == null ? null : String(raw.lastError),
    recentLogs: normalizeRecentLogs(raw.recentLogs),
  };
}

function isSkippableFileStackError(err) {
  const status = err?.status;
  const message = String(err?.message || '');
  if (status === 404) return true;
  if (/file\s*stack/i.test(message) && /does not exist/i.test(message)) {
    return true;
  }
  if (/file\s*stack/i.test(message) && /not found/i.test(message)) {
    return true;
  }
  return false;
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

function normalizeUuidList(input) {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .map((v) => String(v).trim())
        .filter((v) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            v
          )
        )
    ),
  ];
}

/** Accept `{ id: username }` object or string[] of ids. */
function normalizeImportFans(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out = {};
    for (const [id, name] of Object.entries(input)) {
      const fanId = String(id).trim();
      if (!fanId) continue;
      out[fanId] =
        name == null || name === ''
          ? null
          : String(name).trim() || null;
    }
    return out;
  }
  if (Array.isArray(input)) {
    const out = {};
    for (const item of input) {
      if (item && typeof item === 'object') {
        const fanId = String(item._id || item.id || '').trim();
        if (!fanId) continue;
        out[fanId] = item.name || item.username || null;
      } else {
        const fanId = String(item).trim();
        if (fanId) out[fanId] = null;
      }
    }
    return out;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return {};
    try {
      return normalizeImportFans(JSON.parse(trimmed));
    } catch {
      const out = {};
      for (const part of trimmed.split(/[\n,\s]+/)) {
        const fanId = part.trim();
        if (fanId) out[fanId] = null;
      }
      return out;
    }
  }
  return {};
}

function importFanEntries(importFans) {
  const map = normalizeImportFans(importFans);
  return Object.entries(map).map(([fanId, username]) => ({
    fanId,
    username,
  }));
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
    sourceMode: row.sourceMode || 'trending',
    messageText: row.messageText || '',
    vaultIds: Array.isArray(row.vaultIds) ? row.vaultIds : [],
    priceCoins: Number(row.priceCoins) || 0,
    importFans: normalizeImportFans(row.importFans || {}),
    targetCreatorIds: Array.isArray(row.targetCreatorIds)
      ? row.targetCreatorIds
      : [],
    checkpoint: normalizeCheckpoint(row.checkpoint),
    startedAt: row.startedAt || null,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId || null,
  };
}

function abortError() {
  const err = new Error('ABORTED');
  err.code = 'ABORTED';
  return err;
}

async function saveCheckpoint(motherCreatorId, checkpoint, status) {
  const payload = JSON.stringify(normalizeCheckpoint(checkpoint));
  if (status === 'running') {
    const result = await pool.query(
      `UPDATE fourbased_fan_scrape_jobs
       SET checkpoint = $2::jsonb,
           "updatedAt" = NOW()
       WHERE "motherCreatorId" = $1
         AND status = 'running'
       RETURNING *`,
      [motherCreatorId, payload]
    );
    if (!result.rows[0]) {
      await pool.query(
        `UPDATE fourbased_fan_scrape_jobs
         SET checkpoint = $2::jsonb,
             "updatedAt" = NOW()
         WHERE "motherCreatorId" = $1
           AND status = 'paused'`,
        [motherCreatorId, payload]
      );
      throw abortError();
    }
    return rowToJob(result.rows[0]);
  }

  const result = await pool.query(
    `UPDATE fourbased_fan_scrape_jobs
     SET checkpoint = $2::jsonb,
         status = COALESCE($3, status),
         "updatedAt" = NOW()
     WHERE "motherCreatorId" = $1
     RETURNING *`,
    [motherCreatorId, payload, status || null]
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
  if (!active || active.generation !== generation || active.aborted) {
    throw abortError();
  }
  const status = await getJobStatus(motherCreatorId);
  if (status !== 'running') {
    throw abortError();
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

function isInteractionRestricted(err) {
  if (!err) return false;
  if (err.status === 420) return true;
  const systemCode = err.body?.systemCode || err.body?.system_code;
  if (
    typeof systemCode === 'string' &&
    systemCode.toLowerCase() === 'interactionrestrictedexception'
  ) {
    return true;
  }
  const message = typeof err.message === 'string' ? err.message : '';
  return /interaction is restricted/i.test(message);
}

async function openOrCreateChat(creator, fanId) {
  const existing = await fourBasedClient.getChatByUser(creator, fanId);
  const existingId = extractChatId(existing);
  if (existingId) return existingId;
  const created = await fourBasedClient.createChatByUser(creator, fanId);
  return extractChatId(created);
}

async function processFan(creator, job, fan, sourcePostId, cp, senderCreatorId) {
  const fanId = fan?._id;
  const label = formatFanLabel(fan?.name || fan?.username, fanId);
  if (!fanId) {
    return logFanToCheckpoint(
      { ...cp, skippedFans: cp.skippedFans + 1 },
      '-',
      label,
      'SKIPPED - MISSING ID'
    );
  }
  if (fan.own) {
    return logFanToCheckpoint(
      { ...cp, skippedFans: cp.skippedFans + 1 },
      '-',
      label,
      'SKIPPED - OWN ACCOUNT'
    );
  }
  if (isNotContactable(fan.cold_communication_status)) {
    return logFanToCheckpoint(
      { ...cp, skippedFans: cp.skippedFans + 1 },
      '-',
      label,
      'SKIPPED - NOT CONTACTABLE'
    );
  }

  const ownerId = senderCreatorId || job.motherCreatorId;
  if (await fanExists(ownerId, fanId)) {
    return logFanToCheckpoint(
      { ...cp, skippedFans: cp.skippedFans + 1 },
      '-',
      label,
      'SKIPPED - ALREADY MESSAGED'
    );
  }

  try {
    const chatId = await openOrCreateChat(creator, fanId);
    if (!chatId) {
      const reason = `No chat opened for fan ${fanId}`;
      return logFanToCheckpoint(
        {
          ...cp,
          failedFans: cp.failedFans + 1,
          lastError: reason,
        },
        '-',
        label,
        `FAILED - ${reason}`
      );
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

    await upsertFan(ownerId, {
      fanId: String(fanId),
      chatId,
      username: fan.name || fan.username || null,
      sourcePostId,
      messageId,
    });

    return logFanToCheckpoint(
      {
        ...cp,
        processedFans: cp.processedFans + 1,
        lastError: null,
      },
      '+',
      label,
      'MESSAGED'
    );
  } catch (err) {
    if (err?.code === 'ABORTED') throw err;
    if (isInteractionRestricted(err)) {
      return logFanToCheckpoint(
        { ...cp, skippedFans: cp.skippedFans + 1 },
        '-',
        label,
        'SKIPPED - INTERACTION RESTRICTED'
      );
    }
    const reason = err?.message || 'Failed to message fan';
    return logFanToCheckpoint(
      {
        ...cp,
        failedFans: cp.failedFans + 1,
        lastError: reason,
      },
      '-',
      label,
      `FAILED - ${reason}`
    );
  }
}

async function listFourBasedCreatorIds(excludeId) {
  const result = await pool.query(
    `SELECT id FROM creators
     WHERE platform = '4based'
       AND "encryptedAccessToken" IS NOT NULL
       ${excludeId ? 'AND id <> $1' : ''}
     ORDER BY "displayName" ASC NULLS LAST`,
    excludeId ? [excludeId] : []
  );
  return result.rows.map((row) => row.id);
}

async function resolveImportTargets(job) {
  const configured = normalizeUuidList(job.targetCreatorIds || []).filter(
    (id) => id !== job.motherCreatorId
  );
  if (configured.length === 0) return [job.motherCreatorId];
  return [job.motherCreatorId, ...configured];
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

async function runImportColdDm(motherCreatorId, job, generation) {
  const fans = importFanEntries(job.importFans);
  if (fans.length === 0) {
    await saveCheckpoint(
      motherCreatorId,
      {
        ...job.checkpoint,
        lastError: 'Paste at least one fan ID to import',
        statusMessage: 'Missing import fan IDs',
      },
      'failed'
    );
    return;
  }

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

  const targetIds = await resolveImportTargets(job);
  let cp = normalizeCheckpoint(job.checkpoint);

  while (cp.importFanIndex < fans.length) {
    await assertStillRunning(motherCreatorId, generation);
    const fan = fans[cp.importFanIndex];

    while (cp.importCreatorIndex < targetIds.length) {
      await assertStillRunning(motherCreatorId, generation);
      const senderId = targetIds[cp.importCreatorIndex];
      cp = {
        ...cp,
        statusMessage: `Import DM · fan ${cp.importFanIndex + 1}/${fans.length} · creator ${cp.importCreatorIndex + 1}/${targetIds.length} · sent ${cp.processedFans}`,
      };
      await saveCheckpoint(motherCreatorId, cp, 'running');

      try {
        const sender = await loadFourBasedCreator(senderId);
        // Vault IDs belong to the coordinator account — only that sender can PPV them.
        const senderJob = {
          ...job,
          motherCreatorId: senderId,
          vaultIds:
            senderId === motherCreatorId ? job.vaultIds || [] : [],
          priceCoins: senderId === motherCreatorId ? job.priceCoins : 0,
        };
        cp = await processFan(
          sender,
          senderJob,
          { _id: fan.fanId, name: fan.username },
          'import_ids',
          cp,
          senderId
        );
      } catch (err) {
        if (err?.code === 'ABORTED') throw err;
        const reason = err?.message || 'Failed to cold DM fan';
        cp = logFanToCheckpoint(
          {
            ...cp,
            failedFans: cp.failedFans + 1,
            lastError: reason,
          },
          '-',
          formatFanLabel(fan.username, fan.fanId),
          `FAILED - ${reason}`
        );
      }

      const cooldownMs = randomFanCooldownMs();
      cp = {
        ...cp,
        importCreatorIndex: cp.importCreatorIndex + 1,
        statusMessage: `Import DM · fan ${cp.importFanIndex + 1}/${fans.length} · creator ${cp.importCreatorIndex + 1}/${targetIds.length} · sent ${cp.processedFans} · cooldown ${formatCooldownSeconds(cooldownMs)}s`,
      };
      await saveCheckpoint(motherCreatorId, cp, 'running');
      await sleepInterruptible(cooldownMs, motherCreatorId, generation);
    }

    cp = {
      ...cp,
      importFanIndex: cp.importFanIndex + 1,
      importCreatorIndex: 0,
    };
    await saveCheckpoint(motherCreatorId, cp, 'running');
  }

  cp = {
    ...cp,
    lastError: null,
    statusMessage: `Completed · ${cp.processedFans} messaged · ${cp.skippedFans} skipped · ${cp.failedFans} failed`,
  };
  await saveCheckpoint(motherCreatorId, cp, 'completed');
  console.log(
    `[4based-fan-scrape] import completed mother=${motherCreatorId} processed=${cp.processedFans}`
  );
}

async function runTrendingScrape(motherCreatorId, job, generation) {
  const creator = await loadFourBasedCreator(motherCreatorId);
  let cp = normalizeCheckpoint(job.checkpoint);

  while (true) {
    await assertStillRunning(motherCreatorId, generation);
    cp = await ensureTrendingPage(creator, motherCreatorId, cp, generation);

    if (cp.currentPagePostIds.length === 0) {
      cp = {
        ...cp,
        lastError: null,
        statusMessage: `Completed · ${cp.processedFans} messaged · ${cp.skippedFans} skipped · ${cp.failedFans} failed · ${cp.skippedPosts || 0} posts skipped`,
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
      const postCooldownMs = randomPostCheckCooldownMs();
      cp = {
        ...cp,
        currentPostId: postId,
        statusMessage: `Post ${cp.postIndex + 1}/${cp.currentPagePostIds.length} @ offset ${cp.trendingOffset} · fans ${cp.processedFans} · cooldown ${formatCooldownSeconds(postCooldownMs)}s`,
      };
      await saveCheckpoint(motherCreatorId, cp, 'running');
      await sleepInterruptible(postCooldownMs, motherCreatorId, generation);

      let commentsDone = false;
      let postSkipped = false;
      while (!commentsDone) {
        await assertStillRunning(motherCreatorId, generation);
        await sleep(COMMENT_DELAY_MS);
        let page;
        try {
          page = await fourBasedClient.listFileStackComments(creator, postId, {
            offset: cp.commentOffset,
            limit: COMMENT_PAGE_SIZE,
          });
        } catch (err) {
          if (isSkippableFileStackError(err)) {
            cp = appendActivityLog(
              {
                ...cp,
                skippedPosts: (cp.skippedPosts || 0) + 1,
                lastError: err?.message || 'FileStack skipped (missing)',
                commentOffset: 0,
                currentPostId: null,
                postIndex: cp.postIndex + 1,
                statusMessage: `Skipped missing FileStack · fans ${cp.processedFans} · skipped posts ${(cp.skippedPosts || 0)}`,
              },
              `- POST ${postId} - SKIPPED - MISSING FILESTACK`
            );
            await saveCheckpoint(motherCreatorId, cp, 'running');
            postSkipped = true;
            break;
          }
          throw err;
        }
        const comments = asArray(page);

        for (const comment of comments) {
          await assertStillRunning(motherCreatorId, generation);
          cp = await processFan(creator, job, comment?.user, postId, cp);
          const cooldownMs = randomFanCooldownMs();
          cp = {
            ...cp,
            statusMessage: `Post ${cp.postIndex + 1}/${cp.currentPagePostIds.length} @ offset ${cp.trendingOffset} · fans ${cp.processedFans}${cp.skippedPosts ? ` · skipped posts ${cp.skippedPosts}` : ''} · cooldown ${formatCooldownSeconds(cooldownMs)}s`,
          };
          await saveCheckpoint(motherCreatorId, cp, 'running');
          await sleepInterruptible(cooldownMs, motherCreatorId, generation);
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

      if (postSkipped) continue;

      cp = {
        ...cp,
        postIndex: cp.postIndex + 1,
        commentOffset: 0,
        currentPostId: null,
      };
      await saveCheckpoint(motherCreatorId, cp, 'running');
    }

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
        statusMessage: `Completed · ${cp.processedFans} messaged · ${cp.skippedFans} skipped · ${cp.failedFans} failed · ${cp.skippedPosts || 0} posts skipped`,
      };
      await saveCheckpoint(motherCreatorId, cp, 'completed');
      console.log(
        `[4based-fan-scrape] completed mother=${motherCreatorId} processed=${cp.processedFans}`
      );
      return;
    }
  }
}

async function runJob(motherCreatorId, generation) {
  try {
    const row = await loadJobRow(motherCreatorId);
    if (!row) return;
    const job = rowToJob(row);
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

    if (job.sourceMode === 'import_ids') {
      await runImportColdDm(motherCreatorId, job, generation);
      return;
    }

    await runTrendingScrape(motherCreatorId, job, generation);
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
  if (job.sourceMode === 'import_ids' && importFanEntries(job.importFans).length === 0) {
    throw Object.assign(new Error('Paste at least one fan ID to import'), {
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
  const active = activeRuns.get(motherCreatorId);
  if (active) {
    active.aborted = true;
  }
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
  normalizeImportFans,
  normalizeUuidList,
  rowToJob,
};
