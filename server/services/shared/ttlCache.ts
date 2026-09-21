// ---------------------------------------------------------------------------
// Shared lightweight in-process TTL cache for expensive computed stat endpoints.
// Keyed by endpoint + companyId + date params. 30-second TTL means a company
// with multiple users hitting the dashboard simultaneously gets one DB round-
// trip instead of N. Mutations don't invalidate the cache — the 30-second
// staleness is acceptable for these summary/aggregate endpoints.
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
