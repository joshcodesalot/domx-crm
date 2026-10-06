const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { skipsGermanTranslation } = require('./germanTranslationPolicy');

const BANNED = [
  'translateToGerman',
  'translateToGermanFemdom',
  'historyTranslateQueue',
  'translateTextToEnglish',
];

const FANSLY_SURFACES = [
  'frontend/src/pages/ChatterFansly.tsx',
  'frontend/src/pages/FanslyMassMessage.tsx',
  'frontend/src/pages/FanslyFeed.tsx',
  'backend/src/routes/fansly.js',
  'backend/src/services/fanslyClient.js',
];

describe('fansly german translation', () => {
  it('rejects fansly and leaves other platforms alone', () => {
    assert.equal(skipsGermanTranslation('fansly'), true);
    assert.equal(skipsGermanTranslation(' Fansly '), true);
    assert.equal(skipsGermanTranslation('maloum'), false);
    assert.equal(skipsGermanTranslation('4based'), false);
    assert.equal(skipsGermanTranslation('telegram'), false);
    assert.equal(skipsGermanTranslation(''), false);
    assert.equal(skipsGermanTranslation(null), false);
  });

  it('fansly chat, mass message, feed, and client code do not call translators', () => {
    const root = path.resolve(__dirname, '../../..');
    for (const rel of FANSLY_SURFACES) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      for (const token of BANNED) {
        assert.equal(src.includes(token), false, `${rel} references ${token}`);
      }
    }
  });
});
