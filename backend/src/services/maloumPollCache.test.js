const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  peek,
  set,
  getOrLoad,
  invalidatePrefix,
  clear,
} = require('./maloumPollCache');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('maloumPollCache', () => {
  beforeEach(() => {
    clear();
  });

  it('returns loader result on miss and caches the hit', async () => {
    let calls = 0;
    const first = await getOrLoad('badges:a', async () => {
      calls += 1;
      return { messages: 2 };
    });
    const second = await getOrLoad('badges:a', async () => {
      calls += 1;
      return { messages: 99 };
    });
    assert.deepEqual(first, { messages: 2 });
    assert.deepEqual(second, { messages: 2 });
    assert.equal(calls, 1);
    assert.deepEqual(peek('badges:a'), { messages: 2 });
  });

  it('single-flights concurrent misses for the same key', async () => {
    let calls = 0;
    const p1 = getOrLoad('unread:a', async () => {
      calls += 1;
      await sleep(20);
      return { unread: 4 };
    });
    const p2 = getOrLoad('unread:a', async () => {
      calls += 1;
      return { unread: 8 };
    });
    const [a, b] = await Promise.all([p1, p2]);
    assert.deepEqual(a, { unread: 4 });
    assert.deepEqual(b, { unread: 4 });
    assert.equal(calls, 1);
  });

  it('does not cache a thrown loader', async () => {
    await assert.rejects(
      () =>
        getOrLoad('badges:err', async () => {
          throw new Error('maloum down');
        }),
      /maloum down/
    );
    assert.equal(peek('badges:err'), undefined);
    const recovered = await getOrLoad('badges:err', async () => ({ messages: 0 }));
    assert.deepEqual(recovered, { messages: 0 });
  });

  it('invalidates by prefix and leaves other keys', async () => {
    set('msgs:c1:chatA:30:', ['old']);
    set('msgs:c1:chatB:30:', ['keep']);
    set('chats:c1:30::::', { chats: [] });
    set('badges:c1', { messages: 1 });
    invalidatePrefix('msgs:c1:chatA:');
    invalidatePrefix('chats:c1:');
    invalidatePrefix('badges:c1');
    assert.equal(peek('msgs:c1:chatA:30:'), undefined);
    assert.deepEqual(peek('msgs:c1:chatB:30:'), ['keep']);
    assert.equal(peek('chats:c1:30::::'), undefined);
    assert.equal(peek('badges:c1'), undefined);
  });

  it('does not store a load that finished after invalidate', async () => {
    const pending = getOrLoad('msgs:c1:chatA:30:', async () => {
      await sleep(20);
      return ['stale'];
    });
    invalidatePrefix('msgs:c1:chatA:');
    assert.deepEqual(await pending, ['stale']);
    assert.equal(peek('msgs:c1:chatA:30:'), undefined);
    const fresh = await getOrLoad('msgs:c1:chatA:30:', async () => ['fresh']);
    assert.deepEqual(fresh, ['fresh']);
  });
});
