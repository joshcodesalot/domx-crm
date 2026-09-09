const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasMeaningfulDiff,
  buildProposedRule,
  maybeSuggestRuleFromEdit,
  approveRuleSuggestion,
  rejectRuleSuggestion,
  loadApprovedRules,
  BrainError,
} = require('./rules');
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

function createRuleStore() {
  const suggestions = [];
  const rules = [];
  let seq = 0;

  return {
    suggestions,
    rules,
    async query(sql, params) {
      const text = String(sql);
      if (text.includes('INSERT INTO ai_rule_suggestions')) {
        const [
          suggestionId,
          conversationId,
          creatorId,
          platform,
          platformFanId,
          beforeText,
          afterText,
          proposedRule,
          proposedScope,
          status,
          createdBy,
        ] = params;
        if (suggestionId && suggestions.some((row) => row.suggestionId === suggestionId)) {
          return { rows: [] };
        }
        const row = {
          id: `rsug-${++seq}`,
          suggestionId,
          conversationId,
          creatorId,
          platform,
          platformFanId,
          beforeText,
          afterText,
          proposedRule,
          proposedScope,
          status,
          createdBy,
          reviewedBy: null,
          reviewedAt: null,
          createdAt: '2026-09-09T12:00:00.000Z',
        };
        suggestions.push(row);
        return { rows: [row] };
      }

      if (text.includes('SELECT * FROM ai_rule_suggestions WHERE id')) {
        return { rows: suggestions.filter((row) => row.id === params[0]) };
      }

      if (text.includes('INSERT INTO ai_rules')) {
        const [
          scope,
          creatorId,
          platform,
          platformFanId,
          ruleText,
          sourceSuggestionId,
          approvedBy,
        ] = params;
        const row = {
          id: `rule-${++seq}`,
          scope,
          creatorId,
          platform,
          platformFanId,
          text: ruleText,
          sourceSuggestionId,
          approvedBy,
          approvedAt: '2026-09-09T12:01:00.000Z',
          active: true,
          createdAt: '2026-09-09T12:01:00.000Z',
        };
        rules.push(row);
        return { rows: [row] };
      }

      if (text.includes('UPDATE ai_rule_suggestions') && text.includes('RETURNING')) {
        const row = suggestions.find((item) => item.id === params[0]);
        if (!row) return { rows: [] };
        row.status = params[1];
        row.reviewedBy = params[2];
        row.reviewedAt = '2026-09-09T12:02:00.000Z';
        return { rows: [{ ...row }] };
      }

      if (text.includes('UPDATE ai_rule_suggestions')) {
        const row = suggestions.find((item) => item.id === params[0]);
        if (row) {
          row.status = params[1];
          row.reviewedBy = params[2];
          row.reviewedAt = '2026-09-09T12:02:00.000Z';
        }
        return { rows: [] };
      }

      if (text.includes('FROM ai_rules') && text.includes('active = true')) {
        const [platform, creatorId, platformFanId] = params;
        const matched = rules.filter((row) => {
          if (!row.active) return false;
          if (row.scope === 'GLOBAL') return true;
          if (row.scope === 'PLATFORM') return row.platform === platform;
          if (row.scope === 'CREATOR') {
            return row.creatorId === creatorId && row.platform === platform;
          }
          return (
            row.creatorId === creatorId &&
            row.platform === platform &&
            row.platformFanId === platformFanId
          );
        });
        const rank = { FAN: 0, CREATOR: 1, PLATFORM: 2, GLOBAL: 3 };
        matched.sort((a, b) => (rank[a.scope] ?? 9) - (rank[b.scope] ?? 9));
        return { rows: matched.slice(0, 20) };
      }

      return { rows: [] };
    },
  };
}

const editInput = {
  suggestion: {
    id: 'sug-1',
    conversationId: 'conv-1',
    creatorId: 'cr-1',
    platform: 'maloum',
  },
  conversation: { id: 'conv-1', platformFanId: 'fan-1' },
  beforeText: 'hallo',
  afterText: 'hallo schatz',
  createdBy: 'user-1',
};

