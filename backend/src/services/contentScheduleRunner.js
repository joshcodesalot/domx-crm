const fsp = require('fs/promises');
const pool = require('../db/pool');
const { translateToGermanFemdom } = require('./germanTranslator');
const { prepareFeedPhoto } = require('./imageOrient');
const fourBasedClient = require('./fourBasedClient');
const maloumClient = require('./maloumClient');
const { loadFourBasedCreator, loadMaloumCreator } = require('./platformCreatorSession');
const { isInsideMediaDir } = require('./scheduledMedia');
const { getUnsendBeforeMass } = require('./appSettings');
const {
  unsendRecentForCreator,
  MAX_UNSEND_PER_CREATOR,
} = require('./massMessageUnsendAllRunner');
const {
  asIdList,
  asNamedRefs,
  pickRequested,
  refsEqual,
  resolveNamedRefs,
} = require('./scheduleNamedRefs');

const POLL_MS = 15_000;
const DEFAULT_AUDIENCE = [
  'users_with_purchases',
  'users_without_purchases',
  'users_with_subscription',
  'users_without_subscription',
];

let schedulerTimer = null;
let ticking = false;

function parseHashtags(description) {
  const tags = [];
  const seen = new Set();
  const re = /#([\p{L}\p{N}_]+)/gu;
  let match = re.exec(description);
  while (match) {
    const tag = String(match[1] || '').trim();
    if (tag) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tags.push(tag);
      }
    }
    match = re.exec(description);
  }
  return tags;
}

function stripHashtags(text) {
  return String(text || '')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reattachHashtags(translated, tags) {
  const existing = new Set(
    parseHashtags(translated).map((tag) => tag.toLowerCase())
  );
  const missing = tags.filter((tag) => !existing.has(tag.toLowerCase()));
  if (missing.length === 0) return String(translated || '').trim();
  return `${String(translated || '').trim()} ${missing.map((tag) => `#${tag}`).join(' ')}`.trim();
}

async function translateCaption(english) {
  const original = String(english || '').trim();
  if (!original) return '';
  const tags = parseHashtags(original);
  const body = stripHashtags(original);
  if (!body) return tags.map((tag) => `#${tag}`).join(' ');
  const translated = await translateToGermanFemdom(body, []);
  if (!translated) {
    throw new Error('Translation returned empty text');
  }
  return reattachHashtags(translated, tags);
}

function asLiveArray(raw) {
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw)) return raw;
  return [];
}

async function loadSettings(creatorId) {
  const result = await pool.query(
    `SELECT "audienceFilters", "includeListIds", "excludeListIds", "categoryIds"
     FROM creator_schedule_settings
     WHERE "creatorId" = $1`,
    [creatorId]
  );
  const row = result.rows[0];
  const includeLists = asNamedRefs(row?.includeListIds);
  const excludeLists = asNamedRefs(row?.excludeListIds);
  const categoryLists = asNamedRefs(row?.categoryIds).slice(0, 3);
  return {
    audienceFilters: asIdList(row?.audienceFilters).length
      ? asIdList(row.audienceFilters)
      : DEFAULT_AUDIENCE,
    includeListIds: includeLists.map((ref) => ref.id),
    excludeListIds: excludeLists.map((ref) => ref.id),
    categoryIds: categoryLists.map((ref) => ref.id),
    includeLists,
    excludeLists,
    categoryLists,
  };
}

