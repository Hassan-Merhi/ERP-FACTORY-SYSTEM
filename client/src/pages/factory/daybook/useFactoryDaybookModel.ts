import type { ClientErrorLike } from "@/lib/clientError";
/**
 * Controller hook for the Factory Daybook page.
 *
 * Holds every piece of state, query, mutation and handler the page had inline.
 * The page shell and its child views are pure presentation over this model, so
 * filtering, permissions, session persistence, exports and the voucher/cost
 * mutations all keep their original semantics in one place.
 */
import { useEffect, type MouseEvent as ReactMouseEvent } from "react";
import { addDays, format } from "date-fns";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { fetchAllDaybookEntries } from "@/lib/daybookPaginationClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import type { DaybookEntry } from "./types";
import { VOUCHER_TX_TYPES } from "./daybookUtils";
import { FACTORY_DAYBOOK_STATE_KEY, saveFactoryDaybookState } from "./daybookUiState";
import { exportFactoryDaybookDetailed, exportFactoryDaybookSummary } from "./factoryDaybookExports";
import { useFactoryDaybookFiltersModel } from "./useFactoryDaybookFiltersModel";

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

export function shiftPeriod(prev: PeriodFilterValue, days: number): PeriodFilterValue {
  return {
    fromDate: format(addDays(new Date(prev.fromDate + "T00:00:00"), days), DATE_FMT),
    toDate: format(addDays(new Date(prev.toDate + "T00:00:00"), days), DATE_FMT),
    preset: "custom",
  };
}

