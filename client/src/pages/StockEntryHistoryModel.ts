// Extracted from ./StockEntryHistory.tsx: state, queries and handlers for StockEntryHistory.
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { canUseFactorySurface } from "@/lib/factoryClientAccess";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { fetchProduction, type ProductionResponse } from "./factory/factoryProductionTargetsModel";
import type { StockEntryWorker } from "./stockentryhistory/derived";
import type { BaleDetail, GroupRow, StockEntryHistoryPage, StockEntryHistoryProps } from "./stockentryhistory/types";
import { buildStockEntryWorkerGroups, buildStockEntryWorkerTargets } from "./stockEntryHistoryWorkerGroups";
import { createStockEntryHistoryGroupBaleHelpers, groupKey } from "./stockentryhistory/groupBaleHelpers";
import { useStockEntryHistoryMutations } from "./stockentryhistory/useStockEntryHistoryMutations";
import { fetchAllStockEntryHistoryPages } from "./stockentryhistory/utils";

export function useStockEntryHistoryModel({
  onActiveDateChange,
}: {
  onActiveDateChange: StockEntryHistoryProps["onActiveDateChange"];
}) {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60_000,
  });
  const companyAccess = myAccess?.companyId === selectedCompany?.id && selectedCompany?.id ? myAccess : undefined;
  const canReadWorkerPicker =
    canUseFactorySurface(companyAccess, "factory/stock-entry", ["hide_tab_stockentry_history"]) ||
    canUseFactorySurface(companyAccess, "factory/payroll-hub", ["hide_tab_payrollhub_workers"]);
  const canReadProductionTargets = canUseFactorySurface(companyAccess, "factory/stock-entry", [
    "hide_tab_stockentry_production_targets",
  ]);
  const today = new Date().toLocaleDateString("en-CA");

  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [selectedWorkerId, setSelectedWorkerId] = useState("all");
  const dateRangeValid = !!fromDate && !!toDate && fromDate <= toDate;
  const isSingleDay = dateRangeValid && fromDate === toDate;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [includeUnassigned, setIncludeUnassigned] = useState(true);
  const [editingDateKey, setEditingDateKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"condensed" | "detailed">("condensed");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    onActiveDateChange?.(isSingleDay ? fromDate : null);
  }, [onActiveDateChange, isSingleDay, fromDate]);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timeout);
  }, [search]);

  const useLite = viewMode === "condensed";
  const params = new URLSearchParams();
  if (dateRangeValid) {
    params.set("startDate", fromDate);
    params.set("endDate", toDate);
  }
  if (selectedWorkerId !== "all") params.set("workerId", selectedWorkerId);
  if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
  if (!includeUnassigned) params.set("includeUnassigned", "false");
  if (useLite) params.set("lite", "1");
  params.set("limit", "250");

  const {
    data: historyPages,
    isLoading,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery<StockEntryHistoryPage, Error>({
    queryKey: companyQueryKey("/api/factory/bales/stock-entry-history", selectedCompany?.id, params.toString()),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const pageParams = new URLSearchParams(params);
      pageParams.set("page", String(pageParam));
      const response = await fetch(`/api/factory/bales/stock-entry-history?${pageParams.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`Stock entry history failed: ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error("Invalid response: items is not an array");
      return data as StockEntryHistoryPage;
    },
    getNextPageParam: (lastPage) => (lastPage.hasNextPage ? lastPage.page + 1 : undefined),
    enabled: Boolean(selectedCompany?.id) && dateRangeValid,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element || !hasNextPage || isFetchingNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void fetchNextPage();
      },
      { rootMargin: "300px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, viewMode]);

  const firstPage = historyPages?.pages[0];
  const groups: GroupRow[] = useMemo(() => historyPages?.pages.flatMap((page) => page.items) ?? [], [historyPages]);
  const allBales = useMemo(() => groups.flatMap((group) => group.bales ?? []), [groups]);
  const totalBales = useMemo(() => groups.reduce((sum, group) => sum + group.baleCount, 0), [groups]);
  const totalWeight = useMemo(
    () => groups.reduce((sum, group) => sum + parseFloat(group.totalWeight || "0"), 0),
    [groups]
  );

  const { data: workers = [] } = useQuery<StockEntryWorker[]>({
    queryKey: companyQueryKey("/api/factory/workers?profile=picker", selectedCompany?.id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled: canReadWorkerPicker,
  });

  const targetDate = isSingleDay ? fromDate : null;
  const { data: productionTargets } = useQuery<ProductionResponse>({
    // prettier-ignore
    queryKey: companyQueryKey("/api/factory/staff-tracking", selectedCompany?.id, "production", "daily", targetDate, targetDate),
    queryFn: () => fetchProduction("daily", targetDate!, targetDate!),
    enabled: canReadProductionTargets && Boolean(targetDate),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const workerTargets = useMemo(() => buildStockEntryWorkerTargets(productionTargets), [productionTargets]);

  const workerGroups = useMemo(
    () => buildStockEntryWorkerGroups(groups, workerTargets, workers),
    [groups, workerTargets, workers]
  );

  const expandedGroupBaleKeys = useMemo(
    () => Array.from(expandedKeys).filter((key) => key.endsWith("-bales")),
    [expandedKeys]
  );
  const groupBaleQueries = useQueries({
    queries: expandedGroupBaleKeys.map((key) => {
      const baseKey = key.replace(/-bales$/, "");
      const group = groups.find((item) => groupKey(item) === baseKey);
      if (!group) {
        return {
          queryKey: ["stock-entry-history", selectedCompany?.id ?? "no-company", "missing-group", key],
          queryFn: async () => [] as BaleDetail[],
          enabled: false,
        };
      }

      const groupParams = new URLSearchParams();
      groupParams.set("startDate", group.stockEntryDate);
      groupParams.set("endDate", group.stockEntryDate);
      if (group.workerId) groupParams.set("workerId", String(group.workerId));
      if (group.productId) groupParams.set("productId", String(group.productId));
      if (group.erpLocationId) groupParams.set("locationId", String(group.erpLocationId));
      if (debouncedSearch.trim()) groupParams.set("search", debouncedSearch.trim());

      return {
        queryKey: companyQueryKey(
          "/api/factory/bales/stock-entry-history/group",
          selectedCompany?.id,
          groupParams.toString()
        ),
        queryFn: (): Promise<BaleDetail[]> =>
          fetchAllStockEntryHistoryPages(groupParams).then((rows) => rows.flatMap((item) => item.bales ?? [])),
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        enabled: useLite && Boolean(selectedCompany?.id),
      };
    }),
  });

  const { getGroupBales, resolveGroupBaleIds, isGroupBalesLoading } = createStockEntryHistoryGroupBaleHelpers({
    useLite,
    expandedGroupBaleKeys,
    groupBaleQueries,
    queryClient,
    params,
    companyId: selectedCompany?.id,
  });

  function toggleExpand(key: string) {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const { updateDateMutation, bulkAssignMutation } = useStockEntryHistoryMutations({
    fromActive: isSingleDay,
    fromDate: fromDate || today,
    today,
    setEditingDateKey,
  });

  return {
    formatDisplayDate,
    toast,
    fromDate,
    setFromDate,
    toDate,
    setToDate,
    selectedWorkerId,
    setSelectedWorkerId,
    dateRangeValid,
    loadMoreRef,
    search,
    setSearch,
    includeUnassigned,
    setIncludeUnassigned,
    editingDateKey,
    setEditingDateKey,
    viewMode,
    setViewMode,
    expandedKeys,
    historyPages,
    isLoading,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    firstPage,
    groups,
    allBales,
    totalBales,
    totalWeight,
    workers,
    workerTargets,
    workerGroups,
    getGroupBales,
    resolveGroupBaleIds,
    isGroupBalesLoading,
    toggleExpand,
    updateDateMutation,
    bulkAssignMutation,
  };
}

export type StockEntryHistoryModel = ReturnType<typeof useStockEntryHistoryModel>;
