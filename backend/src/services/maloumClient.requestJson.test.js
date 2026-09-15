const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requestJson, MaloumApiError } = require('./maloumClient');

const PROXY = 'http://user:pass@127.0.0.1:9';

function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  const text =
    typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    async text() {
      return text;
    },
  };
}

function cfHtmlResponse() {
  return jsonResponse('<html>Just a moment cf-ray Cloudflare</html>', {
    status: 403,
    contentType: 'text/html',
  });
}

function deps(overrides = {}) {
  return {
    createDispatcher: () => ({}),
    resolveCfBypassBaseUrl: () => 'http://127.0.0.1:8000',
    tryRequestJsonViaCfBypass: async () => {
      throw new Error('bypass should not be called');
    },
    ...overrides,
  };
}

describe('requestJson CF routing', () => {
  it('fallback: undici success does not call bypass', async () => {
    let bypassCalls = 0;
    const result = await requestJson(
      { path: '/chats/unread-count', proxyUrl: PROXY, cfBypass: 'fallback' },
      deps({
        fetch: async () => jsonResponse({ unread: 2 }),
        tryRequestJsonViaCfBypass: async () => {
          bypassCalls += 1;
          return { status: 200, data: { unread: 99 }, text: '{}' };
        },
      })
    );
    assert.equal(bypassCalls, 0);
    assert.deepEqual(result.data, { unread: 2 });
  });

  it('fallback: undici Cloudflare HTML retries via bypass', async () => {
    let bypassCalls = 0;
    const result = await requestJson(
      { path: '/chats', proxyUrl: PROXY, cfBypass: 'fallback' },
      deps({
        fetch: async () => cfHtmlResponse(),
        tryRequestJsonViaCfBypass: async () => {
          bypassCalls += 1;
          return { status: 200, data: { data: [] }, text: '{"data":[]}' };
        },
      })
    );
    assert.equal(bypassCalls, 1);
    assert.deepEqual(result.data, { data: [] });
  });

  it('never: undici Cloudflare HTML throws and does not call bypass', async () => {
    let bypassCalls = 0;
    await assert.rejects(
      () =>
        requestJson(
          {
            path: '/chats/unread-count',
            proxyUrl: PROXY,
            cfBypass: 'never',
          },
          deps({
            fetch: async () => cfHtmlResponse(),
            tryRequestJsonViaCfBypass: async () => {
              bypassCalls += 1;
              return { status: 200, data: {}, text: '{}' };
            },
          })
        ),
      (err) => {
        assert.ok(err instanceof MaloumApiError);
        assert.equal(err.status, 403);
        assert.match(err.message, /Rotate MALOUM_PROXY_URL/);
        return true;
      }
    );
    assert.equal(bypassCalls, 0);
  });

  it('CF 403 with creatorId rotates and retries undici once', async () => {
    const seen = [];
    let rotateCalls = 0;
    const result = await requestJson(
      {
        path: '/chats/unread-count',
        proxyUrl: PROXY,
        creatorId: 'cr-1',
        cfBypass: 'never',
      },
      deps({
        resolveCfBypassBaseUrl: () => null,
        fetch: async (url, opts) => {
          seen.push(opts.dispatcher);
          if (seen.length === 1) return cfHtmlResponse();
          return jsonResponse({ unread: 4 });
        },
        rotatePoolProxy: async (creatorId, current) => {
          rotateCalls += 1;
          assert.equal(creatorId, 'cr-1');
          assert.equal(current, PROXY);
          return 'http://user:pass@127.0.0.1:10';
        },
      })
    );
    assert.equal(rotateCalls, 1);
    assert.equal(seen.length, 2);
    assert.deepEqual(result.data, { unread: 4 });
  });
});
