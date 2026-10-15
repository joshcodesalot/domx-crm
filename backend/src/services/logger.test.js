const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('./logger');

describe('logger redact', () => {
  it('redacts authorization, cookie, password, token, secret, proxy, and message body fields', () => {
    const sample = {
      authorization: 'Bearer secret',
      cookie: 'sid=abc',
      password: 'hunter2',
      token: 'jwt',
      secret: 's3cr3t',
      proxy: 'http://user:pass@host:1',
      body: 'chat text',
      message: 'hello fan',
      nested: {
        accessToken: 'x',
        proxyUrl: 'http://p',
      },
      path: '/api/health',
    };

    const redacted = redact(sample);

    assert.equal(redacted.authorization, '[redacted]');
    assert.equal(redacted.cookie, '[redacted]');
    assert.equal(redacted.password, '[redacted]');
    assert.equal(redacted.token, '[redacted]');
    assert.equal(redacted.secret, '[redacted]');
    assert.equal(redacted.proxy, '[redacted]');
    assert.equal(redacted.body, '[redacted]');
    assert.equal(redacted.message, '[redacted]');
    assert.equal(redacted.nested.accessToken, '[redacted]');
    assert.equal(redacted.nested.proxyUrl, '[redacted]');
    assert.equal(redacted.path, '/api/health');
  });
});
