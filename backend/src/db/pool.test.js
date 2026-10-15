const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePoolMax } = require('./pool');

describe('resolvePoolMax', () => {
  it('uses 10 when the value is missing, zero, or not a number', () => {
    assert.equal(resolvePoolMax(undefined), 10);
    assert.equal(resolvePoolMax(''), 10);
    assert.equal(resolvePoolMax('0'), 10);
    assert.equal(resolvePoolMax('nope'), 10);
  });

  it('uses a positive integer, including the current default of 10', () => {
    assert.equal(resolvePoolMax('10'), 10);
    assert.equal(resolvePoolMax('20'), 20);
  });
});
