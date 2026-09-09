const pool = require('../../db/pool');

const MEMORY_PLATFORMS = ['maloum', '4based', 'telegram'];
const FACT_KINDS = ['name', 'preference', 'boundary', 'spend', 'other'];
const FACT_KIND_SET = new Set(FACT_KINDS);
const MAX_FACTS = 20;
const MAX_FACT_TEXT = 300;

const SECRET_KEYS = new Set([
  'encryptedloginpassword',
  'accesstoken',
  'refreshtoken',
  'proxy',
  'customproxy',
  'token',
  'password',
  'cookies',
  'cookie',
  'jwt',
]);

function isSecretKey(key) {
  return SECRET_KEYS.has(String(key || '').toLowerCase());
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function emptyMemory({ creatorId, platform, platformFanId } = {}) {
  return {
    id: null,
    creatorId: creatorId || null,
    platform: platform || null,
    platformFanId: platformFanId || null,
    nickname: null,
    facts: [],
    sourceNotes: null,
    sourceNotesAt: null,
    updatedAt: null,
  };
}

function normalizeFacts(facts) {
  if (!Array.isArray(facts)) return [];
  const out = [];
  for (const raw of facts) {
    if (!raw || typeof raw !== 'object') continue;
    if (Object.keys(raw).some((key) => isSecretKey(key))) continue;
    const kind = FACT_KIND_SET.has(raw.kind) ? raw.kind : 'other';
    if (isSecretKey(kind)) continue;
    const text = asText(raw.text).trim().slice(0, MAX_FACT_TEXT);
    if (!text) continue;
    out.push({ kind, text });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

function toMemoryDto(row, fallback = {}) {
  if (!row) return emptyMemory(fallback);
  return {
    id: row.id || null,
    creatorId: row.creatorId || fallback.creatorId || null,
    platform: row.platform || fallback.platform || null,
    platformFanId: row.platformFanId || fallback.platformFanId || null,
    nickname: asText(row.nickname).trim() || null,
    facts: normalizeFacts(row.facts),
    sourceNotes: asText(row.sourceNotes).trim() || null,
    sourceNotesAt: row.sourceNotesAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function memoryKey({ creatorId, platform, platformFanId } = {}) {
  const id = String(creatorId || '').trim();
  const plat = String(platform || '').trim();
  const fanId = String(platformFanId || '').trim();
  if (!id || !MEMORY_PLATFORMS.includes(plat) || !fanId) return null;
  return { creatorId: id, platform: plat, platformFanId: fanId };
}

async function getFanMemory(input = {}, client = pool) {
  const key = memoryKey(input);
  if (!key) return emptyMemory(input);
  const result = await client.query(
    `SELECT id, "creatorId", platform, "platformFanId", nickname, facts,
            "sourceNotes", "sourceNotesAt", "updatedAt"
     FROM ai_fan_memories
     WHERE "creatorId" = $1 AND platform = $2 AND "platformFanId" = $3`,
    [key.creatorId, key.platform, key.platformFanId]
  );
  return toMemoryDto(result.rows[0] || null, key);
}

async function upsertFanMemory(input = {}, client = pool) {
  const key = memoryKey(input);
  if (!key) return emptyMemory(input);

  const hasFacts = Array.isArray(input.facts);
  const facts = hasFacts ? normalizeFacts(input.facts) : [];
  const nickname =
    input.nickname == null ? null : asText(input.nickname).trim() || null;
  const sourceNotes =
    input.sourceNotes == null ? null : asText(input.sourceNotes).trim() || null;

  const result = await client.query(
    `INSERT INTO ai_fan_memories (
       "creatorId", platform, "platformFanId", nickname, facts,
       "sourceNotes", "sourceNotesAt"
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, CASE WHEN $6 IS NOT NULL THEN NOW() ELSE NULL END)
     ON CONFLICT ("creatorId", platform, "platformFanId") DO UPDATE SET
       nickname = COALESCE(EXCLUDED.nickname, ai_fan_memories.nickname),
       facts = CASE WHEN $7 THEN EXCLUDED.facts ELSE ai_fan_memories.facts END,
       "sourceNotes" = COALESCE(ai_fan_memories."sourceNotes", EXCLUDED."sourceNotes"),
       "sourceNotesAt" = COALESCE(ai_fan_memories."sourceNotesAt", EXCLUDED."sourceNotesAt"),
       "updatedAt" = NOW()
     RETURNING id, "creatorId", platform, "platformFanId", nickname, facts,
               "sourceNotes", "sourceNotesAt", "updatedAt"`,
    [
      key.creatorId,
      key.platform,
      key.platformFanId,
      nickname,
      JSON.stringify(facts),
      sourceNotes,
      hasFacts,
    ]
  );
  return toMemoryDto(result.rows[0], key);
}

async function maybeCopySourceNotes(input = {}, client = pool) {
  const key = memoryKey(input);
  const notes = asText(input.notes).trim();
  if (!key || !notes) return getFanMemory(input, client);

  const result = await client.query(
    `INSERT INTO ai_fan_memories (
       "creatorId", platform, "platformFanId", "sourceNotes", "sourceNotesAt"
     )
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT ("creatorId", platform, "platformFanId") DO UPDATE SET
       "sourceNotes" = COALESCE(NULLIF(ai_fan_memories."sourceNotes", ''), EXCLUDED."sourceNotes"),
       "sourceNotesAt" = CASE
         WHEN ai_fan_memories."sourceNotes" IS NULL OR ai_fan_memories."sourceNotes" = ''
         THEN EXCLUDED."sourceNotesAt"
         ELSE ai_fan_memories."sourceNotesAt"
       END,
       "updatedAt" = CASE
         WHEN ai_fan_memories."sourceNotes" IS NULL OR ai_fan_memories."sourceNotes" = ''
         THEN NOW()
         ELSE ai_fan_memories."updatedAt"
       END
     RETURNING id, "creatorId", platform, "platformFanId", nickname, facts,
               "sourceNotes", "sourceNotesAt", "updatedAt"`,
    [key.creatorId, key.platform, key.platformFanId, notes]
  );
  return toMemoryDto(result.rows[0], key);
}

async function loadOptionalPlatformNotes(input = {}, client = pool) {
  const platform = String(input.platform || '').trim();
  const platformFanId = String(input.platformFanId || '').trim();
  if (platform !== 'telegram' || !platformFanId) return null;

  const result = await client.query(
    `SELECT notes FROM telegram_fan_notes WHERE "telegramUserId" = $1`,
    [platformFanId]
  );
  const notes = asText(result.rows[0]?.notes).trim();
  return notes || null;
}

module.exports = {
  MEMORY_PLATFORMS,
  FACT_KINDS,
  MAX_FACTS,
  MAX_FACT_TEXT,
  emptyMemory,
  normalizeFacts,
  toMemoryDto,
  getFanMemory,
  upsertFanMemory,
  maybeCopySourceNotes,
  loadOptionalPlatformNotes,
};
