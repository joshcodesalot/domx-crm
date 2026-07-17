const fs = require('fs');
const path = require('path');

const AVATARS_DIR = path.join(__dirname, '../../data/avatars');
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function ensureAvatarsDir() {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

function extensionFromContentType(contentType) {
  if (!contentType) {
    return null;
  }
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[normalized] || null;
}

function removeExistingAvatars(creatorId) {
  ensureAvatarsDir();
  const prefix = `${creatorId}.`;
  for (const file of fs.readdirSync(AVATARS_DIR)) {
    if (file.startsWith(prefix)) {
      fs.unlinkSync(path.join(AVATARS_DIR, file));
    }
  }
}

/**
 * Persist a client-provided avatar image for a creator.
 * Returns the served avatar path (e.g. /uploads/avatars/{id}.jpg).
 *
 * Images must be fetched on the client (Electron) so the backend never
 * contacts Maloum or other remote hosts.
 */
function saveCreatorAvatarFromBuffer(creatorId, buffer, contentType) {
  if (!creatorId) {
    throw new Error('Creator ID is required');
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Avatar image data is required');
  }

  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new Error('Avatar image is too large (max 4MB)');
  }

  const ext = extensionFromContentType(contentType);
  if (!ext) {
    throw new Error('Unsupported avatar image type');
  }

  ensureAvatarsDir();
  removeExistingAvatars(creatorId);

  const fileName = `${creatorId}.${ext}`;
  const filePath = path.join(AVATARS_DIR, fileName);
  fs.writeFileSync(filePath, buffer);

  return `/uploads/avatars/${fileName}`;
}

module.exports = {
  AVATARS_DIR,
  MAX_AVATAR_BYTES,
  saveCreatorAvatarFromBuffer,
};
