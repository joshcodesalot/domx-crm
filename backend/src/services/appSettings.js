const pool = require('../db/pool');

const UNSEND_BEFORE_MASS_KEY = 'schedule.unsend_before_mass';

function asBoolean(value, fallback = true) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

async function getUnsendBeforeMass() {
  const result = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [
    UNSEND_BEFORE_MASS_KEY,
  ]);
  return asBoolean(result.rows[0]?.value, true);
}

async function setUnsendBeforeMass(enabled, userId) {
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
