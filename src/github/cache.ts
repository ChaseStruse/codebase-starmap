/** Response cache. IndexedDB in the browser, in-memory when that is unavailable. */

export interface CacheEntry {
  url: string;
  etag: string | null;
  fetchedAt: number;
  body: unknown;
}

export interface CacheStore {
  get(url: string): Promise<CacheEntry | undefined>;
  set(entry: CacheEntry): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryCache implements CacheStore {
  private entries = new Map<string, CacheEntry>();
  async get(url: string) {
    return this.entries.get(url);
  }
  async set(entry: CacheEntry) {
    this.entries.set(entry.url, entry);
  }
  async clear() {
    this.entries.clear();
  }
}

const DB_NAME = 'codebase-starmap';
const STORE = 'responses';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

class IndexedDbCache implements CacheStore {
  constructor(private db: IDBDatabase) {}
  private store(mode: IDBTransactionMode) {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }
  async get(url: string) {
    return (await promisify(this.store('readonly').get(url))) as CacheEntry | undefined;
  }
  async set(entry: CacheEntry) {
    await promisify(this.store('readwrite').put(entry));
  }
  async clear() {
    await promisify(this.store('readwrite').clear());
  }
}

/**
 * Open the persistent cache. Private windows and locked-down browsers can
 * refuse IndexedDB, so this never throws: it falls back to memory.
 */
export async function openCache(): Promise<CacheStore> {
  try {
    if (typeof indexedDB === 'undefined') return new MemoryCache();
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'url' });
    };
    const db = await promisify(request);
    const cache = new IndexedDbCache(db);
    // Guard against a store that opens but cannot be read (some private modes).
    await cache.get('__probe__');
    return safe(cache);
  } catch {
    return new MemoryCache();
  }
}

/** A cache whose failures degrade to misses instead of breaking the app. */
function safe(inner: CacheStore): CacheStore {
  const memory = new MemoryCache();
  return {
    async get(url) {
      try {
        return (await inner.get(url)) ?? (await memory.get(url));
      } catch {
        return memory.get(url);
      }
    },
    async set(entry) {
      try {
        await inner.set(entry);
      } catch {
        // Quota exceeded or similar: keep it for this session only.
        await memory.set(entry);
      }
    },
    async clear() {
      await memory.clear();
      try {
        await inner.clear();
      } catch {
        /* nothing else to do */
      }
    },
  };
}
