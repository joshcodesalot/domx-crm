const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureClearance,
  unflareProxyFromUrl,
  resetBypassQueueForTests,
  PROXY_SWITCH_PAUSE_MS,
} = require('./maloumCfBypass');

const PROXY_A = 'http://user:pass@a.example:1';
const PROXY_B = 'http://user:pass@b.example:1';

function jsonResponse(body = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function scrapePayload(value) {
  return jsonResponse({
    cookies: [{ name: 'cf_clearance', value, domain: '.maloum.com' }],
    headers: { 'user-agent': 'UA-unflare' },
  });
}

describe('unflareProxyFromUrl', () => {
  it('builds Unflare proxy body from http://user:pass@host:port', () => {
    const parsed = unflareProxyFromUrl(
      'http://sphi0gkvzp:~lr70ekI2Mmx8dCLud@isp.decodo.com:10001'
    );
    assert.equal(parsed.hostPort, 'isp.decodo.com:10001');
    assert.deepEqual(parsed.proxy, {
      host: 'isp.decodo.com',
      port: 10001,
      username: 'sphi0gkvzp',
      password: '~lr70ekI2Mmx8dCLud',
    });
  });
});

describe('ensureClearance cache and queue', () => {
  let prevUrl;

  beforeEach(() => {
    prevUrl = process.env.MALOUM_CF_BYPASS_URL;
    process.env.MALOUM_CF_BYPASS_URL = 'http://127.0.0.1:5002';
    resetBypassQueueForTests();
  });

  afterEach(() => {
    if (prevUrl === undefined) {
      delete process.env.MALOUM_CF_BYPASS_URL;
    } else {
      process.env.MALOUM_CF_BYPASS_URL = prevUrl;
    }
    resetBypassQueueForTests();
  });

  it('cache hit skips scrape', async () => {
    let scrapes = 0;
    resetBypassQueueForTests({
      fetch: async () => {
        scrapes += 1;
        return scrapePayload('one');
      },
    });
    const first = await ensureClearance(PROXY_A);
    const second = await ensureClearance(PROXY_A);
    assert.equal(scrapes, 1);
    assert.equal(first.cookieHeader, 'cf_clearance=one');
    assert.equal(second.cookieHeader, 'cf_clearance=one');
    assert.equal(first.userAgent, 'UA-unflare');
  });

  it('force remints', async () => {
    let scrapes = 0;
    resetBypassQueueForTests({
      fetch: async () => {
        scrapes += 1;
        return scrapePayload(String(scrapes));
      },
    });
    await ensureClearance(PROXY_A);
    const next = await ensureClearance(PROXY_A, { force: true });
    assert.equal(scrapes, 2);
    assert.equal(next.cookieHeader, 'cf_clearance=2');
  });

  it('pauses when the proxy switches', async () => {
    resetBypassQueueForTests({
      fetch: async () => scrapePayload('x'),
    });
    await ensureClearance(PROXY_A, { force: true });
    const started = Date.now();
    await ensureClearance(PROXY_B, { force: true });
    assert.ok(Date.now() - started >= PROXY_SWITCH_PAUSE_MS);
  });
});
