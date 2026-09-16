const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUnreadCount } = require('./maloumClient');

describe('normalizeUnreadCount', () => {
  it('returns a finite number as-is', () => {
    assert.equal(normalizeUnreadCount(4), 4);
    assert.equal(normalizeUnreadCount(0), 0);
  });

  it('parses numeric strings', () => {
    assert.equal(normalizeUnreadCount('4'), 4);
    assert.equal(normalizeUnreadCount(' 2 '), 2);
  });

  it('unwraps unread / unreadCount / count / data objects', () => {
    assert.equal(normalizeUnreadCount({ unread: 2 }), 2);
    assert.equal(normalizeUnreadCount({ unreadCount: 5 }), 5);
    assert.equal(normalizeUnreadCount({ count: 3 }), 3);
    assert.equal(normalizeUnreadCount({ data: 7 }), 7);
  });

  it('returns 0 for junk', () => {
    assert.equal(normalizeUnreadCount(null), 0);
    assert.equal(normalizeUnreadCount(undefined), 0);
    assert.equal(normalizeUnreadCount({}), 0);
    assert.equal(normalizeUnreadCount({ unread: 'nope' }), 0);
    assert.equal(normalizeUnreadCount('abc'), 0);
    assert.equal(normalizeUnreadCount(Number.NaN), 0);
  });
});
