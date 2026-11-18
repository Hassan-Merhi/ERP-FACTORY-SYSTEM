// Extracted from ./use-ws-invalidation.ts to keep that module under the source-size cap.
import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeInvalidationMessage, RealtimeInvalidationTopic } from "@shared/realtimeInvalidation";
import type { BandwidthInvalidationScope } from "@/lib/bandwidthInvalidationPolicy";
import { isFxRateDependentQuery } from "@shared/fxRateQueryInvalidation";

// Heavy analytical queries that are intentionally excluded from automatic WS invalidation.
// These are expensive to compute, have a manual Refresh button, and should not jump
// around every time any write happens anywhere in the system.
const STABLE_QUERY_PREFIXES = [
  "/api/auth/me", // staleTime=Infinity on purpose — spurious auth re-checks cause login redirects
  "/api/stats/net-profit", // full balance-sheet computation; user refreshes manually
  "/api/reports/net-profit-statement", // P&L report; heavy computation
  "/api/balance-sheet", // balance sheet; heavy computation
  "/api/factory/v5/stock-allocation", // ~543 KB response; refresh explicitly after allocation-affecting mutations/manual refresh
];

const TOPIC_QUERY_PREFIXES: Record<RealtimeInvalidationTopic, readonly string[]> = {
  inventory: [
    "/api/locations",
    "/api/inventory",
    "/api/stock",
    "/api/bales",
    "/api/location-inventory",
    "/api/factory/ground-scan-items",
    "/api/factory/stock-entry/in-stock-locations",
  ],
  pos: [
    "/api/pos",
    "/api/sales",
    "/api/dashboard",
    "/api/pending-loadings",
    "/api/factory/ground-scan-items",
    "/api/factory/stock-entry/in-stock-locations",
  ],
  fx: [], // matched via the exact-path predicate, not a broad topic prefix
  accounting: [
    "/api/accounts",
    "/api/voucher",
    "/api/ledger",
    "/api/daybook",
    "/api/factory/daybook",
    "/api/fiscal-transfers",
    "/api/global-transactions",
    "/api/global/transactions",
    "/api/credit-notes",
    "/api/stats",
    "/api/reports/net-position",
    "/api/reports/net-profit",
    "/api/balance-sheet",
    "/api/dashboard-payable-accounts",
    "/api/factory/customers", // This list includes live account balances.
  ],
  factory: ["/api/factory/"],
  scans: ["/api/factory/daily-bale-scans", "/api/factory/ground-scan-items"],
  payroll: ["/api/factory/payroll", "/api/factory-payroll"],
  containers: [
    "/api/containers",
    "/api/import",
    "/api/sp/",
    "/api/supplier-proforma",
    "/api/factory/ground-scan-items",
  ],
  reference: [
    "/api/suppliers",
    "/api/customers",
    "/api/employees",
    "/api/locations",
    "/api/stock-groups",
    "/api/stock-categories",
    "/api/stock-grades",
    "/api/stock-items",
    "/api/ledger-accounts",
    "/api/bank-accounts",
    "/api/fixed-assets",
    "/api/company-settings",
    "/api/user/preferences",
    "/api/factory/bale-products",
    "/api/factory/categories",
    "/api/factory/settings",
    "/api/factory/my-access",
    "/api/factory/users",
    "/api/factory/customers",
    "/api/factory/suppliers",
    "/api/factory/workers",
    "/api/factory/employees",
    "/api/factory/worker-categories",
    "/api/factory/cash-accounts",
  ],
  communications: [
    "/api/notifications",
    "/api/intercompany-notifications",
    "/api/business-alerts",
    "/api/chat",
    "/api/user-notes",
  ],
  presence: ["/api/user-presence"],
};

// Normal writes should feel live. A short trailing debounce still folds an import,
// POS rush, or bulk edit into one refresh round instead of one round per write.
export const INVALIDATE_DEBOUNCE_MS = 400;

export const RECONNECT_BASE_DELAY_MS = 1_500;

export const RECONNECT_MAX_DELAY_MS = 30_000;

export const OFFLINE_PROBE_DELAY_MS = 30_000;

