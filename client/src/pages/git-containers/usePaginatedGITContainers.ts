import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  canonicalApiUrl,
  canonicalSetValues,
  companyDataKey,
  frontendQueryPolicies,
  type CompanyIdentity,
  type QueryParams,
} from "@/lib/frontendDataArchitecture";
import { ContinuousListHttpError, fetchContinuousJson, withContinuousCursor } from "@/lib/continuousListClient";
import type { EnrichedContainerRow, EtaFilterValue, GitContainersResponse } from "./gitContainerTypes";

interface PaginatedContainerFilters {
  companyIdentity: CompanyIdentity;
  allCompanies: boolean;
  pageSize: number;
  companyFilter: string;
  containerFilters: string[];
  supplierFilters: string[];
  transporterFilters: string[];
  agentFilters: string[];
  truckFilters: string[];
  locationFilters: string[];
  docsFilter: string;
  delayedFilter: string;
  freightFilter: string;
  etaFilter: EtaFilterValue;
  notesFilter: string;
  sortOrder: string;
  search: string;
  enabled: boolean;
}

interface GitContinuousResponse {
  containers: EnrichedContainerRow[];
  mode: "single" | "all";
  companyId?: number;
  companyName?: string;
  total: number;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  asOf: string;
  summary?: GitContainersResponse["summary"];
  facets?: GitContainersResponse["facets"];
}

const GIT_SNAPSHOT_EXPIRED = "GIT_CONTINUOUS_SNAPSHOT_EXPIRED";

const compactSet = (values: readonly string[]): string | undefined => {
  const normalized = canonicalSetValues(values);
  return normalized.length > 0 ? normalized.join(",") : undefined;
};

function isExpiredSnapshotError(error: unknown): boolean {
  return error instanceof ContinuousListHttpError && error.code === GIT_SNAPSHOT_EXPIRED;
}

export function usePaginatedGITContainers(filters: PaginatedContainerFilters) {
  const debouncedSearch = useDebouncedValue(filters.search, 300);
  const handledSnapshotError = useRef<unknown>(null);
  const queryUrl = useMemo(() => {
    const etaDates = filters.etaFilter === "ALL" ? undefined : compactSet(filters.etaFilter.selectedDates);
    const params: QueryParams = {
      profile: "compact",
      allCompanies: filters.allCompanies ? true : undefined,
      company: filters.companyFilter !== "ALL" ? filters.companyFilter : undefined,
      containers: compactSet(filters.containerFilters),
      suppliers: compactSet(filters.supplierFilters),
      transporters: compactSet(filters.transporterFilters),
      agents: compactSet(filters.agentFilters),
      trucks: compactSet(filters.truckFilters),
      locations: compactSet(filters.locationFilters),
      docs: filters.docsFilter !== "ALL" ? filters.docsFilter : undefined,
      delayedState: filters.delayedFilter !== "ALL" ? filters.delayedFilter : undefined,
      freight: filters.freightFilter !== "ALL" ? filters.freightFilter : undefined,
      notes: filters.notesFilter !== "ALL" ? filters.notesFilter : undefined,
      sort: filters.sortOrder !== "DEFAULT" ? filters.sortOrder : undefined,
      search: debouncedSearch.trim() || undefined,
      etaDates,
      includeNoEta: filters.etaFilter !== "ALL" && filters.etaFilter.includeNoEta ? true : undefined,
    };
    return canonicalApiUrl("/api/git/containers", params);
  }, [
    filters.etaFilter,
    filters.allCompanies,
    filters.companyFilter,
    filters.containerFilters,
    filters.supplierFilters,
    filters.transporterFilters,
    filters.agentFilters,
    filters.truckFilters,
    filters.locationFilters,
    filters.docsFilter,
    filters.delayedFilter,
    filters.freightFilter,
    filters.notesFilter,
    filters.sortOrder,
    debouncedSearch,
  ]);

  const query = useInfiniteQuery({
    queryKey: companyDataKey(
      queryUrl,
      filters.companyIdentity,
      "git-containers",
      "continuous",
      filters.allCompanies ? "all-accessible" : "active-company"
    ),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchContinuousJson<GitContinuousResponse>(
        withContinuousCursor(queryUrl, { cursor: pageParam, limit: filters.pageSize }),
        { signal, fallbackError: "Failed to load containers" }
      ),
    getNextPageParam: (lastPage) => (lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined),
    enabled: filters.enabled,
    ...frontendQueryPolicies.operational,
    staleTime: 45_000,
    // An expired process-local snapshot cannot succeed by retrying the same
    // cursor. Fail it immediately so the recovery effect can restart at page 1.
    retry: (failureCount, error) => !isExpiredSnapshotError(error) && failureCount < 3,
  });

  const {
    data: infiniteData,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    refetch,
  } = query;

  // Once the first chunk paints, continue through the finite cursor chain automatically.
  // React Query passes an AbortSignal to every request, so changing scope/filters cancels
  // obsolete work instead of letting an old list keep downloading in the background.
  useEffect(() => {
    if (!filters.enabled || !hasNextPage || isFetchingNextPage || isError) return;
    void fetchNextPage();
  }, [filters.enabled, fetchNextPage, hasNextPage, isError, isFetchingNextPage]);

  // Tracking snapshots live in one server process and are intentionally bounded.
  // If a deploy, idle timeout, or process change invalidates the cursor mid-chain,
  // refetch the infinite query from its first page. TanStack then rebuilds existing
  // pages sequentially with fresh cursors, and the auto-advance effect resumes.
  useEffect(() => {
    if (!isExpiredSnapshotError(queryError)) {
      handledSnapshotError.current = null;
      return;
    }
    if (!filters.enabled || isFetching || handledSnapshotError.current === queryError) return;
    handledSnapshotError.current = queryError;
    void refetch({ cancelRefetch: true });
  }, [filters.enabled, isFetching, queryError, refetch]);

  const containers = useMemo(() => infiniteData?.pages.flatMap((page) => page.containers) ?? [], [infiniteData?.pages]);
  const firstPage = infiniteData?.pages[0];
  const data: GitContainersResponse | undefined = firstPage
    ? {
        containers,
        mode: firstPage.mode,
        companyId: firstPage.companyId,
        companyName: firstPage.companyName,
        total: firstPage.total,
        page: 1,
        pageSize: Math.max(containers.length, 1),
        totalPages: firstPage.total > 0 ? 1 : 0,
        hasMore: Boolean(hasNextPage),
        summary: firstPage.summary,
        facets: firstPage.facets,
      }
    : undefined;

  const loadContainerDetail = async (id: number, companyId: number): Promise<EnrichedContainerRow> => {
    const detailUrl = canonicalApiUrl(`/api/git/containers/${id}`, { companyId });
    const response = await fetch(detailUrl, { credentials: "include" });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({ message: "Failed to load container details" }))) as {
        message?: string;
      };
      throw new Error(body.message || "Failed to load container details");
    }
    return response.json() as Promise<EnrichedContainerRow>;
  };

  return { ...query, data, queryUrl, loadContainerDetail };
}
