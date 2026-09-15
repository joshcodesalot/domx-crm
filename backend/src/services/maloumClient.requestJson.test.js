const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requestJson, MaloumApiError } = require('./maloumClient');

const PROXY = 'http://user:pass@127.0.0.1:9';

function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
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
    resolveCfBypassBaseUrl: () => 'http://127.0.0.1:5002',
    ensureClearance: async () => ({
      cookieHeader: 'cf_clearance=cached',
      userAgent: 'UA-cached',
    }),
    ...overrides,
  };
}

describe('requestJson CF routing', () => {
  it('attaches cached Cookie and User-Agent on undici success', async () => {
    let mintCalls = 0;
    let seenHeaders;
    const result = await requestJson(
      { path: '/chats/unread-count', proxyUrl: PROXY, cfBypass: 'never' },
      deps({
        ensureClearance: async (_url, { force } = {}) => {
          mintCalls += 1;
          assert.equal(force, false);
          return { cookieHeader: 'cf_clearance=x', userAgent: 'UA-1' };
        },
        fetch: async (_url, opts) => {
          seenHeaders = opts.headers;
          return jsonResponse({ unread: 2 });
        },
      })
    );
    assert.equal(mintCalls, 1);
    assert.equal(seenHeaders.cookie, 'cf_clearance=x');
    assert.equal(seenHeaders['user-agent'], 'UA-1');
    assert.deepEqual(result.data, { unread: 2 });
  });

  it('CF 403 remints and retries undici once', async () => {
    const cookies = [];
    let mintForce = [];
    const result = await requestJson(
      { path: '/chats', proxyUrl: PROXY, cfBypass: 'fallback' },
      deps({
        ensureClearance: async (_url, { force } = {}) => {
          mintForce.push(Boolean(force));
          return {
            cookieHeader: force ? 'cf_clearance=new' : 'cf_clearance=old',
            userAgent: 'UA-1',
          };
        },
        fetch: async (_url, opts) => {
          cookies.push(opts.headers.cookie);
          if (cookies.length === 1) return cfHtmlResponse();
          return jsonResponse({ data: [] });
        },
      })
    );
    assert.deepEqual(mintForce, [false, true]);
    assert.deepEqual(cookies, ['cf_clearance=old', 'cf_clearance=new']);
    assert.deepEqual(result.data, { data: [] });
  });

  it('never: second CF 403 after remint throws', async () => {
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
          })
        ),
      (err) => {
        assert.ok(err instanceof MaloumApiError);
        assert.equal(err.status, 403);
        assert.match(err.message, /Rotate MALOUM_PROXY_URL/);
        return true;
      }
    );
  });
});
