const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_FACTS,
  MAX_FACT_TEXT,
  normalizeFacts,
  getFanMemory,
  upsertFanMemory,
  maybeCopySourceNotes,
  loadOptionalPlatformNotes,
} = require('./memory');
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

function createMemoryStore(seed = {}) {
  const rows = new Map(Object.entries(seed.rows || {}));
  const telegramNotes = new Map(Object.entries(seed.telegramNotes || {}));
  let seq = 0;

  function key(creatorId, platform, platformFanId) {
    return `${creatorId}|${platform}|${platformFanId}`;
  }

  return {
    rows,
    telegramNotes,
    async query(sql, params) {
      const text = String(sql);
      if (text.includes('FROM telegram_fan_notes')) {
        const notes = telegramNotes.get(params[0]);
        return { rows: notes ? [{ notes }] : [] };
      }

      if (text.includes('INSERT INTO ai_fan_memories') && text.includes('NULLIF')) {
        const [creatorId, platform, platformFanId, notes] = params;
        const k = key(creatorId, platform, platformFanId);
        const existing = rows.get(k);
        if (!existing) {
          const row = {
            id: `mem-${++seq}`,
            creatorId,
            platform,
            platformFanId,
            nickname: null,
            facts: [],
            sourceNotes: notes,
            sourceNotesAt: '2026-09-09T12:00:00.000Z',
            updatedAt: '2026-09-09T12:00:00.000Z',
          };
          rows.set(k, row);
          return { rows: [row] };
        }
        if (!existing.sourceNotes) {
          existing.sourceNotes = notes;
          existing.sourceNotesAt = '2026-09-09T12:00:00.000Z';
          existing.updatedAt = '2026-09-09T12:00:00.000Z';
        }
        return { rows: [{ ...existing }] };
      }

      if (text.includes('INSERT INTO ai_fan_memories')) {
        const [creatorId, platform, platformFanId, nickname, factsJson, sourceNotes] =
          params;
        const k = key(creatorId, platform, platformFanId);
        const facts = JSON.parse(factsJson);
        const existing = rows.get(k);
        if (!existing) {
          const row = {
            id: `mem-${++seq}`,
            creatorId,
            platform,
            platformFanId,
            nickname,
            facts,
            sourceNotes,
            sourceNotesAt: sourceNotes ? '2026-09-09T12:00:00.000Z' : null,
            updatedAt: '2026-09-09T12:00:00.000Z',
          };
          rows.set(k, row);
          return { rows: [row] };
        }
        existing.nickname = nickname || existing.nickname;
        existing.facts = facts;
        if (!existing.sourceNotes && sourceNotes) {
          existing.sourceNotes = sourceNotes;
          existing.sourceNotesAt = '2026-09-09T12:00:00.000Z';
        }
        existing.updatedAt = '2026-09-09T12:01:00.000Z';
        return { rows: [{ ...existing }] };
      }

      if (text.includes('FROM ai_fan_memories')) {
        const [creatorId, platform, platformFanId] = params;
        const row = rows.get(key(creatorId, platform, platformFanId));
        return { rows: row ? [{ ...row }] : [] };
      }

      return { rows: [] };
    },
  };
}

describe('normalizeFacts', () => {
  it('drops empties and clamps count and text', () => {
    const long = 'x'.repeat(MAX_FACT_TEXT + 40);
    const facts = normalizeFacts([
      { kind: 'name', text: 'Alex' },
      { kind: 'preference', text: '   ' },
      { kind: 'weird', text: 'unknown kind stays other' },
      { kind: 'boundary', text: long },
      { kind: 'spend', text: 'tips often', password: 'SECRET_PASSWORD' },
      ...Array.from({ length: 25 }, (_, i) => ({
        kind: 'other',
        text: `fact ${i}`,
      })),
    ]);
    assert.equal(facts.length <= MAX_FACTS, true);
    assert.equal(facts[0].kind, 'name');
    assert.equal(facts.some((fact) => fact.kind === 'other'), true);
    assert.ok(facts.every((fact) => fact.text.length <= MAX_FACT_TEXT));
    assert.equal(facts.some((fact) => fact.text === ''), false);
    assert.equal(
      facts.some((fact) => JSON.stringify(fact).includes('SECRET_PASSWORD')),
      false
    );
  });
});

