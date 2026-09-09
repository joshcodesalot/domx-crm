const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planIngest, shouldPersistIngest, CONVERSATION_UPSERT_SQL, nextIngestPointers } = require('./ingest');
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

describe('CONVERSATION_UPSERT_SQL', () => {
  it('does not clobber aiPaused or humanTakeover on conflict', () => {
    assert.match(CONVERSATION_UPSERT_SQL, /ON CONFLICT/);
    assert.doesNotMatch(
      CONVERSATION_UPSERT_SQL,
      /"aiPaused"\s*=\s*EXCLUDED\."aiPaused"/
    );
    assert.doesNotMatch(
      CONVERSATION_UPSERT_SQL,
      /"humanTakeover"\s*=\s*EXCLUDED\."humanTakeover"/
    );
    assert.doesNotMatch(
      CONVERSATION_UPSERT_SQL,
      /"aiIgnored"\s*=\s*EXCLUDED\."aiIgnored"/
    );
    assert.match(
      CONVERSATION_UPSERT_SQL,
      /"fanUsername"\s*=\s*COALESCE\(EXCLUDED\."fanUsername"/
    );
  });
});

describe('planIngest maxMessages', () => {
  it('can ingest more than 50 messages for backfill', () => {
    const messages = Array.from({ length: 80 }, (_, i) => ({
      platformMessageId: `m${i}`,
      direction: i % 2 === 0 ? 'inbound' : 'outbound',
      senderRole: i % 2 === 0 ? 'fan' : 'creator',
      text: `msg ${i}`,
    }));
    const planned = planIngest({ existingIds: [], messages, maxMessages: 300 });
    assert.equal(planned.toInsert.length, 80);
  });
});

describe('nextIngestPointers', () => {
  const { isSuggestionStale } = require('./send/executeApprovedSend');

  it('counts a live inbound toward revision and last inbound', () => {
    const next = nextIngestPointers({
      conversation: {
        revision: 0,
        lastInboundPlatformMessageId: null,
        lastInboundAt: null,
        lastMessageAt: null,
      },
      toInsert: [
        {
          direction: 'inbound',
          platformMessageId: 'live-1',
          sentAt: '2026-09-09T12:00:00.000Z',
        },
      ],
      inboundCount: 1,
      source: 'poll',
    });
    assert.equal(next.revision, 1);
    assert.equal(next.lastInboundPlatformMessageId, 'live-1');
    assert.equal(next.lastInboundAt, '2026-09-09T12:00:00.000Z');
  });

  it('does not bump revision or last inbound for 20 older backfill messages', () => {
    const live = {
      revision: 1,
      lastInboundPlatformMessageId: 'live-1',
      lastInboundAt: '2026-09-09T12:00:00.000Z',
      lastOutboundPlatformMessageId: null,
      lastMessageAt: '2026-09-09T12:00:00.000Z',
    };
    const oldInbounds = Array.from({ length: 20 }, (_, i) => ({
      direction: 'inbound',
      platformMessageId: `old-${i + 1}`,
      sentAt: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
    }));
    const next = nextIngestPointers({
      conversation: live,
      toInsert: oldInbounds,
      inboundCount: 20,
      source: 'backfill',
      skipProcess: true,
    });
    assert.equal(next.revision, 1);
    assert.equal(next.lastInboundPlatformMessageId, 'live-1');
    assert.equal(next.lastInboundAt, '2026-09-09T12:00:00.000Z');
    assert.equal(
      isSuggestionStale(
        { revision: 1, anchorInboundMessageId: 'live-1' },
        {
          revision: next.revision,
          lastInboundPlatformMessageId: next.lastInboundPlatformMessageId,
        }
      ),
      false
    );
  });
});
