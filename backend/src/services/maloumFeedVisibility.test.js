const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PAGE_GAP_MIN_MS,
  PAGE_GAP_MAX_MS,
  EDIT_GAP_MIN_MS,
  EDIT_GAP_MAX_MS,
  pageGapMs,
  editGapMs,
  postsToLock,
  lockBody,
  createRunner,
} = require('./maloumFeedVisibility');

function feedPost(id, extra = {}) {
  return {
    _id: id,
    type: 'POST',
    active: true,
    public: true,
    caption: `caption-${id}`,
    categories: [{ _id: 'cat-a' }],
    ...extra,
  };
}

describe('maloum feed visibility selection', () => {
  it('patches only public posts after the first 10 and keeps caption and category ids', () => {
    const posts = [];
    for (let i = 1; i <= 10; i += 1) posts.push(feedPost(`keep-${i}`));
    posts.push({
      _id: 'inactive',
      type: 'POST',
      active: false,
      public: true,
      caption: 'skip',
      categories: [{ _id: 'nope' }],
    });
    posts.push({
      _id: 'product',
      type: 'PRODUCT',
      active: true,
      public: true,
      caption: 'skip',
      categories: [],
    });
    posts.push(
      feedPost('lock-me', {
        caption: ' hello ',
        categories: [
          { _id: 'c1' },
          { _id: 'c2' },
          { _id: 'c3' },
          { _id: 'c4' },
        ],
      })
    );
    posts.push(feedPost('already-private', { public: false, caption: 'stay' }));

    const targets = postsToLock(posts);
    assert.deepEqual(
      targets.map((post) => post._id),
      ['lock-me']
    );
    assert.deepEqual(lockBody(targets[0]), {
      caption: ' hello ',
      categories: ['c1', 'c2', 'c3'],
      public: false,
    });
  });

  it('does not patch older posts that are already subscribers-only', () => {
    const posts = [];
    for (let i = 1; i <= 10; i += 1) posts.push(feedPost(`keep-${i}`));
    posts.push(feedPost('old', { public: false }));
    assert.deepEqual(postsToLock(posts), []);
  });
});

describe('maloum feed visibility sweep', () => {
  it('edits older public posts across pages and leaves the newest 10', async () => {
    const pageOne = [];
    for (let i = 1; i <= 10; i += 1) pageOne.push(feedPost(`keep-${i}`));
    pageOne.push({
      _id: 'inactive',
      type: 'POST',
      active: false,
      public: true,
      caption: 'skip',
      categories: [],
    });
    const pageTwo = [
      feedPost('lock-me', {
        caption: ' hello ',
        categories: [{ _id: 'c1' }, { _id: 'c2' }, { _id: 'c3' }, { _id: 'c4' }],
      }),
      feedPost('already-private', { public: false, caption: 'stay' }),
    ];
    const updates = [];
    const sleeps = [];
    const runner = createRunner({
      loadCreator: async () => ({ creator: { id: 'creator-1' } }),
      listMyPosts: async (_creator, query) => {
        if (!query.next) return { data: pageOne, next: '2026-10-03T08:30:19.502Z' };
        return { data: pageTwo, next: null };
      },
      updatePost: async (_creator, id, body) => {
        updates.push({ id, body });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pageGapMs: () => pageGapMs(() => 0),
      editGapMs: () => editGapMs(() => 1),
    });

    const started = runner.startSweep('creator-1');
    assert.equal(started.started, true);
    await runner.whenIdle('creator-1');

    assert.deepEqual(updates, [
      {
        id: 'lock-me',
        body: {
          caption: ' hello ',
          categories: ['c1', 'c2', 'c3'],
          public: false,
        },
      },
    ]);
    assert.deepEqual(sleeps, [PAGE_GAP_MIN_MS, EDIT_GAP_MAX_MS]);
    const status = runner.getStatus('creator-1');
    assert.equal(status.running, false);
    assert.equal(status.updated, 1);
    assert.equal(status.failed, 0);
    assert.equal(status.scanned, 12);
  });

  it('queues exactly one rerun when started again while running', async () => {
    let listCalls = 0;
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const runner = createRunner({
      loadCreator: async () => ({ creator: { id: 'creator-1' } }),
      listMyPosts: async () => {
        listCalls += 1;
        if (listCalls === 1) await gate;
        return { data: [], next: null };
      },
      updatePost: async () => {},
      sleep: async () => {},
      pageGapMs: () => PAGE_GAP_MIN_MS,
      editGapMs: () => EDIT_GAP_MIN_MS,
    });

    const first = runner.startSweep('creator-1');
    const second = runner.startSweep('creator-1');
    const third = runner.startSweep('creator-1');
    assert.equal(first.started, true);
    assert.equal(first.alreadyRunning, false);
    assert.equal(second.started, false);
    assert.equal(second.alreadyRunning, true);
    assert.equal(third.alreadyRunning, true);

    releaseFirst();
    await runner.whenIdle('creator-1');
    assert.equal(listCalls, 2);
    assert.equal(runner.getStatus('creator-1').running, false);
  });
});

describe('maloum feed visibility gaps', () => {
  it('keeps page and edit pauses inside the human ranges', () => {
    assert.equal(pageGapMs(() => 0), PAGE_GAP_MIN_MS);
    assert.equal(pageGapMs(() => 1), PAGE_GAP_MAX_MS);
    assert.equal(editGapMs(() => 0), EDIT_GAP_MIN_MS);
    assert.equal(editGapMs(() => 1), EDIT_GAP_MAX_MS);
    for (let i = 0; i <= 10; i += 1) {
      const page = pageGapMs(() => i / 10);
      const edit = editGapMs(() => i / 10);
      assert.ok(page >= PAGE_GAP_MIN_MS && page <= PAGE_GAP_MAX_MS);
      assert.ok(edit >= EDIT_GAP_MIN_MS && edit <= EDIT_GAP_MAX_MS);
    }
  });
});
