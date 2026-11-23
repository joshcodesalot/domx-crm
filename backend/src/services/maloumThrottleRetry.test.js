const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withMaloumThrottleRetry } = require('./maloumClient');

const SENT_BROADCAST_THROTTLE =
  'Throttled five-seconds-herrin_sofia-BroadcastController-getSentBroadcasts on BroadcastController in method getSentBroadcasts';

describe('withMaloumThrottleRetry getSentBroadcasts', () => {
  it('waits 5s after a five-seconds throttle and then succeeds', async () => {
    const waits = [];
    let calls = 0;
    const result = await withMaloumThrottleRetry(
      'getSentBroadcasts',
      async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error(SENT_BROADCAST_THROTTLE);
          err.status = 429;
          throw err;
        }
        return { data: [{ _id: 'b1' }] };
      },
      {
        sleepFn: async (ms) => {
          waits.push(ms);
        },
      }
    );
    assert.deepEqual(waits, [5000]);
    assert.equal(calls, 2);
    assert.deepEqual(result, { data: [{ _id: 'b1' }] });
  });

  it('does not retry a non-throttle error', async () => {
    let calls = 0;
    let slept = false;
    await assert.rejects(
      () =>
        withMaloumThrottleRetry(
          'getSentBroadcasts',
          async () => {
            calls += 1;
            throw new Error('Maloum request failed (500)');
          },
          {
            sleepFn: async () => {
              slept = true;
            },
          }
        ),
      /Maloum request failed \(500\)/
    );
    assert.equal(calls, 1);
    assert.equal(slept, false);
  });
});
