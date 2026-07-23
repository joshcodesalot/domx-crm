const { encryptSecret, decryptSecret } = require('./crypto');

const SB_AUTH_TOKEN_PREFIX = 'sb-';
const SB_AUTH_TOKEN_SUFFIX = '-auth-token';
const DEFAULT_SUPABASE_URL = 'https://srswgacczfgjttwdpuia.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_4zljSqmEuxGuqPttJAK_kg_XzInyyJ9';

function getSupabaseConfig() {
  return {
    url: process.env.MALOUM_SUPABASE_URL || DEFAULT_SUPABASE_URL,
    publishableKey:
      process.env.MALOUM_SUPABASE_PUBLISHABLE_KEY || DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  };
}

function isMaloumAuthStorageKey(name) {
  return (
    typeof name === 'string' &&
    name.startsWith(SB_AUTH_TOKEN_PREFIX) &&
    name.endsWith(SB_AUTH_TOKEN_SUFFIX)
  );
}

function findAuthStorageEntry(origins) {
  if (!Array.isArray(origins)) {
    return null;
  }

  for (const originEntry of origins) {
    if (!originEntry?.origin?.includes('maloum.com')) {
      continue;
    }

    for (const item of originEntry.localStorage || []) {
      if (!isMaloumAuthStorageKey(item?.name) || !item?.value) {
        continue;
      }

      return {
        origin: originEntry.origin,
        storageKey: item.name,
        storageValue: item.value,
      };
    }
  }

  return null;
}

function parseSupabaseSessionJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const accessToken =
      parsed?.access_token ||
      parsed?.currentSession?.access_token ||
      parsed?.session?.access_token;
    const refreshToken =
      parsed?.refresh_token ||
      parsed?.currentSession?.refresh_token ||
      parsed?.session?.refresh_token;

    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      return null;
    }

    let expiresAt = parsed?.expires_at;
    if (typeof expiresAt !== 'number' && typeof parsed?.expires_in === 'number') {
      expiresAt = Math.floor(Date.now() / 1000 + parsed.expires_in);
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
      session: parsed,
    };
  } catch {
    return null;
  }
}

function extractTokensFromOrigins(origins) {
  const entry = findAuthStorageEntry(origins);
  if (!entry) {
    return null;
  }

  const parsed = parseSupabaseSessionJson(entry.storageValue);
  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    storageKey: entry.storageKey,
    storageValue: entry.storageValue,
    origin: entry.origin,
  };
}

function expiresAtToDate(expiresAt) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return null;
  }
  return new Date(expiresAt * 1000);
}

function buildEncryptedTokenFields({ accessToken, refreshToken, expiresAt }) {
  if (!accessToken || !refreshToken) {
    return null;
  }

  return {
    encryptedAccessToken: encryptSecret(accessToken),
    encryptedRefreshToken: encryptSecret(refreshToken),
    accessTokenExpiresAt: expiresAtToDate(expiresAt),
  };
}

function buildTokenWriteFromOrigins(origins) {
  const extracted = extractTokensFromOrigins(origins);
  if (!extracted) {
    return null;
  }

  const encrypted = buildEncryptedTokenFields(extracted);
  if (!encrypted) {
    return null;
  }

  return {
    ...encrypted,
    authRefreshState: 'active',
    tokenRefreshFailureCount: 0,
  };
}

function buildSupabaseStorageValue(session) {
  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: session.token_type || 'bearer',
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    user: session.user,
  };

  return JSON.stringify(payload);
}

function updateOriginsAuthStorage(origins, storageKey, session) {
  const nextValue = buildSupabaseStorageValue(session);
  const nextOrigins = Array.isArray(origins)
    ? origins.map((originEntry) => ({
        origin: originEntry.origin,
        localStorage: Array.isArray(originEntry.localStorage)
          ? originEntry.localStorage.map((item) =>
              item?.name === storageKey ? { ...item, value: nextValue } : item
            )
          : [],
      }))
    : [];

  const hasKey = nextOrigins.some((originEntry) =>
    (originEntry.localStorage || []).some((item) => item?.name === storageKey)
  );

  if (!hasKey) {
    const maloumOrigin =
      nextOrigins.find((entry) => entry.origin?.includes('app.maloum.com')) ||
      nextOrigins[0];

    if (maloumOrigin) {
      maloumOrigin.localStorage = [
        ...(maloumOrigin.localStorage || []),
        { name: storageKey, value: nextValue },
      ];
    } else {
      nextOrigins.push({
        origin: 'https://app.maloum.com',
        localStorage: [{ name: storageKey, value: nextValue }],
      });
    }
  }

  return nextOrigins;
}

function mergeSessionWithSupabaseResponse(encryptedSession, supabaseSession) {
  const session = encryptedSession || {};
  const storageEntry = findAuthStorageEntry(session.origins || []);
  const storageKey =
    storageEntry?.storageKey || 'sb-srswgacczfgjttwdpuia-auth-token';

  const nextOrigins = updateOriginsAuthStorage(
    session.origins || [],
    storageKey,
    supabaseSession
  );

  return {
    cookies: session.cookies || [],
    origins: nextOrigins,
    loginEmail: session.loginEmail || null,
    savedAt: new Date().toISOString(),
  };
}

function decryptAccessToken(buffer) {
  return decryptSecret(buffer);
}

function decryptRefreshToken(buffer) {
  return decryptSecret(buffer);
}

module.exports = {
  DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SUPABASE_URL,
  buildEncryptedTokenFields,
  buildSupabaseStorageValue,
  buildTokenWriteFromOrigins,
  decryptAccessToken,
  decryptRefreshToken,
  extractTokensFromOrigins,
  findAuthStorageEntry,
  getSupabaseConfig,
  isMaloumAuthStorageKey,
  mergeSessionWithSupabaseResponse,
  parseSupabaseSessionJson,
  updateOriginsAuthStorage,
};
