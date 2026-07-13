const fs = require('fs');
const path = require('path');

const AVATARS_DIR = path.join(__dirname, '../../data/avatars');

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
    return 'jpg';
  }
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[normalized] || 'jpg';
}

function extensionFromUrl(sourceUrl) {
  try {
    const pathname = new URL(sourceUrl).pathname;
    const match = pathname.match(/\.(jpe?g|png|webp|gif)(?:$|\?)/i);
    if (match) {
      return match[1].toLowerCase().replace('jpeg', 'jpg');
    }
  } catch {
    // ignore invalid URLs
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
 * Download a Maloum profile image and save it locally for a creator.
 * Returns the served avatar path (e.g. /uploads/avatars/{id}.jpg).
 */
async function downloadCreatorAvatar(creatorId, sourceUrl) {
  if (!creatorId || !sourceUrl) {
    throw new Error('Creator ID and source URL are required');
  }

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error('Invalid source URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Source URL must be http or https');
  }

  const response = await fetch(sourceUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download avatar (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error('Downloaded content is not an image');
  }

  const ext =
    extensionFromContentType(contentType) ||
    extensionFromUrl(sourceUrl) ||
    'jpg';

  ensureAvatarsDir();
  removeExistingAvatars(creatorId);

  const fileName = `${creatorId}.${ext}`;
  const filePath = path.join(AVATARS_DIR, fileName);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  return `/uploads/avatars/${fileName}`;
}

module.exports = {
  AVATARS_DIR,
  downloadCreatorAvatar,
};
