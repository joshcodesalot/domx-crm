const SB_AUTH_TOKEN_PREFIX = 'sb-';
const SB_AUTH_TOKEN_SUFFIX = '-auth-token';

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

function extractMaloumAuthFromOrigins(origins) {
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

module.exports = {
  extractMaloumAuthFromOrigins,
  findAuthStorageEntry,
  isMaloumAuthStorageKey,
  parseSupabaseSessionJson,
};
