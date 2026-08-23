const TTL_MS = 10 * 60 * 1000;
const DB_NAME = 'domx-vault-listing';
const DB_VERSION = 1;
const STORE = 'listings';

export type VaultCachePlatform = 'maloum' | '4based' | 'telegram';

export type VaultListingRecord<T = unknown> = {
  key: string;
  savedAt: number;
  payload: T;
};

const memory = new Map<string, VaultListingRecord>();
let dbPromise: Promise<IDBDatabase> | null = null;

export function vaultCacheKey(parts: {
  platform: VaultCachePlatform;
  creatorId: string;
  kind: 'folders' | 'media' | 'sent';
  folderId?: string | null;
  fanId?: string | null;
  filters?: string;
}): string {
  return [
    parts.platform,
    parts.creatorId,
    parts.kind,
    parts.folderId || '',
    parts.fanId || '',
    parts.filters || '',
  ].join('|');
}

function isFresh(savedAt: number): boolean {
  return Date.now() - savedAt < TTL_MS;
}

function openDb(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  }
  return dbPromise;
}

async function readIdb<T>(key: string): Promise<VaultListingRecord<T> | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as VaultListingRecord<T>) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeIdb<T>(record: VaultListingRecord<T>): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Private mode / quota — memory cache still works.
  }
}

export function getVaultListingCache<T>(key: string): T | null {
  const mem = memory.get(key);
  if (mem && isFresh(mem.savedAt)) return mem.payload as T;
  if (mem) memory.delete(key);
  return null;
}

export function setVaultListingCache<T>(key: string, payload: T): void {
  const record: VaultListingRecord<T> = {
    key,
    savedAt: Date.now(),
    payload,
  };
  memory.set(key, record as VaultListingRecord);
  void writeIdb(record);
}

export async function loadVaultListingCache<T>(key: string): Promise<T | null> {
  const fresh = getVaultListingCache<T>(key);
  if (fresh) return fresh;
  const fromDb = await readIdb<T>(key);
  if (fromDb && isFresh(fromDb.savedAt)) {
    memory.set(key, fromDb as VaultListingRecord);
    return fromDb.payload;
  }
  return null;
}

export function addVaultSentIds(key: string, uploadIds: string[]): void {
  const ids = uploadIds.map(String).filter(Boolean);
  if (ids.length === 0) return;
  const existing = getVaultListingCache<{ uploadIds: string[] }>(key);
  const next = new Set(existing?.uploadIds || []);
  for (const id of ids) next.add(id);
  setVaultListingCache(key, { uploadIds: [...next] });
}
