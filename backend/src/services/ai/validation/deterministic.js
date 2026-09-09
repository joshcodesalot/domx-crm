const { applyModeration: defaultApplyModeration } = require('../../contentModeration');
const {
  OUTPUT_SCHEMA_VERSION,
  OUTPUT_ACTIONS,
  OUTPUT_INTENTS,
} = require('../contracts');

const MAX_REPLY_LENGTH = 2000;
const INTENT_VALUES = new Set(Object.values(OUTPUT_INTENTS));

function fail(reason, detail) {
  const result = { ok: false, reason };
  if (detail != null) result.detail = detail;
  return result;
}

function ok() {
  return { ok: true };
}

function hasId(row) {
  return Boolean(row && typeof row === 'object' && row.id);
}

function validateSchema(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return fail('schema', 'output');
  }
  if (output.schemaVersion !== OUTPUT_SCHEMA_VERSION) {
    return fail('schema', 'schemaVersion');
  }
  if (typeof output.reply !== 'string' || !output.reply.trim()) {
    return fail('schema', 'reply');
  }
  if (typeof output.replyEnglish !== 'string' || !output.replyEnglish.trim()) {
    return fail('schema', 'replyEnglish');
  }
  if (!INTENT_VALUES.has(output.intent)) {
    return fail('schema', 'intent');
  }
  if (!Array.isArray(output.flags)) {
    return fail('schema', 'flags');
  }
  return ok();
}

function validateAction(output) {
  if (
    output?.action !== OUTPUT_ACTIONS.TEXT_REPLY &&
    output?.action !== OUTPUT_ACTIONS.SEND_PPV
  ) {
    return fail('action', output?.action ?? null);
  }
  return ok();
}

function candidateMediaIds(candidates) {
  const ids = new Set();
  for (const item of Array.isArray(candidates) ? candidates : []) {
    const id = typeof item?.mediaId === 'string' ? item.mediaId.trim() : '';
    if (id) ids.add(id);
  }
  return ids;
}

function validatePpvOffer(output, candidates) {
  if (output?.action === OUTPUT_ACTIONS.TEXT_REPLY) {
    if (output.mediaId != null || output.price != null) {
      return fail('media_or_price');
    }
    return ok();
  }

  if (output?.action !== OUTPUT_ACTIONS.SEND_PPV) {
    return fail('action', output?.action ?? null);
  }

  const mediaId = typeof output.mediaId === 'string' ? output.mediaId.trim() : '';
  if (!mediaId || !candidateMediaIds(candidates).has(mediaId)) {
    return fail('ppv_media', output?.mediaId ?? null);
  }

  const price = Number(output.price);
  if (!Number.isFinite(price) || price <= 0) {
    return fail('ppv_price', output?.price ?? null);
  }

  return ok();
}

function validateLength(output) {
  const reply = typeof output?.reply === 'string' ? output.reply : '';
  const replyEnglish =
    typeof output?.replyEnglish === 'string' ? output.replyEnglish : '';
  if (reply.length > MAX_REPLY_LENGTH || replyEnglish.length > MAX_REPLY_LENGTH) {
    return fail('length');
  }
  return ok();
}

function validateConversation(conversation) {
  if (!hasId(conversation)) {
    return fail('conversation_missing');
  }
  return ok();
}

function validateCreator(creator) {
  if (!hasId(creator)) {
    return fail('creator_missing');
  }
  return ok();
}

function validateConnected(creator) {
  if (creator?.connectionStatus !== 'connected') {
    return fail('not_connected', creator?.connectionStatus ?? null);
  }
  return ok();
}

async function validateModeration(
  output,
  moderationContext = {},
  applyModeration = defaultApplyModeration
) {
  const result = await applyModeration({
    germanText: output.reply,
    englishText: output.replyEnglish,
    creatorId: moderationContext.creatorId || null,
    platform: moderationContext.platform || null,
    chatId: moderationContext.chatId || null,
    userId: moderationContext.userId || null,
  });

  if (result?.blocked) {
    return fail('moderation', result.matchedKeyword || null);
  }
  return ok();
}

async function validateAiOutput({
  output,
  conversation,
  creator,
  mediaCandidates,
  applyModeration,
  moderationContext,
} = {}) {
  const gates = [
    validateSchema(output),
    validateAction(output),
    validatePpvOffer(output, mediaCandidates),
    validateLength(output),
    validateConversation(conversation),
    validateCreator(creator),
    validateConnected(creator),
  ];

  for (const gate of gates) {
    if (!gate.ok) return gate;
  }

  return validateModeration(
    output,
    moderationContext,
    applyModeration || defaultApplyModeration
  );
}

module.exports = {
  MAX_REPLY_LENGTH,
  validateSchema,
  validateAction,
  validatePpvOffer,
  validateLength,
  validateConversation,
  validateCreator,
  validateConnected,
  validateModeration,
  validateAiOutput,
};
