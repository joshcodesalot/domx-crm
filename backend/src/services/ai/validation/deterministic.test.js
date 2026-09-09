const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_REPLY_LENGTH,
  SOFT_GERMAN_MAX,
  validateSchema,
  validateAction,
  validatePpvOffer,
  validateLength,
  applyReplyQualityFlags,
  inboundLooksMultiQuestion,
  validateConversation,
  validateCreator,
  validateConnected,
  validateAiOutput,
} = require('./deterministic');
const { OUTPUT_ACTIONS, OUTPUT_INTENTS } = require('../contracts');

function validOutput(overrides = {}) {
  return {
    schemaVersion: 1,
    reply: 'hallo',
    replyEnglish: 'hello',
    intent: OUTPUT_INTENTS.RAPPORT,
    action: OUTPUT_ACTIONS.TEXT_REPLY,
    mediaId: null,
    price: null,
    flags: [],
    ...overrides,
  };
}

const conversation = { id: 'conv-1' };
const creator = { id: 'cr-1', connectionStatus: 'connected' };

describe('validateSchema', () => {
  it('rejects a missing or invalid object', () => {
    assert.equal(validateSchema(null).reason, 'schema');
    assert.equal(validateSchema([]).reason, 'schema');
  });

  it('rejects the wrong schema version or empty replies', () => {
    assert.equal(validateSchema(validOutput({ schemaVersion: 2 })).reason, 'schema');
    assert.equal(validateSchema(validOutput({ reply: '   ' })).reason, 'schema');
    assert.equal(validateSchema(validOutput({ replyEnglish: '' })).reason, 'schema');
    assert.equal(validateSchema(validOutput({ intent: 'nope' })).reason, 'schema');
    assert.equal(validateSchema(validOutput({ flags: null })).reason, 'schema');
  });

  it('accepts a complete TEXT_REPLY payload', () => {
    assert.equal(validateSchema(validOutput()).ok, true);
  });
});

const pricedCandidate = {
  source: 'script',
  mediaId: 'up-1',
  type: 'video',
  note: null,
  price: 12,
  scriptId: 'sc-1',
  title: 'Clip',
};

describe('validateAction', () => {
  it('allows TEXT_REPLY and SEND_PPV', () => {
    assert.equal(validateAction(validOutput()).ok, true);
    assert.equal(
      validateAction(validOutput({ action: OUTPUT_ACTIONS.SEND_PPV })).ok,
      true
    );
    assert.equal(validateAction(validOutput({ action: 'OTHER' })).reason, 'action');
  });
});

describe('validatePpvOffer', () => {
  it('allows SEND_PPV when mediaId is a candidate with a bound price', () => {
    assert.equal(
      validatePpvOffer(
        validOutput({
          action: OUTPUT_ACTIONS.SEND_PPV,
          mediaId: 'up-1',
          price: 12,
        }),
        [pricedCandidate]
      ).ok,
      true
    );
  });

  it('rejects an invented mediaId', () => {
    assert.equal(
      validatePpvOffer(
        validOutput({
          action: OUTPUT_ACTIONS.SEND_PPV,
          mediaId: 'invented',
          price: 12,
        }),
        [pricedCandidate]
      ).reason,
      'ppv_media'
    );
  });

  it('rejects a missing or non-positive price', () => {
    assert.equal(
      validatePpvOffer(
        validOutput({
          action: OUTPUT_ACTIONS.SEND_PPV,
          mediaId: 'up-1',
          price: null,
        }),
        [pricedCandidate]
      ).reason,
      'ppv_price'
    );
    assert.equal(
      validatePpvOffer(
        validOutput({
          action: OUTPUT_ACTIONS.SEND_PPV,
          mediaId: 'up-1',
          price: 0,
        }),
        [pricedCandidate]
      ).reason,
      'ppv_price'
    );
  });

  it('still rejects TEXT_REPLY with mediaId or price', () => {
    assert.equal(validatePpvOffer(validOutput()).ok, true);
    assert.equal(
      validatePpvOffer(validOutput({ mediaId: 'm1' })).reason,
      'media_or_price'
    );
    assert.equal(
      validatePpvOffer(validOutput({ price: 12 })).reason,
      'media_or_price'
    );
  });
});

