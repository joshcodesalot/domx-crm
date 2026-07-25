const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const CACHE_DIR =
  process.env.FOURBASED_MEDIA_CACHE_DIR ||
  path.join(os.tmpdir(), 'domx-4based-media-cache');

/** Media is immutable; keep warm for a week by default. */
const TTL_MS =
  Number(process.env.FOURBASED_MEDIA_CACHE_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

/** Soft byte cap so the cache does not grow without bound (~10 GB). */
const MAX_BYTES =
  Number(process.env.FOURBASED_MEDIA_CACHE_MAX_BYTES) || 10 * 1024 * 1024 * 1024;

/** Per-file size caps. */
const MAX_IMAGE_BYTES =
  Number(process.env.FOURBASED_MEDIA_CACHE_MAX_IMAGE_BYTES) || 8 * 1024 * 1024;
const MAX_VIDEO_BYTES =
  Number(process.env.FOURBASED_MEDIA_CACHE_MAX_VIDEO_BYTES) || 512 * 1024 * 1024;

let ensuredDir = false;
let purgeRunning = false;

function isVideoPath(mediaPath) {
  if (!mediaPath || typeof mediaPath !== 'string') return false;
  const lower = mediaPath.toLowerCase();
  return (
    lower.includes('.mp4') ||
    lower.includes('.mov') ||
    lower.includes('.webm') ||
    lower.endsWith('/file.mp4') ||
    /\/video\/[^/]+\.mp4$/i.test(lower)
  );
}

function isCacheablePath(mediaPath) {
  if (!mediaPath || typeof mediaPath !== 'string') return false;
  const lower = mediaPath.toLowerCase();
  if (lower.includes('/preview/')) return true;
  if (isVideoPath(lower)) return true;
  return /\.(jpe?g|png|webp|gif)$/i.test(lower);
}

function maxBytesForPath(mediaPath) {
  return isVideoPath(mediaPath) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
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

async function touchFiles(bin, meta) {
  const now = new Date();
  void fsp.utimes(bin, now, now).catch(() => {});
  void fsp.utimes(meta, now, now).catch(() => {});
}

async function readMeta(creatorId, mediaPath) {
  if (!isCacheablePath(mediaPath)) return null;
  await ensureCacheDir();
  const key = cacheKey(creatorId, mediaPath);
  const { bin, meta } = pathsFor(key);
  try {
    const raw = await fsp.readFile(meta, 'utf8');
    const info = JSON.parse(raw);
    if (!info || !info.createdAt) return null;
    if (Date.now() - info.createdAt > TTL_MS) {
      void fsp.unlink(bin).catch(() => {});
      void fsp.unlink(meta).catch(() => {});
      return null;
    }
    const st = await fsp.stat(bin);
    if (!st.isFile() || st.size <= 0) return null;
    await touchFiles(bin, meta);
    return {
      key,
      binPath: bin,
      metaPath: meta,
      size: st.size,
      contentType: info.contentType || 'application/octet-stream',
      etag: info.etag || null,
      createdAt: info.createdAt,
    };
  } catch {
    return null;
  }
}

/** Returns { buffer, contentType, etag } for small files (images). */
async function readCache(creatorId, mediaPath) {
  const info = await readMeta(creatorId, mediaPath);
  if (!info) return null;
  try {
    const buffer = await fsp.readFile(info.binPath);
    return {
      buffer,
      contentType: info.contentType,
      etag: info.etag,
    };
  } catch {
    return null;
  }
}

/**
 * Returns disk path + metadata so large videos can be streamed / ranged
 * without loading the whole file into memory.
 */
async function readCachePath(creatorId, mediaPath) {
  return readMeta(creatorId, mediaPath);
}

async function writeCache(creatorId, mediaPath, { buffer, contentType, etag }) {
  if (!isCacheablePath(mediaPath) || !buffer || !buffer.length) return;
  if (buffer.length > maxBytesForPath(mediaPath)) return;
  await ensureCacheDir();
  const { bin, meta } = pathsFor(cacheKey(creatorId, mediaPath));
  const tmpBin = `${bin}.${process.pid}.${Date.now()}.tmp`;
  const tmpMeta = `${meta}.${process.pid}.${Date.now()}.tmp`;
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

/**
 * Atomically commit a temp file already written to disk into the cache.
 * Used by the media route's tee-to-disk path for large videos.
 */
async function commitTempFile(
  creatorId,
  mediaPath,
  tmpBinPath,
  { contentType, etag, size } = {}
) {
  if (!isCacheablePath(mediaPath) || !tmpBinPath) return false;
  const fileSize = Number(size) || 0;
  if (fileSize <= 0 || fileSize > maxBytesForPath(mediaPath)) {
    void fsp.unlink(tmpBinPath).catch(() => {});
    return false;
  }
  await ensureCacheDir();
  const { bin, meta } = pathsFor(cacheKey(creatorId, mediaPath));
  const tmpMeta = `${meta}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(
      tmpMeta,
      JSON.stringify({
        createdAt: Date.now(),
        contentType: contentType || 'application/octet-stream',
        etag: etag || null,
        path: mediaPath,
        creatorId,
        size: fileSize,
      })
    );
    await fsp.rename(tmpBinPath, bin);
    await fsp.rename(tmpMeta, meta);
    void maybePurge();
    return true;
  } catch (err) {
    console.warn('4based media cache commit failed:', err.message);
    void fsp.unlink(tmpBinPath).catch(() => {});
    void fsp.unlink(tmpMeta).catch(() => {});
    return false;
  }
}

function tempDownloadPath(creatorId, mediaPath) {
  const key = cacheKey(creatorId, mediaPath);
  return path.join(
    CACHE_DIR,
    `${key}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.download`
  );
}

async function maybePurge() {
  if (purgeRunning) return;
  purgeRunning = true;
  try {
    await ensureCacheDir();
    const names = await fsp.readdir(CACHE_DIR);
    const metas = names.filter((n) => n.endsWith('.json'));
    const entries = [];
    let totalBytes = 0;

    for (const name of metas) {
      const key = name.replace(/\.json$/, '');
      const { bin, meta } = pathsFor(key);
      try {
        const [stBin, stMeta] = await Promise.all([
          fsp.stat(bin),
          fsp.stat(meta),
        ]);
        const size = stBin.size || 0;
        totalBytes += size;
        entries.push({
          key,
          bin,
          meta,
          mtime: Math.max(stBin.mtimeMs || 0, stMeta.mtimeMs || 0),
          size,
        });
      } catch {
        // ignore missing pairs
      }
    }

    if (totalBytes <= MAX_BYTES) return;

    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (totalBytes <= MAX_BYTES) break;
      void fsp.unlink(entry.bin).catch(() => {});
      void fsp.unlink(entry.meta).catch(() => {});
      totalBytes -= entry.size;
    }
  } catch (err) {
    console.warn('4based media cache purge failed:', err.message);
  } finally {
    purgeRunning = false;
  }
}

module.exports = {
  isCacheablePath,
  isVideoPath,
  readCache,
  readCachePath,
  writeCache,
  commitTempFile,
  tempDownloadPath,
  CACHE_DIR,
  TTL_MS,
  MAX_BYTES,
  maxBytesForPath,
};
