const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../contracts');
const { classifyQueueBucket, QUEUE_BUCKETS } = require('./queue');
const { requirePermission } = require('../../../middleware/authorize');

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

describe('classifyQueueBucket', () => {
  it('paused wins over takeover and pending', () => {
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.SUGGEST_ONLY, paused: true },
        conversation: { humanTakeover: true, aiPaused: false },
        pendingSuggestion: { status: 'pending' },
        effectiveMode: MODES.OFF,
      }),
      QUEUE_BUCKETS.PAUSED
    );
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.SUGGEST_ONLY, paused: false },
        conversation: { humanTakeover: false, aiPaused: true },
        pendingSuggestion: { status: 'pending' },
        effectiveMode: MODES.SUGGEST_ONLY,
      }),
      QUEUE_BUCKETS.PAUSED
    );
  });

  it('takeover wins over pending', () => {
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.HUMAN_TAKEOVER, paused: false },
        conversation: { humanTakeover: false, aiPaused: false },
        pendingSuggestion: { status: 'pending' },
        effectiveMode: MODES.HUMAN_TAKEOVER,
      }),
      QUEUE_BUCKETS.TAKEN_OVER
    );
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.SUGGEST_ONLY, paused: false },
        conversation: { humanTakeover: true, aiPaused: false },
        pendingSuggestion: { status: 'pending' },
        effectiveMode: MODES.SUGGEST_ONLY,
      }),
      QUEUE_BUCKETS.TAKEN_OVER
    );
  });

  it('pending + suggest_only is needs_review', () => {
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.SUGGEST_ONLY, paused: false },
        conversation: { humanTakeover: false, aiPaused: false },
        pendingSuggestion: { status: 'pending' },
        effectiveMode: MODES.SUGGEST_ONLY,
      }),
      QUEUE_BUCKETS.NEEDS_REVIEW
    );
  });

  it('pending + shadow is ai_handling', () => {
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.SHADOW, paused: false },
        conversation: { humanTakeover: false, aiPaused: false },
        pendingSuggestion: { status: 'pending' },
        effectiveMode: MODES.SHADOW,
      }),
      QUEUE_BUCKETS.AI_HANDLING
    );
  });

  it('suggest_only without pending is ai_handling', () => {
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.SUGGEST_ONLY, paused: false },
        conversation: { humanTakeover: false, aiPaused: false },
        pendingSuggestion: null,
        effectiveMode: MODES.SUGGEST_ONLY,
      }),
      QUEUE_BUCKETS.AI_HANDLING
    );
  });

  it('auto modes without pending are ai_handling', () => {
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.AUTO_LOW_RISK, paused: false },
        conversation: { humanTakeover: false, aiPaused: false },
        pendingSuggestion: null,
        effectiveMode: MODES.AUTO_LOW_RISK,
      }),
      QUEUE_BUCKETS.AI_HANDLING
    );
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.AUTO, paused: false },
        conversation: { humanTakeover: false, aiPaused: false },
        pendingSuggestion: null,
        effectiveMode: MODES.AUTO,
      }),
      QUEUE_BUCKETS.AI_HANDLING
    );
  });

  it('off is none', () => {
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.OFF, paused: false },
        conversation: { humanTakeover: false, aiPaused: false },
        pendingSuggestion: null,
        effectiveMode: MODES.OFF,
      }),
      null
    );
  });
});

describe('GET /api/ai/queue permission', () => {
  const mw = requirePermission('ai.moderate', 'ai.settings.manage');

  it('allows ai.moderate or ai.settings.manage', () => {
    const res = mockRes();
    let nextCalled = false;
    mw(
      { user: { role: 'manager', permissions: ['ai.moderate'] } },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);

    const res2 = mockRes();
    let next2 = false;
    mw(
      { user: { role: 'manager', permissions: ['ai.settings.manage'] } },
      res2,
      () => {
        next2 = true;
      }
    );
    assert.equal(next2, true);
  });

  it('returns 403 without either permission', () => {
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
