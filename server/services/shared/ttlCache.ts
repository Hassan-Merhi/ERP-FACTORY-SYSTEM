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
  _statCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  // Prune stale entries to prevent unbounded growth (> 500 entries is unusual)
  if (_statCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _statCache) {
      if (v.expiresAt < now) _statCache.delete(k);
    }
  }
}