describe('hasMeaningfulDiff', () => {
  it('is false when trimmed texts match', () => {
    assert.equal(hasMeaningfulDiff('hallo', 'hallo'), false);
    assert.equal(hasMeaningfulDiff(' hallo ', 'hallo'), false);
  });

  it('is true when the sent text changed', () => {
    assert.equal(hasMeaningfulDiff('hallo', 'hallo schatz'), true);
    assert.equal(buildProposedRule('hallo', 'hallo schatz'), 'Prefer: hallo schatz');
  });
});

describe('maybeSuggestRuleFromEdit', () => {
  it('does not insert when texts match', async () => {
    const store = createRuleStore();
    const row = await maybeSuggestRuleFromEdit(
      { ...editInput, afterText: 'hallo' },
      store
    );
    assert.equal(row, null);
    assert.equal(store.suggestions.length, 0);
    assert.equal(store.rules.length, 0);
  });

  it('creates a pending suggestion and never writes a rule', async () => {
    const store = createRuleStore();
    const row = await maybeSuggestRuleFromEdit(editInput, store);
    assert.equal(row.status, 'pending');
    assert.equal(row.beforeText, 'hallo');
    assert.equal(row.afterText, 'hallo schatz');
    assert.equal(row.proposedRule, 'Prefer: hallo schatz');
    assert.equal(store.suggestions.length, 1);
    assert.equal(store.rules.length, 0);
  });
});

describe('approve and reject', () => {
  it('approve writes ai_rules and reject does not', async () => {
    const store = createRuleStore();
    const pending = await maybeSuggestRuleFromEdit(editInput, store);
    const rule = await approveRuleSuggestion(
      pending.id,
      { scope: 'CREATOR', user: { id: 'mgr-1' } },
      store
    );
    assert.equal(rule.scope, 'CREATOR');
    assert.equal(rule.text, 'Prefer: hallo schatz');
    assert.equal(store.rules.length, 1);
    assert.equal(store.suggestions[0].status, 'approved');

    const other = await maybeSuggestRuleFromEdit(
      { ...editInput, suggestion: { ...editInput.suggestion, id: 'sug-2' } },
      store
    );
    await rejectRuleSuggestion(other.id, { id: 'mgr-1' }, store);
    assert.equal(store.rules.length, 1);
    assert.equal(store.suggestions[1].status, 'rejected');
  });

  it('does not approve a non-pending suggestion', async () => {
    const store = createRuleStore();
    const pending = await maybeSuggestRuleFromEdit(editInput, store);
    await approveRuleSuggestion(pending.id, { user: { id: 'mgr-1' } }, store);
    await assert.rejects(
      () => approveRuleSuggestion(pending.id, { user: { id: 'mgr-1' } }, store),
      (err) => err instanceof BrainError && err.status === 409
    );
  });
});

describe('loadApprovedRules', () => {
  it('returns matching scopes most-specific first', async () => {
    const store = createRuleStore();
    store.rules.push(
      {
        scope: 'GLOBAL',
        creatorId: null,
        platform: null,
        platformFanId: null,
        text: 'global tone',
        active: true,
        approvedAt: '1',
      },
      {
        scope: 'CREATOR',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformFanId: null,
        text: 'creator tone',
        active: true,
        approvedAt: '2',
      },
      {
        scope: 'FAN',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformFanId: 'fan-1',
        text: 'fan tone',
        active: true,
        approvedAt: '3',
      },
      {
        scope: 'CREATOR',
        creatorId: 'cr-other',
        platform: 'maloum',
        platformFanId: null,
        text: 'other creator',
        active: true,
        approvedAt: '4',
      }
    );
    const loaded = await loadApprovedRules(
      { creatorId: 'cr-1', platform: 'maloum', platformFanId: 'fan-1' },
      store
    );
    assert.deepEqual(
      loaded.map((item) => item.text),
      ['fan tone', 'creator tone', 'global tone']
    );
  });
});

describe('POST /api/ai/rules permission', () => {
  const mw = requirePermission('ai.rules.manage');

  it('returns 403 without ai.rules.manage', () => {
    const req = {
      user: { role: 'chatter', permissions: ['ai.suggest.use'] },
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('allows a manager with ai.rules.manage', () => {
    const req = {
      user: { role: 'manager', permissions: ['ai.rules.manage'] },
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});
