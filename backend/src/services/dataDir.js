const fs = require('fs');
const path = require('path');

const DATA_SUBDIRS = [
  'avatars',
  'telegram',
  'telegram-fans',
  'telegram-vault',
  'scheduled-media',
  'maloum-media-cache',
  '4based-media-cache',
];

function getDataDir() {
  const fromEnv = String(process.env.DOMX_DATA_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(__dirname, '../../data');
}

function dataPath(...parts) {
  return path.join(getDataDir(), ...parts);
}

function ensureDataDirs() {
  const root = getDataDir();
  fs.mkdirSync(root, { recursive: true });
  for (const name of DATA_SUBDIRS) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
}

module.exports = {
  DATA_SUBDIRS,
  getDataDir,
  dataPath,
  ensureDataDirs,
};
