const crypto = require('crypto');
const pool = require('../db/pool');
const { skipsGermanTranslation } = require('./germanTranslationPolicy');

const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';
const SOURCE_LANG = 'de';
const TARGET_LANG = 'en';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, digits) => {
      const code = Number(digits);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&([a-z]+);/gi, (entity, name) => {
      const mapped = NAMED_ENTITIES[String(name).toLowerCase()];
      return mapped == null ? entity : mapped;
    });
}

function normalizeSource(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sourceHash(text) {
  const normalized = normalizeSource(text);
  return crypto
    .createHash('sha256')
    .update(`${SOURCE_LANG}|${TARGET_LANG}|${normalized}`)
    .digest('hex');
}

async function lookupCache(hash, query) {
  const result = await query(
    `SELECT "translatedText" FROM translation_cache WHERE "sourceHash" = $1`,
    [hash]
  );
  const translated = result.rows[0]?.translatedText;
  return typeof translated === 'string' && translated.trim() ? translated : null;
}

async function storeCache(hash, sourceText, translatedText, query) {
  await query(
    `INSERT INTO translation_cache (
       "sourceHash", "sourceLang", "targetLang", "sourceText", "translatedText"
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ("sourceHash") DO NOTHING`,
    [hash, SOURCE_LANG, TARGET_LANG, sourceText, translatedText]
  );
}

/**
 * German to English via Cloud Translation API v2.
 * Identical source text is served from translation_cache.
 * deps.query / deps.fetch are test seams. Missing API key throws.
 */
async function translateDeToEn(text, deps = {}) {
  const source = normalizeSource(text);
  if (!source) return '';

  const query = deps.query || ((sql, params) => pool.query(sql, params));
  const fetchImpl = deps.fetch || fetch;
  const hash = sourceHash(source);
  const cached = await lookupCache(hash, query);
  if (cached) return cached;

  const apiKey = String(deps.apiKey ?? process.env.GOOGLE_TRANSLATE_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('GOOGLE_TRANSLATE_API_KEY is not set');
  }

  const response = await fetchImpl(GOOGLE_TRANSLATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
    },
    body: JSON.stringify({
      q: source,
      source: SOURCE_LANG,
      target: TARGET_LANG,
      format: 'text',
    }),
  });
  if (!response.ok) {
    throw new Error(`Google Translation API failed with status ${response.status}`);
  }
  const data = await response.json();
  const translated = decodeHtmlEntities(
    data?.data?.translations?.[0]?.translatedText || ''
  ).trim();
  if (!translated) {
    throw new Error('Google Translation API returned empty text');
  }
  try {
    await storeCache(hash, source, translated, query);
  } catch (err) {
    console.warn('[googleTranslate] cache:', err.message);
  }
  return translated;
}

async function translateTextForPlatform(text, platform, deps) {
  const original = String(text || '').trim();
  if (!original) return '';
  if (skipsGermanTranslation(platform)) return original;
  return translateDeToEn(original, deps);
}

module.exports = {
  decodeHtmlEntities,
  normalizeSource,
  sourceHash,
  translateDeToEn,
  translateTextForPlatform,
};