async function persistTargetingIfChanged(creatorId, settings, next) {
  const includeLists = next.includeLists ?? settings.includeLists;
  const excludeLists = next.excludeLists ?? settings.excludeLists;
  const categoryLists = next.categoryLists ?? settings.categoryLists;
  if (
    refsEqual(includeLists, settings.includeLists) &&
    refsEqual(excludeLists, settings.excludeLists) &&
    refsEqual(categoryLists, settings.categoryLists)
  ) {
    return;
  }
  await pool.query(
    `INSERT INTO creator_schedule_settings (
       "creatorId", "audienceFilters", "includeListIds", "excludeListIds", "categoryIds"
     ) VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb)
     ON CONFLICT ("creatorId") DO UPDATE SET
       "includeListIds" = EXCLUDED."includeListIds",
       "excludeListIds" = EXCLUDED."excludeListIds",
       "categoryIds" = EXCLUDED."categoryIds",
       "updatedAt" = NOW()`,
    [
      creatorId,
      JSON.stringify(settings.audienceFilters || DEFAULT_AUDIENCE),
      JSON.stringify(includeLists),
      JSON.stringify(excludeLists),
      JSON.stringify(categoryLists),
    ]
  );
}

function pickNamedFolder(folders, nameRe) {
  const list = Array.isArray(folders) ? folders : [];
  const named = list.find((name) => nameRe.test(String(name || '').trim()));
  return named || list[0] || null;
}

async function pickFourBasedFolder(creator, preferred) {
  if (typeof preferred === 'string' && preferred.trim()) return preferred.trim();
  const profile = await fourBasedClient.getUser(creator, creator.providerUserId);
  const folders = Array.isArray(profile?.folders)
    ? profile.folders.filter((name) => typeof name === 'string' && name.trim())
    : [];
  return pickNamedFolder(folders, /feed/i);
}

async function pickMaloumFolderId(creator, preferred) {
  if (typeof preferred === 'string' && preferred.trim()) return preferred.trim();
  let next;
  const collected = [];
  for (let i = 0; i < 8; i += 1) {
    const result = await maloumClient.listVaultFolders(creator, {
      limit: 25,
      next,
    });
    const folders = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result)
        ? result
        : [];
    collected.push(...folders);
    next = result?.next;
    if (!next || folders.length === 0) break;
  }
  const feed = collected.find((folder) =>
    /feed/i.test(String(folder?.name || '').trim())
  );
  const chosen = feed || collected[0];
  return chosen?._id || chosen?.id || null;
}

async function readJobFile(job) {
  const storedPath = job.storedPath;
  if (!storedPath) {
    throw new Error('Scheduled image is missing');
  }
  if (!isInsideMediaDir(storedPath)) {
    throw new Error('Scheduled image path is invalid');
  }
  try {
    await fsp.access(storedPath);
  } catch {
    throw new Error('Scheduled image file was not found');
  }
  return fsp.readFile(storedPath);
}

async function sendFourBasedMass(job, settings, text) {
  const loaded = await loadFourBasedCreator(job.creatorId);
  if (loaded.error) throw new Error(loaded.error.message);
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  const vaults = Array.isArray(payload.vaults) ? payload.vaults : [];
  let fileStackId = payload.fileStackId || null;
  if (!fileStackId && vaults.length > 0) {
    const fileStack = await fourBasedClient.createFileStackFromVault(loaded.creator, {
      vaults,
      description: text,
      priceCoins: Number(payload.priceCoins) || 0,
    });
    fileStackId = fileStack?._id || null;
    if (!fileStackId) throw new Error('Failed to create file stack for mass message');
  }
  if (!String(text || '').trim() && !fileStackId) {
    throw new Error('Mass message needs text or media');
  }
  await fourBasedClient.sendMassMessage(loaded.creator, {
    message: text,
    includeUserList: asIdList(payload.includeUserList).length
      ? asIdList(payload.includeUserList)
      : settings.includeListIds,
    excludeUserList: asIdList(payload.excludeUserList).length
      ? asIdList(payload.excludeUserList)
      : settings.excludeListIds,
    filter: asIdList(payload.filter).length
      ? asIdList(payload.filter)
      : settings.audienceFilters,
    fileStackId,
  });
}

