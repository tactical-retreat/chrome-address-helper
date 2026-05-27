import { Tag, TagLookup, StoredTags, TagStats } from '../types';
import { normalizeAddress } from '../utils/address';

const DB_NAME = 'WalletTaggerDB';
const DB_VERSION = 1;
const TAGS_STORE = 'tags';
const META_STORE = 'meta';

let db: IDBDatabase | null = null;
let tagCache: TagLookup = {};
let cacheReady = false;

export async function initDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      db = request.result;
      loadCacheFromDB().then(resolve).catch(reject);
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;

      // Store for tags
      if (!database.objectStoreNames.contains(TAGS_STORE)) {
        const tagStore = database.createObjectStore(TAGS_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        tagStore.createIndex('address', 'address', { unique: false });
        tagStore.createIndex('source', 'source', { unique: false });
      }

      // Store for metadata
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
  });
}

async function loadCacheFromDB(): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(TAGS_STORE, 'readonly');
    const store = transaction.objectStore(TAGS_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      tagCache = {};
      for (const tag of request.result) {
        const normalized = normalizeAddress(tag.address);
        if (!tagCache[normalized]) {
          tagCache[normalized] = [];
        }
        tagCache[normalized].push(tag);
      }
      cacheReady = true;
      console.log(`[WalletTagger] Loaded ${request.result.length} tags into cache`);
      resolve();
    };

    request.onerror = () => reject(request.error);
  });
}

export function getTagsForAddress(address: string): Tag[] {
  const normalized = normalizeAddress(address);
  return tagCache[normalized] || [];
}

export function getResolvedTag(address: string): Tag | null {
  const tags = getTagsForAddress(address);
  if (tags.length === 0) return null;

  // Priority: Arkham first
  const arkhamTag = tags.find((t) => t.source === 'arkham');
  if (arkhamTag) return arkhamTag;

  // Otherwise return first available
  return tags[0];
}

export function hasTag(address: string): boolean {
  const normalized = normalizeAddress(address);
  return !!tagCache[normalized] && tagCache[normalized].length > 0;
}

export function getAllKnownAddresses(): string[] {
  return Object.keys(tagCache);
}

export async function importTags(tags: Tag[], source: string): Promise<number> {
  if (!db) throw new Error('Database not initialized');

  // First, remove existing tags from this source
  await clearTagsBySource(source);

  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(TAGS_STORE, 'readwrite');
    const store = transaction.objectStore(TAGS_STORE);
    let count = 0;

    for (const tag of tags) {
      const normalizedTag = {
        ...tag,
        address: normalizeAddress(tag.address),
        source,
      };
      const request = store.add(normalizedTag);
      request.onsuccess = () => count++;
    }

    transaction.oncomplete = () => {
      // Update cache
      for (const tag of tags) {
        const normalized = normalizeAddress(tag.address);
        if (!tagCache[normalized]) {
          tagCache[normalized] = [];
        }
        tagCache[normalized].push({ ...tag, address: normalized, source });
      }
      console.log(`[WalletTagger] Imported ${count} tags from ${source}`);
      resolve(count);
    };

    transaction.onerror = () => reject(transaction.error);
  });
}

export async function clearTagsBySource(source: string): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(TAGS_STORE, 'readwrite');
    const store = transaction.objectStore(TAGS_STORE);
    const index = store.index('source');
    const request = index.openCursor(IDBKeyRange.only(source));

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    transaction.oncomplete = () => {
      // Update cache - remove tags from this source
      for (const address of Object.keys(tagCache)) {
        tagCache[address] = tagCache[address].filter((t) => t.source !== source);
        if (tagCache[address].length === 0) {
          delete tagCache[address];
        }
      }
      resolve();
    };

    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getTagsBySource(source: string): Promise<Tag[]> {
  if (!db) throw new Error('Database not initialized');

  return new Promise((resolve, reject) => {
    const transaction = db!.transaction(TAGS_STORE, 'readonly');
    const store = transaction.objectStore(TAGS_STORE);
    const index = store.index('source');
    const request = index.getAll(IDBKeyRange.only(source));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getStats(): Promise<TagStats> {
  const sourceBreakdown: { [source: string]: number } = {};
  let totalTags = 0;

  for (const address of Object.keys(tagCache)) {
    for (const tag of tagCache[address]) {
      totalTags++;
      sourceBreakdown[tag.source] = (sourceBreakdown[tag.source] || 0) + 1;
    }
  }

  return {
    totalTags,
    sourceBreakdown,
    uniqueAddresses: Object.keys(tagCache).length,
  };
}

export function hasSource(source: string): boolean {
  for (const tags of Object.values(tagCache)) {
    if (tags.some(t => t.source === source)) return true;
  }
  return false;
}

export function isCacheReady(): boolean {
  return cacheReady;
}

export { tagCache };
