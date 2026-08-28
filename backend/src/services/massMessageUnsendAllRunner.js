const { loadFourBasedCreator, loadMaloumCreator } = require('./platformCreatorSession');
const fourBasedClient = require('./fourBasedClient');
const maloumClient = require('./maloumClient');

/** @typedef {{ abort: boolean, status: string, done: number, failed: number, totalEstimate: number, currentId: string | null, lastError: string | null, startedAt: number, currentCreatorId: string | null, currentCreatorName: string | null, creatorsDone: number, creatorsTotal: number, creatorsSkipped: number }} UnsendRun */

/** @type {Map<string, UnsendRun>} */
const runs = new Map();

function runKey(platform, creatorId) {
  return `${platform}:${creatorId}`;
}

function platformAllKey(platform) {
  return `${platform}:all`;
}

const MAX_UNSEND_PER_CREATOR = 30;

function randomUnsendGapMs() {
  return 5000 + Math.floor(Math.random() * 5001);
}

function creatorUnsendCap(opts) {
  const cap = Number(opts?.cap);
  if (Number.isFinite(cap) && cap > 0) return Math.floor(cap);
  return opts.skipLoadErrors ? MAX_UNSEND_PER_CREATOR : Number.POSITIVE_INFINITY;
}

function sleep(ms, shouldAbort) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (shouldAbort() || Date.now() >= end) {
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
    done: 0,
    failed: 0,
    totalEstimate: 0,
    currentId: null,
    lastError: null,
    currentCreatorId: null,
    currentCreatorName: null,
    creatorsDone: 0,
    creatorsTotal: 0,
    creatorsSkipped: 0,
  };
}

function snapshotFrom(run) {
  if (!run) return idleSnapshot();
  return {
    status: run.status,
    done: run.done,
    failed: run.failed,
    totalEstimate: run.totalEstimate,
    currentId: run.currentId,
    lastError: run.lastError,
    startedAt: run.startedAt,
    currentCreatorId: run.currentCreatorId || null,
    currentCreatorName: run.currentCreatorName || null,
    creatorsDone: run.creatorsDone || 0,
    creatorsTotal: run.creatorsTotal || 0,
    creatorsSkipped: run.creatorsSkipped || 0,
  };
}

function snapshot(platform, creatorId) {
  return snapshotFrom(runs.get(runKey(platform, creatorId)));
}

function snapshotPlatform(platform) {
  return snapshotFrom(runs.get(platformAllKey(platform)));
}

function isActive(run) {
  return Boolean(run && (run.status === 'running' || run.status === 'starting'));
}

function findActiveRunOnPlatform(platform) {
  const prefix = `${platform}:`;
  for (const [key, run] of runs) {
    if (!key.startsWith(prefix)) continue;
    if (isActive(run)) return { key, run };
  }
  return null;
}

function massMessageId(msg) {
  return String(msg?._id || msg?.id || '');
}

function createRun() {
  return {
    abort: false,
    status: 'running',
    done: 0,
    failed: 0,
    totalEstimate: 0,
    currentId: null,
    lastError: null,
    startedAt: Date.now(),
    currentCreatorId: null,
    currentCreatorName: null,
    creatorsDone: 0,
    creatorsTotal: 0,
    creatorsSkipped: 0,
  };
}

function conflictResult(platform, activeKey) {
  const message =
    activeKey === platformAllKey(platform)
      ? `An unsend-all is already running for all ${platform} creators.`
      : 'An unsend-all is already running on this platform.';
  return { error: { status: 409, message } };
}

function isUnsendThrottled(err) {
  if (Number(err?.status) === 429) return true;
  const message = String(err?.message || '');
  const body = err?.body;
  const bodyText =
    typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
  const haystack = `${message} ${bodyText}`;
  return /throttled/i.test(haystack) || /hourly-broadcast-deleting/i.test(haystack);
}

/**
 * @param {UnsendRun} run
 * @param {{ skipLoadErrors?: boolean, bestEffortDeletes?: boolean, cap?: number }} opts
 * @param {string} message
 * @returns {'skipped' | 'failed'}
 */
function failOrSkip(run, opts, message) {
  run.lastError = message;
  if (opts.skipLoadErrors) {
    run.creatorsSkipped += 1;
    return 'skipped';
  }
  run.status = 'failed';
  return 'failed';
}

/**
 * @returns {'skipped' | 'failed' | 'ok' | null} null means keep going
 */
function handleUnsendDeleteError(run, opts, err, fallbackMessage) {
  run.failed += 1;
  const message = err?.message || fallbackMessage;
  run.lastError = message;
  if (opts.bestEffortDeletes) {
    return 'ok';
  }
  if (isUnsendThrottled(err)) {
    return failOrSkip(run, opts, message);
  }
  if (!opts.skipLoadErrors) {
    run.status = 'failed';
    return 'failed';
  }
  return null;
}

