import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
/**
 * Controller hook for the Factory Daybook page.
 *
 * Holds every piece of state, query, mutation and handler the page had inline.
 * The page shell and its child views are pure presentation over this model, so
 * filtering, permissions, session persistence, exports and the voucher/cost
 * mutations all keep their original semantics in one place.
 */
import { useState, useMemo, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { addDays, format } from "date-fns";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useAppMode } from "@/contexts/AppModeContext";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import type { DaybookEntry, DisplayEntry, FactoryDaybookUIState } from "./types";
import {
  parseBalesMeta,
  expandBaleEntries,
  formatDaybookDescription,
  formatTxType,
  VOUCHER_TX_TYPES,
} from "./daybookUtils";
import { FACTORY_DAYBOOK_STATE_KEY, loadFactoryDaybookState, saveFactoryDaybookState } from "./daybookUiState";
import { exportFactoryDaybookDetailed, exportFactoryDaybookSummary } from "./factoryDaybookExports";

export interface CondensedRow {
  date: string;
  txType: string;
  currencyCode: string;
  count: number;
  totalAmountCurrency: number;
  fxRateToUsd: string | null;
  totalAmountUsd: number;
  key: string;
}

const CONTAINER_COST_TX_TYPES = new Set(["OFFLOAD_RAW_STOCK", "FREIGHT", "COMMISSION", "DUTY", "OTHER_CHARGE"]);

const DATE_FMT = "yyyy-MM-dd";

function shiftPeriod(prev: PeriodFilterValue, days: number): PeriodFilterValue {
  return {
    fromDate: format(addDays(new Date(prev.fromDate + "T00:00:00"), days), DATE_FMT),
    toDate: format(addDays(new Date(prev.toDate + "T00:00:00"), days), DATE_FMT),
    preset: "custom",
  };
}

