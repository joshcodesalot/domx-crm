const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeOpaqueId,
  sanitizeFanUsername,
  resolveGivenName,
  displayFanLabel,
} = require('./names');

describe('names', () => {
  it('rejects hex ids and long numeric ids as usernames', () => {
    assert.equal(looksLikeOpaqueId('abc123abc123abc123abc123'), true);
    assert.equal(looksLikeOpaqueId('12345678901'), true);
    assert.equal(sanitizeFanUsername('abc123abc123abc123abc123'), null);
    assert.equal(sanitizeFanUsername('sugar_daddy99'), 'sugar_daddy99');
    assert.equal(sanitizeFanUsername('@mira'), 'mira');
  });

  it('never uses username as givenName', () => {
    assert.equal(
      resolveGivenName({
        username: 'sugar_daddy99',
        nickname: 'sugar_daddy99',
        statedName: 'sugar_daddy99',
      }),
      null
    );
    assert.equal(
      resolveGivenName({
        username: 'sugar_daddy99',
        memories: [{ kind: 'name', text: 'Alex' }],
      }),
      'Alex'
    );
  });

  it('never displays a hex platformFanId as the fan label', () => {
    assert.equal(
      displayFanLabel({
        platformFanId: 'abc123abc123abc123abc123',
        fanUsername: 'abc123abc123abc123abc123',
      }),
      'Fan'
    );
    assert.equal(
      displayFanLabel({
        nickname: 'Alex',
        fanUsername: 'sugar_daddy99',
        platformFanId: 'abc123abc123abc123abc123',
      }),
      'Alex'
    );
  });
});
