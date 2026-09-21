/**
 * Tiny in-process TTL cache.
 * Keeps recently-fetched values in a Map and evicts them after `ttlMs`.
 * Designed for settings/config endpoints that are called on every page-load
 * but change very rarely — eliminates round-trips to the DB for repeated reads.
 *
 * Usage:
 *   import { cache } from "@/lib/simpleCache";
 *   const val = await cache("key", 30_000, () => db.select()...);
 *   cache.del("key"); // invalidate on writes
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = Math.max(32, Number.parseInt(process.env.SIMPLE_CACHE_MAX_ENTRIES || "256", 10) || 256);

function prune(now = Date.now()): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

export async function cache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = store.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.value as T;
  }
  const value = await loader();
  store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  prune();
  return value;
}

cache.del = (key: string) => {
  store.delete(key);
};

cache.delPrefix = (prefix: string) => {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
};
