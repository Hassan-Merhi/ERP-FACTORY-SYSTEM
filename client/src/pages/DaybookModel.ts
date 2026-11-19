// Extracted from ./Daybook.tsx: state, queries and handlers for Daybook.
import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  canonicalApiUrl,
  companyDataKey,
  frontendQueryPolicies,
  invalidateCompanyApiFamily,
} from "@/lib/frontendDataArchitecture";
import { exportDaybookDetail, exportDaybookSummary } from "./daybook/exportDaybook";
import { isGoldenCoastProgrammeVoucher, isVoucherMutationBlocked } from "@/lib/migratedVoucherGuard";
import { isBlockingQueryError } from "@/lib/abortError";
import type { EditVoucherForm, Voucher, OffloadListItem, DaybookRow, DaybookUser } from "./daybook/types";
import {
  openDaybookVoucherEditor,
  useDaybookDeleteMutation,
  useDaybookLinkedVoucherIds,
} from "./useDaybookIntercompany";
import { usePaginatedDaybookVouchers } from "./daybook/usePaginatedDaybookVouchers";
import { VOUCHER_TYPE_ORDER } from "./daybook/constants";
import { useDaybookFiltersModel } from "./DaybookFiltersModel";

export function useDaybookModel({ user }: { user: { user?: DaybookUser | null }["user"] }) {
  const f = useDaybookFiltersModel({ user });

  const { voucherToEdit, voucherEntries, entriesLoading, editFormInitialized, editForm, setEditFormInitialized } = f;
  useEffect(() => {
    if (voucherToEdit && voucherEntries.length > 0 && !entriesLoading && !editFormInitialized) {
      editForm.reset({
        voucherType: voucherToEdit.voucherType as
          "Journal" | "Payment" | "Receipt" | "Stock Transfer" | "Sales" | "Purchase" | "Contra" | undefined,
        voucherDate: voucherToEdit.voucherDate,
        description: voucherToEdit.description || "",
        optional: voucherToEdit.optional,
        entries: voucherEntries.map((e) => ({
          // NOTE: /api/vouchers/:id/entries can also return "factorySupplier"
          // and "customer" account types, which the edit form's enum does not
          // offer. The raw value is passed through unchanged (historical
          // behavior) rather than being silently remapped.
          accountType: e.accountType as EditVoucherForm["entries"][number]["accountType"],
          accountId: e.accountId,
          accountName: e.accountName,
          debitAmount: e.debitAmount || "0",
          creditAmount: e.creditAmount || "0",
          narration: e.narration || "",
        })),
      });
      setEditFormInitialized(true);
    }
  }, [voucherToEdit, voucherEntries, entriesLoading, editFormInitialized, editForm, setEditFormInitialized]);

  const [accountNameCache] = useState<Record<number, string>>({});
  const {
    response: voucherPageResponse,
    summary: voucherSummary,
    vouchers,
    isLoading,
    isError,
    error,
    refetch: refetchVouchers,
    loadAllVouchers,
  } = usePaginatedDaybookVouchers({
    companyId: f.selectedCompany?.id,
    fromDate: f.periodFilter.fromDate,
    toDate: f.periodFilter.toDate,
    filters: f.filters,
    page: f.voucherPage,
    pageSize: f.VOUCHER_PAGE_SIZE,
  });

  // A cancelled request is not a failure, and a failed refetch that left the
  // previous page on screen is not worth a full-table error either.
  const daybookErrorMessage = isBlockingQueryError(isError ? error : null, vouchers.length > 0)
    ? error instanceof Error
      ? error.message
      : "Failed to load transactions"
    : null;

  const { setVoucherPage, setDaybookRowLimit, DAYBOOK_PAGE_SIZE, selectedCompany, periodFilter, filters } = f;
  useEffect(() => {
    setVoucherPage(1);
    setDaybookRowLimit(DAYBOOK_PAGE_SIZE);
  }, [
    selectedCompany?.id,
    periodFilter.fromDate,
    periodFilter.toDate,
    filters.voucherType,
    filters.searchQuery,
    filters.sortOrder,
    filters.minAmount,
    filters.maxAmount,
    filters.statusFilter,
    setVoucherPage,
    setDaybookRowLimit,
    DAYBOOK_PAGE_SIZE,
  ]);

  const offloadsUrl = useMemo(
    () =>
      canonicalApiUrl("/api/offloads", {
        startDate: f.periodFilter.fromDate,
        endDate: f.periodFilter.toDate,
      }),
    [f.periodFilter.fromDate, f.periodFilter.toDate]
  );
  const { data: offloads = [] } = useQuery<OffloadListItem[]>({
    queryKey: companyDataKey(offloadsUrl, f.selectedCompany?.id, "daybook-offloads"),
    queryFn: async ({ signal }) => {
      const response = await fetch(offloadsUrl, { credentials: "include", signal });
      if (!response.ok) throw new Error("Failed to load offloads");
      return response.json();
    },
    enabled: !!f.selectedCompany,
    ...frontendQueryPolicies.operational,
  });

  const filteredVouchers = useMemo(() => {
    return vouchers
      .filter((v) => {
        if (f.filters.voucherType !== "all" && v.voucherType !== f.filters.voucherType) return false;
        if (f.filters.statusFilter === "active" && v.optional) return false;
        if (f.filters.statusFilter === "optional" && !v.optional) return false;
        if (f.filters.minAmount && parseFloat(v.totalAmount) < parseFloat(f.filters.minAmount)) return false;
        if (f.filters.maxAmount && parseFloat(v.totalAmount) > parseFloat(f.filters.maxAmount)) return false;
        if (f.filters.searchQuery) {
          return searchAny(
            f.filters.searchQuery,
            v.voucherNumber,
            v.description,
            (v as { locationName?: string }).locationName
          );
        }
        return true;
      })
      .sort((a, b) => (f.filters.sortOrder === "asc" ? a.id - b.id : b.id - a.id));
  }, [vouchers, f.filters]);

  const allRows: DaybookRow[] = useMemo(() => {
    // Offloads are shown when: (a) no type filter ("all"), or (b) "Offload" is
    // explicitly selected. Filtering by any other voucher type hides offloads so
    // they don't bleed through and confuse a filtered view.
    const includeOffloads = f.filters.voucherType === "all" || f.filters.voucherType === "Offload";
    const rows: DaybookRow[] = [
      ...filteredVouchers.map((v) => ({ _type: "voucher" as const, data: v })),
      ...(f.voucherPage === 1 && includeOffloads ? offloads.map((o) => ({ _type: "offload" as const, data: o })) : []),
    ];
    return rows.sort((a, b) => {
      // Daybook > Offload is a container-number list, not a date/record-ID list.
      // Sort the entire selected date range A–Z before display limits are applied.
      if (f.filters.voucherType === "Offload" && a._type === "offload" && b._type === "offload") {
        return (
          (a.data.containerNumber ?? "").localeCompare(b.data.containerNumber ?? "", undefined, {
            numeric: true,
            sensitivity: "base",
          }) || a.data.id - b.data.id
        );
      }
      const da = a._type === "voucher" ? a.data.voucherDate : a.data.offloadedAt.slice(0, 10);
      const db = b._type === "voucher" ? b.data.voucherDate : b.data.offloadedAt.slice(0, 10);
      if (da !== db) return f.filters.sortOrder === "asc" ? da.localeCompare(db) : db.localeCompare(da);
      const typeA = a._type === "voucher" ? (VOUCHER_TYPE_ORDER[a.data.voucherType] ?? 99) : 99;
      const typeB = b._type === "voucher" ? (VOUCHER_TYPE_ORDER[b.data.voucherType] ?? 99) : 99;
      if (typeA !== typeB) return typeA - typeB;
      const idA = a.data.id,
        idB = b.data.id;
      return f.filters.sortOrder === "asc" ? idA - idB : idB - idA;
    });
  }, [f.filters.voucherType, f.filters.sortOrder, filteredVouchers, f.voucherPage, offloads]);

  // Summary amounts/counts come from the same company-scoped, filtered voucher API.
  // Legacy list responses have no global summary, so their fallback is explicitly page-scoped.
  const overviewStats = useMemo(() => {
    const loadedValue = filteredVouchers.reduce((sum, voucher) => sum + (Number(voucher.totalAmount) || 0), 0);
    return {
      vouchers: voucherPageResponse?.total ?? filteredVouchers.length,
      value: voucherSummary?.totalAmount ?? loadedValue,
      active: voucherSummary?.active ?? filteredVouchers.filter((voucher) => !voucher.optional).length,
      optional: voucherSummary?.optional ?? filteredVouchers.filter((voucher) => voucher.optional).length,
      scope: voucherSummary ? "Selected filters" : "Loaded page",
    };
  }, [filteredVouchers, voucherPageResponse?.total, voucherSummary]);

  const visibleRows = useMemo(
    () =>
      allRows.filter(
        (r) =>
          f.showHidden || !f.hiddenRowIds.has(r._type === "voucher" ? `voucher-${r.data.id}` : `offload-${r.data.id}`)
      ),
    [allRows, f.hiddenRowIds, f.showHidden]
  );
  const displayedRows = useMemo(() => visibleRows.slice(0, f.daybookRowLimit), [visibleRows, f.daybookRowLimit]);
  const linkedVoucherIds = useDaybookLinkedVoucherIds(f.selectedCompany?.id, displayedRows);

  const canEdit = (v: Voucher) =>
    f.recordChanges.allowed &&
    v.voucherType !== "Purchase" &&
    user?.role !== "POS" &&
    !isGoldenCoastProgrammeVoucher(v) &&
    !isVoucherMutationBlocked(v);
  const canDelete = () =>
    f.recordChanges.allowed && !!(user?.role === "Developer" || user?.role === "Admin" || user?.canDeleteRecords);
  const handleView = (v: Voucher) => {
    f.setSelectedVoucher(v);
    f.setViewProfitFilter("all");
    f.setViewDialogOpen(true);
  };
  const handleEdit = (v: Voucher) =>
    openDaybookVoucherEditor(v, { vouchersBase: f.vouchersBase, navigate: f.navigate, toast: f.toast });

  const deleteMutation = useDaybookDeleteMutation({
    recordChanges: f.recordChanges,
    voucherToDelete: f.voucherToDelete,
    companyId: f.selectedCompany?.id,
    refreshBalances: f.refreshBalances,
    toast: f.toast,
    setDeleteDialogOpen: f.setDeleteDialogOpen,
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: EditVoucherForm }) => {
      if (!f.recordChanges.allowed) throw new Error(f.recordChanges.reason ?? "");
      return apiRequest("PATCH", `/api/vouchers/${id}`, updates);
    },
    onSuccess: () => {
      void invalidateCompanyApiFamily(queryClient, "/api/vouchers", f.selectedCompany?.id);
      f.refreshBalances();
      f.toast({ title: "Updated", description: "Voucher updated" });
      f.setEditDialogOpen(false);
    },
  });

  const handleExportToExcel = async () => {
    await exportDaybookSummary(await loadAllVouchers(), {
      operationalFiltered: f.routineAccountingViewFiltered,
      formatDisplayDate: f.formatDisplayDate,
      formatAmount: f.formatAmount,
    });
  };
  const handleExportDetailedToExcel = async () => {
    const detailRows = await exportDaybookDetail(await loadAllVouchers(), {
      operationalFiltered: f.routineAccountingViewFiltered,
      formatDisplayDate: f.formatDisplayDate,
    });
    f.toast({ title: "Export complete", description: `${detailRows.length} detail rows exported.` });
  };

  const runDaybookExport = async (exportAction: () => Promise<void>) => {
    if (f.isExportingReport) return;
    f.setIsExportingReport(true);
    try {
      await exportAction();
    } catch (error) {
      f.toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Unable to export the Daybook.",
        variant: "destructive",
      });
    } finally {
      f.setIsExportingReport(false);
    }
  };

  return {
    recordChanges: f.recordChanges,
    routineAccountingViewFiltered: f.routineAccountingViewFiltered,
    vouchersBase: f.vouchersBase,
    formatDisplayDate: f.formatDisplayDate,
    formatDisplayTime: f.formatDisplayTime,
    formatAmount: f.formatAmount,
    formatTransactionAmount: f.formatTransactionAmount,
    navigate: f.navigate,
    hideAmounts: f.hideAmounts,
    activeDaybookTab: f.activeDaybookTab,
    setActiveDaybookTab: f.setActiveDaybookTab,
    isExportingReport: f.isExportingReport,
    periodFilter: f.periodFilter,
    filters: f.filters,
    voucherPage: f.voucherPage,
    setVoucherPage: f.setVoucherPage,
    setPeriodFilter: f.setPeriodFilter,
    setFilters: f.setFilters,
    resetDaybookFilters: f.resetDaybookFilters,
    hasActiveDaybookFilters: f.hasActiveDaybookFilters,
    shiftDay: f.shiftDay,
    viewDialogOpen: f.viewDialogOpen,
    setViewDialogOpen: f.setViewDialogOpen,
    selectedVoucher: f.selectedVoucher,
    selectedDialogRow: f.selectedDialogRow,
    setSelectedDialogRow: f.setSelectedDialogRow,
    viewProfitFilter: f.viewProfitFilter,
    setViewProfitFilter: f.setViewProfitFilter,
    editDialogOpen: f.editDialogOpen,
    setEditDialogOpen: f.setEditDialogOpen,
    voucherToEdit: f.voucherToEdit,
    deleteDialogOpen: f.deleteDialogOpen,
    setDeleteDialogOpen: f.setDeleteDialogOpen,
    voucherToDelete: f.voucherToDelete,
    setVoucherToDelete: f.setVoucherToDelete,
    selectedRowId: f.selectedRowId,
    setSelectedRowId: f.setSelectedRowId,
    hiddenRowIds: f.hiddenRowIds,
    setHiddenRowIds: f.setHiddenRowIds,
    showHidden: f.showHidden,
    setShowHidden: f.setShowHidden,
    DAYBOOK_PAGE_SIZE: f.DAYBOOK_PAGE_SIZE,
    VOUCHER_PAGE_SIZE: f.VOUCHER_PAGE_SIZE,
    daybookRowLimit: f.daybookRowLimit,
    setDaybookRowLimit: f.setDaybookRowLimit,
    viewMode: f.viewMode,
    setViewMode: f.setViewMode,
    expandedVoucherId: f.expandedVoucherId,
    setExpandedVoucherId: f.setExpandedVoucherId,
    expandedCondensedGroups: f.expandedCondensedGroups,
    setExpandedCondensedGroups: f.setExpandedCondensedGroups,
    ledgerAccounts: f.ledgerAccounts,
    bankAccounts: f.bankAccounts,
    suppliers: f.suppliers,
    employees: f.employees,
    fixedAssets: f.fixedAssets,
    purchaseOrderData: f.purchaseOrderData,
    poSupplierBalance: f.poSupplierBalance,
    viewEntriesLoading: f.viewEntriesLoading,
    viewVoucherEntries: f.viewVoucherEntries,
    expandedLoading: f.expandedLoading,
    expandedEntries: f.expandedEntries,
    isStockTransferVoucher: f.isStockTransferVoucher,
    voucherRevisions: f.voucherRevisions,
    revisionsLoading: f.revisionsLoading,
    revisionsError: f.revisionsError,
    revisionsErrorDetail: f.revisionsErrorDetail,
    retryVoucherRevisions: f.retryVoucherRevisions,
    cashAccountBalance: f.cashAccountBalance,
    entryBalances: f.entryBalances,
    entriesLoading: f.entriesLoading,
    editForm: f.editForm,
    editFields: f.editFields,
    editAppend: f.editAppend,
    editRemove: f.editRemove,
    accountNameCache,
    voucherPageResponse,
    isLoading,
    refetchVouchers,
    daybookErrorMessage,
    overviewStats,
    visibleRows,
    displayedRows,
    linkedVoucherIds,
    canEdit,
    canDelete,
    handleView,
    handleEdit,
    deleteMutation,
    editMutation,
    handleExportToExcel,
    handleExportDetailedToExcel,
    runDaybookExport,
  };
}

export type DaybookModel = ReturnType<typeof useDaybookModel>;
