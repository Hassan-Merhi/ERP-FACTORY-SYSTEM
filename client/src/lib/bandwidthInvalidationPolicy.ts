export type BandwidthCacheScope = "live" | "reference";
export type BandwidthInvalidationScope = "live" | "all";

export type BandwidthInvalidationMessage = {
  type: "invalidate";
  scope: BandwidthInvalidationScope;
};

export const BANDWIDTH_INVALIDATION_CHANNEL = "erp-bandwidth-cache-invalidation";

const FULL_INVALIDATION_WRITE_PATHS: readonly RegExp[] = [
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/csrf-token\/?$/,
  /^\/api\/admin(?:\/|$)/,
  /^\/api\/companies(?:\/|$)/,
  /^\/api\/user\/companies(?:\/|$)/,
  /^\/api\/user-preferences(?:\/|$)/,
  /^\/api\/company-settings(?:\/|$)/,
  /^\/api\/factory\/settings(?:\/|$)/,
  /^\/api\/factory\/my-access(?:\/|$)/,
  /^\/api\/locations(?:\/|$)/,
  /^\/api\/ledger-accounts(?:\/|$)/,
  /^\/api\/stock-items(?:\/|$)/,
  /^\/api\/employees(?:\/|$)/,
  /^\/api\/factory\/(?:employees|workers|users)(?:\/|$)/,
  /^\/api\/factory\/(?:bale-products|categories)(?:\/|$)/,
  /^\/api\/(?:customers|suppliers)(?:\/|$)/,
  /^\/api\/factory\/(?:customers|suppliers)(?:\/|$)/,
  /(?:^|\/)(?:set|switch|select|current)[-_]?(?:company|location)(?:\/|$)/i,
  /(?:^|\/)(?:company|location)[-_]?(?:switch|selection)(?:\/|$)/i,
];

/**
 * Ordinary vouchers, scans, transfers, order writes and customer-proforma
 * edits invalidate live balances/workflow snapshots only. Proforma writes used
 * to clear every reference cache, which repeatedly evicted large unrelated
 * catalogs such as /api/stock-items/light and /api/factory/bale-products.
 *
 * Authentication, company/location changes, settings/access changes and edits
 * to the reference data itself still clear every client read snapshot.
 */
export function getBandwidthInvalidationScope(pathname: string): BandwidthInvalidationScope {
  return FULL_INVALIDATION_WRITE_PATHS.some((pattern) => pattern.test(pathname)) ? "all" : "live";
}

export function shouldClearBandwidthEntry(
  entryScope: BandwidthCacheScope,
  invalidationScope: BandwidthInvalidationScope
): boolean {
  return invalidationScope === "all" || entryScope === "live";
}

/**
 * The read caches above are cleared by writes this browser tab makes itself.
 * A write made by another user in another session never passes through this
 * tab's fetch wrapper, so its realtime invalidation used to refetch straight
 * out of a snapshot that the write had just made wrong — the query refreshed
 * without a request and the screen kept the old numbers until the TTL expired.
 *
 * Each installed guard registers its own synchronous clear here so the
 * realtime path can drop those snapshots before React Query refetches. The
 * BroadcastChannel the guards already use delivers asynchronously, which is
 * fine between tabs but too late for the refetch that follows in this one.
 */
export type BandwidthCacheInvalidator = (scope: BandwidthInvalidationScope) => void;

const bandwidthCacheInvalidators = new Set<BandwidthCacheInvalidator>();

export function registerBandwidthCacheInvalidator(invalidator: BandwidthCacheInvalidator): () => void {
  bandwidthCacheInvalidators.add(invalidator);
  return () => {
    bandwidthCacheInvalidators.delete(invalidator);
  };
}

export function invalidateBandwidthReadCaches(scope: BandwidthInvalidationScope): void {
  for (const invalidator of [...bandwidthCacheInvalidators]) invalidator(scope);
}
