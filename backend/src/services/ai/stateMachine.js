const pool = require('../../db/pool');
const {
  CONVERSATION_STATES,
  isConversationState,
} = require('./contracts');

const TRANSITIONS = {
  [CONVERSATION_STATES.NEW]: [
    CONVERSATION_STATES.DISCOVERY,
    CONVERSATION_STATES.KINK_DISCOVERY,
    CONVERSATION_STATES.WARMUP,
  ],
  [CONVERSATION_STATES.DISCOVERY]: [
    CONVERSATION_STATES.KINK_DISCOVERY,
    CONVERSATION_STATES.WARMUP,
  ],
  [CONVERSATION_STATES.KINK_DISCOVERY]: [
    CONVERSATION_STATES.WARMUP,
    CONVERSATION_STATES.INTENSE_WARMUP,
  ],
  [CONVERSATION_STATES.WARMUP]: [
    CONVERSATION_STATES.INTENSE_WARMUP,
    CONVERSATION_STATES.SALES_READY,
  ],
  [CONVERSATION_STATES.INTENSE_WARMUP]: [
    CONVERSATION_STATES.SALES_READY,
    CONVERSATION_STATES.OFFERED,
  ],
  [CONVERSATION_STATES.SALES_READY]: [
    CONVERSATION_STATES.OFFERED,
    CONVERSATION_STATES.WARMUP,
  ],
  [CONVERSATION_STATES.OFFERED]: [
    CONVERSATION_STATES.PURCHASED,
    CONVERSATION_STATES.SALES_READY,
    CONVERSATION_STATES.RETENTION,
  ],
  [CONVERSATION_STATES.PURCHASED]: [
    CONVERSATION_STATES.FULFILLMENT,
    CONVERSATION_STATES.RETENTION,
  ],
  [CONVERSATION_STATES.FULFILLMENT]: [CONVERSATION_STATES.RETENTION],
  [CONVERSATION_STATES.RETENTION]: [
    CONVERSATION_STATES.WARMUP,
    CONVERSATION_STATES.SALES_READY,
    CONVERSATION_STATES.OFFERED,
  ],
};

const STATE_SOURCES = new Set(['model', 'system', 'human']);

function normalizeConversationState(value) {
  return isConversationState(value) ? value : CONVERSATION_STATES.NEW;
}

function canTransition(from, to) {
  if (!isConversationState(to)) return false;
  const current = normalizeConversationState(from);
  if (current === to) return false;
  const allowed = TRANSITIONS[current] || [];
  return allowed.includes(to);
}

async function applyRecommendedState(
  {
    conversationId,
    currentState,
    recommendedState,
    runId,
    source,
  } = {},
  client = pool
) {
  const id = String(conversationId || '').trim();
  if (!id) return { applied: false };

  const fromState = normalizeConversationState(currentState);
  const toState = isConversationState(recommendedState) ? recommendedState : null;
  if (!toState || !canTransition(fromState, toState)) {
    return { applied: false, fromState, toState };
  }

  const historySource = STATE_SOURCES.has(source) ? source : 'model';

  try {
    await client.query(
      `UPDATE ai_conversations
       SET state = $2, "updatedAt" = NOW()
       WHERE id = $1`,
      [id, toState]
    );
    await client.query(
      `INSERT INTO ai_conversation_state_history (
         "conversationId", "fromState", "toState", source, "runId", "recommendedState"
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, fromState, toState, historySource, runId || null, toState]
    );
    return { applied: true, fromState, toState };
  } catch (err) {
    console.error('AI conversation state apply error:', err);
    return { applied: false, fromState, toState };
  }
}

module.exports = {
  TRANSITIONS,
  normalizeConversationState,
  canTransition,
  applyRecommendedState,
};
