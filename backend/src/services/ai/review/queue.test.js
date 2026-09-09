const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../contracts');
const {
  classifyQueueBucket,
  QUEUE_BUCKETS,
  toQueueRow,
  buildQueueItems,
  listQueue,
} = require('./queue');
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
  it('ignored wins over paused, takeover, and needs_review', () => {
    assert.equal(
      classifyQueueBucket({
        settings: { mode: MODES.SUGGEST_ONLY, paused: true },
        conversation: {
          humanTakeover: true,
          aiPaused: true,
          aiIgnored: true,
        },
        pendingSuggestion: { status: 'pending' },
        effectiveMode: MODES.SUGGEST_ONLY,
      }),
      QUEUE_BUCKETS.IGNORED
    );
    assert.notEqual(
      classifyQueueBucket({
        settings: { mode: MODES.SUGGEST_ONLY, paused: true },
        conversation: { aiIgnored: true, aiPaused: true },
        pendingSuggestion: { status: 'pending' },
        effectiveMode: MODES.SUGGEST_ONLY,
      }),
      QUEUE_BUCKETS.PAUSED
    );
  });

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

const ON_FLAGS = {
  enabled: true,
  shadowAllowed: true,
  suggestAllowed: true,
  autoSendAllowed: false,
};

function sampleRow(overrides = {}) {
  return {
    conversationId: 'conv-1',
    creatorId: 'cr-1',
    creatorName: 'Naomi',
    platform: 'maloum',
    platformChatId: 'chat-1',
    platformFanId: 'fan-1',
    state: 'WARMUP',
    humanTakeover: false,
    aiPaused: false,
    aiIgnored: false,
    lastInboundAt: '2026-09-09T12:00:00.000Z',
    lastMessageAt: '2026-09-09T12:01:00.000Z',
    lastInboundPreview: 'hey there',
    mode: MODES.SUGGEST_ONLY,
    paused: false,
    suggestionId: 'sug-1',
    suggestionStatus: 'pending',
    reply: 'hallo',
    replyEnglish: 'hello',
    intent: 'rapport',
    suggestionUpdatedAt: '2026-09-09T12:01:00.000Z',
    ...overrides,
  };
}

describe('toQueueRow / listQueue state', () => {
  it('includes funnel state, preview, and pause sources', () => {
    const { items } = buildQueueItems([sampleRow()], ON_FLAGS);
    assert.equal(items.length, 1);
    assert.equal(items[0].state, 'WARMUP');
    assert.equal(items[0].lastInboundPreview, 'hey there');
    assert.equal(items[0].conversationId, 'conv-1');
    assert.equal(items[0].suggestion.id, 'sug-1');
    assert.equal(items[0].paused, false);
    assert.equal(items[0].aiPaused, false);
    assert.equal(items[0].creatorPaused, false);
    assert.equal(items[0].humanTakeover, false);
    assert.equal(items[0].effectiveMode, MODES.SUGGEST_ONLY);
  });

  it('counts ignored separately from paused', () => {
    const { items, counts } = buildQueueItems(
      [
        sampleRow({
          conversationId: 'conv-ignored',
          aiIgnored: true,
          aiPaused: true,
          paused: true,
        }),
      ],
      ON_FLAGS
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].bucket, QUEUE_BUCKETS.IGNORED);
    assert.equal(items[0].aiIgnored, true);
    assert.equal(counts.ignored, 1);
    assert.equal(counts.paused, 0);
  });

  it('defaults missing state to NEW', () => {
    const row = toQueueRow(
      sampleRow({ state: null }),
      QUEUE_BUCKETS.NEEDS_REVIEW,
      MODES.SUGGEST_ONLY
    );
    assert.equal(row.state, 'NEW');
  });

  it('returns state from listQueue and honors state filter', async () => {
    const rows = [
      sampleRow({ conversationId: 'conv-warm', state: 'WARMUP' }),
      sampleRow({
        conversationId: 'conv-new',
        state: 'NEW',
        platformChatId: 'chat-2',
      }),
    ];
    const result = await listQueue(
      {
        bucket: 'needs_review',
        user: { role: 'manager', permissions: ['creators.manage'] },
      },
      {
        getAiFlags: async () => ON_FLAGS,
        loadQueueRows: async () => rows,
      }
    );
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].state, 'WARMUP');

    const filtered = await listQueue(
      {
        bucket: 'needs_review',
        state: 'NEW',
        user: { role: 'manager', permissions: ['creators.manage'] },
      },
      {
        getAiFlags: async () => ON_FLAGS,
        loadQueueRows: async () => rows,
      }
    );
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].conversationId, 'conv-new');
    assert.equal(filtered.items[0].state, 'NEW');
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