export function useFactoryDaybookModel() {
  const fd = useFactoryDaybookFiltersModel();

  const clearFilters = () => {
    fd.setPeriodFilter(getDefaultPeriodValue("today"));
    fd.setTxTypeFilter("ALL");
    fd.setCurrencyFilter("ALL");
    fd.setStatusFilter("all");
    fd.setSearchQuery("");
    fd.setMinAmount("");
    fd.setMaxAmount("");
  };

  // ── Session persistence: restore scroll position on mount ─────────────────
  // Filter/period state is now restored directly in the useState initializers
  // above (see initialDaybookStateRef) so the query doesn't fire twice on
  // mount — once for the "today" default, then again for the restored range.
  const { initialDaybookStateRef } = fd;
  useEffect(() => {
    const scrollY = initialDaybookStateRef.current?.scrollY || 0;
    if (!scrollY) return;
    requestAnimationFrame(() => {
      window.scrollTo({ top: scrollY, behavior: "instant" as ScrollBehavior });
    });
  }, [initialDaybookStateRef]);

  // ── Session persistence: save on every state change ───────────────────────
  const {
    periodFilter,
    txTypeFilter,
    currencyFilter,
    statusFilter,
    searchQuery,
    minAmount,
    maxAmount,
    sortOrder,
    scrollYRef,
  } = fd;
  useEffect(() => {
    saveFactoryDaybookState({
      periodFilter: periodFilter,
      txTypeFilter: txTypeFilter,
      currencyFilter: currencyFilter,
      statusFilter: statusFilter,
      searchQuery: searchQuery,
      minAmount: minAmount,
      maxAmount: maxAmount,
      sortOrder: sortOrder,
      scrollY: scrollYRef.current,
    });
  }, [
    periodFilter,
    txTypeFilter,
    currencyFilter,
    statusFilter,
    searchQuery,
    minAmount,
    maxAmount,
    sortOrder,
    scrollYRef,
  ]);

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
  }, [scrollYRef]);

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
    fd.toast({
      title: "No data to export",
      description: "No entries found for the current filters.",
      variant: "destructive",
    });
  };

  // ── Excel export: summary ─────────────────────────────────────────────────
  const handleExportToExcel = async () => {
    let exportEntries: DaybookEntry[];
    try {
      exportEntries = (await fetchAllDaybookEntries(new URLSearchParams(fd.queryParams))).filter(
        (entry) => entry.txType !== "WORKER_EDITED"
      ) as DaybookEntry[];
    } catch (error) {
      fd.toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "The complete filtered daybook could not be loaded.",
        variant: "destructive",
      });
      return;
    }
    if (exportEntries.length === 0) {
      warnNothingToExport();
      return;
    }
    const { fileName, rowCount } = await exportFactoryDaybookSummary(exportEntries, fd.formatDisplayDate);
    fd.toast({
      title: "Export successful",
      description: `Downloaded ${fileName} with ${rowCount} entries.`,
    });
  };

  // ── Excel export: detailed (with voucher debit/credit entries) ────────────
  const handleExportDetailedToExcel = async () => {
    fd.setIsExportingDetailed(true);
    try {
      const exportEntries = (await fetchAllDaybookEntries(new URLSearchParams(fd.queryParams))).filter(
        (entry) => entry.txType !== "WORKER_EDITED"
      ) as DaybookEntry[];
      if (exportEntries.length === 0) {
        warnNothingToExport();
        return;
      }
      const { fileName, rowCount } = await exportFactoryDaybookDetailed(exportEntries, fd.formatDisplayDate);
      fd.toast({ title: "Export successful", description: `Downloaded ${fileName} with ${rowCount} entries.` });
    } catch {
      fd.toast({ title: "Export failed", description: "An error occurred while exporting.", variant: "destructive" });
    } finally {
      fd.setIsExportingDetailed(false);
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
      fd.setEditEntry(null);
      fd.setEditReason("");
      fd.toast({ title: "Entry updated", description: "Description synced to source record." });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      fd.toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const voidMutation = useMutation({
    mutationFn: async (entryId: number) => {
      const res = await factoryApiRequest("DELETE", `/api/factory/daybook/entry/${entryId}/void`);
      return res.json();
    },
    onSuccess: (result: { fxPaymentCancelled?: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      if (result.fxPaymentCancelled) {
        queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-agent-wallets"] });
        queryClient.invalidateQueries({ queryKey: ["fx-agent-eur-statement"] });
        queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
        queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
        queryClient.invalidateQueries({ queryKey: ["/api/accounts/voucher-sidebar"] });
      }
      fd.setVoidEntry(null);
      fd.toast(
        result.fxPaymentCancelled
          ? { title: "FX payment deleted", description: "EUR restored; USD posting and FX gain/loss reversed." }
          : { title: "Voucher voided", description: "All accounting entries have been reversed." }
      );
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      fd.toast({ title: "Void failed", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (entryId: number) => {
      const res = await factoryApiRequest("DELETE", `/api/factory/daybook/entry/${entryId}`);
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.message || "Daybook deletion / reversal failed");
      return result;
    },
    onSuccess: (result: { reversed?: boolean; replayed?: boolean }) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      if (result.reversed) {
        void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses/payments"] });
        void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/weekly-payments"] });
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/production-target-bonuses/weekly-reconciliation"],
        });
        void queryClient.invalidateQueries({ queryKey: ["/api/factory/vouchers"] });
        void queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
        fd.toast({
          title: result.replayed ? "Bonus already reversed" : "Bonus payment removed and reversed",
          description:
            "Cash / Bank and Deposit Expense were offset. Original and reversal vouchers remain in audit history; this bonus cannot be paid again.",
        });
      } else {
        fd.toast({ title: "Entry deleted", description: "The daybook entry has been permanently removed." });
      }
      fd.setDeleteEntry(null);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      fd.toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    },
  });

  const isCostEditable = (entry: DaybookEntry) => {
    if (!fd.isAdminOrOwner) return false;
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
      fd.setCostEditEntry(null);
      fd.setCostEditAmount("");
      fd.setCostEditReason("");
      fd.toast({ title: "Cost updated", description: data.message || "Container costs recalculated and cascaded." });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      fd.toast({ title: "Cost edit failed", description: e.message, variant: "destructive" });
    },
  });

  const openEditDialog = (entry: DaybookEntry) => {
    fd.setEditEntry(entry);
    fd.setEditDescription(entry.description);
    fd.setEditAmountCurrency(entry.amountCurrency);
    fd.setEditAmountUsd(entry.amountUsd);
    fd.setEditTxDate(entry.txDate);
    fd.setEditReason("");
  };

  const handleEntryClick = (entry: DaybookEntry, e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (entry.txType === "BALE_TRANSFER") fd.navigate(`${fd.routePrefix}/bale-transfers`);
  };

  const editSourceRecord = (entry: DaybookEntry) => {
    if (entry.txType === "BALE_STOCK_ENTRY") return;
    if (entry.txType === "INVOICE" && entry.referenceId) {
      fd.navigate(`${fd.routePrefix}/sales/invoices/${entry.referenceId}`);
      return;
    }
    if (entry.txType === "BALE_SALE" && entry.referenceId) {
      fd.navigate(`${fd.routePrefix}/pos?edit=${entry.referenceId}`);
      return;
    }
    const tab = VOUCHER_TX_TYPES[entry.txType];
    if (tab && entry.referenceId) fd.navigate(`${fd.routePrefix}/vouchers?edit=${entry.referenceId}&tab=${tab}`);
  };

  const handleEditSubmit = () => {
    if (!fd.editEntry || !fd.editReason.trim()) return;
    const isVoucherBacked = fd.editEntry.referenceTable === "vouchers" || fd.editEntry.id < 0;
    editMutation.mutate({
      entryId: fd.editEntry.id,
      data: {
        description: fd.editDescription,
        ...(!isVoucherBacked && { amountCurrency: fd.editAmountCurrency, amountUsd: fd.editAmountUsd }),
        ...(fd.editTxDate !== fd.editEntry.txDate && { txDate: fd.editTxDate }),
        reason: fd.editReason.trim(),
      },
    });
  };

  return {
    // identity / permissions
    wrapAdminAction: fd.wrapAdminAction,
    AdminDialog: fd.AdminDialog,
    isAdminOrOwner: fd.isAdminOrOwner,
    showAmounts: fd.showAmounts,
    navigate: fd.navigate,
    formatDisplayDate: fd.formatDisplayDate,
    formatDisplayTime: fd.formatDisplayTime,
    // filters
    periodFilter: fd.periodFilter,
    setPeriodFilter: fd.setPeriodFilter,
    stepPeriod: fd.stepPeriod,
    txTypeFilter: fd.txTypeFilter,
    setTxTypeFilter: fd.setTxTypeFilter,
    availableTxTypes: fd.availableTxTypes,
    statusFilter: fd.statusFilter,
    setStatusFilter: fd.setStatusFilter,
    searchQuery: fd.searchQuery,
    setSearchQuery: fd.setSearchQuery,
    hasActiveFilters: fd.hasActiveFilters,
    clearFilters,
    // data
    isLoading: fd.isLoading,
    isError: fd.isError,
    error: fd.error,
    refetch: fd.refetch,
    filteredEntries: fd.filteredEntries,
    condensedRows: fd.condensedRows,
    getEntriesForCondensedRow: fd.getEntriesForCondensedRow,
    expandedRowKey: fd.expandedRowKey,
    setExpandedRowKey: fd.setExpandedRowKey,
    // exports
    isExportingDetailed: fd.isExportingDetailed,
    handleExportToExcel,
    handleExportDetailedToExcel,
    // dialogs
    editEntry: fd.editEntry,
    setEditEntry: fd.setEditEntry,
    editDescription: fd.editDescription,
    setEditDescription: fd.setEditDescription,
    editAmountCurrency: fd.editAmountCurrency,
    setEditAmountCurrency: fd.setEditAmountCurrency,
    editAmountUsd: fd.editAmountUsd,
    setEditAmountUsd: fd.setEditAmountUsd,
    editTxDate: fd.editTxDate,
    setEditTxDate: fd.setEditTxDate,
    editReason: fd.editReason,
    setEditReason: fd.setEditReason,
    handleEditSubmit,
    openEditDialog,
    viewEntry: fd.viewEntry,
    setViewEntry: fd.setViewEntry,
    voidEntry: fd.voidEntry,
    setVoidEntry: fd.setVoidEntry,
    deleteEntry: fd.deleteEntry,
    setDeleteEntry: fd.setDeleteEntry,
    costEditEntry: fd.costEditEntry,
    setCostEditEntry: fd.setCostEditEntry,
    costEditAmount: fd.costEditAmount,
    setCostEditAmount: fd.setCostEditAmount,
    costEditReason: fd.costEditReason,
    setCostEditReason: fd.setCostEditReason,
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
