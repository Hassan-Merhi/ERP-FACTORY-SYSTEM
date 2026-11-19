// Extracted from ./useFactoryDaybookModel.ts: Factory Daybook filters, paged query and entry state.
import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useDebounce } from "@/hooks/use-debounce";
import { useDaybookDayKeys } from "@/components/daybook/useDaybookDayKeys";
import type { DaybookEntry, DisplayEntry, FactoryDaybookUIState } from "./types";
import { parseBalesMeta, expandBaleEntries, formatDaybookDescription, formatTxType } from "./daybookUtils";
import { loadFactoryDaybookState } from "./daybookUiState";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";
import type { CondensedRow } from "./useFactoryDaybookModel";
import { shiftPeriod } from "./useFactoryDaybookModel";

export function useFactoryDaybookFiltersModel() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { formatDisplayDate, formatDisplayTime } = useDateFormat();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const appMode = useAppMode();
  const { selectedCompany } = useCompany();
  const routePrefix: "/properties" | "/factory" = appMode === "properties" ? "/properties" : "/factory";

  const { data: currentUser } = useQuery<{ id?: number; role?: string }>({ queryKey: ["/api/auth/me"] });
  const isAdminOrOwner =
    currentUser?.role === "Admin" || currentUser?.role === "Owner" || currentUser?.role === "Developer";

  // ── Filter state ──────────────────────────────────────────────────────────
  // Restore any saved session state directly in the initializers (not in a
  // post-mount useEffect) so the very first query fires once, with the right
  // dates/filters — never "today" followed immediately by a second, wider fetch.
  const initialDaybookStateRef = useRef<FactoryDaybookUIState | null>(loadFactoryDaybookState());
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(
    () => initialDaybookStateRef.current?.periodFilter || getDefaultPeriodValue("today")
  );
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [txTypeFilter, setTxTypeFilter] = useState(() => initialDaybookStateRef.current?.txTypeFilter || "ALL");
  const [currencyFilter, setCurrencyFilter] = useState(() => initialDaybookStateRef.current?.currencyFilter || "ALL");
  const [statusFilter, setStatusFilter] = useState<"all" | "exclude" | "only">(
    () => (initialDaybookStateRef.current?.statusFilter as "all" | "exclude" | "only") || "all"
  );
  const [searchQuery, setSearchQuery] = useState(() => initialDaybookStateRef.current?.searchQuery || "");
  const [minAmount, setMinAmount] = useState(() => initialDaybookStateRef.current?.minAmount || "");
  const [maxAmount, setMaxAmount] = useState(() => initialDaybookStateRef.current?.maxAmount || "");
  const [sortOrder] = useState<"asc" | "desc">(() => initialDaybookStateRef.current?.sortOrder || "desc");
  // searchQuery filters client-side only (not part of the query key below), but debounce
  // it anyway so rapid typing doesn't thrash the derived filteredEntries memo on large lists.
  const debouncedSearchQuery = useDebounce(searchQuery, 250);

  // ── View/UX state ─────────────────────────────────────────────────────────
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [selectedRowId] = useState<string | null>(null);
  const scrollYRef = useRef(0);

  // ── Dialog state ──────────────────────────────────────────────────────────
  const [editEntry, setEditEntry] = useState<DaybookEntry | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [editAmountCurrency, setEditAmountCurrency] = useState("");
  const [editAmountUsd, setEditAmountUsd] = useState("");
  const [editTxDate, setEditTxDate] = useState("");
  const [editReason, setEditReason] = useState("");
  const [costEditEntry, setCostEditEntry] = useState<DaybookEntry | null>(null);
  const [costEditAmount, setCostEditAmount] = useState("");
  const [costEditReason, setCostEditReason] = useState("");
  const [viewEntry, setViewEntry] = useState<DaybookEntry | null>(null);
  const [voidEntry, setVoidEntry] = useState<DaybookEntry | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<DaybookEntry | null>(null);
  const [isExportingDetailed, setIsExportingDetailed] = useState(false);
  const [urlEntryHandled, setUrlEntryHandled] = useState(false);

  // ── Derive API date params from periodFilter ──────────────────────────────
  const startDate = periodFilter.fromDate;
  const endDate = periodFilter.toDate;

  const stepPeriod = useCallback((days: number) => setPeriodFilter((prev) => shiftPeriod(prev, days)), []);

  // ── Keyboard date navigation ("-" / "+") ─────────────────────────────────
  useDaybookDayKeys(stepPeriod);

  // ── Scroll selected row into view ─────────────────────────────────────────
  useEffect(() => {
    if (!selectedRowId) return;
    const el = document.querySelector(`[data-row-id="${selectedRowId}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [selectedRowId]);

  // ── API query ─────────────────────────────────────────────────────────────
  const queryParams = new URLSearchParams();
  // Empty values are intentional: their presence prevents the paged backend
  // from applying its today-only default when the UI selects All Time.
  queryParams.set("startDate", startDate);
  queryParams.set("endDate", endDate);
  if (txTypeFilter !== "ALL") queryParams.set("txType", txTypeFilter);
  if (currencyFilter !== "ALL") queryParams.set("currencyCode", currencyFilter);
  if (statusFilter !== "all") queryParams.set("optionalStatus", statusFilter);
  if (debouncedSearchQuery.trim()) queryParams.set("search", debouncedSearchQuery.trim());
  if (minAmount.trim()) queryParams.set("minAmount", minAmount.trim());
  if (maxAmount.trim()) queryParams.set("maxAmount", maxAmount.trim());
  queryParams.set("sortOrder", sortOrder);

  const {
    data: entries = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<DaybookEntry[]>({
    queryKey: [
      "/api/factory/daybook",
      startDate,
      endDate,
      txTypeFilter,
      currencyFilter,
      statusFilter,
      debouncedSearchQuery,
      minAmount,
      maxAmount,
      sortOrder,
    ],
    queryFn: async ({ signal }) => {
      // Keep the table and totals hidden until every matching transaction is
      // available. The loader uses small server-side batches (not UI pagination)
      // and rejects incomplete results rather than showing misleading totals.
      const { fetchAllDaybookEntries } = await import("@/lib/daybookPaginationClient");
      return fetchAllDaybookEntries(new URLSearchParams(queryParams), signal);
    },
    // Avoid the bandwidth spike from constant refetching: the daybook list doesn't
    // need to be second-by-second live, and refocusing/reconnecting shouldn't
    // trigger a fresh multi-MB fetch every time.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Never show a previous date/company/filter's transactions while fetching.
  });

  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, true),
  });
  const hiddenErpCosts: string[] = myErpPages?.hiddenErpCostFields ?? [];
  const showAmounts = !hiddenErpCosts.includes("daybook_amounts");

  // Keep the type dropdown in sync with transactions that actually exist for
  // the selected company and date range. Unlike the full daybook query, this
  // metadata query remains small even with a large history or a type filter.
  const {
    data: availableTypeData,
    isSuccess: typeOptionsReady,
    isFetching: isFetchingTypeOptions,
  } = useQuery<{
    types: string[];
  }>({
    queryKey: ["/api/factory/daybook", "filter-options", startDate, endDate, currencyFilter],
    queryFn: async () => {
      const params = new URLSearchParams({
        filterOptions: "true",
        startDate: startDate || "",
        endDate: endDate || "",
      });
      if (currencyFilter !== "ALL") params.set("currencyCode", currencyFilter);
      const res = await fetch(`/api/factory/daybook?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load daybook filter options");
      const result: { types?: unknown } = await res.json();
      if (!Array.isArray(result.types)) throw new Error("Invalid daybook filter options");
      return { types: result.types.filter((type): type is string => typeof type === "string") };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const availableTxTypes = useMemo(
    () =>
      [
        ...new Set(
          (availableTypeData?.types ?? entries.map((entry) => entry.txType)).filter(
            (type) => type && type !== "WORKER_EDITED"
          )
        ),
      ].sort((a, b) => formatTxType(a).localeCompare(formatTxType(b))),
    [availableTypeData, entries]
  );

  // A type can disappear after moving to another date or after deleting the
  // last matching entry. Reset it so the user isn't stuck on an empty filter.
  useEffect(() => {
    if (
      typeOptionsReady &&
      !isFetchingTypeOptions &&
      txTypeFilter !== "ALL" &&
      !availableTxTypes.includes(txTypeFilter)
    ) {
      setTxTypeFilter("ALL");
    }
  }, [typeOptionsReady, isFetchingTypeOptions, txTypeFilter, availableTxTypes]);

  // ── URL deep link: ?entryId= or ?voucherId= on mount ─────────────────────
  useEffect(() => {
    if (urlEntryHandled || isLoading || entries.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const entryId = parseInt(params.get("entryId") ?? "");
    const voucherId = parseInt(params.get("voucherId") ?? "");
    if (!isNaN(entryId) && entryId !== 0) {
      const found = entries.find((e) => e.id === entryId);
      if (found) {
        setViewEntry(found);
        setUrlEntryHandled(true);
        const url = new URL(window.location.href);
        url.searchParams.delete("entryId");
        window.history.replaceState({}, "", url.toString());
      }
    } else if (!isNaN(voucherId) && voucherId !== 0) {
      const found = entries.find((e) => e.referenceId === voucherId);
      if (found) {
        setViewEntry(found);
        setUrlEntryHandled(true);
        const url = new URL(window.location.href);
        url.searchParams.delete("voucherId");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, [entries, isLoading, urlEntryHandled]);

  // ── Client-side filters (search, amount range, status) ────────────────────
  const filteredEntries = useMemo(() => {
    let result = entries;
    // Always hide worker edit audit entries
    result = result.filter((e) => e.txType !== "WORKER_EDITED");
    // Non-admins only see their own entries (View Only users are observers — they see everything)
    const ownEntriesUserId = currentUser?.id;
    if (!isAdminOrOwner && !isExistingRecordReadOnlyRole(currentUser?.role) && ownEntriesUserId) {
      result = result.filter((e) => e.createdBy === ownEntriesUserId);
    }
    if (statusFilter === "exclude") result = result.filter((e) => !e.optional);
    else if (statusFilter === "only") result = result.filter((e) => e.optional);
    if (debouncedSearchQuery.trim()) {
      result = result.filter((e) =>
        searchAny(debouncedSearchQuery, formatDaybookDescription(e), formatTxType(e.txType), e.txType)
      );
    }
    const minAmt = minAmount ? parseFloat(minAmount) : null;
    const maxAmt = maxAmount ? parseFloat(maxAmount) : null;
    if (minAmt !== null || maxAmt !== null) {
      result = result.filter((e) => {
        const amt = parseFloat(e.amountCurrency || "0");
        if (minAmt !== null && amt < minAmt) return false;
        if (maxAmt !== null && amt > maxAmt) return false;
        return true;
      });
    }
    result = [...result].sort((a, b) => {
      const aDate = a.effectiveDate || a.txDate;
      const bDate = b.effectiveDate || b.txDate;
      const dateCmp = aDate.localeCompare(bDate) || a.id - b.id;
      return sortOrder === "desc" ? -dateCmp : dateCmp;
    });
    return result;
  }, [
    entries,
    isAdminOrOwner,
    currentUser?.role,
    currentUser?.id,
    statusFilter,
    debouncedSearchQuery,
    minAmount,
    maxAmount,
    sortOrder,
  ]);

  // ── Condensed grouped rows ────────────────────────────────────────────────
  const condensedRows = useMemo(() => {
    const grouped: Record<string, CondensedRow> = {};
    filteredEntries.forEach((e) => {
      const eDate = e.effectiveDate || e.txDate;
      const key = `${eDate}|${e.txType}|${e.currencyCode}`;
      if (!grouped[key]) {
        grouped[key] = {
          date: eDate,
          txType: e.txType,
          currencyCode: e.currencyCode,
          count: 0,
          totalAmountCurrency: 0,
          fxRateToUsd: e.fxRateToUsd,
          totalAmountUsd: 0,
          key,
        };
      }
      // Count individual bales for BALE_STOCK_ENTRY so the count reflects bales not batches
      const baleCount = e.txType === "BALE_STOCK_ENTRY" ? Math.max(parseBalesMeta(e).length, 1) : 1;
      grouped[key].count += baleCount;
      grouped[key].totalAmountCurrency += parseFloat(e.amountCurrency || "0");
      grouped[key].totalAmountUsd += parseFloat(e.amountUsd || "0");
      if (grouped[key].fxRateToUsd !== e.fxRateToUsd) grouped[key].fxRateToUsd = null;
    });
    return Object.values(grouped).sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      return a.txType.localeCompare(b.txType);
    });
  }, [filteredEntries]);

  const getEntriesForCondensedRow = (rowKey: string): DisplayEntry[] => {
    const [date, txType, currencyCode] = rowKey.split("|");
    const raw = filteredEntries.filter(
      (e) => (e.effectiveDate || e.txDate) === date && e.txType === txType && e.currencyCode === currencyCode
    );
    if (txType === "BALE_STOCK_ENTRY") {
      return raw.map((e) => ({ ...e, _vKey: String(e.id), _source: e }) as DisplayEntry);
    }
    return expandBaleEntries(raw);
  };

  // ── Active filters detection ──────────────────────────────────────────────
  const hasActiveFilters =
    periodFilter.preset !== "today" ||
    txTypeFilter !== "ALL" ||
    currencyFilter !== "ALL" ||
    statusFilter !== "all" ||
    !!searchQuery ||
    !!minAmount ||
    !!maxAmount;

  return {
    wrapAdminAction,
    AdminDialog,
    formatDisplayDate,
    formatDisplayTime,
    toast,
    navigate,
    routePrefix,
    isAdminOrOwner,
    initialDaybookStateRef,
    periodFilter,
    setPeriodFilter,
    txTypeFilter,
    setTxTypeFilter,
    currencyFilter,
    setCurrencyFilter,
    statusFilter,
    setStatusFilter,
    searchQuery,
    setSearchQuery,
    minAmount,
    setMinAmount,
    maxAmount,
    setMaxAmount,
    sortOrder,
    expandedRowKey,
    setExpandedRowKey,
    scrollYRef,
    editEntry,
    setEditEntry,
    editDescription,
    setEditDescription,
    editAmountCurrency,
    setEditAmountCurrency,
    editAmountUsd,
    setEditAmountUsd,
    editTxDate,
    setEditTxDate,
    editReason,
    setEditReason,
    costEditEntry,
    setCostEditEntry,
    costEditAmount,
    setCostEditAmount,
    costEditReason,
    setCostEditReason,
    viewEntry,
    setViewEntry,
    voidEntry,
    setVoidEntry,
    deleteEntry,
    setDeleteEntry,
    isExportingDetailed,
    setIsExportingDetailed,
    stepPeriod,
    queryParams,
    isLoading,
    isError,
    error,
    refetch,
    showAmounts,
    availableTxTypes,
    filteredEntries,
    condensedRows,
    getEntriesForCondensedRow,
    hasActiveFilters,
  };
}