export function useFactoryDaybookModel() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { formatDisplayDate, formatDisplayTime } = useDateFormat();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const appMode = useAppMode();
  const routePrefix = appMode === "properties" ? "/properties" : "/factory";

  const { data: currentUser } = useQuery<{ id?: number; role?: string }>({ queryKey: ["/api/auth/me"] });
  const isAdminOrOwner =
    currentUser?.role === "Admin" || currentUser?.role === "Owner" || currentUser?.role === "Developer";

  // ── Filter state ──────────────────────────────────────────────────────────
  // Restore any saved session state directly in the initializers (not in a
  // post-mount useEffect) so the very first query fires once, with the right
  // dates/filters — never "today" followed immediately by a second, wider fetch.
  const initialDaybookStateRef = useRef<FactoryDaybookUIState | null>(loadFactoryDaybookState());
  const [activeDaybookTab, setActiveDaybookTab] = useState<"transactions" | "activity">("transactions");
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
  const [sortOrder, _setSortOrder] = useState<"asc" | "desc">(
    () => initialDaybookStateRef.current?.sortOrder || "desc"
  );
  // searchQuery filters client-side only (not part of the query key below), but debounce
  // it anyway so rapid typing doesn't thrash the derived filteredEntries memo on large lists.
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(searchQuery);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchQuery(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

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

  const stepPeriod = (days: number) => setPeriodFilter((prev) => shiftPeriod(prev, days));

  // ── Keyboard date navigation ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasAnyOpenDialog()) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const isBack = e.key === "-" || e.code === "Minus";
      const isForward = (e.key === "+" && e.shiftKey) || (e.code === "Equal" && e.shiftKey) || e.key === "=";
      if (isBack) {
        e.preventDefault();
        setPeriodFilter((prev) => shiftPeriod(prev, -1));
      } else if (isForward) {
        e.preventDefault();
        setPeriodFilter((prev) => shiftPeriod(prev, 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // ── Scroll selected row into view ─────────────────────────────────────────
  useEffect(() => {
    if (!selectedRowId) return;
    const el = document.querySelector(`[data-row-id="${selectedRowId}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [selectedRowId]);

  // ── API query ─────────────────────────────────────────────────────────────
  const queryParams = new URLSearchParams();
  // Always send startDate/endDate explicitly — including as empty strings for the
  // "All Time" preset — so the server can tell "user explicitly wants all time" apart
  // from "caller omitted the params entirely" (e.g. a raw API call) and only applies
  // its own safety-net default in the latter case.
  queryParams.set("startDate", startDate || "");
  queryParams.set("endDate", endDate || "");
  if (txTypeFilter !== "ALL") queryParams.set("txType", txTypeFilter);
  if (currencyFilter !== "ALL") queryParams.set("currencyCode", currencyFilter);

  const {
    data: entries = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<DaybookEntry[]>({
    queryKey: ["/api/factory/daybook", startDate, endDate, txTypeFilter, currencyFilter],
    queryFn: async () => {
      const res = await fetch(`/api/factory/daybook?${queryParams.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch daybook");
      return res.json();
    },
    // Avoid the bandwidth spike from constant refetching: the daybook list doesn't
    // need to be second-by-second live, and refocusing/reconnecting shouldn't
    // trigger a fresh multi-MB fetch every time.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: (prev) => prev,
  });

  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({ queryKey: ["/api/my-erp-pages"] });
  const hiddenErpCosts: string[] = myErpPages?.hiddenErpCostFields ?? [];
  const showAmounts = !hiddenErpCosts.includes("daybook_amounts");

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
    if (!isAdminOrOwner && currentUser?.role !== "View Only" && ownEntriesUserId) {
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

  const clearFilters = () => {
    setPeriodFilter(getDefaultPeriodValue("today"));
    setTxTypeFilter("ALL");
    setCurrencyFilter("ALL");
    setStatusFilter("all");
    setSearchQuery("");
    setMinAmount("");
    setMaxAmount("");
  };

  // ── Session persistence: restore scroll position on mount ─────────────────
  // Filter/period state is now restored directly in the useState initializers
  // above (see initialDaybookStateRef) so the query doesn't fire twice on
  // mount — once for the "today" default, then again for the restored range.
  useEffect(() => {
    const scrollY = initialDaybookStateRef.current?.scrollY || 0;
    if (!scrollY) return;
    requestAnimationFrame(() => {
      window.scrollTo({ top: scrollY, behavior: "instant" as ScrollBehavior });
    });
  }, []);

  // ── Session persistence: save on every state change ───────────────────────
  useEffect(() => {
    saveFactoryDaybookState({
      periodFilter,
      txTypeFilter,
      currencyFilter,
      statusFilter,
      searchQuery,
      minAmount,
      maxAmount,
      sortOrder,
      scrollY: scrollYRef.current,
    });
  }, [periodFilter, txTypeFilter, currencyFilter, statusFilter, searchQuery, minAmount, maxAmount, sortOrder]);

  // ── Session persistence: track scroll ────────────────────────────────────
  useEffect(() => {
    const handleScroll = () => {
      scrollYRef.current = window.scrollY;
      try {
        const raw = sessionStorage.getItem(FACTORY_DAYBOOK_STATE_KEY);
        if (raw) {
          const state = JSON.parse(raw);
          state.scrollY = window.scrollY;
          sessionStorage.setItem(FACTORY_DAYBOOK_STATE_KEY, JSON.stringify(state));
        }
      } catch {
        // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // ── Session persistence: clear on unmount if leaving daybook flow ─────────
  useEffect(() => {
    return () => {
      const path = window.location.pathname;
      const isDaybookFlow =
        path.includes("/factory/daybook") ||
        path.includes("/factory/vouchers") ||
        path.includes("/properties/daybook") ||
        path.includes("/properties/vouchers");
      if (!isDaybookFlow) sessionStorage.removeItem(FACTORY_DAYBOOK_STATE_KEY);
    };
  }, []);

  const warnNothingToExport = () => {
    toast({
      title: "No data to export",
      description: "No entries found for the current filters.",
      variant: "destructive",
    });
  };

  // ── Excel export: summary ─────────────────────────────────────────────────
  const handleExportToExcel = async () => {
    if (filteredEntries.length === 0) {
      warnNothingToExport();
      return;
    }
    const { fileName, rowCount } = await exportFactoryDaybookSummary(filteredEntries, formatDisplayDate);
    toast({
      title: "Export successful",
      description: `Downloaded ${fileName} with ${rowCount} entries.`,
    });
  };

  // ── Excel export: detailed (with voucher debit/credit entries) ────────────
  const handleExportDetailedToExcel = async () => {
    if (filteredEntries.length === 0) {
      warnNothingToExport();
      return;
    }
    setIsExportingDetailed(true);
    try {
      const { fileName, rowCount } = await exportFactoryDaybookDetailed(filteredEntries, formatDisplayDate);
      toast({ title: "Export successful", description: `Downloaded ${fileName} with ${rowCount} entries.` });
    } catch (_error) {
      toast({ title: "Export failed", description: "An error occurred while exporting.", variant: "destructive" });
    } finally {
      setIsExportingDetailed(false);
    }
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const editMutation = useMutation({
    mutationFn: async ({ entryId, data }: { entryId: number; data: unknown }) => {
      const res = await factoryApiRequest("PUT", `/api/factory/daybook/${entryId}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      setEditEntry(null);
      setEditReason("");
      toast({ title: "Entry updated", description: "Description synced to source record." });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const voidMutation = useMutation({
    mutationFn: async (entryId: number) => {
      const res = await factoryApiRequest("DELETE", `/api/factory/daybook/entry/${entryId}/void`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      setVoidEntry(null);
      toast({ title: "Voucher voided", description: "All accounting entries have been reversed." });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Void failed", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (entryId: number) => {
      const res = await factoryApiRequest("DELETE", `/api/factory/daybook/entry/${entryId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      setDeleteEntry(null);
      toast({ title: "Entry deleted", description: "The daybook entry has been permanently removed." });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    },
  });

  const isCostEditable = (entry: DaybookEntry) => {
    if (!isAdminOrOwner) return false;
    if (!CONTAINER_COST_TX_TYPES.has(entry.txType)) return false;
    if (entry.id < 0) return false; // synthetic/voucher rows
    if (entry.referenceTable === "vouchers") return false;
    return true;
  };

  const costEditMutation = useMutation({
    mutationFn: async ({ entryId, newAmount, reason }: { entryId: number; newAmount: string; reason: string }) => {
      const res = await factoryApiRequest("PATCH", `/api/factory/daybook/${entryId}/cost-edit`, { newAmount, reason });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update cost");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      setCostEditEntry(null);
      setCostEditAmount("");
      setCostEditReason("");
      toast({ title: "Cost updated", description: data.message || "Container costs recalculated and cascaded." });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Cost edit failed", description: e.message, variant: "destructive" });
    },
  });

  const openEditDialog = (entry: DaybookEntry) => {
    setEditEntry(entry);
    setEditDescription(entry.description);
    setEditAmountCurrency(entry.amountCurrency);
    setEditAmountUsd(entry.amountUsd);
    setEditTxDate(entry.txDate);
    setEditReason("");
  };

  const handleEntryClick = (entry: DaybookEntry, e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (entry.txType === "BALE_TRANSFER") navigate(`${routePrefix}/bale-transfers`);
  };

  const editSourceRecord = (entry: DaybookEntry) => {
    if (entry.txType === "BALE_STOCK_ENTRY") return;
    if (entry.txType === "INVOICE" && entry.referenceId) {
      navigate(`${routePrefix}/sales/invoices/${entry.referenceId}`);
      return;
    }
    if (entry.txType === "BALE_SALE" && entry.referenceId) {
      navigate(`${routePrefix}/pos?edit=${entry.referenceId}`);
      return;
    }
    const tab = VOUCHER_TX_TYPES[entry.txType];
    if (tab && entry.referenceId) navigate(`${routePrefix}/vouchers?edit=${entry.referenceId}&tab=${tab}`);
  };

  const handleEditSubmit = () => {
    if (!editEntry || !editReason.trim()) return;
    const isVoucherBacked = editEntry.referenceTable === "vouchers" || editEntry.id < 0;
    editMutation.mutate({
      entryId: editEntry.id,
      data: {
        description: editDescription,
        ...(!isVoucherBacked && { amountCurrency: editAmountCurrency, amountUsd: editAmountUsd }),
        ...(editTxDate !== editEntry.txDate && { txDate: editTxDate }),
        reason: editReason.trim(),
      },
    });
  };

  return {
    // identity / permissions
    wrapAdminAction,
    AdminDialog,
    isAdminOrOwner,
    showAmounts,
    navigate,
    formatDisplayDate,
    formatDisplayTime,
    // filters
    activeDaybookTab,
    setActiveDaybookTab,
    periodFilter,
    setPeriodFilter,
    stepPeriod,
    txTypeFilter,
    setTxTypeFilter,
    statusFilter,
    setStatusFilter,
    searchQuery,
    setSearchQuery,
    hasActiveFilters,
    clearFilters,
    // data
    isLoading,
    isError,
    error,
    refetch,
    filteredEntries,
    condensedRows,
    getEntriesForCondensedRow,
    expandedRowKey,
    setExpandedRowKey,
    // exports
    isExportingDetailed,
    handleExportToExcel,
    handleExportDetailedToExcel,
    // dialogs
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
    handleEditSubmit,
    openEditDialog,
    viewEntry,
    setViewEntry,
    voidEntry,
    setVoidEntry,
    deleteEntry,
    setDeleteEntry,
    costEditEntry,
    setCostEditEntry,
    costEditAmount,
    setCostEditAmount,
    costEditReason,
    setCostEditReason,
    isCostEditable,
    // mutations
    editMutation,
    voidMutation,
    deleteMutation,
    costEditMutation,
    // row behaviour
    handleEntryClick,
    editSourceRecord,
  };
}

export type FactoryDaybookModel = ReturnType<typeof useFactoryDaybookModel>;
