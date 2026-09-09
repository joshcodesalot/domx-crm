const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { nextProfileVersion } = require('./profile');
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

describe('nextProfileVersion', () => {
  it('starts at 1 when no row exists', () => {
    assert.equal(nextProfileVersion(null), 1);
  });

  it('bumps an existing version', () => {
    assert.equal(nextProfileVersion({ version: 3 }), 4);
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
