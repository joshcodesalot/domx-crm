const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeHtmlEntities,
  normalizeSource,
  sourceHash,
  translateDeToEn,
  translateTextForPlatform,
} = require('./googleTranslate');

describe('google translate', () => {
  const originalKey = process.env.GOOGLE_TRANSLATE_API_KEY;

  beforeEach(() => {
    delete process.env.GOOGLE_TRANSLATE_API_KEY;
  });

  afterEach(() => {
    if (originalKey == null) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = originalKey;
  });

  it('decodes the entities Google returns for plain text', () => {
    assert.equal(
      decodeHtmlEntities('It&#39;s &amp; &quot;ok&quot; &lt;3'),
      'It\'s & "ok" <3'
    );
  });

  it('hashes the same German text once', () => {
    assert.equal(sourceHash('  hallo   du '), sourceHash(normalizeSource('hallo du')));
    assert.notEqual(sourceHash('hallo'), sourceHash('hello'));
  });

  it('returns cached English without calling Google', async () => {
    let fetched = false;
    const translated = await translateDeToEn('hallo', {
      query: async () => ({ rows: [{ translatedText: 'hello' }] }),
      fetch: async () => {
        fetched = true;
        throw new Error('should not fetch');
      },
    });
    assert.equal(translated, 'hello');
    assert.equal(fetched, false);
  });

  it('throws when the API key is missing', async () => {
    let fetched = false;
    await assert.rejects(
      () =>
        translateDeToEn('hallo', {
          query: async () => ({ rows: [] }),
          fetch: async () => {
            fetched = true;
            throw new Error('should not fetch');
          },
        }),
      /GOOGLE_TRANSLATE_API_KEY is not set/
    );
    assert.equal(fetched, false);
  });

  it('stores a decoded Google result', async () => {
    const inserts = [];
    const translated = await translateDeToEn("wie geht's", {
      apiKey: 'test-key',
      query: async (sql, params) => {
        if (String(sql).includes('INSERT')) inserts.push(params);
        return { rows: [] };
      },
      fetch: async (_url, init) => {
        assert.equal(init.headers['X-Goog-Api-Key'], 'test-key');
        const body = JSON.parse(init.body);
        assert.deepEqual(body, {
          q: "wie geht's",
          source: 'de',
          target: 'en',
          format: 'text',
        });
        return {
          ok: true,
          json: async () => ({
            data: { translations: [{ translatedText: 'how&#39;s it going' }] },
          }),
        };
      },
    });
    assert.equal(translated, "how's it going");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0][3], "wie geht's");
    assert.equal(inserts[0][4], "how's it going");
  });

  it('returns Fansly text without calling Google', async () => {
    let fetched = false;
    const translated = await translateTextForPlatform('hey babe', 'fansly', {
      fetch: async () => {
        fetched = true;
        throw new Error('should not fetch');
      },
    });
    assert.equal(translated, 'hey babe');
    assert.equal(fetched, false);
  });
});