describe('fan memory unique key', () => {
  it('upserts once per creator+platform+fan and keeps facts clamped', async () => {
    const store = createMemoryStore();
    const first = await upsertFanMemory(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'maloum',
        platformFanId: 'fan-1',
        nickname: 'Alex',
        facts: [
          { kind: 'name', text: 'Alex' },
          ...Array.from({ length: 30 }, (_, i) => ({
            kind: 'other',
            text: `extra ${i}`,
          })),
        ],
      },
      store
    );
    const second = await upsertFanMemory(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'maloum',
        platformFanId: 'fan-1',
        facts: [{ kind: 'preference', text: 'likes voice notes' }],
      },
      store
    );
    const other = await upsertFanMemory(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'maloum',
        platformFanId: 'fan-2',
        facts: [{ kind: 'name', text: 'Sam' }],
      },
      store
    );

    assert.equal(first.id, second.id);
    assert.equal(store.rows.size, 2);
    assert.equal(first.facts.length, MAX_FACTS);
    assert.deepEqual(second.facts, [
      { kind: 'preference', text: 'likes voice notes' },
    ]);
    assert.equal(other.id !== first.id, true);
    assert.equal(second.nickname, 'Alex');
  });
});

describe('maybeCopySourceNotes', () => {
  it('fills empty sourceNotes once and does not overwrite facts', async () => {
    const store = createMemoryStore();
    const seeded = await upsertFanMemory(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'telegram',
        platformFanId: 'tg-1',
        facts: [{ kind: 'boundary', text: 'no calls' }],
      },
      store
    );

    const first = await maybeCopySourceNotes(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'telegram',
        platformFanId: 'tg-1',
        notes: '  lives in Berlin  ',
      },
      store
    );
    const second = await maybeCopySourceNotes(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'telegram',
        platformFanId: 'tg-1',
        notes: 'should not replace',
      },
      store
    );
    const loaded = await getFanMemory(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'telegram',
        platformFanId: 'tg-1',
      },
      store
    );

    assert.equal(first.id, seeded.id);
    assert.equal(first.sourceNotes, 'lives in Berlin');
    assert.equal(second.sourceNotes, 'lives in Berlin');
    assert.deepEqual(loaded.facts, [{ kind: 'boundary', text: 'no calls' }]);
  });

  it('creates a snapshot row when none exists', async () => {
    const store = createMemoryStore();
    const copied = await maybeCopySourceNotes(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'maloum',
        platformFanId: 'fan-9',
        notes: 'first note',
      },
      store
    );
    assert.equal(copied.sourceNotes, 'first note');
    assert.deepEqual(copied.facts, []);
  });
});

describe('loadOptionalPlatformNotes', () => {
  it('reads telegram_fan_notes only', async () => {
    const store = createMemoryStore({
      telegramNotes: { 'tg-22': '  telegram note  ' },
    });
    const telegram = await loadOptionalPlatformNotes(
      { platform: 'telegram', platformFanId: 'tg-22' },
      store
    );
    const maloum = await loadOptionalPlatformNotes(
      { platform: 'maloum', platformFanId: 'tg-22' },
      store
    );
    assert.equal(telegram, 'telegram note');
    assert.equal(maloum, null);
  });
});

describe('PUT /api/ai/creators/:id/fans/:fanId/memory permission', () => {
  const mw = requirePermission('ai.settings.manage');

  it('returns 403 without ai.settings.manage', () => {
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

  it('allows a manager with ai.settings.manage', () => {
    const req = {
      user: { role: 'manager', permissions: ['ai.settings.manage'] },
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});
