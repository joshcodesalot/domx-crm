const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapWithLimit } = require('./telegramWorker');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithLimit', () => {
  it('runs every item and keeps at most the limit active', async () => {
    let active = 0;
    let maxActive = 0;
    const seen = [];
    await mapWithLimit([1, 2, 3, 4, 5, 6], 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(20);
      seen.push(item);
      active -= 1;
    });
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    assert.equal(maxActive <= 3, true);
    assert.equal(maxActive >= 2, true);
  });

  it('finishes later items after one throws', async () => {
    const seen = [];
    await assert.rejects(
      () =>
        mapWithLimit([1, 2, 3, 4], 3, async (item) => {
          await wait(10);
          seen.push(item);
          if (item === 1) throw new Error('boom');
        }),
      /boom/
    );
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4]);
  });
});
