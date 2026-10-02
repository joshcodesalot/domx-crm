const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { clientCheck } = require('./fanslyClient');

describe('fansly client check', () => {
  const deviceId = '881829141681287168';

  it('matches the captured login request', () => {
    assert.equal(clientCheck('/api/v1/login', deviceId), '1c8e3faa8dec20');
  });

  it('matches the captured account and unread requests', () => {
    assert.equal(clientCheck('/api/v1/account/me', deviceId), '1d4d5ea10eb692');
    assert.equal(clientCheck('/api/v1/message/unread', deviceId), '1768606ea849fb');
  });
});
