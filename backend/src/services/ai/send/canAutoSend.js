const { MODES, OUTPUT_ACTIONS } = require('../contracts');
const { isSuggestionStale } = require('./executeApprovedSend');

const AUTO_SEND_MIN_CONFIDENCE = 0.7;
const AUTO_SEND_PLATFORMS = new Set(['maloum', '4based', 'telegram']);

function asConfidence(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function flagsEmpty(flags) {
  return Array.isArray(flags) && flags.length === 0;
}

function isAutoSendMode(mode) {
  return mode === MODES.AUTO_LOW_RISK || mode === MODES.AUTO;
}

function canAutoSend({
  globalFlags,
  settings,
  effectiveMode,
  output,
  platform,
  conversation,
  suggestionOrRun,
} = {}) {
  if (!globalFlags?.autoSendAllowed) return false;
  if (!isAutoSendMode(settings?.mode)) return false;
  if (!isAutoSendMode(effectiveMode)) return false;
  if (!AUTO_SEND_PLATFORMS.has(String(platform || '').trim())) return false;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  if (output.action !== OUTPUT_ACTIONS.TEXT_REPLY) return false;
  if (!flagsEmpty(output.flags)) return false;
  if (asConfidence(output.confidence) < AUTO_SEND_MIN_CONFIDENCE) return false;
  if (isSuggestionStale(suggestionOrRun, conversation)) return false;
  return true;
}

module.exports = {
  AUTO_SEND_MIN_CONFIDENCE,
  AUTO_SEND_PLATFORMS,
  isAutoSendMode,
  canAutoSend,
};