async function sendMaloumMass(job, settings, text) {
  const loaded = await loadMaloumCreator(job.creatorId);
  if (loaded.error) throw new Error(loaded.error.message);
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  const liveLists = await maloumClient.listAllChatLists(loaded.creator);
  const includeRefs = resolveNamedRefs(
    pickRequested(payload.includeFromLists, settings.includeLists),
    liveLists,
    { fallbackDefault: true }
  );
  if (includeRefs.length === 0) {
    throw new Error('Set include lists for this Maloum creator before the job can send');
  }
  const excludeRefs = resolveNamedRefs(
    pickRequested(payload.excludeFromLists, settings.excludeLists),
    liveLists
  );
  await persistTargetingIfChanged(job.creatorId, settings, {
    includeLists: resolveNamedRefs(settings.includeLists, liveLists, {
      fallbackDefault: true,
    }),
    excludeLists: resolveNamedRefs(settings.excludeLists, liveLists),
  });
  await maloumClient.sendBroadcast(loaded.creator, {
    includeFromLists: includeRefs.map((ref) => ref.id),
    excludeFromLists: excludeRefs.map((ref) => ref.id),
    text,
    media: Array.isArray(payload.media) ? payload.media : [],
    price: Number(payload.price) || 0,
  });
}

async function postFourBasedFeed(job, text) {
  const loaded = await loadFourBasedCreator(job.creatorId);
  if (loaded.error) throw new Error(loaded.error.message);
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  if (payload.vaultId) {
    await fourBasedClient.createFeedPostFromVault(loaded.creator, {
      vaultId: payload.vaultId,
      vaultGuid: payload.vaultGuid,
      description: text,
    });
    return;
  }
  const buffer = await readJobFile(job);
  const prepared = await prepareFeedPhoto(buffer, {
    mimeType: 'image/jpeg',
    maxEdge: 1440,
  });
  const folder = await pickFourBasedFolder(loaded.creator, payload.folder);
  if (!folder) {
    throw new Error('No 4based vault folder found for the feed upload');
  }
  const original = job.imageFileName || 'upload.jpg';
  const fileName = original.replace(/\.[^.]+$/, '') + '.jpg';
  await fourBasedClient.uploadFeedPhoto(loaded.creator, {
    buffer: prepared.buffer,
    width: prepared.width,
    height: prepared.height,
    fileName,
    mimeType: prepared.mimeType || 'image/jpeg',
    description: text,
    folder,
  });
}

