const fs = require('fs');
const path = require('path');
const { getProfilesRoot } = require('./app-paths');

function getProfileDir(accountId) {
  return path.join(getProfilesRoot(), accountId);
}

function getProfileFilePath(accountId) {
  return path.join(getProfileDir(accountId), 'storage-state.json');
}

function ensureProfilesRoot() {
  fs.mkdirSync(getProfilesRoot(), { recursive: true });
}

function hasLocalProfile(accountId) {
  try {
    return fs.existsSync(getProfileFilePath(accountId));
  } catch {
    return false;
  }
}

function readLocalProfile(accountId) {
  try {
    const filePath = getProfileFilePath(accountId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.cookies?.length) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalProfile(accountId, profile) {
  ensureProfilesRoot();
  const profileDir = getProfileDir(accountId);
  fs.mkdirSync(profileDir, { recursive: true });
  const payload = {
    accountId,
    savedAt:
      typeof profile.savedAt === 'string' && profile.savedAt
        ? profile.savedAt
        : new Date().toISOString(),
    cookies: profile.cookies || [],
    origins: profile.origins || [],
  };
  fs.writeFileSync(getProfileFilePath(accountId), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function getLocalProfileMeta(accountId) {
  try {
    const filePath = getProfileFilePath(accountId);
    if (!fs.existsSync(filePath)) {
      return { exists: false, savedAt: null };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      exists: Boolean(parsed?.cookies?.length),
      savedAt: typeof parsed?.savedAt === 'string' ? parsed.savedAt : null,
    };
  } catch {
    return { exists: false, savedAt: null };
  }
}

function deleteLocalProfile(accountId) {
  try {
    const profileDir = getProfileDir(accountId);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup failures
  }
}

function electronCookieToPlaywright(cookie) {
  const domain = cookie.domain || '';
  const normalizedDomain = domain.startsWith('.') ? domain : `.${domain}`;

  const playwrightCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: normalizedDomain,
    path: cookie.path || '/',
    expires: cookie.expirationDate ? cookie.expirationDate : -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
  };

  if (cookie.sameSite) {
    if (cookie.sameSite === 'no_restriction') {
      playwrightCookie.sameSite = 'None';
    } else if (cookie.sameSite === 'strict') {
      playwrightCookie.sameSite = 'Strict';
    } else {
      playwrightCookie.sameSite = 'Lax';
    }
  }

  return playwrightCookie;
}

async function exportProfileFromPartition(accountId, webContents) {
  const { session } = require('electron');
  const partitionSession = session.fromPartition(`persist:creator-${accountId}`);
  const electronCookies = await partitionSession.cookies.get({});
  const cookies = electronCookies
    .filter((cookie) => (cookie.domain || '').includes('maloum.com'))
    .map(electronCookieToPlaywright);

  const origins = [];
  const originMap = new Map();

  if (webContents && !webContents.isDestroyed()) {
    try {
      const currentOrigin = await webContents.executeJavaScript(`
        (function() {
          const items = [];
          for (let i = 0; i < localStorage.length; i += 1) {
            const name = localStorage.key(i);
            if (name) {
              items.push({ name, value: localStorage.getItem(name) });
            }
          }
          return { origin: window.location.origin, localStorage: items };
        })()
      `);
      if (currentOrigin?.origin && currentOrigin.localStorage?.length) {
        originMap.set(currentOrigin.origin, currentOrigin.localStorage);
      }
    } catch {
      // ignore export failures from active page
    }
  }

  for (const [origin, localStorage] of originMap.entries()) {
    origins.push({ origin, localStorage });
  }

  return { cookies, origins };
}

module.exports = {
  getProfileFilePath,
  hasLocalProfile,
  readLocalProfile,
  writeLocalProfile,
  getLocalProfileMeta,
  deleteLocalProfile,
  exportProfileFromPartition,
};
