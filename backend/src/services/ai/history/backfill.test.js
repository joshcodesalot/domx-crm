const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shouldBackfill, maybeBackfillHistory } = require('./backfill');

describe('shouldBackfill', () => {
  it('runs on first AI touch when history is thin', () => {
    assert.equal(
      shouldBackfill({ id: 'c1', historyBackfilledAt: null }, 5),
      true
    );
    assert.equal(
      shouldBackfill({ id: 'c1', historyBackfilledAt: '2026-09-09T00:00:00.000Z' }, 2),
      false
    );
  });
});

describe('maybeBackfillHistory', () => {
  it('paginates telegram with markRead false and does not block on timeout', async () => {
    const listCalls = [];
    const ingested = [];
    const marked = [];
    const result = await maybeBackfillHistory(
      {
        conversation: { id: 'conv-1', platformFanId: '99', fanUsername: 'mira' },
        creatorId: 'cr-1',
        platform: 'telegram',
        platformChatId: '99',
      },
      {
        pool: {},
        messageCount: async () => 3,
        markBackfilled: async (id) => {
          marked.push(id);
        },
        listTelegramMessages: async (creatorId, peerId, opts) => {
          listCalls.push({ creatorId, peerId, opts });
          return {
            messages: [
              { id: '1', text: 'hi', isOutgoing: false, date: '2026-08-01T00:00:00.000Z' },
            ],
            next: null,
            hasMore: false,
          };
        },
        ingestConversation: async (row) => {
          ingested.push(row);
          return { inserted: 1 };
        },
      }
    );
    assert.equal(result.skipped, false);
    assert.equal(listCalls[0].opts.markRead, false);
    assert.equal(ingested[0].skipProcess, true);
    assert.equal(ingested[0].source, 'backfill');
    assert.deepEqual(marked, ['conv-1']);
  });
});
