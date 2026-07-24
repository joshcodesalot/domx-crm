const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const CACHE_DIR =
  process.env.FOURBASED_MEDIA_CACHE_DIR ||
  path.join(os.tmpdir(), 'domx-4based-media-cache');

/** Preview images stay warm for a day; avoids re-pulling thumbs through the residential proxy. */
const TTL_MS = Number(process.env.FOURBASED_MEDIA_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;

/** Soft cap so the cache does not grow without bound. */
const MAX_FILES = Number(process.env.FOURBASED_MEDIA_CACHE_MAX_FILES) || 2000;

let ensuredDir = false;
let purgeRunning = false;

function isCacheablePath(mediaPath) {
  if (!mediaPath || typeof mediaPath !== 'string') return false;
  const lower = mediaPath.toLowerCase();
  if (lower.includes('.mp4') || lower.includes('.mov') || lower.includes('.webm')) {
    return false;
  }
  if (lower.includes('/preview/')) return true;
  return /\.(jpe?g|png|webp|gif)$/i.test(lower);
}

function cacheKey(creatorId, mediaPath) {
  return crypto
    .createHash('sha256')
    .update(`${creatorId}\n${mediaPath}`)
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

async function readCache(creatorId, mediaPath) {
  if (!isCacheablePath(mediaPath)) return null;
  await ensureCacheDir();
  const { bin, meta } = pathsFor(cacheKey(creatorId, mediaPath));
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
    // Touch mtime for LRU-ish purge
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

async function writeCache(creatorId, mediaPath, { buffer, contentType, etag }) {
  if (!isCacheablePath(mediaPath) || !buffer || !buffer.length) return;
  // Skip very large "previews" (defensive)
  if (buffer.length > 8 * 1024 * 1024) return;
  await ensureCacheDir();
  const { bin, meta } = pathsFor(cacheKey(creatorId, mediaPath));
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
        path: mediaPath,
        creatorId,
        size: buffer.length,
      })
    );
    await fsp.rename(tmpBin, bin);
    await fsp.rename(tmpMeta, meta);
    void maybePurge();
  } catch (err) {
    console.warn('4based media cache write failed:', err.message);
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
    const metas = names.filter((n) => n.endsWith('.json'));
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
    console.warn('4based media cache purge failed:', err.message);
  } finally {
    purgeRunning = false;
  }
}

module.exports = {
  isCacheablePath,
  readCache,
  writeCache,
  CACHE_DIR,
  TTL_MS,
};
