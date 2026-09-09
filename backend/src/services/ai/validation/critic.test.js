const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CRITIC_LOW_CONFIDENCE,
  shouldCritic,
  normalizeCriticResult,
  criticReply,
} = require('./critic');
const { OUTPUT_ACTIONS, OUTPUT_INTENTS } = require('../contracts');

function draft(overrides = {}) {
  return {
    action: OUTPUT_ACTIONS.TEXT_REPLY,
    intent: OUTPUT_INTENTS.RAPPORT,
    confidence: 0.9,
    flags: [],
    ...overrides,
  };
}

describe('shouldCritic', () => {
  it('skips simple rapport TEXT_REPLY with high confidence and empty flags', () => {
    assert.equal(shouldCritic(draft()), false);
  });

  it('runs for SEND_PPV even when confidence is high', () => {
    assert.equal(
      shouldCritic(
        draft({
          action: OUTPUT_ACTIONS.SEND_PPV,
          confidence: 0.95,
        })
      ),
      true
    );
  });

  it('runs for low-confidence TEXT_REPLY', () => {
    assert.equal(shouldCritic(draft({ confidence: 0.4 })), true);
    assert.equal(shouldCritic(draft({ confidence: CRITIC_LOW_CONFIDENCE })), false);
  });

  it('runs when flags are present', () => {
    assert.equal(shouldCritic(draft({ flags: ['risky'] })), true);
  });

  it('treats missing confidence as low', () => {
    assert.equal(shouldCritic(draft({ confidence: undefined })), true);
  });
});

describe('normalizeCriticResult', () => {
  it('accepts a valid pass or fail payload', () => {
    assert.deepEqual(normalizeCriticResult({ ok: true, flags: [], reason: null }), {
      ok: true,
      flags: [],
      reason: null,
    });
    assert.deepEqual(
      normalizeCriticResult({ ok: false, flags: ['bad_ppv'], reason: 'price' }),
      { ok: false, flags: ['bad_ppv'], reason: 'price' }
    );
  });

  it('rejects invalid shapes', () => {
    assert.equal(normalizeCriticResult(null), null);
    assert.equal(normalizeCriticResult({ ok: 'yes', flags: [] }), null);
    assert.equal(normalizeCriticResult({ ok: true, flags: 'nope' }), null);
    assert.equal(normalizeCriticResult({ ok: true, flags: [1] }), null);
  });
});

describe('criticReply', () => {
  it('parses provider JSON and returns usage', async () => {
    const result = await criticReply({
      context: {},
      output: draft(),
      provider: {
        async createResponse() {
          return {
            outputText: '{"ok":true,"flags":["reviewed"],"reason":null}',
            usage: { input_tokens: 3, output_tokens: 2 },
          };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.flags, ['reviewed']);
    assert.equal(result.usage.promptTokens, 3);
    assert.equal(result.usage.completionTokens, 2);
  });

  it('prefers validateReply when injected', async () => {
    let usedValidate = false;
    const result = await criticReply({
      output: draft(),
      provider: {
        async validateReply() {
          usedValidate = true;
          return { outputText: '{"ok":false,"flags":[],"reason":"unsafe"}' };
        },
        async createResponse() {
          return { outputText: '{"ok":true,"flags":[],"reason":null}' };
        },
      },
    });
    assert.equal(usedValidate, true);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsafe');
  });

  it('throws critic_invalid on bad JSON', async () => {
    await assert.rejects(
      () =>
        criticReply({
          output: draft(),
          provider: { createResponse: async () => ({ outputText: 'not-json' }) },
        }),
      (err) => err.code === 'critic_invalid'
    );
  });
});
