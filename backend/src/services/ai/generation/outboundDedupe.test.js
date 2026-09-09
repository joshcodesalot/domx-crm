const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOutboundDedupe } = require('./outboundDedupe');

describe('evaluateOutboundDedupe', () => {
  it('flags a matcha/selfie pair 13 minutes apart as duplicate', () => {
    const result = evaluateOutboundDedupe({
      messages: [
        {
          direction: 'inbound',
          senderRole: 'fan',
          text: 'hey',
          sentAt: '2026-09-09T11:47:00.000Z',
        },
        {
          direction: 'outbound',
          senderRole: 'creator',
          text: 'Schick mir ein Selfie mit deinem Matcha',
          sentAt: '2026-09-09T11:48:00.000Z',
        },
      ],
      draft: 'Mach ein Selfie mit dem Matcha, baby',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.flags, ['duplicate_outbound']);
  });

  it('flags regenerating an unsent pitch', () => {
    const result = evaluateOutboundDedupe({
      messages: [],
      draft: 'Schick mir ein Selfie mit deinem Matcha',
      lastUnsentText: 'Schick mir ein Selfie mit deinem Matcha!',
    });
    assert.equal(result.ok, false);
    assert.ok(result.flags.includes('duplicate_outbound'));
  });

  it('allows a new topic after a fan inbound', () => {
    const result = evaluateOutboundDedupe({
      messages: [
        {
          direction: 'outbound',
          senderRole: 'creator',
          text: 'Schick mir ein Selfie mit deinem Matcha',
        },
        {
          direction: 'inbound',
          senderRole: 'fan',
          text: 'ok later, how was your day?',
        },
      ],
      draft: 'Pretty chill, just made coffee. You?',
    });
    assert.equal(result.ok, true);
  });
});
