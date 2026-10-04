const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { dataPath } = require('./dataDir');

const CACHE_DIR =
  String(process.env.FANSLY_MEDIA_CACHE_DIR || '').trim() ||
  dataPath('fansly-media-cache');

/** Preview images stay warm for a day; avoids re-pulling thumbs through the residential proxy. */
const TTL_MS = Number(process.env.FANSLY_MEDIA_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;

/** Soft cap so the cache does not grow without bound. */
const MAX_FILES = Number(process.env.FANSLY_MEDIA_CACHE_MAX_FILES) || 2000;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

let ensuredDir = false;
let purgeRunning = false;

function isCacheableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const pathName = url.split('?')[0].toLowerCase();
  if (pathName.endsWith('.mp4') || pathName.endsWith('.mov') || pathName.endsWith('.webm')) {
    return false;
  }
  return /\.(jpe?g|png|webp|gif)$/.test(pathName);
}

function cacheKey(creatorId, mediaId) {
  return crypto
    .createHash('sha256')
    .update(`${creatorId}\n${mediaId}`)
    .digest('hex');
}

function pathsFor(key) {
  return {
    bin: path.join(CACHE_DIR, `${key}.bin`),
    meta: path.join(CACHE_DIR, `${key}.json`),
  };
}

async function ensureCacheDir() {
  if (ensuredDir) return;
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  ensuredDir = true;
}

async function readCache(creatorId, mediaId) {
  if (!creatorId || !mediaId) return null;
  await ensureCacheDir();
  const { bin, meta } = pathsFor(cacheKey(creatorId, mediaId));
  try {
    const raw = await fsp.readFile(meta, 'utf8');
    const info = JSON.parse(raw);
    if (!info || !info.createdAt) return null;
    if (Date.now() - info.createdAt > TTL_MS) {
      void fsp.unlink(bin).catch(() => {});
      void fsp.unlink(meta).catch(() => {});
      return null;
    }
    const buffer = await fsp.readFile(bin);
    const now = new Date();
    void fsp.utimes(bin, now, now).catch(() => {});
    void fsp.utimes(meta, now, now).catch(() => {});
    return {
      buffer,
      contentType: info.contentType || 'application/octet-stream',
      etag: info.etag || null,
    };
  } catch {
    return null;
  }
}

async function writeCache(creatorId, mediaId, { buffer, contentType, etag, url }) {
  if (!creatorId || !mediaId || !buffer || !buffer.length) return;
  if (buffer.length > MAX_IMAGE_BYTES) return;
  if (url && !isCacheableUrl(url)) return;
  await ensureCacheDir();
  const { bin, meta } = pathsFor(cacheKey(creatorId, mediaId));
  const tmpBin = `${bin}.${process.pid}.tmp`;
  const tmpMeta = `${meta}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmpBin, buffer);
    await fsp.writeFile(
      tmpMeta,
      JSON.stringify({
        createdAt: Date.now(),
        contentType: contentType || 'application/octet-stream',
        etag: etag || null,
        mediaId,
        creatorId,
        url: url || null,
        size: buffer.length,
      })
    );
    await fsp.rename(tmpBin, bin);
    await fsp.rename(tmpMeta, meta);
    void maybePurge();
  } catch (err) {
    console.warn('Fansly media cache write failed:', err.message);
    void fsp.unlink(tmpBin).catch(() => {});
    void fsp.unlink(tmpMeta).catch(() => {});
  }
}

async function maybePurge() {
  if (purgeRunning) return;
  purgeRunning = true;
  try {
    await ensureCacheDir();
    const names = await fsp.readdir(CACHE_DIR);
    const metas = names.filter((name) => name.endsWith('.json'));
    if (metas.length <= MAX_FILES) return;

    const entries = [];
    for (const name of metas) {
      const full = path.join(CACHE_DIR, name);
      try {
        const st = await fsp.stat(full);
        entries.push({ name, mtime: st.mtimeMs });
      } catch {
        // ignore
      }
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    const toRemove = entries.slice(0, Math.max(0, entries.length - MAX_FILES));
    for (const entry of toRemove) {
      const key = entry.name.replace(/\.json$/, '');
      const { bin, meta } = pathsFor(key);
      void fsp.unlink(bin).catch(() => {});
      void fsp.unlink(meta).catch(() => {});
    }
  } catch (err) {
    console.warn('Fansly media cache purge failed:', err.message);
  } finally {
    purgeRunning = false;
  }
}

module.exports = {
  isCacheableUrl,
  readCache,
  writeCache,
  CACHE_DIR,
  TTL_MS,
};
