const TTL_MS = 30_000;

const store = new Map();
const inflight = new Map();
const epochs = new Map();

function currentEpoch(key) {
  return epochs.get(key) || 0;
}

function peek(key) {
  const entry = store.get(key);
  if (!entry || entry.expires <= Date.now()) {
    if (entry) store.delete(key);
    return undefined;
  }
  return entry.data;
}

function set(key, data, ttlMs = TTL_MS) {
  store.set(key, { expires: Date.now() + ttlMs, data });
}

async function getOrLoad(key, loader, ttlMs = TTL_MS) {
  const hit = peek(key);
  if (hit !== undefined) return hit;

  const existing = inflight.get(key);
  if (existing) return existing;

  const epoch = currentEpoch(key);
  const promise = (async () => {
    try {
      const data = await loader();
      if (currentEpoch(key) === epoch) {
        set(key, data, ttlMs);
      }
      return data;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

function matchesPrefix(key, prefix) {
  return key === prefix || key.startsWith(prefix);
}

function invalidatePrefix(prefix) {
  if (!prefix) return;
  for (const key of [...store.keys()]) {
    if (matchesPrefix(key, prefix)) {
      store.delete(key);
      epochs.set(key, currentEpoch(key) + 1);
    }
  }
  for (const key of inflight.keys()) {
    if (matchesPrefix(key, prefix)) {
      epochs.set(key, currentEpoch(key) + 1);
    }
  }
}

function clear() {
  store.clear();
  inflight.clear();
  epochs.clear();
}

module.exports = {
  TTL_MS,
  peek,
  set,
  getOrLoad,
  invalidatePrefix,
  clear,
};
