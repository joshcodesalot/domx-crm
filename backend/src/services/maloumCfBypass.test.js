const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  mirrorMaloumRequest,
  resetBypassQueueForTests,
  PROXY_SWITCH_PAUSE_MS,
} = require('./maloumCfBypass');

function jsonResponse(body = {}) {
  return {
    status: 200,
    headers: { get: () => 'application/json' },
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe('mirrorMaloumRequest queue', () => {
  beforeEach(() => {
    resetBypassQueueForTests();
  });

  afterEach(() => {
    resetBypassQueueForTests();
  });

  it('runs overlapping requests sequentially', async () => {
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    resetBypassQueueForTests({
      fetch: async (_url, opts) => {
        const proxy = opts.headers['x-proxy'];
        order.push(`start:${proxy}`);
        if (proxy === 'http://a.example:1') {
          await firstGate;
        }
        order.push(`end:${proxy}`);
        return jsonResponse({ ok: true });
      },
    });

    const first = mirrorMaloumRequest({
      path: '/chats',
      proxyUrl: 'http://a.example:1',
    });
    const second = mirrorMaloumRequest({
      path: '/chats',
      proxyUrl: 'http://a.example:1',
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(order, ['start:http://a.example:1']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, [
      'start:http://a.example:1',
      'end:http://a.example:1',
      'start:http://a.example:1',
      'end:http://a.example:1',
    ]);
  });

  it('pauses when the proxy switches', async () => {
    resetBypassQueueForTests({
      fetch: async () => jsonResponse({ ok: true }),
    });

    await mirrorMaloumRequest({
      path: '/chats',
      proxyUrl: 'http://a.example:1',
    });
    const started = Date.now();
    await mirrorMaloumRequest({
      path: '/chats',
      proxyUrl: 'http://b.example:1',
    });
    assert.ok(Date.now() - started >= PROXY_SWITCH_PAUSE_MS);
  });
});
