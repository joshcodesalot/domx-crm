const maloumClient = require('./maloumClient');
const { loadMaloumCreator } = require('./platformCreatorSession');

const KEEP_PUBLIC = 10;
const PAGE_LIMIT = 15;
const MAX_PAGES = 400;
const MAX_CONCURRENT = 2;
const PAGE_GAP_MIN_MS = 2500;
const PAGE_GAP_MAX_MS = 6000;
const EDIT_GAP_MIN_MS = 4000;
const EDIT_GAP_MAX_MS = 9000;

function gapMs(min, max, random = Math.random) {
  const roll = typeof random === 'function' ? random() : Number(random);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(roll) ? roll : 0));
  return Math.round(min + clamped * (max - min));
}

function pageGapMs(random = Math.random) {
  return gapMs(PAGE_GAP_MIN_MS, PAGE_GAP_MAX_MS, random);
}

function editGapMs(random = Math.random) {
  return gapMs(EDIT_GAP_MIN_MS, EDIT_GAP_MAX_MS, random);
}

function postIdOf(post) {
  return String(post?._id || post?.id || '').trim();
}

function isFeedPost(post) {
  if (!post || typeof post !== 'object') return false;
  if (!postIdOf(post)) return false;
  if (post.active === false) return false;
  const type = post.type == null ? '' : String(post.type).trim();
  if (type && type.toUpperCase() !== 'POST') return false;
  return true;
}

function categoryIds(post) {
  const cats = Array.isArray(post?.categories) ? post.categories : [];
  const ids = [];
  for (const cat of cats) {
    const raw = typeof cat === 'string' ? cat : cat?._id || cat?.id;
    const id = String(raw || '').trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= 3) break;
  }
  return ids;
}

function lockBody(post) {
  return {
    caption: typeof post?.caption === 'string' ? post.caption : '',
    categories: categoryIds(post),
    public: false,
  };
}

function postsToLock(posts, keep = KEEP_PUBLIC) {
  const list = Array.isArray(posts) ? posts.filter(isFeedPost) : [];
  const targets = [];
  list.forEach((post, index) => {
    if (index < keep) return;
    if (post.public === false) return;
    targets.push(post);
  });
  return targets;
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

function idleStatus() {
  return {
    running: false,
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    error: null,
  };
}

function snapshotStatus(status, running) {
  return {
    running: Boolean(running),
    scanned: status?.scanned || 0,
    updated: status?.updated || 0,
    skipped: status?.skipped || 0,
    failed: status?.failed || 0,
    error: status?.error || null,
  };
}

function createRunner(overrides = {}) {
  const deps = {
    loadCreator: overrides.loadCreator || loadMaloumCreator,
    listMyPosts:
      overrides.listMyPosts ||
      ((creator, query) =>
        maloumClient.withMaloumThrottleRetry('listMyPosts', () =>
          maloumClient.listMyPosts(creator, query)
        )),
    updatePost:
      overrides.updatePost ||
      ((creator, id, body) => maloumClient.updatePost(creator, id, body)),
    sleep:
      overrides.sleep ||
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pageGapMs: overrides.pageGapMs || (() => pageGapMs()),
    editGapMs: overrides.editGapMs || (() => editGapMs()),
    keep: overrides.keep ?? KEEP_PUBLIC,
    maxConcurrent: overrides.maxConcurrent ?? MAX_CONCURRENT,
  };

  const runs = new Map();
  let activeSlots = 0;
  const slotWaiters = [];

  function acquireSlot() {
    if (activeSlots < deps.maxConcurrent) {
      activeSlots += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      slotWaiters.push(resolve);
    }).then(() => {
      activeSlots += 1;
    });
  }

  function releaseSlot() {
    activeSlots = Math.max(0, activeSlots - 1);
    const next = slotWaiters.shift();
    if (next) next();
  }

  async function runPass(creator, status) {
    let next = undefined;
    let feedIndex = 0;
    const seenNext = new Set();
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      if (pageNumber > 0) {
        await deps.sleep(deps.pageGapMs());
      }
      const page = await deps.listMyPosts(creator, {
        limit: PAGE_LIMIT,
        next,
      });
      const rows = pageRows(page);
      for (const post of rows) {
        if (!isFeedPost(post)) {
          status.skipped += 1;
          continue;
        }
        status.scanned += 1;
        const position = feedIndex;
        feedIndex += 1;
        if (position < deps.keep || post.public === false) {
          status.skipped += 1;
          continue;
        }
        await deps.sleep(deps.editGapMs());
        try {
          await deps.updatePost(creator, postIdOf(post), lockBody(post));
          status.updated += 1;
        } catch (err) {
          status.failed += 1;
          status.error = err?.message || 'Failed to update post';
        }
      }
      next = pageNext(page);
      if (!next || rows.length === 0) return;
      if (seenNext.has(next)) return;
      seenNext.add(next);
    }
  }

  function getStatus(creatorId) {
    const id = String(creatorId || '').trim();
    const state = runs.get(id);
    if (!state) return idleStatus();
    return snapshotStatus(state.status, state.running);
  }

  function startSweep(creatorId) {
    const id = String(creatorId || '').trim();
    if (!id) {
      const err = new Error('creatorId is required');
      err.status = 400;
      throw err;
    }
    const existing = runs.get(id);
    if (existing?.running) {
      existing.rerun = true;
      return {
        started: false,
        alreadyRunning: true,
        status: snapshotStatus(existing.status, true),
      };
    }

    const state = {
      running: true,
      rerun: false,
      status: { ...idleStatus(), running: true },
    };
    runs.set(id, state);

    const work = (async () => {
      await acquireSlot();
      try {
        while (true) {
          state.status = { ...idleStatus(), running: true };
          try {
            const loaded = await deps.loadCreator(id);
            if (loaded?.error) {
              throw new Error(loaded.error.message || 'Creator unavailable');
            }
            if (!loaded?.creator) {
              throw new Error('Creator unavailable');
            }
            await runPass(loaded.creator, state.status);
          } catch (err) {
            const message = err?.message || 'Feed lock failed';
            state.status.error = message;
            if (!state.status.failed) state.status.failed = 1;
            console.error('[maloumFeedVisibility]', id, message);
          }
          if (!state.rerun) break;
          state.rerun = false;
        }
      } finally {
        state.running = false;
        state.status.running = false;
        releaseSlot();
      }
    })();

    state.promise = work;
    work.catch((err) => {
      console.error('[maloumFeedVisibility]', id, err?.message || err);
    });

    return {
      started: true,
      alreadyRunning: false,
      status: snapshotStatus(state.status, true),
    };
  }

  return {
    startSweep,
    getStatus,
    whenIdle(creatorId) {
      const state = runs.get(String(creatorId || '').trim());
      return state?.promise || Promise.resolve();
    },
  };
}

const runner = createRunner();

module.exports = {
  KEEP_PUBLIC,
  PAGE_LIMIT,
  MAX_CONCURRENT,
  PAGE_GAP_MIN_MS,
  PAGE_GAP_MAX_MS,
  EDIT_GAP_MIN_MS,
  EDIT_GAP_MAX_MS,
  pageGapMs,
  editGapMs,
  isFeedPost,
  categoryIds,
  lockBody,
  postsToLock,
  createRunner,
  startSweep: (creatorId) => runner.startSweep(creatorId),
  getStatus: (creatorId) => runner.getStatus(creatorId),
};
