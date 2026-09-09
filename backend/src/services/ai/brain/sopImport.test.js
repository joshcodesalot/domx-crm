const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createResponse } = require('../providers/mockProvider');
const { requirePermission } = require('../../../middleware/authorize');
const {
  SopImportError,
  normalizeProposedJson,
  normalizeOverlapJson,
  importSopGuide,
  getSopImportDraft,
  approveSopImport,
  rejectSopImport,
  loadActiveSops,
  MAX_SOP_CONTEXT_BODY,
} = require('./sopImport');

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const RULE_ID = '33333333-3333-4333-8333-333333333333';

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

function parseJsonb(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsonProvider(payload) {
  return {
    createResponse: () =>
      createResponse({ outputText: JSON.stringify(payload) }),
  };
}

function emptyOverlap() {
  return jsonProvider({ overlaps: [] });
}

function createSopStore() {
  const drafts = [];
  const sops = [];
  const rules = [];
  const profiles = [];
  const creators = [{ id: CREATOR_ID, platform: 'maloum' }];
  let seq = 0;

  return {
    drafts,
    sops,
    rules,
    profiles,
    async query(sql, params = []) {
      const text = String(sql);

      if (text.includes('SELECT id FROM creators WHERE id')) {
        return { rows: creators.filter((row) => row.id === params[0]) };
      }

      if (text.includes('SELECT platform FROM creators')) {
        const row = creators.find((item) => item.id === params[0]);
        return { rows: row ? [row] : [] };
      }

      if (text.includes('FROM ai_creator_profiles')) {
        return {
          rows: profiles.filter((row) => row.creatorId === params[0]),
        };
      }

      if (text.includes('INSERT INTO ai_sop_import_drafts')) {
        const [
          rawText,
          status,
          proposedJson,
          overlapJson,
          documentType,
          creatorId,
          createdBy,
        ] = params;
        const row = {
          id: DRAFT_ID,
          rawText,
          status,
          proposedJson: parseJsonb(proposedJson),
          overlapJson: parseJsonb(overlapJson),
          documentType,
          creatorId,
          createdBy,
          reviewedBy: null,
          reviewedAt: null,
          createdAt: '2026-09-09T12:00:00.000Z',
          updatedAt: '2026-09-09T12:00:00.000Z',
        };
        drafts.push(row);
        return { rows: [row] };
      }

      if (text.includes('SELECT * FROM ai_sop_import_drafts WHERE id')) {
        return { rows: drafts.filter((row) => row.id === params[0]) };
      }

      if (text.includes('UPDATE ai_sop_import_drafts')) {
        const row = drafts.find((item) => item.id === params[0]);
        if (!row) return { rows: [] };
        row.status = params[1];
        if (text.includes('"proposedJson"')) {
          row.proposedJson = parseJsonb(params[2]);
          row.reviewedBy = params[3];
        } else {
          row.reviewedBy = params[2];
        }
        row.reviewedAt = '2026-09-09T12:03:00.000Z';
        row.updatedAt = '2026-09-09T12:03:00.000Z';
        return { rows: [{ ...row }] };
      }

      if (text.includes('INSERT INTO ai_sops')) {
        const [
          title,
          body,
          scope,
          creatorId,
          sourceDraftId,
          createdBy,
          documentType,
        ] = params;
        const row = {
          id: `sop-${++seq}`,
          title,
          body,
          scope,
          creatorId,
          active: true,
          sourceDraftId,
          createdBy,
          documentType,
          sortOrder: 0,
          updatedBy: createdBy,
          createdAt: '2026-09-09T12:04:00.000Z',
          updatedAt: '2026-09-09T12:04:00.000Z',
        };
        sops.push(row);
        return { rows: [row] };
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
          approvedAt: '2026-09-09T12:04:00.000Z',
          active: true,
          createdAt: '2026-09-09T12:04:00.000Z',
        };
        rules.push(row);
        return { rows: [row] };
      }

      if (text.includes('FROM ai_rules') && text.includes('active = true')) {
        return { rows: rules.filter((row) => row.active !== false) };
      }

      if (text.includes('FROM ai_sops') && text.includes('active = true')) {
        const creatorId = params[0];
        const matched = sops.filter(
          (row) =>
            row.active &&
            (row.scope === 'GLOBAL' ||
              (row.scope === 'CREATOR' && row.creatorId === creatorId))
        );
        return { rows: matched };
      }

      return { rows: [] };
    },
  };
}

