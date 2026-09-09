const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MODES, OUTPUT_ACTIONS } = require('../contracts');
const { AUTO_SEND_MIN_CONFIDENCE, canAutoSend } = require('./canAutoSend');

const fresh = {
  suggestionOrRun: { anchorInboundMessageId: 'in-1', revision: 2 },
  conversation: { lastInboundPlatformMessageId: 'in-1', revision: 2 },
};

function base(overrides = {}) {
  return {
    globalFlags: { autoSendAllowed: true },
    settings: { mode: MODES.AUTO_LOW_RISK, paused: false },
    effectiveMode: MODES.AUTO_LOW_RISK,
    output: {
      action: OUTPUT_ACTIONS.TEXT_REPLY,
      confidence: 0.85,
      flags: [],
    },
    platform: 'maloum',
    ...fresh,
    ...overrides,
  };
}

describe('canAutoSend', () => {
  it('exports the 0.7 high-confidence bar', () => {
    assert.equal(AUTO_SEND_MIN_CONFIDENCE, 0.7);
  });

  it('passes when every limited auto-send gate is met', () => {
    assert.equal(canAutoSend(base()), true);
  });

  it('fails closed when auto_send_allowed is off', () => {
    assert.equal(canAutoSend(base({ globalFlags: { autoSendAllowed: false } })), false);
  });

  it('passes for wider auto mode on the same TEXT_REPLY gates', () => {
    assert.equal(
      canAutoSend(
        base({
          settings: { mode: MODES.AUTO, paused: false },
          effectiveMode: MODES.AUTO,
        })
      ),
      true
    );
  });

  it('fails closed when stored mode is not auto_low_risk or auto', () => {
    assert.equal(
      canAutoSend(
        base({
          settings: { mode: MODES.SUGGEST_ONLY, paused: false },
          effectiveMode: MODES.SUGGEST_ONLY,
        })
      ),
      false
    );
  });

  it('fails closed when effective mode demoted off auto send', () => {
    assert.equal(
      canAutoSend(
        base({
          effectiveMode: MODES.SUGGEST_ONLY,
        })
      ),
      false
    );
  });

  it('fails closed for SEND_PPV including wider auto', () => {
    assert.equal(
      canAutoSend(
        base({
          settings: { mode: MODES.AUTO, paused: false },
          effectiveMode: MODES.AUTO,
          output: {
            action: OUTPUT_ACTIONS.SEND_PPV,
            confidence: 0.95,
            flags: [],
          },
        })
      ),
      false
    );
    assert.equal(
      canAutoSend(
        base({
          output: {
            action: OUTPUT_ACTIONS.SEND_PPV,
            confidence: 0.95,
            flags: [],
          },
        })
      ),
      false
    );
  });

  it('fails closed when flags are not empty', () => {
    assert.equal(
      canAutoSend(
        base({
          output: {
            action: OUTPUT_ACTIONS.TEXT_REPLY,
            confidence: 0.9,
            flags: ['review'],
          },
        })
      ),
      false
    );
  });

  it('fails closed below the confidence bar', () => {
    assert.equal(
      canAutoSend(
        base({
          output: {
            action: OUTPUT_ACTIONS.TEXT_REPLY,
            confidence: 0.69,
            flags: [],
          },
        })
      ),
      false
    );
    assert.equal(
      canAutoSend(
        base({
          output: {
            action: OUTPUT_ACTIONS.TEXT_REPLY,
            confidence: 0.7,
            flags: [],
          },
        })
      ),
      true
    );
  });

  it('fails closed off maloum', () => {
    assert.equal(canAutoSend(base({ platform: '4based' })), false);
    assert.equal(canAutoSend(base({ platform: 'telegram' })), false);
  });

  it('fails closed when the draft is stale', () => {
    assert.equal(
      canAutoSend(
        base({
          conversation: { lastInboundPlatformMessageId: 'in-2', revision: 2 },
        })
      ),
      false
    );
    assert.equal(
      canAutoSend(
        base({
          conversation: { lastInboundPlatformMessageId: 'in-1', revision: 3 },
        })
      ),
      false
    );
  });

  it('fails closed on missing input', () => {
    assert.equal(canAutoSend(), false);
    assert.equal(canAutoSend(base({ output: null })), false);
    assert.equal(canAutoSend(base({ conversation: null })), false);
    assert.equal(canAutoSend(base({ suggestionOrRun: null })), false);
  });
});
