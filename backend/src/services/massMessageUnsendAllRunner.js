const { loadFourBasedCreator, loadMaloumCreator } = require('./platformCreatorSession');
const fourBasedClient = require('./fourBasedClient');
const maloumClient = require('./maloumClient');

/** @type {Map<string, { abort: boolean, status: string, done: number, failed: number, totalEstimate: number, currentId: string | null, lastError: string | null, startedAt: number }>} */
const runs = new Map();

function runKey(platform, creatorId) {
  return `${platform}:${creatorId}`;
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

function snapshot(platform, creatorId) {
  const run = runs.get(runKey(platform, creatorId));
  if (!run) {
    return {
      status: 'idle',
      done: 0,
      failed: 0,
      totalEstimate: 0,
      currentId: null,
      lastError: null,
    };
  }
  return {
    status: run.status,
    done: run.done,
    failed: run.failed,
    totalEstimate: run.totalEstimate,
    currentId: run.currentId,
    lastError: run.lastError,
    startedAt: run.startedAt,
  };
}

function massMessageId(msg) {
  return String(msg?._id || msg?.id || '');
}

async function runFourBased(creatorId) {
  const key = runKey('4based', creatorId);
  const run = runs.get(key);
  if (!run) return;
  const loaded = await loadFourBasedCreator(creatorId);
  if (loaded.error) {
    run.status = 'failed';
    run.lastError = loaded.error.message;
    return;
  }

  const pageSize = 50;
  let offset = 0;
  for (;;) {
    if (run.abort) {
      run.status = 'stopped';
      return;
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
        return;
      }
      run.currentId = id;
      try {
        await fourBasedClient.deleteMassMessage(loaded.creator, id);
        run.done += 1;
      } catch (err) {
        run.failed += 1;
        run.lastError = err?.message || 'Failed to unsend mass message';
        run.status = 'failed';
        return;
      }
      await sleep(randomUnsendGapMs(), () => run.abort);
    }

    if (ids.length < pageSize) break;
    // Always restart at offset 0: deleted items drop off the sent list.
    offset = 0;
  }

  run.status = 'completed';
  run.currentId = null;
}

async function runMaloum(creatorId) {
  const key = runKey('maloum', creatorId);
  const run = runs.get(key);
  if (!run) return;
  const loaded = await loadMaloumCreator(creatorId);
  if (loaded.error) {
    run.status = 'failed';
    run.lastError = loaded.error.message;
    return;
  }

  let next;
  const seen = new Set();
  for (;;) {
    if (run.abort) {
      run.status = 'stopped';
      return;
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
        return;
      }
      run.currentId = id;
      try {
        await maloumClient.revokeBroadcast(loaded.creator, id);
        run.done += 1;
      } catch (err) {
        run.failed += 1;
        run.lastError = err?.message || 'Failed to delete mass message';
        run.status = 'failed';
        return;
      }
      await sleep(randomUnsendGapMs(), () => run.abort);
    }

    next = result?.next;
    if (!next || broadcasts.length === 0) break;
  }

  run.status = 'completed';
  run.currentId = null;
}

function startUnsendAll(platform, creatorId) {
  const key = runKey(platform, creatorId);
  const existing = runs.get(key);
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    return snapshot(platform, creatorId);
  }
  const run = {
    abort: false,
    status: 'running',
    done: 0,
    failed: 0,
    totalEstimate: 0,
    currentId: null,
    lastError: null,
    startedAt: Date.now(),
  };
  runs.set(key, run);
  const task = platform === '4based' ? runFourBased(creatorId) : runMaloum(creatorId);
  void task.catch((err) => {
    run.status = 'failed';
    run.lastError = err?.message || 'Unsend all failed';
  });
  return snapshot(platform, creatorId);
}

function stopUnsendAll(platform, creatorId) {
  const run = runs.get(runKey(platform, creatorId));
  if (run && (run.status === 'running' || run.status === 'starting')) {
    run.abort = true;
  }
  return snapshot(platform, creatorId);
}

module.exports = {
  startUnsendAll,
  stopUnsendAll,
  snapshot,
};
