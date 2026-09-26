const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_ARCHIVE_BYTES = 180 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

const SKIP_DIR_NAMES = new Set([
  'cache',
  'code cache',
  'gpucache',
  'shadercache',
  'grshadercache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'crashpad',
  'browsermetrics',
  'optimization_guide_model_store',
  'graphitedawncache',
  'safe browsing',
  'crowd deny',
]);

const SKIP_FILE_NAMES = new Set([
  'singletonlock',
  'singletonsocket',
  'singletoncookie',
  'lockfile',
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const year = Math.max(d.getFullYear() - 1980, 0);
  const day = (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: day };
}

function shouldSkipRelative(relPath) {
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  if (parts.some((part) => SKIP_DIR_NAMES.has(part.toLowerCase()))) {
    return true;
  }
  const base = parts[parts.length - 1] || '';
  return SKIP_FILE_NAMES.has(base.toLowerCase());
}

function isSafeZipName(name) {
  if (!name || typeof name !== 'string') return false;
  const normalized = name.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  return normalized.split('/').every((part) => part && part !== '..');
}

function walkFiles(root, current, out) {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(current, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (shouldSkipRelative(rel)) {
      continue;
    }
    if (entry.isDirectory()) {
      walkFiles(root, abs, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    out.push({ abs, name: rel });
  }
}

function localHeader(meta, nameBuf) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(meta.method, 8);
  header.writeUInt16LE(meta.time, 10);
  header.writeUInt16LE(meta.date, 12);
  header.writeUInt32LE(meta.crc, 14);
  header.writeUInt32LE(meta.compressedSize, 18);
  header.writeUInt32LE(meta.uncompressedSize, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(meta, nameBuf) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x800, 8);
  header.writeUInt16LE(meta.method, 10);
  header.writeUInt16LE(meta.time, 12);
  header.writeUInt16LE(meta.date, 14);
  header.writeUInt32LE(meta.crc, 16);
  header.writeUInt32LE(meta.compressedSize, 20);
  header.writeUInt32LE(meta.uncompressedSize, 24);
  header.writeUInt16LE(nameBuf.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(meta.offset, 42);
  return header;
}

function packProfile(root) {
  const files = [];
  if (fs.existsSync(root)) {
    walkFiles(root, root, files);
  }
  const stamp = dosDateTime(new Date());
  const parts = [];
  const records = [];
  let offset = 0;
  let total = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.abs);
    total += data.length;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new Error('Profile archive is too large');
    }
    const deflated = zlib.deflateRawSync(data);
    const method = deflated.length < data.length ? 8 : 0;
    const compressed = method === 8 ? deflated : data;
    const nameBuf = Buffer.from(file.name, 'utf8');
    const meta = {
      method,
      time: stamp.time,
      date: stamp.date,
      crc: crc32(data),
      compressedSize: compressed.length,
      uncompressedSize: data.length,
      offset,
    };
    const header = localHeader(meta, nameBuf);
    parts.push(header, nameBuf, compressed);
    offset += header.length + nameBuf.length + compressed.length;
    records.push({ meta, nameBuf });
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const record of records) {
    const header = centralHeader(record.meta, record.nameBuf);
    parts.push(header, record.nameBuf);
    cdSize += header.length + record.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  return Buffer.concat(parts);
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  throw new Error('Profile archive is not a zip file');
}

function unpackProfile(buffer, root) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) {
    throw new Error('Profile archive is empty');
  }
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 8);
  let cursor = buf.readUInt32LE(eocd + 16);
  fs.mkdirSync(root, { recursive: true });
  const rootResolved = path.resolve(root);
  let uncompressedTotal = 0;

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Profile archive is not a zip file');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) {
      continue;
    }
    if (!isSafeZipName(name)) {
      throw new Error('Profile archive contains an unsafe path');
    }
    if (method !== 0 && method !== 8) {
      throw new Error('Profile archive uses an unsupported compression method');
    }

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    if (data.length !== uncompressedSize) {
      throw new Error('Profile archive entry is corrupt');
    }
    uncompressedTotal += data.length;
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Profile archive is too large');
    }

    const dest = path.resolve(rootResolved, ...name.split('/'));
    if (dest !== rootResolved && !dest.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error('Profile archive contains an unsafe path');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  SKIP_DIR_NAMES,
  packProfile,
  unpackProfile,
  isSafeZipName,
  shouldSkipRelative,
};
