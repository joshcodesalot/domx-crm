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

function randomUnsendGapMs() {
  return 5000 + Math.floor(Math.random() * 5001);
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

/**
 * @param {string} creatorId
 * @param {UnsendRun} run
 * @param {{ skipLoadErrors?: boolean }} [opts]
 * @returns {Promise<'ok' | 'skipped' | 'failed' | 'stopped'>}
 */
async function runFourBased(creatorId, run, opts = {}) {
  const loaded = await loadFourBasedCreator(creatorId);
  if (loaded.error) {
    if (opts.skipLoadErrors) {
      run.creatorsSkipped += 1;
      run.lastError = loaded.error.message;
      return 'skipped';
    }
    run.status = 'failed';
    run.lastError = loaded.error.message;
    return 'failed';
  }

  const pageSize = 50;
  let offset = 0;
  for (;;) {
    if (run.abort) {
      run.status = 'stopped';
      return 'stopped';
    }
    const page = await fourBasedClient.listMassMessages(loaded.creator, {
      tab: 'sent',
      limit: pageSize,
      offset,
    });
    const ids = (Array.isArray(page) ? page : [])
      .map(massMessageId)
      .filter(Boolean);
    if (ids.length === 0) break;
    run.totalEstimate = Math.max(run.totalEstimate, offset + ids.length);
    if (ids.length === pageSize) {
      run.totalEstimate = Math.max(run.totalEstimate, offset + pageSize + 1);
    }

    for (const id of ids) {
      if (run.abort) {
        run.status = 'stopped';
        return 'stopped';
      }
      run.currentId = id;
      try {
        await fourBasedClient.deleteMassMessage(loaded.creator, id);
        run.done += 1;
      } catch (err) {
        run.failed += 1;
        run.lastError = err?.message || 'Failed to unsend mass message';
        run.status = 'failed';
        return 'failed';
      }
      await sleep(randomUnsendGapMs(), () => run.abort);
    }

    if (ids.length < pageSize) break;
    // Always restart at offset 0: deleted items drop off the sent list.
    offset = 0;
  }

  run.currentId = null;
  return 'ok';
}

/**
 * @param {string} creatorId
 * @param {UnsendRun} run
 * @param {{ skipLoadErrors?: boolean }} [opts]
 * @returns {Promise<'ok' | 'skipped' | 'failed' | 'stopped'>}
 */
async function runMaloum(creatorId, run, opts = {}) {
  const loaded = await loadMaloumCreator(creatorId);
  if (loaded.error) {
    if (opts.skipLoadErrors) {
      run.creatorsSkipped += 1;
      run.lastError = loaded.error.message;
      return 'skipped';
    }
    run.status = 'failed';
    run.lastError = loaded.error.message;
    return 'failed';
  }

  let next;
  const seen = new Set();
  for (;;) {
    if (run.abort) {
      run.status = 'stopped';
      return 'stopped';
    }
    const result = await maloumClient.listSentBroadcasts(loaded.creator, {
      limit: 50,
      filter: 'ALL',
      next,
    });
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
    run.totalEstimate = Math.max(run.totalEstimate, seen.size);
    if (result?.next) {
      run.totalEstimate = Math.max(run.totalEstimate, seen.size + 1);
    }

    for (const id of ids) {
      if (run.abort) {
        run.status = 'stopped';
        return 'stopped';
      }
      run.currentId = id;
      try {
        await maloumClient.revokeBroadcast(loaded.creator, id);
        run.done += 1;
      } catch (err) {
        run.failed += 1;
        run.lastError = err?.message || 'Failed to delete mass message';
        run.status = 'failed';
        return 'failed';
      }
      await sleep(randomUnsendGapMs(), () => run.abort);
    }

    next = result?.next;
    if (!next || broadcasts.length === 0) break;
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
    const outcome = await worker(creator.id, run, { skipLoadErrors: true });
    if (outcome === 'stopped' || outcome === 'failed') return;
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

module.exports = {
  startUnsendAll,
  stopUnsendAll,
  snapshot,
  startUnsendAllPlatform,
  stopUnsendAllPlatform,
  snapshotPlatform,
};
