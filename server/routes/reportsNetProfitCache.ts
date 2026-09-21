/**
 * Shared short-lived (30s) cache for net-profit-statement report queries.
 *
 * Used by both the main statement route (reportsRoutes.ts) and the
 * account-level drill-down routes (reportsNetProfitStatementRoutes.ts), so it
 * lives here to avoid a circular import between the two.
 */
const _npsCache = new Map<string, { data: unknown; expiresAt: number }>();
const MAX_CACHE_ENTRIES = 500;

function pruneCache(now = Date.now()): void {
  for (const [key, entry] of _npsCache) {
    if (entry.expiresAt <= now) _npsCache.delete(key);
  }
  while (_npsCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = _npsCache.keys().next().value;
    if (oldestKey === undefined) break;
    _npsCache.delete(oldestKey);
  }
}

export function _npsCached(key: string) {
  const c = _npsCache.get(key);
  return c && Date.now() < c.expiresAt ? c.data : null;
}

export function _npsSetCache(key: string, data: unknown) {
  _npsCache.delete(key);
  _npsCache.set(key, { data, expiresAt: Date.now() + 30_000 });
  pruneCache();
}
