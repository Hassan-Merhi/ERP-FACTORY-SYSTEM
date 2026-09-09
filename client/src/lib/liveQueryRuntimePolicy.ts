import type { QueryKey } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { isLiveTransactionalQueryKey, QUERY_STALE_TIMES } from "./queryPolicies";

interface LiveQueryState {
  dataUpdatedAt: number;
  fetchStatus: string;
  isInvalidated?: boolean;
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
      void queryClient.invalidateQueries({
        predicate: (query) => isLiveTransactionalQueryKey(query.queryKey),
        refetchType: "active",
      });
    });
  }
}

installLiveQueryRuntimePolicy();
