const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAnalyticsPlatform,
  monthlySalesByPlatformFromRows,
} = require('./messagingAnalyticsHelpers');

describe('normalizeAnalyticsPlatform', () => {
  it('keeps maloum, 4based, and telegram', () => {
    assert.equal(normalizeAnalyticsPlatform('maloum'), 'maloum');
    assert.equal(normalizeAnalyticsPlatform('4based'), '4based');
    assert.equal(normalizeAnalyticsPlatform('telegram'), 'telegram');
  });

  it('does not treat unknown or empty values as maloum', () => {
    assert.equal(normalizeAnalyticsPlatform(null), null);
    assert.equal(normalizeAnalyticsPlatform(''), null);
    assert.equal(normalizeAnalyticsPlatform('unknown'), null);
  });
});

describe('monthlySalesByPlatformFromRows', () => {
  it('does not bucket unknown platforms as maloum', () => {
    const rows = monthlySalesByPlatformFromRows([
      { platform: 'telegram', currency: 'USD', amount: 10 },
      { platform: null, currency: 'EUR', amount: 5 },
    ]);
    assert.deepEqual(
      rows.map((row) => row.platform),
      ['telegram']
    );
  });
});
