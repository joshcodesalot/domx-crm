const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canTransition,
  normalizeConversationState,
  applyRecommendedState,
} = require('./stateMachine');
const { CONVERSATION_STATES } = require('./contracts');

function createStateStore(initial = {}) {
  const conversations = new Map(Object.entries(initial.conversations || {}));
  const history = [];
  return {
    conversations,
    history,
    async query(sql, params) {
      const text = String(sql);
      if (text.includes('UPDATE ai_conversations')) {
        const [id, state] = params;
        conversations.set(id, state);
        return { rows: [] };
      }
      if (text.includes('INSERT INTO ai_conversation_state_history')) {
        const [conversationId, fromState, toState, source, runId, recommendedState] =
          params;
        history.push({
          conversationId,
          fromState,
          toState,
          source,
          runId,
          recommendedState,
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe('normalizeConversationState', () => {
  it('returns NEW for missing or unknown values', () => {
    assert.equal(normalizeConversationState(null), CONVERSATION_STATES.NEW);
    assert.equal(normalizeConversationState('nope'), CONVERSATION_STATES.NEW);
    assert.equal(
      normalizeConversationState(CONVERSATION_STATES.WARMUP),
      CONVERSATION_STATES.WARMUP
    );
  });
});

describe('canTransition', () => {
  it('allows listed edges and rejects illegal or same', () => {
    assert.equal(
      canTransition(CONVERSATION_STATES.NEW, CONVERSATION_STATES.WARMUP),
      true
    );
    assert.equal(
      canTransition(CONVERSATION_STATES.NEW, CONVERSATION_STATES.PURCHASED),
      false
    );
    assert.equal(
      canTransition(CONVERSATION_STATES.WARMUP, CONVERSATION_STATES.WARMUP),
      false
    );
    assert.equal(canTransition(CONVERSATION_STATES.NEW, 'NOPE'), false);
  });
});

describe('applyRecommendedState', () => {
  it('applies an allowed edge and writes history', async () => {
    const store = createStateStore();
    const result = await applyRecommendedState(
      {
        conversationId: 'conv-1',
        currentState: CONVERSATION_STATES.NEW,
        recommendedState: CONVERSATION_STATES.WARMUP,
        runId: 'run-1',
        source: 'model',
      },
      store
    );
    assert.equal(result.applied, true);
    assert.equal(result.fromState, CONVERSATION_STATES.NEW);
    assert.equal(result.toState, CONVERSATION_STATES.WARMUP);
    assert.equal(store.conversations.get('conv-1'), CONVERSATION_STATES.WARMUP);
    assert.equal(store.history.length, 1);
    assert.equal(store.history[0].toState, CONVERSATION_STATES.WARMUP);
  });

  it('ignores illegal, same, and unknown recommendations', async () => {
    const store = createStateStore();
    const illegal = await applyRecommendedState(
      {
        conversationId: 'conv-1',
        currentState: CONVERSATION_STATES.NEW,
        recommendedState: CONVERSATION_STATES.PURCHASED,
        runId: 'run-1',
        source: 'model',
      },
      store
    );
    const same = await applyRecommendedState(
      {
        conversationId: 'conv-1',
        currentState: CONVERSATION_STATES.WARMUP,
        recommendedState: CONVERSATION_STATES.WARMUP,
        runId: 'run-2',
        source: 'model',
      },
      store
    );
    const unknown = await applyRecommendedState(
      {
        conversationId: 'conv-1',
        currentState: CONVERSATION_STATES.NEW,
        recommendedState: 'NOPE',
        runId: 'run-3',
        source: 'model',
      },
      store
    );
    assert.equal(illegal.applied, false);
    assert.equal(same.applied, false);
    assert.equal(unknown.applied, false);
    assert.equal(store.history.length, 0);
    assert.equal(store.conversations.size, 0);
  });
});
