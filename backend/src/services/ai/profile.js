const pool = require('../../db/pool');

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function asObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function defaultCreatorAiProfile() {
  return {
    persona: '',
    tone: '',
    languages: [],
    biography: '',
    preferredTerminology: {},
    prohibitedClaims: [],
    salesStyle: '',
    platformRules: {},
    instructions: '',
    version: 0,
    updatedBy: null,
    updatedAt: null,
  };
}

function nextProfileVersion(row) {
  return (row?.version || 0) + 1;
}

function normalizeProfileBody(body = {}) {
  return {
    persona: asString(body.persona),
    tone: asString(body.tone),
    languages: splitList(body.languages),
    biography: asString(body.biography),
    preferredTerminology: asObject(body.preferredTerminology, {}),
    prohibitedClaims: splitList(body.prohibitedClaims),
    salesStyle: asString(body.salesStyle),
    platformRules: asObject(body.platformRules, {}),
    instructions: asString(body.instructions),
  };
}

function toProfilePayload(row) {
  if (!row) return defaultCreatorAiProfile();
  return {
    persona: row.persona || '',
    tone: row.tone || '',
    languages: Array.isArray(row.languages) ? row.languages : [],
    biography: row.biography || '',
    preferredTerminology: asObject(row.preferredTerminology, {}),
    prohibitedClaims: Array.isArray(row.prohibitedClaims)
      ? row.prohibitedClaims
      : [],
    salesStyle: row.salesStyle || '',
    platformRules: asObject(row.platformRules, {}),
    instructions: row.instructions || '',
    version: Number(row.version) || 0,
    updatedBy: row.updatedBy || null,
    updatedAt: row.updatedAt || null,
  };
}

async function getCreatorProfile(creatorId, client = pool) {
  const result = await client.query(
    `SELECT "creatorId", persona, tone, languages, biography,
            "preferredTerminology", "prohibitedClaims", "salesStyle",
            "platformRules", instructions, version, "updatedBy", "updatedAt"
     FROM ai_creator_profiles
     WHERE "creatorId" = $1`,
    [creatorId]
  );
  return toProfilePayload(result.rows[0] || null);
}

function applyProfilePatch(current, patch) {
  const next = { ...(current || defaultCreatorAiProfile()) };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'persona')) {
    next.persona = asString(patch.persona);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'tone')) {
    next.tone = asString(patch.tone);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'languages')) {
    next.languages = splitList(patch.languages);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'biography')) {
    next.biography = asString(patch.biography);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'preferredTerminology')) {
    next.preferredTerminology = asObject(patch.preferredTerminology, {});
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'salesStyle')) {
    next.salesStyle = asString(patch.salesStyle);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'instructions')) {
    next.instructions = asString(patch.instructions);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'prohibitedClaims')) {
    next.prohibitedClaims = splitList(patch.prohibitedClaims);
  }
  return next;
}

async function upsertCreatorProfile(creatorId, body, userId, client = pool) {
  const existing = await client.query(
    `SELECT version FROM ai_creator_profiles WHERE "creatorId" = $1`,
    [creatorId]
  );
  const normalized = normalizeProfileBody(body);
  const version = nextProfileVersion(existing.rows[0] || null);

  const result = await client.query(
    `INSERT INTO ai_creator_profiles (
       "creatorId", persona, tone, languages, biography,
       "preferredTerminology", "prohibitedClaims", "salesStyle",
       "platformRules", instructions, version, "updatedBy"
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12)
     ON CONFLICT ("creatorId") DO UPDATE SET
       persona = EXCLUDED.persona,
       tone = EXCLUDED.tone,
       languages = EXCLUDED.languages,
       biography = EXCLUDED.biography,
       "preferredTerminology" = EXCLUDED."preferredTerminology",
       "prohibitedClaims" = EXCLUDED."prohibitedClaims",
       "salesStyle" = EXCLUDED."salesStyle",
       "platformRules" = EXCLUDED."platformRules",
       instructions = EXCLUDED.instructions,
       version = EXCLUDED.version,
       "updatedBy" = EXCLUDED."updatedBy",
       "updatedAt" = NOW()
     RETURNING "creatorId", persona, tone, languages, biography,
               "preferredTerminology", "prohibitedClaims", "salesStyle",
               "platformRules", instructions, version, "updatedBy", "updatedAt"`,
    [
      creatorId,
      normalized.persona,
      normalized.tone,
      normalized.languages,
      normalized.biography,
      JSON.stringify(normalized.preferredTerminology),
      normalized.prohibitedClaims,
      normalized.salesStyle,
      JSON.stringify(normalized.platformRules),
      normalized.instructions,
      version,
      userId || null,
    ]
  );

  return toProfilePayload(result.rows[0]);
}

async function mergeCreatorProfile(creatorId, patch, userId, client = pool) {
  const current = await getCreatorProfile(creatorId, client);
  return upsertCreatorProfile(
    creatorId,
    applyProfilePatch(current, patch),
    userId,
    client
  );
}

module.exports = {
  defaultCreatorAiProfile,
  nextProfileVersion,
  normalizeProfileBody,
  applyProfilePatch,
  getCreatorProfile,
  upsertCreatorProfile,
  mergeCreatorProfile,
};
