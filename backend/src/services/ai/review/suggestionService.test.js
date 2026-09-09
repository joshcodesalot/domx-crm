const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SUGGESTION_STATUSES,
  applySupersedePending,
  persistPendingSuggestion,
  emitSuggestionEvent,
  toSuggestionEvent,
  ignoreConversation,
  unignoreConversation,
} = require('./suggestionService');
const { MODES } = require('../contracts');
const { requirePermission } = require('../../../middleware/authorize');

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
        isConversationIgnored: async () => false,
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

  it('no-ops when the conversation is ignored', async () => {
    const store = createMemoryStore();
    const result = await persistPendingSuggestion(
      {
        conversation: {
          id: 'conv-1',
          creatorId: 'cr-1',
          platform: 'maloum',
          platformChatId: 'chat-1',
          revision: 1,
          aiIgnored: true,
        },
        run: { id: 'run-1', revision: 1, route: 'HUMAN_REVIEW' },
        output: { reply: 'hallo', replyEnglish: 'hello', intent: 'rapport' },
      },
      {
        insertPendingSuggestion: async () => {
          throw new Error('should not insert');
        },
        supersedePending: async () => {
          throw new Error('should not supersede');
        },
        isConversationIgnored: async () => {
          throw new Error('should not query');
        },
      }
    );
    assert.equal(result, null);
    assert.equal(store.rows.length, 0);
  });

  it('no-ops when isConversationIgnored is true', async () => {
    let inserted = false;
    const result = await persistPendingSuggestion(
      {
        conversation: {
          id: 'conv-1',
          creatorId: 'cr-1',
          platform: 'maloum',
          platformChatId: 'chat-1',
          revision: 1,
        },
        run: { id: 'run-1', revision: 1, route: 'HUMAN_REVIEW' },
        output: { reply: 'hallo', replyEnglish: 'hello', intent: 'rapport' },
      },
      {
        isConversationIgnored: async () => true,
        insertPendingSuggestion: async () => {
          inserted = true;
          return { id: 'sug-x' };
        },
      }
    );
    assert.equal(result, null);
    assert.equal(inserted, false);
  });
});

function recordingClient() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id FROM ai_conversations/.test(sql)) {
        return { rows: [{ id: params[0] }] };
      }
      if (/"aiIgnored" = true/.test(sql)) {
        return {
          rows: [
            {
              id: params[0],
              aiIgnored: true,
              ignoredByUserId: params[1],
              aiPaused: false,
              humanTakeover: false,
            },
          ],
        };
      }
      if (/"aiIgnored" = false/.test(sql)) {
        return {
          rows: [
            {
              id: params[0],
              aiIgnored: false,
              ignoredAt: null,
              ignoredByUserId: null,
              aiPaused: true,
              humanTakeover: true,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('ignoreConversation / unignoreConversation', () => {
  it('sets ignore flags, supersedes pending, and does not touch creator settings', async () => {
    const client = recordingClient();
    const updated = await ignoreConversation(
      { conversationId: 'conv-1', userId: 'user-1' },
      client
    );
    assert.equal(updated.aiIgnored, true);
    assert.equal(updated.ignoredByUserId, 'user-1');
    assert.equal(
      client.queries.some((q) => /ai_creator_settings/.test(q.sql)),
      false
    );
    assert.equal(
      client.queries.some((q) => /UPDATE ai_suggestions/.test(q.sql)),
      true
    );
  });

  it('clears ignore flags without clearing pause or takeover', async () => {
    const client = recordingClient();
    const updated = await unignoreConversation(
      { conversationId: 'conv-1' },
      client
    );
    assert.equal(updated.aiIgnored, false);
    assert.equal(updated.aiPaused, true);
    assert.equal(updated.humanTakeover, true);
    const sql = client.queries.map((q) => q.sql).join('\n');
    assert.doesNotMatch(sql, /"aiPaused"/);
    assert.doesNotMatch(sql, /"humanTakeover"/);
    assert.doesNotMatch(sql, /ai_creator_settings/);
  });
});

describe('POST /api/ai/conversations ignore permission', () => {
  const mw = requirePermission('ai.moderate', 'ai.settings.manage');

  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  it('returns 403 for a chatter with only ai.suggest.use', () => {
    const res = mockRes();
    let nextCalled = false;
    mw(
      { user: { role: 'chatter', permissions: ['ai.suggest.use'] } },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
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
