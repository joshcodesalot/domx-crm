const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requirePermission } = require('../middleware/authorize');
const {
  AI_SETTING_KEYS,
  AiFlagsError,
  parseAiFlagsPatch,
  setAiFlags,
  toAiFlagsPayload,
  assertCanPatchAutoSend,
} = require('./appSettings');

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

function createFlagStore(initial = {}) {
  const values = {
    [AI_SETTING_KEYS.enabled]: false,
    [AI_SETTING_KEYS.shadowAllowed]: false,
    [AI_SETTING_KEYS.suggestAllowed]: false,
    [AI_SETTING_KEYS.autoSendAllowed]: false,
    ...initial,
  };
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO app_settings')) {
        values[params[0]] = JSON.parse(params[1]);
      }
      return { rows: [] };
    },
    async getAiFlags() {
      return {
        enabled: Boolean(values[AI_SETTING_KEYS.enabled]),
        shadowAllowed: Boolean(values[AI_SETTING_KEYS.shadowAllowed]),
        suggestAllowed: Boolean(values[AI_SETTING_KEYS.suggestAllowed]),
        autoSendAllowed: Boolean(values[AI_SETTING_KEYS.autoSendAllowed]),
      };
    },
  };
}

describe('parseAiFlagsPatch', () => {
  it('upserts only known boolean keys and ignores unknown keys', () => {
    const entries = parseAiFlagsPatch({
      enabled: true,
      suggestAllowed: true,
      extra: true,
      paused: false,
    });
    assert.deepEqual(
      entries.map((row) => row.key),
      [AI_SETTING_KEYS.enabled, AI_SETTING_KEYS.suggestAllowed]
    );
  });

  it('fails closed when a known key is not a boolean', () => {
    assert.throws(
      () => parseAiFlagsPatch({ enabled: 'yes' }),
      (err) => err instanceof AiFlagsError && err.status === 400
    );
  });
});

describe('setAiFlags', () => {
  it('PATCH enabled+suggestAllowed leaves autoSendAllowed false', async () => {
    const store = createFlagStore();
    const flags = await setAiFlags(
      { enabled: true, suggestAllowed: true, extra: true },
      'user-1',
      { query: store.query.bind(store), getAiFlags: store.getAiFlags.bind(store) }
    );
    assert.equal(flags.enabled, true);
    assert.equal(flags.suggestAllowed, true);
    assert.equal(flags.shadowAllowed, false);
    assert.equal(flags.autoSendAllowed, false);
    assert.equal(store.queries.length, 2);
    assert.equal(
      store.queries.some(
        (row) => row.params[0] === AI_SETTING_KEYS.autoSendAllowed
      ),
      false
    );
    assert.equal(store.queries[0].params[2], 'user-1');
  });
});

describe('GET /api/ai/flags payload', () => {
  it('returns flags for a manager and canEditAutoSend from permission', () => {
    const manager = {
      role: 'manager',
      permissions: ['ai.settings.manage', 'ai.autosend.enable'],
    };
    const payload = toAiFlagsPayload(
      {
        enabled: false,
        shadowAllowed: false,
        suggestAllowed: false,
        autoSendAllowed: false,
      },
      manager
    );
    assert.equal(payload.enabled, false);
    assert.equal(payload.suggestAllowed, false);
    assert.equal(payload.autoSendAllowed, false);
    assert.equal(payload.canEditAutoSend, true);
  });
});

describe('GET/PATCH /api/ai/flags permission', () => {
  const mw = requirePermission('ai.settings.manage');

  it('allows a manager with ai.settings.manage', () => {
    const res = mockRes();
    let nextCalled = false;
    mw(
      { user: { role: 'manager', permissions: ['ai.settings.manage'] } },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);
  });

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

  it('PATCH autoSendAllowed without ai.autosend.enable is 403', () => {
    const user = {
      role: 'manager',
      permissions: ['ai.settings.manage'],
    };
    assert.equal(assertCanPatchAutoSend(user, { autoSendAllowed: true }), false);
    assert.equal(assertCanPatchAutoSend(user, { enabled: true }), true);
    assert.equal(
      assertCanPatchAutoSend(
        {
          role: 'manager',
          permissions: ['ai.settings.manage', 'ai.autosend.enable'],
        },
        { autoSendAllowed: true }
      ),
      true
    );
  });
});
