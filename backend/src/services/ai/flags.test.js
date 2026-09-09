const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveEffectiveAiMode } = require('./flags');
const { MODES } = require('./contracts');

const globalOn = {
  enabled: true,
  shadowAllowed: true,
  suggestAllowed: true,
  autoSendAllowed: true,
};

describe('resolveEffectiveAiMode', () => {
  it('global off wins over creator auto', () => {
    assert.equal(
      resolveEffectiveAiMode({
        global: { ...globalOn, enabled: false },
        creator: { mode: MODES.AUTO, paused: false },
      }),
      MODES.OFF
    );
  });

  it('global off wins over creator suggest_only', () => {
    assert.equal(
      resolveEffectiveAiMode({
        global: { ...globalOn, enabled: false },
        creator: { mode: MODES.SUGGEST_ONLY, paused: false },
      }),
      MODES.OFF
    );
  });

  it('creator off stays off when global is on', () => {
    assert.equal(
      resolveEffectiveAiMode({
        global: globalOn,
        creator: { mode: MODES.OFF, paused: false },
      }),
      MODES.OFF
    );
  });

  it('paused creator is off even in suggest_only', () => {
    assert.equal(
      resolveEffectiveAiMode({
        global: globalOn,
        creator: { mode: MODES.SUGGEST_ONLY, paused: true },
      }),
      MODES.OFF
    );
  });

  it('suggest_only is kept when suggest is allowed', () => {
    assert.equal(
      resolveEffectiveAiMode({
        global: globalOn,
        creator: { mode: MODES.SUGGEST_ONLY, paused: false },
      }),
      MODES.SUGGEST_ONLY
    );
  });

  it('shadow demotes to off when shadow is not allowed', () => {
    assert.equal(
      resolveEffectiveAiMode({
        global: { ...globalOn, shadowAllowed: false },
        creator: { mode: MODES.SHADOW, paused: false },
      }),
      MODES.OFF
    );
  });

  it('auto_low_risk demotes to suggest_only when auto-send is off', () => {
    assert.equal(
      resolveEffectiveAiMode({
        global: { ...globalOn, autoSendAllowed: false },
        creator: { mode: MODES.AUTO_LOW_RISK, paused: false },
      }),
      MODES.SUGGEST_ONLY
    );
  });

  it('human_takeover is kept when global is on', () => {
    assert.equal(
      resolveEffectiveAiMode({
        global: globalOn,
        creator: { mode: MODES.HUMAN_TAKEOVER, paused: false },
      }),
      MODES.HUMAN_TAKEOVER
    );
  });
});
