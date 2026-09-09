import type { QueryKey } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { isLiveTransactionalQueryKey, QUERY_STALE_TIMES } from "./queryPolicies";

interface LiveQueryState {
  dataUpdatedAt: number;
  fetchStatus: string;
  isInvalidated?: boolean;
}

interface LiveQueryOptions {
  refetchOnReconnect?: unknown;
  staleTime?: unknown;
}

export function shouldDefaultRefetchLiveQuery(queryKey: QueryKey): boolean {
  return isLiveTransactionalQueryKey(queryKey);
}

/**
 * Only legacy live queries that override the central reconnect/freshness policy
 * need the extra browser-online compatibility path. Normal live queries already
 * use TanStack Query's refetchOnReconnect hook and must not be woken twice.
 */
export function needsLegacyReconnectFallback(queryKey: QueryKey, options: LiveQueryOptions): boolean {
  if (!isLiveTransactionalQueryKey(queryKey)) return false;
  if (options.refetchOnReconnect === false) return true;
  return typeof options.staleTime === "number" && options.staleTime > QUERY_STALE_TIMES.live;
}

/**
 * React Query is intentionally configured to avoid broad remount/focus traffic.
 * Live transactional screens are the exception: if they were inactive while a
 * write event happened, a cached snapshot must not survive another navigation
 * for minutes simply because that page set a long local staleTime.
 */
export function shouldRefreshLiveQueryOnObserverAdd(
  queryKey: QueryKey,
  state: LiveQueryState,
  now = Date.now()
): boolean {
  if (!isLiveTransactionalQueryKey(queryKey)) return false;
  if (state.fetchStatus === "fetching") return false;
  // A query with no data is already fetched by its observer's normal mount path.
  if (!state.dataUpdatedAt) return false;
  if (state.isInvalidated) return true;
  return now - state.dataUpdatedAt >= QUERY_STALE_TIMES.live;
}

let installed = false;

export function installLiveQueryRuntimePolicy(): void {
  if (installed) return;
  installed = true;

  // Wire the policy into TanStack Query itself. This fixes the common path for
  // every live family while preserving the repository-wide no-focus-refetch rule.
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: {
      ...defaults.queries,
      refetchOnMount: (query) => shouldDefaultRefetchLiveQuery(query.queryKey),
      refetchOnReconnect: (query) => shouldDefaultRefetchLiveQuery(query.queryKey),
    },
  });

  // A few older heavy pages explicitly override refetchOnMount=false and carry
  // local 10-minute staleTime values. The observer hook is a narrow compatibility
  // bridge: once their live snapshot is older than the central 15-second policy,
  // fetch it on the next mount despite that legacy local override.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "observerAdded") return;
    const query = event.query;
    if (!shouldRefreshLiveQueryOnObserverAdd(query.queryKey, query.state)) return;

    // Let the observer finish mounting before the recovery fetch. Recheck state
    // so a normal query fetch that started in the meantime is never duplicated.
    setTimeout(() => {
      if (query.getObserversCount() <= 0) return;
      if (!shouldRefreshLiveQueryOnObserverAdd(query.queryKey, query.state)) return;
      void query.fetch();
    }, 0);
  });

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      // TanStack handles normal live queries through refetchOnReconnect. Defer the
      // compatibility pass one tick so any standard reconnect fetch starts first,
      // then only recover active legacy queries that are still centrally stale.
      setTimeout(() => {
        void queryClient.invalidateQueries({
          predicate: (query) =>
            needsLegacyReconnectFallback(query.queryKey, query.options) &&
            shouldRefreshLiveQueryOnObserverAdd(query.queryKey, query.state),
          refetchType: "active",
        });
      }, 0);
    });
  }
}

installLiveQueryRuntimePolicy();
