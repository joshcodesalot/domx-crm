const pool = require('../db/pool');

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
     VALUES ($1, 'true'::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [UNSEND_BEFORE_MASS_KEY]
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

module.exports = {
  UNSEND_BEFORE_MASS_KEY,
  getUnsendBeforeMass,
  setUnsendBeforeMass,
};