function structuredOutput(overrides = {}) {
  return {
    documentType: 'sop',
    sops: [
      {
        title: 'Femdom Tone',
        body: 'Stay dominant and unhurried.',
        scope: 'GLOBAL',
        creatorId: null,
      },
    ],
    profilePatch: { tone: 'dominant', salesStyle: 'slow upsell' },
    shortRules: [
      { text: 'Never break character', scope: 'GLOBAL' },
      { text: 'Use this creator voice', scope: 'CREATOR' },
    ],
    ...overrides,
  };
}

async function importWith(store, { structure, overlap, ...rest } = {}) {
  return importSopGuide({
    rawText: rest.rawText || 'guide',
    creatorId: rest.creatorId,
    documentType: rest.documentType,
    user: rest.user || { id: 'user-1' },
    provider: jsonProvider(structure || structuredOutput()),
    overlapProvider: overlap ? jsonProvider(overlap) : emptyOverlap(),
    client: store,
    listRules: async () =>
      store.rules.map((row) => ({ id: row.id, text: row.text })),
    getProfile: async () => store.profiles[0] || {},
  });
}

describe('normalizeProposedJson', () => {
  it('stamps CREATOR sops and drops GLOBAL sops for infosheets', () => {
    const normalized = normalizeProposedJson(
      {
        documentType: 'infosheet',
        sops: [
          { title: 'Femdom Tone', body: 'process', scope: 'GLOBAL' },
          { title: 'Voice', body: 'creator process', scope: 'CREATOR' },
        ],
        profilePatch: { biography: 'Hamburg', extra: 'ignore' },
        shortRules: [{ text: `x`.repeat(600), scope: 'PLATFORM' }],
      },
      CREATOR_ID,
      'infosheet'
    );
    assert.equal(normalized.documentType, 'infosheet');
    assert.equal(normalized.sops.length, 1);
    assert.equal(normalized.sops[0].title, 'Voice');
    assert.equal(normalized.sops[0].creatorId, CREATOR_ID);
    assert.equal(normalized.profilePatch.biography, 'Hamburg');
    assert.equal(normalized.profilePatch.extra, undefined);
    assert.equal(normalized.shortRules[0].scope, 'GLOBAL');
    assert.equal(normalized.shortRules[0].text.length, 500);
  });

  it('returns null for non-objects', () => {
    assert.equal(normalizeProposedJson(null), null);
    assert.equal(normalizeProposedJson([]), null);
  });
});

describe('normalizeOverlapJson', () => {
  it('keeps valid overlaps and drops incomplete rows', () => {
    const normalized = normalizeOverlapJson({
      overlaps: [
        {
          severity: 'conflict',
          newItem: 'never baby',
          existingItem: 'use baby',
          existingId: RULE_ID,
          summary: 'Opposite pet-name rule',
          suggestion: 'human_decide',
        },
        { severity: 'duplicate' },
      ],
    });
    assert.equal(normalized.overlaps.length, 1);
    assert.equal(normalized.overlaps[0].severity, 'conflict');
  });

  it('returns null for malformed payloads', () => {
    assert.equal(normalizeOverlapJson(null), null);
    assert.equal(normalizeOverlapJson([]), null);
  });
});

