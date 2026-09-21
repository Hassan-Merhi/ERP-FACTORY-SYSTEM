/**
 * Shared state and helpers for the factoryBalesRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryBalesRoutes.ts.
 */

// ---------------------------------------------------------------------------
// Lightweight in-process TTL cache for expensive dashboard KPI endpoint
// ---------------------------------------------------------------------------
export const _kpiCache = new Map<string, { data: unknown; expiresAt: number }>();
const MAX_CACHE_ENTRIES = 200;

function pruneCache(now = Date.now()): void {
  for (const [key, entry] of _kpiCache) {
    if (entry.expiresAt <= now) _kpiCache.delete(key);
  }
  while (_kpiCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = _kpiCache.keys().next().value;
    if (oldestKey === undefined) break;
    _kpiCache.delete(oldestKey);
  }
}
export function _getKpiCached(key: string): unknown | null {
  const e = _kpiCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    _kpiCache.delete(key);
    return null;
  }
  return e.data;
}
export function _setKpiCached(key: string, data: unknown, ttlMs = 30_000): void {
  _kpiCache.delete(key);
  _kpiCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  pruneCache();
}
