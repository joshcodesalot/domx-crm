const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { nextProfileVersion, applyProfilePatch } = require('./profile');
const { requirePermission } = require('../../middleware/authorize');

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

describe('applyProfilePatch', () => {
  it('overlays only provided profile keys', () => {
    const merged = applyProfilePatch(
      {
        persona: 'Naomi',
        tone: 'cold',
        languages: ['en'],
        biography: 'bio',
        preferredTerminology: { Queen: 'Mistress' },
        prohibitedClaims: ['meetup'],
        salesStyle: 'slow',
        platformRules: {},
        instructions: 'old sop',
        version: 2,
        updatedBy: null,
        updatedAt: null,
      },
      {
        tone: 'warm dominant',
        prohibitedClaims: ['meetup', 'real name'],
      }
    );
    assert.equal(merged.persona, 'Naomi');
    assert.equal(merged.tone, 'warm dominant');
    assert.equal(merged.salesStyle, 'slow');
    assert.equal(merged.instructions, 'old sop');
    assert.deepEqual(merged.prohibitedClaims, ['meetup', 'real name']);
  });
});

describe('PUT /api/ai/creators/:id/profile permission', () => {
  const mw = requirePermission('ai.settings.manage');

  it('returns 403 for a chatter without ai.settings.manage', () => {
    const req = {
      user: {
        role: 'chatter',
        permissions: ['dashboard.view', 'analytics.self', 'creators.view'],
      },
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Insufficient permissions');
    assert.equal(nextCalled, false);
  });

  it('allows a manager with ai.settings.manage', () => {
    const req = {
      user: {
        role: 'manager',
        permissions: ['ai.settings.manage'],
      },
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });
});
