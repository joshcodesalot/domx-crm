const { Pool } = require('pg');
require('dotenv').config();

function resolvePoolMax(raw = process.env.DATABASE_POOL_MAX) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return parsed;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: resolvePoolMax(),
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

module.exports = pool;
module.exports.resolvePoolMax = resolvePoolMax;
