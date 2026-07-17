const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
  const keyB64 = process.env.ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }

  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }

  return key;
}

function encryptJson(obj) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(obj);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptJson(buffer) {
  const key = getEncryptionKey();
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateAccountToken() {
  return crypto.randomBytes(32).toString('hex');
}

function encryptSecret(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value);
  if (!normalized) {
    return null;
  }
  return encryptJson({ v: normalized });
}

function decryptSecret(buffer) {
  if (!buffer) {
    return null;
  }
  const payload = decryptJson(buffer);
  return typeof payload?.v === 'string' ? payload.v : null;
}

module.exports = {
  encryptJson,
  decryptJson,
  encryptSecret,
  decryptSecret,
  hashToken,
  generateAccountToken,
};
