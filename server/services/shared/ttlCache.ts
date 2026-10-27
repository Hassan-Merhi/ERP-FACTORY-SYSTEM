// ---------------------------------------------------------------------------
// Shared lightweight in-process TTL cache for expensive computed stat endpoints.
// Keyed by endpoint + companyId + date params. 30-second TTL means a company
// with multiple users hitting the dashboard simultaneously gets one DB round-
// trip instead of N. Most mutations tolerate their short TTL. A committed company FX rate
// change explicitly invalidates affected financial summaries.
//
// Previously duplicated verbatim in each of the four stats route files.
// Consolidated here to eliminate the duplication; behaviour is identical.
// ---------------------------------------------------------------------------

const _statCache = new Map<string, { data: unknown; expiresAt: number }>();
const MAX_CACHE_ENTRIES = 500;

function pruneCache(now = Date.now()): void {
  for (const [key, entry] of _statCache) {
    if (entry.expiresAt <= now) _statCache.delete(key);
  }
  while (_statCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = _statCache.keys().next().value;
    if (oldestKey === undefined) break;
    _statCache.delete(oldestKey);
  }
}

export function _getCached(key: string): unknown | null {
  const e = _statCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    _statCache.delete(key);
    return null;
  }
  return e.data;
}

export function _setCached(key: string, data: unknown, ttlMs = 30_000): void {
  _statCache.delete(key);
  _statCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  pruneCache();
}

/**
 * Evict entries whose key matches a scoped financial predicate, e.g. after a
 * confirmed company exchange-rate save. Never clear unrelated tenants' data.
 * Returns the number of keys removed for diagnostics.
 */
export function _invalidateCachedWhere(predicate: (key: string) => boolean): number {
  let removed = 0;
  for (const key of _statCache.keys()) {
    if (predicate(key)) {
      _statCache.delete(key);
      removed++;
    }
  }
  return removed;
}
