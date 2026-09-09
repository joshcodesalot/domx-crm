const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MEDIA_CANDIDATE_LIMIT,
  subtractSent,
  candidatesFromScripts,
  normalizeMediaCandidates,
  loadMediaCandidates,
  findCandidate,
  bindPpvFromCandidates,
} = require('./mediaCandidates');
const { OUTPUT_ACTIONS } = require('./contracts');

describe('subtractSent', () => {
  it('drops vault items that were already sent', () => {
    const kept = subtractSent(
      [
        { source: 'vault', mediaId: 'up-1', type: 'image', note: null, price: null, scriptId: null, title: null },
        { source: 'vault', mediaId: 'up-2', type: 'video', note: null, price: null, scriptId: null, title: null },
      ],
      ['up-1']
    );
    assert.deepEqual(
      kept.map((item) => item.mediaId),
      ['up-2']
    );
  });
});

describe('candidatesFromScripts', () => {
  it('drops scripts already sent to the fan', () => {
    const candidates = candidatesFromScripts(
      [
        {
          id: 'script-sent',
          title: 'Old offer',
          price: 12,
          media: [{ mediaKey: 'm-old', type: 'image', previewUrl: 'https://secret' }],
        },
        {
          id: 'script-new',
          title: 'New offer',
          price: 15,
          media: [{ mediaKey: 'm-new', type: 'video' }],
        },
      ],
      ['script-sent']
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].mediaId, 'm-new');
    assert.equal(candidates[0].scriptId, 'script-new');
    assert.equal(candidates[0].price, 15);
    assert.equal(Object.hasOwn(candidates[0], 'previewUrl'), false);
  });
});

describe('normalizeMediaCandidates', () => {
  it('caps at 20 and strips previewUrl', () => {
    const raw = Array.from({ length: 25 }, (_, i) => ({
      source: 'vault',
      mediaId: `m${i}`,
      previewUrl: 'https://cdn.example/secret',
      password: 'SECRET_PASSWORD',
    }));
    const normalized = normalizeMediaCandidates(raw);
    assert.equal(normalized.length, MEDIA_CANDIDATE_LIMIT);
    assert.equal(
      normalized.every((item) => !Object.hasOwn(item, 'previewUrl')),
      true
    );
    assert.equal(
      JSON.stringify(normalized).includes('SECRET_PASSWORD'),
      false
    );
  });
});

describe('bindPpvFromCandidates', () => {
  const candidates = [
    {
      source: 'script',
      mediaId: 'up-1',
      type: 'video',
      note: null,
      price: 12,
      scriptId: 'sc-1',
      title: 'Clip',
    },
  ];

  it('clears mediaId and price on TEXT_REPLY', () => {
    const bound = bindPpvFromCandidates(
      {
        action: OUTPUT_ACTIONS.TEXT_REPLY,
        mediaId: 'up-1',
        price: 99,
      },
      candidates
    );
    assert.equal(bound.mediaId, null);
    assert.equal(bound.price, null);
  });

  it('overwrites model price from the matched candidate', () => {
    const bound = bindPpvFromCandidates(
      {
        action: OUTPUT_ACTIONS.SEND_PPV,
        mediaId: 'up-1',
        price: 99,
      },
      candidates
    );
    assert.equal(bound.action, OUTPUT_ACTIONS.SEND_PPV);
    assert.equal(bound.mediaId, 'up-1');
    assert.equal(bound.price, 12);
    assert.equal(bound.scriptId, 'sc-1');
    assert.equal(findCandidate(candidates, 'up-1')?.mediaId, 'up-1');
  });

  it('nulls price when mediaId is not a candidate', () => {
    const bound = bindPpvFromCandidates(
      {
        action: OUTPUT_ACTIONS.SEND_PPV,
        mediaId: 'invented',
        price: 99,
      },
      candidates
    );
    assert.equal(bound.mediaId, 'invented');
    assert.equal(bound.price, null);
    assert.equal(bound.scriptId, null);
  });
});

describe('loadMediaCandidates', () => {
  it('merges unsent scripts and vault, attaches notes, skips sent', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (String(sql).includes('FROM creator_scripts')) {
          return {
            rows: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                title: 'PPV clip',
                price: 20,
                media: [{ mediaKey: 'script-media', type: 'video' }],
              },
              {
                id: '22222222-2222-4222-8222-222222222222',
                title: 'Already sent',
                price: 9,
                media: [{ mediaKey: 'sent-script-media', type: 'image' }],
              },
            ],
          };
        }
        if (String(sql).includes('FROM creator_script_sends')) {
          return { rows: [{ scriptId: '22222222-2222-4222-8222-222222222222' }] };
        }
        if (String(sql).includes('FROM maloum_vault_sent')) {
          return { rows: [{ uploadId: 'sent-upload' }] };
        }
        if (String(sql).includes('FROM vault_media_notes')) {
          return { rows: [{ mediaKey: 'live-upload', note: 'best seller' }] };
        }
        return { rows: [] };
      },
    };

    const candidates = await loadMediaCandidates(
      {
        creatorId: '11111111-1111-4111-8111-111111111111',
        platform: 'maloum',
        platformFanId: 'fan-1',
      },
      {
        pool: client,
        loadMaloumCreator: async () => ({ creator: { id: 'cr-1' } }),
        listVaultFolders: async () => [{ _id: 'folder-1' }],
        listVaultMedia: async () => [
          { media: { uploadId: 'live-upload', type: 'image' } },
          { media: { uploadId: 'sent-upload', type: 'video' } },
        ],
      }
    );

    assert.deepEqual(
      candidates.map((item) => item.mediaId),
      ['script-media', 'live-upload']
    );
    assert.equal(candidates[0].source, 'script');
    assert.equal(candidates[0].price, 20);
    assert.equal(candidates[1].source, 'vault');
    assert.equal(candidates[1].price, null);
    assert.equal(candidates[1].note, 'best seller');
  });

  it('returns empty on vault errors', async () => {
    const candidates = await loadMediaCandidates(
      { creatorId: 'cr-1', platform: 'maloum', platformFanId: 'fan-1' },
      {
        pool: {
          async query() {
            throw new Error('db down');
          },
        },
      }
    );
    assert.deepEqual(candidates, []);
  });
});
