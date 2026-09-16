const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { UNSEND_BEFORE_MASS_KEY } = require('./appSettings');

describe('appSettings', () => {
  it('exports the unsend-before-mass key', () => {
    assert.equal(UNSEND_BEFORE_MASS_KEY, 'schedule.unsend_before_mass');
  });
});