export const RECONNECT_JITTER_RATIO = 0.2;

type RealtimeConnectionStatus = "connecting" | "ready" | "disconnected";

export interface PendingInvalidation {
  blanket: boolean;
  topics: Set<RealtimeInvalidationTopic>;
  locationIds: Set<number>;
  hasUnscopedLocation: boolean;
}

export function createPendingInvalidation(): PendingInvalidation {
  return {
    blanket: false,
    topics: new Set<RealtimeInvalidationTopic>(),
    locationIds: new Set<number>(),
    hasUnscopedLocation: false,
  };
}

// Multiple React surfaces may mount this hook in the same browser tab. Keep a
// single module-level socket and reference-count subscribers by QueryClient so
// child-first effect ordering cannot steal ownership from the app shell. The
// socket lives until the last subscriber unmounts.
export const subscribers = new Map<QueryClient, number>();

export let pendingInvalidation = createPendingInvalidation();

export function setRealtimeConnectionStatus(status: RealtimeConnectionStatus): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.realtimeStatus = status;
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(new CustomEvent("erp:realtime-status", { detail: { status } }));
  }
}

function isStableQueryKey(key: string): boolean {
  return STABLE_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function explicitLocationIdFromKey(key: string): number | null {
  const pathMatch = key.match(/^\/api\/locations\/(\d+)(?:\/|$|\?)/);
  if (pathMatch) return Number(pathMatch[1]);

  const queryMatch = key.match(/[?&](?:locationId|location_id)=(\d+)(?:&|$)/);
  return queryMatch ? Number(queryMatch[1]) : null;
}

export function queryMatchesPendingInvalidation(
  query: { queryKey: readonly unknown[] },
  invalidation: PendingInvalidation
): boolean {
  const key = query.queryKey[0];
  if (typeof key !== "string") return true;
  // Heavy reports generally refresh manually, but a committed FX rate is an
  // explicit monetary-valuation revision: even mounted stable current-USD
  // reports must update. Other accounting writes retain the old safeguard.
  if (isStableQueryKey(key) && !(invalidation.topics.has("fx") && isFxRateDependentQuery(query.queryKey))) return false;
  if (invalidation.blanket) return true;

  const isReferenceQuery = TOPIC_QUERY_PREFIXES.reference.some((prefix) => key.startsWith(prefix));
  const matchesTopic = [...invalidation.topics].some((topic) => {
    if (topic === "factory" && isReferenceQuery && !invalidation.topics.has("reference")) return false;
    if (topic === "fx") return isFxRateDependentQuery(query.queryKey);
    return TOPIC_QUERY_PREFIXES[topic].some((prefix) => key.startsWith(prefix));
  });
  if (!matchesTopic) return false;

  if (!invalidation.hasUnscopedLocation && invalidation.locationIds.size > 0) {
    const queryLocationId = explicitLocationIdFromKey(key);
    if (queryLocationId !== null && !invalidation.locationIds.has(queryLocationId)) return false;
  }

  return true;
}

export function resetPendingInvalidation(): void {
  pendingInvalidation = createPendingInvalidation();
}

export function mergePendingInvalidation(message: RealtimeInvalidationMessage): void {
  if (!message.topics?.length) {
    pendingInvalidation.blanket = true;
    return;
  }

  for (const topic of message.topics) pendingInvalidation.topics.add(topic);

  if (!message.locationIds?.length) {
    pendingInvalidation.hasUnscopedLocation = true;
    return;
  }
  for (const locationId of message.locationIds) pendingInvalidation.locationIds.add(locationId);
}

/**
 * The bandwidth read caches only see writes this tab makes itself, so a write
 * from another session leaves them holding a snapshot the write invalidated.
 * Reference entries are long-lived and are only dropped when the change can
 * actually have touched reference data.
 */
export function bandwidthScopeFor(invalidation: PendingInvalidation): BandwidthInvalidationScope {
  if (invalidation.blanket) return "all";
  // A rate revision may reprice cached account/customer reference reads as
  // well as live financial snapshots. Flush both browser cache layers.
  return invalidation.topics.has("reference") || invalidation.topics.has("fx") ? "all" : "live";
}
