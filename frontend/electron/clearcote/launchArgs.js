const fs = require('fs');
const path = require('path');

const MISSING_CLEARCOTE_MESSAGE =
  'Clearcote is not installed. Point CLEARCOTE_EXECUTABLE at the Clearcote chrome binary. DomX does not fall back to system Chrome.';

function findClearcoteExecutable() {
  const fromEnv = process.env.CLEARCOTE_EXECUTABLE;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const local = process.env.LOCALAPPDATA || '';
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(local, 'Clearcote', 'Application', 'chrome.exe'),
          path.join(local, 'clearcote', 'chrome.exe'),
          path.join(home, 'clearcote', 'chrome-win64', 'chrome.exe'),
          path.join(home, 'AppData', 'Local', 'Clearcote', 'Application', 'chrome.exe'),
        ]
      : [
          '/opt/clearcote/chrome',
          '/usr/local/bin/clearcote-chrome',
          path.join(home, '.local', 'share', 'clearcote', 'chrome'),
        ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function primaryLang(acceptLanguage) {
  if (!acceptLanguage || typeof acceptLanguage !== 'string') {
    return null;
  }
  const first = acceptLanguage.split(',')[0].trim();
  return first || null;
}

function proxyLaunchArgs(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') {
    return [];
  }
  const parsed = new URL(proxyUrl);
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  const defaultPort = scheme === 'https' ? '443' : scheme.startsWith('socks') ? '1080' : '80';
  const port = parsed.port || defaultPort;
  const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
  const args = [`--proxy-server=${scheme}://${host}:${port}`];
  const username = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  if (username || password) {
    const credentials = `${username}:${password}`;
    if (scheme.startsWith('socks')) {
      args.push(`--socks5-credentials=${credentials}`);
    } else {
      args.push(`--proxy-auth=${credentials}`);
    }
  }
  args.push('--disable-quic', '--webrtc-ip-handling-policy=disable_non_proxied_udp');
  return args;
}

function buildClearcoteArgs({
  userDataDir,
  fingerprintSeed,
  fingerprintPlatform = 'windows',
  encryptionKey,
  proxyUrl,
  timezone,
  acceptLanguage,
  virtualDisplay = false,
  startUrl = 'https://x.com',
}) {
  if (!userDataDir) {
    throw new Error('Clearcote needs a user data directory');
  }
  if (!fingerprintSeed) {
    throw new Error('Clearcote needs a fingerprint seed');
  }
  if (!encryptionKey) {
    throw new Error('Clearcote needs a profile encryption key');
  }

  const platform = fingerprintPlatform === 'linux' || fingerprintPlatform === 'macos'
    ? fingerprintPlatform
    : 'windows';
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--fingerprint=${fingerprintSeed}`,
    `--fingerprint-platform=${platform}`,
    '--fingerprint-brand=chrome',
    `--profile-encryption-key=${encryptionKey}`,
    '--ignore-gpu-blocklist',
  ];

  if (timezone) {
    args.push(`--timezone=${timezone}`);
  }
  const lang = primaryLang(acceptLanguage);
  if (acceptLanguage) {
    args.push(`--accept-lang=${acceptLanguage}`);
  }
  if (lang) {
    args.push(`--lang=${lang}`);
  }

  args.push(...proxyLaunchArgs(proxyUrl));

  if (virtualDisplay) {
    args.push(
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--enable-features=WebBluetooth',
      '--window-size=1366,768'
    );
  }

  if (startUrl) {
    args.push(startUrl);
  }
  return args;
}

module.exports = {
  MISSING_CLEARCOTE_MESSAGE,
  findClearcoteExecutable,
  primaryLang,
  proxyLaunchArgs,
  buildClearcoteArgs,
};
