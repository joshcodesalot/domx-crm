const { MODES, isAiMode } = require('./contracts');

function demoteWithoutAutoSend(global) {
  if (global.suggestAllowed) return MODES.SUGGEST_ONLY;
  if (global.shadowAllowed) return MODES.SHADOW;
  return MODES.OFF;
}

function resolveEffectiveAiMode({ global, creator } = {}) {
  if (!global?.enabled) return MODES.OFF;

  const paused = Boolean(creator?.paused);
  const mode = isAiMode(creator?.mode) ? creator.mode : MODES.OFF;

  if (paused || mode === MODES.OFF) return MODES.OFF;
  if (mode === MODES.HUMAN_TAKEOVER) return MODES.HUMAN_TAKEOVER;

  if (mode === MODES.SHADOW) {
    return global.shadowAllowed ? MODES.SHADOW : MODES.OFF;
  }

  if (mode === MODES.SUGGEST_ONLY) {
    if (global.suggestAllowed) return MODES.SUGGEST_ONLY;
    return global.shadowAllowed ? MODES.SHADOW : MODES.OFF;
  }

  if (mode === MODES.AUTO_LOW_RISK || mode === MODES.AUTO) {
    if (global.autoSendAllowed) return mode;
    return demoteWithoutAutoSend(global);
  }

  return MODES.OFF;
}

module.exports = {
  resolveEffectiveAiMode,
};
