const pool = require('../db/pool');
const { AI_SETTING_KEYS } = require('./ai/contracts');

const UNSEND_BEFORE_MASS_KEY = 'schedule.unsend_before_mass';

let appSettingsReady = false;

function asBoolean(value, fallback = true) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

async function ensureAppSettingsTable() {
  if (appSettingsReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedByUserId" UUID REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES
       ($1, 'true'::jsonb),
       ($2, 'false'::jsonb),
       ($3, 'false'::jsonb),
       ($4, 'false'::jsonb),
       ($5, 'false'::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [
      UNSEND_BEFORE_MASS_KEY,
      AI_SETTING_KEYS.enabled,
      AI_SETTING_KEYS.shadowAllowed,
      AI_SETTING_KEYS.suggestAllowed,
      AI_SETTING_KEYS.autoSendAllowed,
    ]
  );
  appSettingsReady = true;
}

async function getUnsendBeforeMass() {
  await ensureAppSettingsTable();
  const result = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [
    UNSEND_BEFORE_MASS_KEY,
  ]);
  return asBoolean(result.rows[0]?.value, true);
}

async function setUnsendBeforeMass(enabled, userId) {
  await ensureAppSettingsTable();
  const value = Boolean(enabled);
  await pool.query(
    `INSERT INTO app_settings (key, value, "updatedByUserId")
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       "updatedAt" = NOW(),
       "updatedByUserId" = EXCLUDED."updatedByUserId"`,
    [UNSEND_BEFORE_MASS_KEY, JSON.stringify(value), userId || null]
  );
  return value;
}

const AI_FLAG_FIELDS = {
  enabled: AI_SETTING_KEYS.enabled,
  shadowAllowed: AI_SETTING_KEYS.shadowAllowed,
  suggestAllowed: AI_SETTING_KEYS.suggestAllowed,
  autoSendAllowed: AI_SETTING_KEYS.autoSendAllowed,
};

class AiFlagsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AiFlagsError';
    this.status = status;
  }
}

function userHasPermission(user, slug) {
  return (user?.permissions || []).includes(slug);
}

function toAiFlagsPayload(flags, user) {
  return {
    enabled: Boolean(flags?.enabled),
    shadowAllowed: Boolean(flags?.shadowAllowed),
    suggestAllowed: Boolean(flags?.suggestAllowed),
    autoSendAllowed: Boolean(flags?.autoSendAllowed),
    canEditAutoSend: userHasPermission(user, 'ai.autosend.enable'),
  };
}

function assertCanPatchAutoSend(user, body) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, 'autoSendAllowed')) {
    return true;
  }
  return userHasPermission(user, 'ai.autosend.enable');
}

function parseAiFlagsPatch(patch = {}) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const entries = [];
  for (const [field, key] of Object.entries(AI_FLAG_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    if (typeof value !== 'boolean') {
      throw new AiFlagsError(`${field} must be a boolean`);
    }
    entries.push({ field, key, value });
  }
  return entries;
}

async function getAiFlags() {
  await ensureAppSettingsTable();
  const keys = [
    AI_SETTING_KEYS.enabled,
    AI_SETTING_KEYS.shadowAllowed,
    AI_SETTING_KEYS.suggestAllowed,
    AI_SETTING_KEYS.autoSendAllowed,
  ];
  const result = await pool.query(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
    [keys]
  );
  const byKey = new Map(result.rows.map((row) => [row.key, row.value]));
  return {
    enabled: asBoolean(byKey.get(AI_SETTING_KEYS.enabled), false),
    shadowAllowed: asBoolean(byKey.get(AI_SETTING_KEYS.shadowAllowed), false),
    suggestAllowed: asBoolean(byKey.get(AI_SETTING_KEYS.suggestAllowed), false),
    autoSendAllowed: asBoolean(byKey.get(AI_SETTING_KEYS.autoSendAllowed), false),
  };
}

const UPSERT_AI_FLAG_SQL = `INSERT INTO app_settings (key, value, "updatedByUserId")
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       "updatedAt" = NOW(),
       "updatedByUserId" = EXCLUDED."updatedByUserId"`;

async function setAiFlags(patch, userId, deps = {}) {
  const query =
    deps.query ||
    (async (sql, params) => {
      await ensureAppSettingsTable();
      return pool.query(sql, params);
    });
  const loadFlags = deps.getAiFlags || getAiFlags;
  const entries = parseAiFlagsPatch(patch);
  for (const entry of entries) {
    await query(UPSERT_AI_FLAG_SQL, [
      entry.key,
      JSON.stringify(entry.value),
      userId || null,
    ]);
  }
  return loadFlags();
}

module.exports = {
  UNSEND_BEFORE_MASS_KEY,
  AI_SETTING_KEYS,
  AI_FLAG_FIELDS,
  AiFlagsError,
  getUnsendBeforeMass,
  setUnsendBeforeMass,
  getAiFlags,
  setAiFlags,
  parseAiFlagsPatch,
  toAiFlagsPayload,
  assertCanPatchAutoSend,
  userHasPermission,
};
