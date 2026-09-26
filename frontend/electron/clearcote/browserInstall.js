const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { findClearcoteExecutable } = require('./launchArgs');

const FEED_URL = 'https://domx-agency.com/crm-updates/';
const ZIP_NAME = 'Clearcote-win-x64.zip';
const SHA_NAME = 'Clearcote-win-x64.sha256';
const ZIP_URL = `${FEED_URL}${ZIP_NAME}`;
const SHA_URL = `${FEED_URL}${SHA_NAME}`;
const MARKER_NAME = 'installed.sha256';

const DOWNLOAD_FAILED_MESSAGE =
  'Clearcote could not be downloaded. DomX does not fall back to system Chrome.';
const CHECKSUM_FAILED_MESSAGE =
  'Clearcote download did not match its checksum. DomX does not fall back to system Chrome.';

function parseSha256(text) {
  const token = String(text || '').trim().split(/\s+/)[0] || '';
  return /^[a-f0-9]{64}$/i.test(token) ? token.toLowerCase() : null;
}

function checksumMatches(actualHex, expectedText) {
  const expected = parseSha256(expectedText);
  const actual = parseSha256(actualHex);
  return Boolean(expected && actual && expected === actual);
}

function installDir() {
  const local =
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(local, 'Clearcote');
}

function findChromeExe(root) {
  if (!root || !fs.existsSync(root)) return null;
  const directExe = path.join(root, 'chrome.exe');
  const directDll = path.join(root, 'chrome.dll');
  if (fs.existsSync(directExe) && fs.existsSync(directDll)) return directExe;

  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const exe = path.join(dir, 'chrome.exe');
    const dll = path.join(dir, 'chrome.dll');
    if (fs.existsSync(exe) && fs.existsSync(dll)) return exe;
  }
  return null;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readInstalledSha(dir) {
  try {
    return parseSha256(fs.readFileSync(path.join(dir, MARKER_NAME), 'utf8'));
  } catch {
    return null;
  }
}

function downloadError(message = DOWNLOAD_FAILED_MESSAGE) {
  const err = new Error(message);
  err.code = 'CLEARCOTE_DOWNLOAD_FAILED';
  return err;
}

async function fetchExpectedSha() {
  const response = await fetch(SHA_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw downloadError();
  return response.text();
}

async function downloadZip(dest, onProgress) {
  const response = await fetch(ZIP_URL, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw downloadError();
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  let lastEmit = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const now = Date.now();
      if (onProgress && (now - lastEmit > 250 || (total > 0 && received >= total))) {
        lastEmit = now;
        onProgress({ received, total });
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), progress, fs.createWriteStream(dest));
}

function extractZip(zipPath, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', zipPath, '-C', dest], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', () => reject(downloadError()));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(downloadError());
    });
  });
}

function promoteExtract(staging, exePath, dest) {
  const sourceDir = path.dirname(exePath);
  const keep = new Set(['.staging', '.download.zip', MARKER_NAME]);
  for (const name of fs.readdirSync(dest)) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join(dest, name), { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(sourceDir)) {
    fs.renameSync(path.join(sourceDir, name), path.join(dest, name));
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

async function ensureClearcoteInstalled({ onProgress } = {}) {
  if (process.platform !== 'win32') return findClearcoteExecutable();

  const fromEnv = process.env.CLEARCOTE_EXECUTABLE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const dir = installDir();
  fs.mkdirSync(dir, { recursive: true });
  const managed = findChromeExe(dir);
  const existing = managed || findClearcoteExecutable();

  let expectedText = '';
  try {
    expectedText = await fetchExpectedSha();
  } catch (err) {
    if (existing) return existing;
    throw err;
  }
  const expected = parseSha256(expectedText);
  if (!expected) {
    if (existing) return existing;
    throw downloadError();
  }

  const installedSha = readInstalledSha(dir);
  if (managed && (!installedSha || installedSha === expected)) return managed;
  if (!managed && existing) return existing;

  const zipPath = path.join(dir, '.download.zip');
  const staging = path.join(dir, '.staging');
  try {
    await downloadZip(zipPath, onProgress);
    const actual = await hashFile(zipPath);
    if (!checksumMatches(actual, expected)) {
      throw downloadError(CHECKSUM_FAILED_MESSAGE);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await extractZip(zipPath, staging);
    const exe = findChromeExe(staging);
    if (!exe) throw downloadError();
    promoteExtract(staging, exe, dir);
    fs.writeFileSync(path.join(dir, MARKER_NAME), `${expected}\n`);
    const installed = findChromeExe(dir);
    if (!installed) throw downloadError();
    return installed;
  } finally {
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = {
  FEED_URL,
  ZIP_NAME,
  SHA_NAME,
  ZIP_URL,
  SHA_URL,
  DOWNLOAD_FAILED_MESSAGE,
  CHECKSUM_FAILED_MESSAGE,
  parseSha256,
  checksumMatches,
  installDir,
  findChromeExe,
  hashFile,
  ensureClearcoteInstalled,
};
