const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stripModelTokens } = require('./germanTranslator');

describe('stripModelTokens', () => {
  it('removes a glued end token', () => {
    assert.equal(
      stripModelTokens('du hältst dich ganz schön bedeckt<|eos|>'),
      'du hältst dich ganz schön bedeckt'
    );
  });

  it('removes a token in the middle of a message', () => {
    assert.equal(
      stripModelTokens('ein <|endoftext|>bisschen zu still<|eot_id|>'),
      'ein bisschen zu still'
    );
  });

  it('leaves ordinary chat text unchanged', () => {
    assert.equal(
      stripModelTokens('du bist mir <3 und score < 3'),
      'du bist mir <3 und score < 3'
    );
  });

  it('returns empty when the model output is only a token', () => {
    assert.equal(stripModelTokens('<|eos|>'), '');
  });
});