describe('importSopGuide', () => {
  it('infosheet paste maps to profilePatch and not a GLOBAL tone SOP', async () => {
    const store = createSopStore();
    const draft = await importWith(store, {
      documentType: 'infosheet',
      creatorId: CREATOR_ID,
      structure: {
        documentType: 'infosheet',
        sops: [
          {
            title: 'Femdom Tone',
            body: 'Always demand.',
            scope: 'GLOBAL',
          },
        ],
        profilePatch: {
          persona: 'Valentina',
          biography: 'Lives in Hamburg. Colombian-German.',
          languages: ['de', 'en'],
        },
        shortRules: [],
      },
    });
    assert.equal(draft.documentType, 'infosheet');
    assert.equal(draft.proposedJson.profilePatch.biography.includes('Hamburg'), true);
    assert.equal(
      draft.proposedJson.sops.some((sop) => sop.scope === 'GLOBAL'),
      false
    );
    assert.equal(store.sops.length, 0);
  });

  it('tone-guide paste becomes a GLOBAL Femdom Tone SOP', async () => {
    const store = createSopStore();
    const draft = await importWith(store, {
      documentType: 'sop',
      structure: structuredOutput(),
    });
    assert.equal(draft.proposedJson.sops[0].title, 'Femdom Tone');
    assert.equal(draft.proposedJson.sops[0].scope, 'GLOBAL');
    assert.equal(draft.status, 'pending');
    assert.equal(store.sops.length, 0);
  });

  it('fails closed on bad structure JSON without writing a draft', async () => {
    const store = createSopStore();
    await assert.rejects(
      () =>
        importSopGuide({
          rawText: 'some guide',
          provider: {
            createResponse: () => createResponse({ outputText: 'not json at all' }),
          },
          overlapProvider: emptyOverlap(),
          client: store,
        }),
      (err) => err instanceof SopImportError && err.code === 'invalid_json'
    );
    assert.equal(store.drafts.length, 0);
  });

  it('flags duplicate vs an existing short rule', async () => {
    const store = createSopStore();
    store.rules.push({
      id: RULE_ID,
      text: 'Never say would you like',
      active: true,
    });
    const draft = await importWith(store, {
      structure: {
        documentType: 'sop',
        sops: [],
        profilePatch: null,
        shortRules: [{ text: 'Never would you like', scope: 'GLOBAL' }],
      },
      overlap: {
        overlaps: [
          {
            severity: 'duplicate',
            newItem: 'Never would you like',
            existingItem: 'Never say would you like',
            existingId: RULE_ID,
            summary: 'Same instruction',
            suggestion: 'keep_existing',
          },
        ],
      },
    });
    assert.equal(draft.overlapJson.overlaps[0].severity, 'duplicate');
    assert.equal(store.sops.length, 0);
  });

  it('flags never baby vs use baby as a conflict', async () => {
    const store = createSopStore();
    store.sops.push({
      id: 'sop-baby',
      title: 'Pet names',
      body: 'use baby as pet name',
      scope: 'GLOBAL',
      active: true,
    });
    const draft = await importWith(store, {
      overlap: {
        overlaps: [
          {
            severity: 'conflict',
            newItem: 'never use baby',
            existingItem: 'Pet names',
            existingId: 'sop-baby',
            summary: 'Opposite pet-name instruction',
            suggestion: 'human_decide',
          },
        ],
      },
    });
    assert.equal(draft.overlapJson.overlaps[0].severity, 'conflict');
  });

  it('does not treat infosheet Hamburg bio vs global tone as duplicate', async () => {
    const store = createSopStore();
    store.sops.push({
      id: 'sop-tone',
      title: 'Femdom Tone',
      body: 'Stay dominant.',
      scope: 'GLOBAL',
      active: true,
    });
    const draft = await importWith(store, {
      documentType: 'infosheet',
      creatorId: CREATOR_ID,
      structure: {
        documentType: 'infosheet',
        sops: [],
        profilePatch: { biography: 'Lives in Hamburg.' },
        shortRules: [],
      },
      overlap: {
        overlaps: [
          {
            severity: 'related',
            newItem: 'biography',
            existingItem: 'Femdom Tone',
            existingId: 'sop-tone',
            summary: 'Identity vs process, complementary',
            suggestion: 'keep_new',
          },
        ],
      },
    });
    assert.equal(draft.overlapJson.overlaps[0].severity, 'related');
    assert.notEqual(draft.overlapJson.overlaps[0].severity, 'duplicate');
  });

  it('malformed overlap JSON still saves a pending draft and does not write live', async () => {
    const store = createSopStore();
    const draft = await importSopGuide({
      rawText: 'guide',
      provider: jsonProvider(structuredOutput()),
      overlapProvider: {
        createResponse: () => createResponse({ outputText: 'not overlap json' }),
      },
      client: store,
    });
    assert.equal(draft.status, 'pending');
    assert.equal(draft.overlapJson.error, 'overlap_parse_failed');
    assert.deepEqual(draft.overlapJson.overlaps, []);
    assert.equal(store.sops.length, 0);
    assert.equal(store.rules.length, 0);
  });
});

