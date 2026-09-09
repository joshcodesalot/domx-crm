const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planIngest, shouldPersistIngest } = require('./ingest');
const { MODES } = require('./contracts');

describe('shouldPersistIngest', () => {
  it('is false when global is off and mode is off', () => {
    assert.equal(
      shouldPersistIngest({ globalEnabled: false, creatorMode: MODES.OFF }),
      false
    );
  });

  it('is false when global is off and mode is missing', () => {
    assert.equal(shouldPersistIngest({ globalEnabled: false }), false);
  });

  it('is true when global is on', () => {
    assert.equal(
      shouldPersistIngest({ globalEnabled: true, creatorMode: MODES.OFF }),
      true
    );
  });

  it('is true when creator mode is suggest_only', () => {
    assert.equal(
      shouldPersistIngest({
        globalEnabled: false,
        creatorMode: MODES.SUGGEST_ONLY,
      }),
      true
    );
  });
});

describe('planIngest', () => {
  it('duplicate ids do not insert or count inbound', () => {
    const planned = planIngest({
      existingIds: ['m1'],
      messages: [
        {
          platformMessageId: 'm1',
          direction: 'inbound',
          senderRole: 'fan',
          text: 'hi',
        },
      ],
    });
    assert.equal(planned.toInsert.length, 0);
    assert.equal(planned.inboundCount, 0);
  });

  it('new inbound inserts and counts toward revision', () => {
    const planned = planIngest({
      existingIds: [],
      messages: [
        {
          platformMessageId: 'm2',
          direction: 'inbound',
          senderRole: 'fan',
          text: 'hello',
        },
      ],
    });
    assert.equal(planned.toInsert.length, 1);
    assert.equal(planned.inboundCount, 1);
    assert.equal(planned.toInsert[0].platformMessageId, 'm2');
  });

  it('new outbound inserts without inbound count', () => {
    const planned = planIngest({
      existingIds: [],
      messages: [
        {
          platformMessageId: 'o1',
          direction: 'outbound',
          senderRole: 'creator',
          text: 'hey',
        },
      ],
    });
    assert.equal(planned.toInsert.length, 1);
    assert.equal(planned.inboundCount, 0);
  });

  it('drops messages without a platform id', () => {
    const planned = planIngest({
      existingIds: [],
      messages: [{ direction: 'inbound', senderRole: 'fan', text: 'x' }],
    });
    assert.equal(planned.toInsert.length, 0);
    assert.equal(planned.inboundCount, 0);
  });
});
