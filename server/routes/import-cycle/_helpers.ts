/**
 * Shared state and helpers for the importCycleRoutes routes.
 *
 * Extracted verbatim from the former single-file importCycleRoutes.ts.
 */
import {} from "@shared/schema";

// ---------------------------------------------------------------------------
// Lightweight in-process TTL cache — same 30s pattern as statsRoutes.ts.
// Keyed by companyId. Multiple dashboard users share one DB round-trip.
// ---------------------------------------------------------------------------
export const _icCache = new Map<string, { data: unknown; expiresAt: number }>();
const MAX_CACHE_ENTRIES = 200;

function pruneCache(now = Date.now()): void {
  for (const [key, entry] of _icCache) {
    if (entry.expiresAt <= now) _icCache.delete(key);
  }
  while (_icCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = _icCache.keys().next().value;
    if (oldestKey === undefined) break;
    _icCache.delete(oldestKey);
  }
}
export function _getCached(key: string): unknown | null {
  const e = _icCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    _icCache.delete(key);
    return null;
  }
  return e.data;
}
export function _setCached(key: string, data: unknown, ttlMs = 30_000): void {
  _icCache.delete(key);
  _icCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  pruneCache();
}
