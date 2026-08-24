const path = require('path');
const fs = require('fs');

const { dataPath } = require('./dataDir');

const MEDIA_DIR = dataPath('scheduled-media');

function ensureMediaDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
}

function resolveStoredPath(fileName) {
  ensureMediaDir();
  const safe = String(fileName || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 180);
  return path.join(MEDIA_DIR, safe);
}

function isInsideMediaDir(filePath) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(MEDIA_DIR);
  return resolved === root || resolved.startsWith(root + path.sep);
}

module.exports = {
  MEDIA_DIR,
  ensureMediaDir,
  resolveStoredPath,
  isInsideMediaDir,
};