/**
 * @param {string} creatorId
 * @param {UnsendRun} run
 * @param {{ skipLoadErrors?: boolean, bestEffortDeletes?: boolean, cap?: number }} [opts]
 * @returns {Promise<'ok' | 'skipped' | 'failed' | 'stopped'>}
 */
async function runFourBased(creatorId, run, opts = {}) {
  const loaded = await loadFourBasedCreator(creatorId);
  if (loaded.error) {
    return failOrSkip(run, opts, loaded.error.message);
  }

  const cap = creatorUnsendCap(opts);
  const pageSize = Number.isFinite(cap) ? Math.min(50, cap) : 50;
  let offset = 0;
  let processed = 0;
  const attempted = new Set();
  for (;;) {
    if (run.abort) {
      run.status = 'stopped';
      return 'stopped';
    }
    if (processed >= cap) break;
    const limit = Number.isFinite(cap)
      ? Math.min(pageSize, cap - processed)
      : pageSize;
    let page;
    try {
      page = await fourBasedClient.listMassMessages(loaded.creator, {
        tab: 'sent',
        limit,
        offset,
      });
    } catch (err) {
      return failOrSkip(
        run,
        opts,
        err?.message || 'Failed to list mass messages'
      );
    }
    const rawIds = (Array.isArray(page) ? page : [])
      .map(massMessageId)
      .filter(Boolean);
    const ids = rawIds.filter((id) => !attempted.has(id));
    for (const id of rawIds) attempted.add(id);
    if (ids.length === 0) {
      if (rawIds.length === 0 || rawIds.length < limit) break;
      // Failed deletes stay on the sent list; step past a full page of them.
      offset += rawIds.length;
      continue;
    }
    run.totalEstimate = Math.max(
      run.totalEstimate,
      offset + Math.min(rawIds.length, cap - processed)
    );
    if (!Number.isFinite(cap) && rawIds.length === pageSize) {
      run.totalEstimate = Math.max(run.totalEstimate, offset + pageSize + 1);
    }

    for (const id of ids) {
      if (run.abort) {
        run.status = 'stopped';
        return 'stopped';
      }
      if (processed >= cap) break;
      run.currentId = id;
      try {
        await fourBasedClient.deleteMassMessage(loaded.creator, id);
        run.done += 1;
      } catch (err) {
        const outcome = handleUnsendDeleteError(
          run,
          opts,
          err,
          'Failed to unsend mass message'
        );
        if (outcome) {
          run.currentId = null;
          return outcome;
        }
      }
      processed += 1;
      await sleep(randomUnsendGapMs(), () => run.abort);
    }

    if (processed >= cap || rawIds.length < limit) break;
    // Successful deletes drop off the sent list; failed ones are skipped via
    // `attempted`, so restart at 0 unless a full page was already tried.
    offset = 0;
  }

  run.currentId = null;
  return 'ok';
}

/**
 * @param {string} creatorId
 * @param {UnsendRun} run
 * @param {{ skipLoadErrors?: boolean, bestEffortDeletes?: boolean, cap?: number }} [opts]
 * @returns {Promise<'ok' | 'skipped' | 'failed' | 'stopped'>}
 */
async function runMaloum(creatorId, run, opts = {}) {
  const loaded = await loadMaloumCreator(creatorId);
  if (loaded.error) {
    return failOrSkip(run, opts, loaded.error.message);
  }

  const cap = creatorUnsendCap(opts);
  let next;
  let processed = 0;
  const seen = new Set();
  for (;;) {
    if (run.abort) {
      run.status = 'stopped';
      return 'stopped';
    }
    if (processed >= cap) break;
    const limit = Number.isFinite(cap)
      ? Math.min(50, cap - processed)
      : 50;
    let result;
    try {
      result = await maloumClient.listSentBroadcasts(loaded.creator, {
        limit,
        filter: 'ALL',
        next,
      });
    } catch (err) {
      return failOrSkip(
        run,
        opts,
        err?.message || 'Failed to list mass messages'
      );
    }
    const broadcasts = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result)
        ? result
        : [];
    const ids = broadcasts
      .filter((row) => !row.isRevoked && row._id && !seen.has(row._id))
      .map((row) => row._id);
    for (const id of broadcasts.map((row) => row._id).filter(Boolean)) {
      seen.add(id);
    }
    run.totalEstimate = Math.max(
      run.totalEstimate,
      Math.min(seen.size, Number.isFinite(cap) ? cap : seen.size)
    );
    if (!Number.isFinite(cap) && result?.next) {
      run.totalEstimate = Math.max(run.totalEstimate, seen.size + 1);
    }

    for (const id of ids) {
      if (run.abort) {
        run.status = 'stopped';
        return 'stopped';
      }
      if (processed >= cap) break;
      run.currentId = id;
      try {
        await maloumClient.revokeBroadcast(loaded.creator, id);
        run.done += 1;
      } catch (err) {
        const outcome = handleUnsendDeleteError(
          run,
          opts,
          err,
          'Failed to delete mass message'
        );
        if (outcome) {
          run.currentId = null;
          return outcome;
        }
      }
      processed += 1;
      await sleep(randomUnsendGapMs(), () => run.abort);
    }

    next = result?.next;
    // Platform unsend-all only touches the latest page (cap 30), then the next creator.
    if (processed >= cap || Number.isFinite(cap) || !next || broadcasts.length === 0) {
      break;
    }
  }

  run.currentId = null;
  return 'ok';
}

