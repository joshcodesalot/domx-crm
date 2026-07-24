const fs = require('fs');
const path = require('path');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const AVATARS_DIR = path.join(__dirname, '../../data/avatars');
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const EXT_BY_PATH = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
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

function contentTypeFromUrl(imageUrl) {
  try {
    const pathname = new URL(imageUrl).pathname.toLowerCase();
    for (const [ext, mime] of Object.entries(EXT_BY_PATH)) {
      if (pathname.endsWith(ext)) {
        return mime;
      }
    }
  } catch {
    // ignore
  }
  return null;
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
 * Persist an avatar image buffer for a creator.
 * Returns the served avatar path (e.g. /uploads/avatars/{id}.jpg).
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

/**
 * Download a remote Maloum avatar URL through the residential proxy and cache it locally.
 */
async function cacheCreatorAvatarFromUrl(creatorId, imageUrl, { proxyUrl } = {}) {
  if (!creatorId) {
    throw new Error('Creator ID is required');
  }
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new Error('Avatar image URL is required');
  }
  if (!proxyUrl || typeof proxyUrl !== 'string') {
    throw new Error('Maloum proxy is required to cache avatar');
  }

  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error('Avatar image URL is invalid');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Avatar image URL must be http(s)');
  }

  const dispatcher = new ProxyAgent(proxyUrl.trim());
  let response;
  try {
    response = await undiciFetch(imageUrl, {
      method: 'GET',
      headers: {
        accept: 'image/*,*/*',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      },
      dispatcher,
      maxRedirections: 3,
    });
  } catch (err) {
    const detail = err?.cause?.message || err?.message || 'connection error';
    throw new Error(`Failed to download avatar (${detail})`);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to download avatar (HTTP ${response.status})`);
  }

  const headerType = response.headers.get('content-type');
  const contentType =
    (headerType && extensionFromContentType(headerType) ? headerType.split(';')[0].trim() : null) ||
    contentTypeFromUrl(imageUrl) ||
    'image/jpeg';

  if (!extensionFromContentType(contentType)) {
    throw new Error('Unsupported avatar image type');
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return saveCreatorAvatarFromBuffer(creatorId, buffer, contentType);
}

module.exports = {
  AVATARS_DIR,
  MAX_AVATAR_BYTES,
  saveCreatorAvatarFromBuffer,
  cacheCreatorAvatarFromUrl,
};