async function postMaloumFeed(job, settings, text) {
  const loaded = await loadMaloumCreator(job.creatorId);
  if (loaded.error) throw new Error(loaded.error.message);
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  const liveCategories = asLiveArray(await maloumClient.listCategories(loaded.creator));
  const categoryRefs = resolveNamedRefs(
    pickRequested(payload.categories, settings.categoryLists),
    liveCategories
  ).slice(0, 3);
  if (categoryRefs.length === 0) {
    throw new Error('Set 1–3 Maloum categories for this creator before the post can go out');
  }
  await persistTargetingIfChanged(job.creatorId, settings, {
    categoryLists: resolveNamedRefs(settings.categoryLists, liveCategories).slice(
      0,
      3
    ),
  });
  const categories = categoryRefs.map((ref) => ref.id);

  let mediaId = payload.mediaId || payload.uploadId || null;
  if (!mediaId) {
    const buffer = await readJobFile(job);
    const prepared = await prepareFeedPhoto(buffer, {
      mimeType: 'image/jpeg',
    });
    const folderId = await pickMaloumFolderId(loaded.creator, payload.folderId);
    if (!folderId) {
      throw new Error('No Maloum vault folder found for the feed upload');
    }
    const uploadMeta = await maloumClient.generateUploadUrl(loaded.creator, {
      width: prepared.width,
      height: prepared.height,
      folderId,
    });
    const uploadId =
      uploadMeta?.id || uploadMeta?.uploadId || uploadMeta?._id || null;
    const uploadUrl = uploadMeta?.uploadUrl || uploadMeta?.url || null;
    if (!uploadId || !uploadUrl) {
      throw new Error('Maloum did not return an upload URL');
    }
    const { proxyUrl } = maloumClient.authContext(loaded.creator);
    await maloumClient.uploadToSignedUrl(
      proxyUrl,
      uploadUrl,
      prepared.buffer,
      prepared.mimeType || 'image/jpeg'
    );
    await maloumClient.waitForUploadApproved(loaded.creator, uploadId, {
      folderId,
    });
    mediaId = uploadId;
  }

  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await maloumClient.createPost(loaded.creator, {
        caption: text,
        categories,
        public: payload.public !== false,
        mediaIds: [mediaId],
      });
      return;
    } catch (err) {
      if (!maloumClient.isUploadNotApprovedError(err) || Date.now() >= deadline) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

async function unsendBeforeScheduledMass(job) {
  const enabled = await getUnsendBeforeMass();
  if (!enabled) return;
  const result = await unsendRecentForCreator(job.platform, job.creatorId, {
    cap: MAX_UNSEND_PER_CREATOR,
  });
  if (result?.skipped) {
    console.log(
      'Scheduled mass skipped unsend-before-send:',
      job.id,
      job.platform,
      result.reason
    );
    return;
  }
  console.log(
    'Scheduled mass unsend-before-send:',
    job.id,
    job.platform,
    `done=${result.done} failed=${result.failed}`
  );
}

async function executeJob(job) {
  const settings = await loadSettings(job.creatorId);
  const english = String(job.bodyText || '').trim();
  const text = english ? await translateCaption(english) : '';

  if (job.kind === 'mass_message') {
    await unsendBeforeScheduledMass(job);
    if (job.platform === '4based') {
      await sendFourBasedMass(job, settings, text);
      return;
    }
    await sendMaloumMass(job, settings, text);
    return;
  }

  if (job.platform === '4based') {
    await postFourBasedFeed(job, text);
    return;
  }
  await postMaloumFeed(job, settings, text);
}

async function claimDueJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT j.*
       FROM scheduled_content_jobs j
       WHERE j.status = 'pending'
         AND j."runAt" <= NOW()
         AND NOT EXISTS (
           SELECT 1
           FROM scheduled_content_jobs r
           WHERE r."creatorId" = j."creatorId"
             AND r.platform = j.platform
             AND r.status = 'running'
         )
       ORDER BY j."runAt" ASC
       LIMIT 1
       FOR UPDATE OF j SKIP LOCKED`
    );
    const job = result.rows[0];
    if (!job) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(
      `UPDATE scheduled_content_jobs
       SET status = 'running', "updatedAt" = NOW(), "lastError" = NULL
       WHERE id = $1`,
      [job.id]
    );
    await client.query('COMMIT');
    return { ...job, status: 'running' };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

async function finishJob(id, status, lastError) {
  await pool.query(
    `UPDATE scheduled_content_jobs
     SET status = $2, "lastError" = $3, "updatedAt" = NOW()
     WHERE id = $1 AND status = 'running'`,
    [id, status, lastError || null]
  );
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (let i = 0; i < 5; i += 1) {
      const job = await claimDueJob();
      if (!job) break;
      try {
        await executeJob(job);
        await finishJob(job.id, 'sent', null);
      } catch (err) {
        const message = err?.message || 'Scheduled job failed';
        console.error('Scheduled content job failed:', job.id, message);
        await finishJob(job.id, 'failed', message);
      }
    }
  } catch (err) {
    console.error('Content schedule tick failed:', err);
  } finally {
    ticking = false;
  }
}

function startContentScheduleRunner() {
  if (schedulerTimer) return;
  const run = () => {
    void tick();
  };
  run();
  schedulerTimer = setInterval(run, POLL_MS);
  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

function stopContentScheduleRunner() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  startContentScheduleRunner,
  stopContentScheduleRunner,
  tick,
  DEFAULT_AUDIENCE,
};
