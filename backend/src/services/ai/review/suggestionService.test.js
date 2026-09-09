const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SUGGESTION_STATUSES,
  applySupersedePending,
  persistPendingSuggestion,
  emitSuggestionEvent,
  toSuggestionEvent,
} = require('./suggestionService');
const { MODES } = require('../contracts');

function createMemoryStore() {
  const rows = [];
  let seq = 0;

  async function supersedePending(conversationId) {
    return applySupersedePending(rows, conversationId);
  }

  async function insertPendingSuggestion(row) {
    const created = {
      ...row,
      id: `sug-${++seq}`,
      status: SUGGESTION_STATUSES.PENDING,
    };
    rows.push(created);
    return created;
  }

  return {
    rows,
    persist(input) {
      return persistPendingSuggestion(input, {
        supersedePending,
        insertPendingSuggestion,
      });
    },
  };
}

describe('persistPendingSuggestion', () => {
  it('supersedes the previous pending row', async () => {
    const store = createMemoryStore();
    const conversation = {
      id: 'conv-1',
      creatorId: 'cr-1',
      platform: 'maloum',
      platformChatId: 'chat-1',
      revision: 1,
    };

    const first = await store.persist({
      conversation,
      run: { id: 'run-1', revision: 1, route: 'HUMAN_REVIEW' },
      output: { reply: 'first', replyEnglish: 'first en', intent: 'rapport' },
    });
    const second = await store.persist({
      conversation,
      run: { id: 'run-2', revision: 2, route: 'HUMAN_REVIEW' },
      output: { reply: 'second', replyEnglish: 'second en', intent: 'upsell' },
    });

    assert.equal(store.rows.length, 2);
    assert.equal(first.status, SUGGESTION_STATUSES.SUPERSEDED);
    assert.equal(second.status, SUGGESTION_STATUSES.PENDING);
    assert.equal(store.rows[0].status, SUGGESTION_STATUSES.SUPERSEDED);
    assert.equal(store.rows[1].status, SUGGESTION_STATUSES.PENDING);
    assert.equal(store.rows[1].reply, 'second');
  });
});

describe('emitSuggestionEvent', () => {
  it('does not emit in shadow mode', async () => {
    let called = false;
    const result = await emitSuggestionEvent(
      { id: 'sug-1', creatorId: 'cr-1', status: 'pending' },
      { mode: MODES.SHADOW },
      {
        getUserIdsWithCreatorAccess: async () => {
          called = true;
          return ['u1'];
        },
        emitToUsers: () => {
          called = true;
        },
      }
    );
    assert.equal(result.emitted, false);
    assert.equal(result.reason, 'shadow');
    assert.equal(called, false);
  });

  it('emits ai:suggestion to the access list', async () => {
    const events = [];
    const suggestion = {
      id: 'sug-1',
      runId: 'run-1',
      creatorId: 'cr-1',
      platform: 'maloum',
      platformChatId: 'chat-1',
      conversationId: 'conv-1',
      revision: 2,
      status: 'pending',
      reply: 'hallo',
      replyEnglish: 'hello',
      intent: 'rapport',
      route: 'HUMAN_REVIEW',
    };
    const result = await emitSuggestionEvent(
      suggestion,
      { mode: MODES.SUGGEST_ONLY },
      {
        getUserIdsWithCreatorAccess: async () => ['u1', 'u2'],
        emitToUsers: (userIds, event) => {
          events.push({ userIds, event });
        },
      }
    );
    assert.equal(result.emitted, true);
    assert.deepEqual(events[0].userIds, ['u1', 'u2']);
    assert.deepEqual(events[0].event, toSuggestionEvent(suggestion));
  });
});