describe('validateLength', () => {
  it('caps reply and replyEnglish', () => {
    assert.equal(validateLength(validOutput()).ok, true);
    assert.equal(
      validateLength(validOutput({ reply: 'x'.repeat(MAX_REPLY_LENGTH + 1) }))
        .reason,
      'length'
    );
    assert.equal(
      validateLength(
        validOutput({ replyEnglish: 'y'.repeat(MAX_REPLY_LENGTH + 1) })
      ).reason,
      'length'
    );
  });
});

describe('applyReplyQualityFlags', () => {
  it('flags a long German reply unless inbound asked several questions', () => {
    const longReply = 'x'.repeat(SOFT_GERMAN_MAX + 1);
    const flagged = applyReplyQualityFlags(validOutput({ reply: longReply }), {
      messages: [{ direction: 'inbound', text: 'hey' }],
    });
    assert.ok(flagged.flags.includes('too_long'));
    assert.equal(flagged.requiresHumanReview, true);

    const allowed = applyReplyQualityFlags(validOutput({ reply: longReply }), {
      messages: [
        { direction: 'inbound', text: 'Wie gehts? Was machst du? Wo bist du?' },
      ],
    });
    assert.equal(allowed.flags.includes('too_long'), false);
    assert.equal(inboundLooksMultiQuestion('Wie gehts? Was machst du?'), true);
  });

  it('flags em dashes without failing the hard length cap', () => {
    const flagged = applyReplyQualityFlags(
      validOutput({ reply: 'hey — babe' })
    );
    assert.ok(flagged.flags.includes('em_dash'));
    assert.equal(validateLength(validOutput({ reply: 'hey — babe' })).ok, true);
  });
});

describe('validateConversation', () => {
  it('requires a conversation id', () => {
    assert.equal(validateConversation(conversation).ok, true);
    assert.equal(validateConversation(null).reason, 'conversation_missing');
    assert.equal(validateConversation({}).reason, 'conversation_missing');
  });
});

describe('validateCreator', () => {
  it('requires a creator id', () => {
    assert.equal(validateCreator(creator).ok, true);
    assert.equal(validateCreator(null).reason, 'creator_missing');
  });
});

describe('validateConnected', () => {
  it('requires connectionStatus connected', () => {
    assert.equal(validateConnected(creator).ok, true);
    assert.equal(
      validateConnected({ id: 'cr-1', connectionStatus: 'error' }).reason,
      'not_connected'
    );
    assert.equal(validateConnected({ id: 'cr-1' }).reason, 'not_connected');
  });
});

describe('validateAiOutput', () => {
  it('passes when every gate and moderation succeed', async () => {
    const result = await validateAiOutput({
      output: validOutput(),
      conversation,
      creator,
      applyModeration: async () => ({ blocked: false }),
    });
    assert.equal(result.ok, true);
  });

  it('accepts a bound SEND_PPV offer', async () => {
    const result = await validateAiOutput({
      output: validOutput({
        action: OUTPUT_ACTIONS.SEND_PPV,
        mediaId: 'up-1',
        price: 12,
      }),
      conversation,
      creator,
      mediaCandidates: [pricedCandidate],
      applyModeration: async () => ({ blocked: false }),
    });
    assert.equal(result.ok, true);
  });

  it('blocks on a keyword match', async () => {
    const result = await validateAiOutput({
      output: validOutput(),
      conversation,
      creator,
      applyModeration: async () => ({
        blocked: true,
        matchedKeyword: 'forbidden',
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'moderation');
    assert.equal(result.detail, 'forbidden');
  });
});
