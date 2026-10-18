const fs = require('fs');
const path = require('path');

const PARTIAL_SUFFIX = '.partial';

function partialPathFor(destPath) {
  return `${destPath}${PARTIAL_SUFFIX}`;
}

function isServableCacheFile(filePath) {
  if (!filePath || String(filePath).endsWith(PARTIAL_SUFFIX)) return false;
  try {
    return Boolean(fs.existsSync(filePath) && fs.statSync(filePath).size);
  } catch {
    return false;
  }
}

function parseByteRange(rangeHeader, size) {
  if (!rangeHeader || typeof rangeHeader !== 'string' || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start == null && end == null) return null;
  if (start == null) {
    const suffix = end;
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) return null;
    if (end == null || !Number.isFinite(end)) end = size - 1;
    if (end >= size) end = size - 1;
    if (start > end) return null;
  }
  return { start, end };
}

function safeFilename(name) {
  const cleaned = String(name || 'video').replace(/[\r\n"]/g, '');
  return cleaned || 'video';
}

function notify(session) {
  for (const waiter of [...session.waiters]) waiter();
}

function waitForByte(session, offset, res) {
  if (session.bytesWritten > offset || session.done || res.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const wake = () => {
      if (session.bytesWritten > offset || session.done || res.destroyed) {
        session.waiters.delete(wake);
        res.off('close', wake);
        resolve();
      }
    };
    session.waiters.add(wake);
    res.on('close', wake);
  });
}

async function renameWhenFree(from, to) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  fs.renameSync(from, to);
}

async function readSlice(session, pos, end) {
  const len = end - pos + 1;
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const filePath = session.renamed ? session.destPath : session.partialPath;
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, pos + got);
        if (n === 0) break;
        got += n;
      }
      if (got === len) return buf;
      lastErr = new Error('Media read was short');
    } catch (err) {
      lastErr = err;
      if (
        err.code !== 'ENOENT' &&
        err.code !== 'EPERM' &&
        err.code !== 'EBUSY' &&
        err.code !== 'EACCES'
      ) {
        throw err;
      }
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw lastErr || new Error('Failed to read media');
}

function writeBody(res, buf) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  let ok = true;
  try {
    ok = res.write(buf);
  } catch {
    return Promise.resolve(false);
  }
  if (ok !== false) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (cont) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(cont);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

function startProgressiveDownload({ destPath, totalSize, iterate }) {
  if (!Number.isInteger(totalSize) || totalSize <= 0) {
    throw new Error('Invalid media size');
  }
  const partialPath = partialPathFor(destPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    fs.unlinkSync(partialPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const session = {
    destPath,
    partialPath,
    totalSize,
    bytesWritten: 0,
    done: false,
    renamed: false,
    error: null,
    waiters: new Set(),
    finished: null,
  };

  session.finished = (async () => {
    let handle = null;
    try {
      handle = await fs.promises.open(partialPath, 'w');
      for await (const chunk of iterate()) {
        const buf = Buffer.from(chunk);
        if (!buf.length) continue;
        let offset = 0;
        while (offset < buf.length) {
          const written = await handle.write(buf.subarray(offset));
          const n = typeof written === 'number' ? written : written?.bytesWritten;
          if (!n) {
            throw new Error('Failed to write media');
          }
          offset += n;
        }
        session.bytesWritten += offset;
        notify(session);
        if (session.bytesWritten > totalSize) {
          throw new Error('Download exceeded the expected file size');
        }
      }
      if (session.bytesWritten !== totalSize) {
        throw new Error('Download ended before the full file arrived');
      }
      await handle.close();
      handle = null;
      await renameWhenFree(partialPath, destPath);
      session.renamed = true;
      session.done = true;
      notify(session);
      return { error: null };
    } catch (err) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // ignore
        }
      }
      try {
        fs.unlinkSync(partialPath);
      } catch {
        // ignore
      }
      session.error = err;
      session.done = true;
      notify(session);
      return { error: err };
    }
  })();

  return session;
}

function rangeResponse(rangeHeader, total) {
  if (!rangeHeader || typeof rangeHeader !== 'string' || !rangeHeader.trim()) {
    return { start: 0, end: total - 1, ranged: false };
  }
  const parsed = parseByteRange(rangeHeader, total);
  if (!parsed) {
    if (/^bytes=/i.test(rangeHeader.trim())) return { unsatisfiable: true };
    return { start: 0, end: total - 1, ranged: false };
  }
  return { start: parsed.start, end: parsed.end, ranged: true };
}

async function pipeProgressiveMedia(res, session, { rangeHeader, mimeType, filename } = {}) {
  if (session.done && session.error && session.bytesWritten === 0) {
    throw session.error;
  }
  const total = session.totalSize;
  const range = rangeResponse(rangeHeader, total);
  if (range.unsatisfiable) {
    res.writeHead(416, {
      'Content-Range': `bytes */${total}`,
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end();
    return;
  }

  const headers = {
    'Content-Type': mimeType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `inline; filename="${safeFilename(filename)}"`,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Length': String(range.end - range.start + 1),
  };
  if (range.ranged) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
  }
  res.writeHead(range.ranged ? 206 : 200, headers);

  let pos = range.start;
  try {
    while (pos <= range.end) {
      if (res.destroyed || res.writableEnded) return;
      await waitForByte(session, pos, res);
      if (res.destroyed || res.writableEnded) return;
      if (session.bytesWritten <= pos) {
        throw session.error || new Error('Failed to download media');
      }
      const sliceEnd = Math.min(range.end, session.bytesWritten - 1);
      const slice = await readSlice(session, pos, sliceEnd);
      const cont = await writeBody(res, slice);
      if (!cont) return;
      pos += slice.length;
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (err) {
    if (res.headersSent) {
      if (!res.destroyed) res.destroy(err);
      return;
    }
    throw err;
  }
}

module.exports = {
  PARTIAL_SUFFIX,
  partialPathFor,
  isServableCacheFile,
  parseByteRange,
  startProgressiveDownload,
  pipeProgressiveMedia,
};
