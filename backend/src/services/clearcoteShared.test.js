const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { isLockActive, LOCK_STALE_MS } = require('./browserProfiles');
const {
  buildClearcoteArgs,
  proxyLaunchArgs,
  startHttpProxyForwarder,
  writeProxyAuthExtension,
} = require('../../../frontend/electron/clearcote/launchArgs');
const {
  packProfile,
  unpackProfile,
  shouldSkipRelative,
  isSafeZipName,
} = require('../../../frontend/electron/clearcote/profileArchive');

describe('browser profile lock', () => {
  it('treats a fresh heartbeat as held', () => {
    const now = Date.now();
    assert.equal(
      isLockActive(
        { lockedBy: 'user-1', heartbeatAt: new Date(now - 10_000).toISOString() },
        now
      ),
      true
    );
  });

  it('releases a missed heartbeat', () => {
    const now = Date.now();
    assert.equal(
      isLockActive(
        { lockedBy: 'user-1', heartbeatAt: new Date(now - LOCK_STALE_MS - 1000).toISOString() },
        now
      ),
      false
    );
    assert.equal(isLockActive({ lockedBy: null, heartbeatAt: new Date(now).toISOString() }, now), false);
  });
});

describe('Clearcote launch args', () => {
  it('keeps the seed, profile key, proxy, and timezone', () => {
    const extensionDir = 'C:\\profiles\\creator-proxy-auth';
    const args = buildClearcoteArgs({
      userDataDir: 'C:\\profiles\\creator',
      fingerprintSeed: '12345',
      fingerprintPlatform: 'windows',
      encryptionKey: 'secret-key',
      proxyUrl: 'http://user:p%40ss@10.0.0.1:8000',
      timezone: 'Europe/Berlin',
      acceptLanguage: 'de-DE,de',
      proxyAuthExtensionDir: extensionDir,
    });
    const joined = args.join('\n');
    assert.match(joined, /--fingerprint=12345/);
    assert.match(joined, /--fingerprint-platform=windows/);
    assert.match(joined, /--profile-encryption-key=secret-key/);
    assert.match(joined, /--timezone=Europe\/Berlin/);
    assert.match(joined, /--accept-lang=de-DE,de/);
    assert.match(joined, /--lang=de-DE/);
    assert.match(joined, /--proxy-server=http:\/\/10\.0\.0\.1:8000/);
    assert.equal(joined.includes('--proxy-auth='), false);
    assert.equal(joined.includes(`--load-extension=${extensionDir}`), true);
    assert.equal(joined.includes(`--disable-extensions-except=${extensionDir}`), true);
    assert.equal(joined.includes('--disable-features=DisableLoadExtensionCommandLineSwitch'), true);
    assert.equal(joined.includes('--enable-automation'), false);
    assert.equal(joined.includes('user:p'), false);
    assert.equal(args.some((arg) => arg.startsWith('--proxy-server=') && arg.includes('@')), false);
  });

  it('writes HTTP proxy credentials into the extension', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-proxy-auth-'));
    try {
      writeProxyAuthExtension(dir, 'user', 'p@ss');
      const background = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
      assert.match(background, /const password = "p@ss"/);
      assert.match(background, /details\.isProxy/);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.manifest_version, 3);
      assert.equal(manifest.permissions.includes('webRequestAuthProvider'), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('points Clearcote at the local forwarder without proxy credentials', () => {
    const args = buildClearcoteArgs({
      userDataDir: 'C:\\profiles\\creator',
      fingerprintSeed: '12345',
      encryptionKey: 'secret-key',
      proxyUrl: 'http://user:p%40ss@10.0.0.1:8000',
      localProxyServer: 'http://127.0.0.1:9',
    });
    const joined = args.join('\n');
    assert.match(joined, /--proxy-server=http:\/\/127\.0\.0\.1:9/);
    assert.equal(joined.includes('10.0.0.1'), false);
    assert.equal(joined.includes('--load-extension='), false);
    assert.equal(joined.includes('user:p'), false);
  });

  it('adds proxy credentials before the browser sees the upstream proxy', async () => {
    const upstream = net.createServer((socket) => {
      socket.once('data', (buf) => {
        const text = buf.toString('latin1');
        const expected = `Basic ${Buffer.from('user:p@ss').toString('base64')}`;
        assert.match(text, new RegExp(`Proxy-Authorization: ${expected}`));
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.end();
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = upstream.address();
    const forwarder = await startHttpProxyForwarder(`http://user:p%40ss@127.0.0.1:${port}`);
    try {
      const status = await new Promise((resolve, reject) => {
        const client = net.connect(Number(new URL(forwarder.proxyServer).port), '127.0.0.1', () => {
          client.write('CONNECT x.com:443 HTTP/1.1\r\nHost: x.com:443\r\n\r\n');
        });
        client.once('data', (buf) => {
          resolve(buf.toString('latin1'));
          client.end();
        });
        client.on('error', reject);
      });
      assert.match(status, /^HTTP\/1\.1 200/);
    } finally {
      forwarder.close();
      upstream.close();
    }
  });

  it('hides an upstream proxy challenge from the browser', async () => {
    const upstream = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
        socket.end();
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = upstream.address();
    const forwarder = await startHttpProxyForwarder(`http://user:secret@127.0.0.1:${port}`);
    try {
      const status = await new Promise((resolve, reject) => {
        const client = net.connect(Number(new URL(forwarder.proxyServer).port), '127.0.0.1', () => {
          client.write('CONNECT x.com:443 HTTP/1.1\r\nHost: x.com:443\r\n\r\n');
        });
        client.once('data', (buf) => {
          resolve(buf.toString('latin1'));
          client.end();
        });
        client.on('error', reject);
      });
      assert.match(status, /^HTTP\/1\.1 502/);
      assert.equal(status.includes('407'), false);
    } finally {
      forwarder.close();
      upstream.close();
    }
  });

  it('uses socks credentials without putting them in the server flag', () => {
    const args = proxyLaunchArgs('socks5://alpha:beta@10.1.1.1:1080');
    assert.deepEqual(args.slice(0, 2), [
      '--proxy-server=socks5://10.1.1.1:1080',
      '--socks5-credentials=alpha:beta',
    ]);
  });

  it('adds the virtual display flags only for the Debian host', () => {
    const args = buildClearcoteArgs({
      userDataDir: '/tmp/profile',
      fingerprintSeed: '99',
      encryptionKey: 'key',
      virtualDisplay: true,
    });
    assert.equal(args.includes('--no-sandbox'), true);
    assert.equal(args.includes('--disable-gpu'), true);
    assert.equal(args.includes('https://x.com'), true);
  });
});

describe('Clearcote profile archive', () => {
  it('round-trips profile files and leaves caches out', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-profile-'));
    const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-profile-out-'));
    try {
      fs.mkdirSync(path.join(root, 'Default', 'Cache'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Default', 'Cookies'), 'cookies');
      fs.writeFileSync(path.join(root, 'Default', 'Cache', 'data_0'), 'cache');
      fs.writeFileSync(path.join(root, 'SingletonLock'), 'lock');
      const zip = packProfile(root);
      unpackProfile(zip, restored);
      assert.equal(fs.readFileSync(path.join(restored, 'Default', 'Cookies'), 'utf8'), 'cookies');
      assert.equal(fs.existsSync(path.join(restored, 'Default', 'Cache', 'data_0')), false);
      assert.equal(fs.existsSync(path.join(restored, 'SingletonLock')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(restored, { recursive: true, force: true });
    }
  });

  it('rejects unsafe archive paths', () => {
    assert.equal(shouldSkipRelative('Default/Cache/data_0'), true);
    assert.equal(shouldSkipRelative('Default/Cookies'), false);
    assert.equal(isSafeZipName('../evil'), false);
    assert.equal(isSafeZipName('Default/Cookies'), true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-zip-'));
    try {
      assert.throws(() => unpackProfile(Buffer.from('this is not a zip file'), root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

const {
  checksumMatches,
  findChromeExe,
  hashFile,
  ZIP_NAME,
} = require('../../../frontend/electron/clearcote/browserInstall');
const { buildManifest } = require('../../../frontend/scripts/generate-update-manifest');

describe('Clearcote crm-updates download', () => {
  it('rejects a checksum that does not match the zip', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-clearcote-sha-'));
    const file = path.join(dir, 'payload.bin');
    try {
      fs.writeFileSync(file, 'clearcote-bytes');
      const actual = await hashFile(file);
      assert.equal(checksumMatches(actual, actual), true);
      assert.equal(checksumMatches(actual, `${'ab'.repeat(32)}\n`), false);
      assert.equal(checksumMatches(actual, 'not-a-hash'), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds chrome.exe at the archive root and one folder down', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-clearcote-bin-'));
    const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'domx-clearcote-nested-'));
    try {
      fs.writeFileSync(path.join(root, 'chrome.exe'), 'exe');
      fs.writeFileSync(path.join(root, 'chrome.dll'), 'dll');
      assert.equal(findChromeExe(root), path.join(root, 'chrome.exe'));

      const inner = path.join(nested, 'clearcote-windows');
      fs.mkdirSync(inner);
      fs.writeFileSync(path.join(inner, 'chrome.exe'), 'exe');
      fs.writeFileSync(path.join(inner, 'chrome.dll'), 'dll');
      assert.equal(findChromeExe(nested), path.join(inner, 'chrome.exe'));
      assert.equal(findChromeExe(path.join(nested, 'missing')), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(nested, { recursive: true, force: true });
    }
  });

  it('leaves the Clearcote zip out of the DomX update manifest', () => {
    const manifest = buildManifest('1.2.3', [
      'DomX-CRM-Setup-1.2.3-x64.exe',
      'DomX-CRM-1.2.3-arm64.dmg',
      ZIP_NAME,
      'Clearcote-win-x64.sha256',
    ]);
    const encoded = JSON.stringify(manifest);
    assert.equal(encoded.includes('Clearcote'), false);
    assert.match(manifest.downloads.windows.url, /DomX-CRM-Setup-1\.2\.3-x64\.exe$/);
    assert.match(manifest.downloads.mac.arm64.url, /DomX-CRM-1\.2\.3-arm64\.dmg$/);
  });
});