async function runPlatform(platform, creators, run) {
  const worker = platform === '4based' ? runFourBased : runMaloum;
  for (const creator of creators) {
    if (run.abort) {
      run.status = 'stopped';
      return;
    }
    run.currentCreatorId = creator.id;
    run.currentCreatorName = creator.displayName || creator.id;
    let outcome;
    try {
      outcome = await worker(creator.id, run, { skipLoadErrors: true });
    } catch (err) {
      run.creatorsSkipped += 1;
      run.lastError = err?.message || 'Unsend all failed for creator';
      continue;
    }
    if (outcome === 'stopped') return;
    if (outcome === 'ok') run.creatorsDone += 1;
  }
  run.status = 'completed';
  run.currentId = null;
  run.currentCreatorId = null;
  run.currentCreatorName = null;
}

function startUnsendAll(platform, creatorId) {
  const key = runKey(platform, creatorId);
  const existing = runs.get(key);
  if (isActive(existing)) {
    return snapshot(platform, creatorId);
  }
  const active = findActiveRunOnPlatform(platform);
  if (active) {
    return conflictResult(platform, active.key);
  }
  const run = createRun();
  run.currentCreatorId = creatorId;
  runs.set(key, run);
  const task = platform === '4based' ? runFourBased(creatorId, run) : runMaloum(creatorId, run);
  void task
    .then((outcome) => {
      if (outcome === 'ok') {
        run.status = 'completed';
        run.currentId = null;
      }
    })
    .catch((err) => {
      run.status = 'failed';
      run.lastError = err?.message || 'Unsend all failed';
    });
  return snapshot(platform, creatorId);
}

function startUnsendAllPlatform(platform, creators) {
  const active = findActiveRunOnPlatform(platform);
  if (active) {
    return conflictResult(platform, active.key);
  }
  const run = createRun();
  run.creatorsTotal = Array.isArray(creators) ? creators.length : 0;
  runs.set(platformAllKey(platform), run);
  void runPlatform(platform, creators || [], run).catch((err) => {
    run.status = 'failed';
    run.lastError = err?.message || 'Unsend all failed';
  });
  return snapshotPlatform(platform);
}

function stopUnsendAll(platform, creatorId) {
  const run = runs.get(runKey(platform, creatorId));
  if (isActive(run)) {
    run.abort = true;
  }
  return snapshot(platform, creatorId);
}

function stopUnsendAllPlatform(platform) {
  const run = runs.get(platformAllKey(platform));
  if (isActive(run)) {
    run.abort = true;
  }
  return snapshotPlatform(platform);
}

/**
 * Awaited helper for scheduled sends: unsend up to `cap` recent mass messages.
 * If a manual unsend-all is already running on this platform, skip cleanup.
 * Load/list failures throw so the scheduled job can fail; delete failures stop
 * remaining deletes and resolve so the send can still go out.
 *
 * @param {'4based' | 'maloum'} platform
 * @param {string} creatorId
 * @param {{ cap?: number }} [opts]
 */
async function unsendRecentForCreator(platform, creatorId, opts = {}) {
  if (platform !== '4based' && platform !== 'maloum') {
    return { skipped: true, reason: 'unsupported_platform', done: 0, failed: 0 };
  }
  const active = findActiveRunOnPlatform(platform);
  if (active) {
    return { skipped: true, reason: 'unsend_all_running', done: 0, failed: 0 };
  }

  const cap =
    Number.isFinite(Number(opts.cap)) && Number(opts.cap) > 0
      ? Math.floor(Number(opts.cap))
      : MAX_UNSEND_PER_CREATOR;
  const key = runKey(platform, creatorId);
  const run = createRun();
  run.currentCreatorId = creatorId;
  runs.set(key, run);

  try {
    const worker = platform === '4based' ? runFourBased : runMaloum;
    const outcome = await worker(creatorId, run, {
      cap,
      bestEffortDeletes: true,
    });
    if (outcome === 'failed') {
      throw new Error(run.lastError || 'Failed to list mass messages for unsend');
    }
    return {
      skipped: false,
      reason: outcome === 'stopped' ? 'stopped' : null,
      done: run.done,
      failed: run.failed,
    };
  } finally {
    runs.delete(key);
  }
}

module.exports = {
  startUnsendAll,
  stopUnsendAll,
  snapshot,
  startUnsendAllPlatform,
  stopUnsendAllPlatform,
  snapshotPlatform,
  unsendRecentForCreator,
  MAX_UNSEND_PER_CREATOR,
};
