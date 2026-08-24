const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath } = require('./dataDir');

const PLACEHOLDERS = new Set([
  '',
  'change-me-in-production',
  'your-secret-here',
  'generate-a-long-random-string',
]);

const SECRET_PATH = dataPath('jwt-secret');

function resolveJwtSecret() {
  const fromEnv = String(process.env.JWT_SECRET || '').trim();
  if (fromEnv && !PLACEHOLDERS.has(fromEnv)) {
    process.env.JWT_SECRET = fromEnv;
    return fromEnv;
  }

  try {
    const existing = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (existing) {
      process.env.JWT_SECRET = existing;
      return existing;
    }
  } catch {
    // First run or unreadable file — generate below.
  }

  const generated = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, generated, { mode: 0o600 });
  process.env.JWT_SECRET = generated;
  console.warn(
    `[auth] JWT_SECRET was missing; saved a persistent secret to ${SECRET_PATH}`
  );
  return generated;
}

module.exports = { resolveJwtSecret };
