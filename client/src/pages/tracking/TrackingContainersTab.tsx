import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { isAbortError } from "@/lib/abortError";
import GITContainers from "@/pages/GITContainers";

/**
 * Containers OTW loads a large, company-scoped query. Two things used to leave
 * the tab stuck on "Failed to load containers — The operation was aborted.":
 *
 * 1. A query started for the previous company was still in the cache when the
 *    active company changed, so the tab mounted against a request that was
 *    about to be cancelled.
 * 2. An aborted request is not a failure — nobody asked for that error — but it
 *    still settles the query into an error state, and with no refetch on mount
 *    the tab stays on the error screen until a manual reload.
 *
 * The boundary below cancels and drops stale company queries before mounting,
 * and resets any query that ends up carrying an AbortError. Each query hash is
 * recovered once so a genuinely failing request cannot spin.
 */
export default function TrackingContainersTab() {
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const companyId = selectedCompany?.id ?? null;
  const [readyCompanyId, setReadyCompanyId] = useState<number | null>(null);
  const recoveringRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (companyId === null) {
      setReadyCompanyId(null);
      return;
    }
    if (readyCompanyId === companyId) return;

    let cancelled = false;
    // Only company-scoped entries are stale here. The all-companies view keys on
    // the user instead, so it is left alone rather than being dropped on mount.
    const staleContainerQuery = (queryKey: readonly unknown[]): boolean =>
      typeof queryKey[0] === "string" &&
      queryKey[0].startsWith("/api/git/containers") &&
      typeof queryKey[1] === "number" &&
      queryKey[1] !== companyId;

    void (async () => {
      await queryClient.cancelQueries({ predicate: (query) => staleContainerQuery(query.queryKey) });
      queryClient.removeQueries({ predicate: (query) => staleContainerQuery(query.queryKey) });
      if (!cancelled) {
        recoveringRef.current.clear();
        setReadyCompanyId(companyId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [companyId, queryClient, readyCompanyId]);

  useEffect(() => {
    const recovering = recoveringRef.current;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      const query = event.query;
      if (!query || query.state.status !== "error") return;
      if (typeof query.queryKey[0] !== "string" || !query.queryKey[0].startsWith("/api/git/containers")) return;
      if (!isAbortError(query.state.error)) return;
      if (recovering.has(query.queryHash)) return;

      recovering.add(query.queryHash);
      void queryClient.resetQueries({ queryKey: query.queryKey, exact: true });
    });

    return () => {
      unsubscribe();
    };
  }, [queryClient]);

  if (companyId === null || readyCompanyId !== companyId) return null;

  // The same ERP table now includes SP rows from the read-only GIT projection.
  // Negative synthetic ids disambiguate SP and ERP container records.
  return <GITContainers key={`tracking-containers-${companyId}`} embedded />;
}