describe('approve and reject SOP import', () => {
  it('approve writes SOPs, profile merge, and rules', async () => {
    const store = createSopStore();
    const draft = await importWith(store, { creatorId: CREATOR_ID });
    const mergeCalls = [];
    const result = await approveSopImport(draft.id, {
      user: { id: 'reviewer-1' },
      client: store,
      mergeProfile: async (creatorId, patch, userId) => {
        mergeCalls.push({ creatorId, patch, userId });
        return { tone: patch.tone };
      },
    });
    assert.equal(result.draft.status, 'approved');
    assert.equal(store.sops.length, 1);
    assert.equal(store.rules.length, 2);
    assert.equal(mergeCalls.length, 1);
  });

  it('keep_existing skips the matching new SOP', async () => {
    const store = createSopStore();
    const draft = await importWith(store, {
      overlap: {
        overlaps: [
          {
            severity: 'duplicate',
            newItem: 'Femdom Tone',
            existingItem: 'Old tone',
            existingId: 'sop-old',
            summary: 'Same tone guide',
            suggestion: 'keep_existing',
          },
        ],
      },
    });
    const result = await approveSopImport(draft.id, {
      client: store,
      overlapResolutions: [
        {
          existingId: 'sop-old',
          newItem: 'Femdom Tone',
          suggestion: 'keep_existing',
        },
      ],
    });
    assert.equal(result.sops.length, 0);
    assert.equal(store.sops.length, 0);
  });

  it('unresolved conflict returns 400 and writes nothing', async () => {
    const store = createSopStore();
    const draft = await importWith(store, {
      overlap: {
        overlaps: [
          {
            severity: 'conflict',
            newItem: 'never use baby',
            existingItem: 'use baby',
            existingId: 'sop-baby',
            summary: 'Opposite',
            suggestion: 'human_decide',
          },
        ],
      },
    });
    await assert.rejects(
      () => approveSopImport(draft.id, { client: store }),
      (err) =>
        err instanceof SopImportError && err.code === 'conflict_unresolved'
    );
    assert.equal(store.sops.length, 0);
  });

  it('reject writes no live SOPs or rules', async () => {
    const store = createSopStore();
    const draft = await importWith(store);
    const rejected = await rejectSopImport(draft.id, {
      user: { id: 'reviewer-1' },
      client: store,
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(store.sops.length, 0);
    assert.equal(store.rules.length, 0);
  });

  it('approve of a non-pending draft returns 409', async () => {
    const store = createSopStore();
    const draft = await importWith(store);
    await rejectSopImport(draft.id, { client: store });
    await assert.rejects(
      () => approveSopImport(draft.id, { client: store }),
      (err) => err instanceof SopImportError && err.code === 'not_pending'
    );
  });
});

describe('loadActiveSops', () => {
  it('returns GLOBAL and matching CREATOR rows truncated to 4000 chars', async () => {
    const store = createSopStore();
    store.sops.push(
      {
        title: 'Global',
        body: 'A'.repeat(4500),
        scope: 'GLOBAL',
        creatorId: null,
        active: true,
        updatedAt: '2026-09-09T12:00:00.000Z',
      },
      {
        title: 'Mine',
        body: 'Creator SOP',
        scope: 'CREATOR',
        creatorId: CREATOR_ID,
        active: true,
        updatedAt: '2026-09-09T12:01:00.000Z',
      },
      {
        title: 'Other',
        body: 'skip',
        scope: 'CREATOR',
        creatorId: '44444444-4444-4444-8444-444444444444',
        active: true,
        updatedAt: '2026-09-09T12:02:00.000Z',
      }
    );
    const loaded = await loadActiveSops({ creatorId: CREATOR_ID }, store);
    assert.equal(loaded.length, 2);
    assert.ok(loaded.every((row) => row.body.length <= MAX_SOP_CONTEXT_BODY));
    assert.ok(loaded.some((row) => row.title === 'Mine'));
    assert.equal(
      loaded.some((row) => row.title === 'Other'),
      false
    );
  });
});

describe('getSopImportDraft', () => {
  it('returns 404 when missing', async () => {
    const store = createSopStore();
    await assert.rejects(
      () => getSopImportDraft(DRAFT_ID, store),
      (err) => err instanceof SopImportError && err.status === 404
    );
  });
});

describe('POST /api/ai/sops/import permission', () => {
  const mw = requirePermission('ai.rules.manage');

  it('returns 403 without ai.rules.manage', () => {
    const req = {
      user: { role: 'chatter', permissions: ['creators.view'] },
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
