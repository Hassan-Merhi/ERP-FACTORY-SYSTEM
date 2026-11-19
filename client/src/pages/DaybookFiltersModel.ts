// Extracted from ./DaybookModel.ts: Daybook filters, selection, dialog state and entry queries.
import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDaybookTab } from "@/components/daybook/useDaybookTab";
import { useDaybookDayKeys } from "@/components/daybook/useDaybookDayKeys";
import { apiRequest } from "@/lib/queryClient";
import { companyDataKey, frontendQueryPolicies } from "@/lib/frontendDataArchitecture";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { format, addDays } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useDateJump } from "@/hooks/use-date-jump";
import { createVoucherSchema } from "./daybook/types";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import type {
  LedgerAccount,
  BankAccount,
  Supplier,
  Employee,
  FixedAsset,
  EditVoucherForm,
  Voucher,
  DaybookPurchaseOrderData,
  DaybookUser,
  DaybookViewEntriesResponse,
  VoucherEntry,
  ViewVoucherEntry,
} from "./daybook/types";
import { loadDaybookState } from "./daybook/state";
import { useDaybookFilterState } from "./daybook/useDaybookFilterState";
import { entryBalanceUrl, selectBalanceDisplayEntries, selectCashAccountId } from "./daybook/voucherBalanceSelection";

export function useDaybookFiltersModel({ user }: { user: { user: { user?: DaybookUser | null }["user"] }["user"] }) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const routineAccountingViewFiltered = selectedCompany?.id === 8 && (user?.currentRole ?? user?.role) !== "Developer";
  const vouchersBase: "/properties/vouchers" | "/vouchers" =
    selectedCompany?.companyType === "properties" ? "/properties/vouchers" : "/vouchers";
  const { formatDisplayDate, formatDisplayTime } = useDateFormat();
  const { formatHistoricalBaseAmount: formatAmount, formatTransactionAmount } = useCurrencyContext();
  const [, navigate] = useLocation();
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, true),
  });
  const hiddenErpCosts = myErpPages?.hiddenErpCostFields ?? [];
  const hideAmounts = hiddenErpCosts.includes("daybook_amounts");
  const [activeDaybookTab, setActiveDaybookTab] = useDaybookTab();
  const [isExportingReport, setIsExportingReport] = useState(false);
  const {
    periodFilter,
    filters,
    voucherPage,
    setVoucherPage,
    setPeriodFilter,
    setFilters,
    resetFilters: resetDaybookFilters,
    hasActiveFilters: hasActiveDaybookFilters,
  } = useDaybookFilterState(selectedCompany?.id);
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const shiftDay = useCallback(
    (delta: number) => {
      const fmt = "yyyy-MM-dd";
      setPeriodFilter((prev) => ({
        fromDate: format(addDays(new Date(prev.fromDate + "T00:00:00"), delta), fmt),
        toDate: format(addDays(new Date(prev.toDate + "T00:00:00"), delta), fmt),
        preset: "custom",
      }));
    },
    [setPeriodFilter]
  );

  useDaybookDayKeys(shiftDay);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [selectedDialogRow, setSelectedDialogRow] = useState<number | null>(null);
  const [viewProfitFilter, setViewProfitFilter] = useState<"all" | "gain" | "loss" | "even">("all");

  useEffect(() => {
    if (!viewDialogOpen) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const key = e.key.toLowerCase();
      if (key === "g") {
        e.preventDefault();
        setViewProfitFilter("gain");
      } else if (key === "l") {
        e.preventDefault();
        setViewProfitFilter("loss");
      } else if (key === "e") {
        e.preventDefault();
        setViewProfitFilter("even");
      } else if (key === "a") {
        e.preventDefault();
        setViewProfitFilter("all");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewDialogOpen]);

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [voucherToEdit, setVoucherToEdit] = useState<Voucher | null>(null);
  const [editFormInitialized, setEditFormInitialized] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [voucherToDelete, setVoucherToDelete] = useState<Voucher | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [hiddenRowIds, setHiddenRowIds] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const DAYBOOK_PAGE_SIZE = 200;
  const VOUCHER_PAGE_SIZE = 100;
  const [daybookRowLimit, setDaybookRowLimit] = useState(DAYBOOK_PAGE_SIZE);
  const [viewMode, setViewMode] = useState<"detailed" | "condensed">(() => loadDaybookState()?.viewMode ?? "detailed");
  const [expandedVoucherId, setExpandedVoucherId] = useState<number | null>(null);
  const [expandedCondensedGroups, setExpandedCondensedGroups] = useState<Set<string>>(new Set());

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyDataKey("/api/ledger-accounts", selectedCompany?.id),
    enabled: !!selectedCompany,
    ...frontendQueryPolicies.reference,
  });
  const { data: bankAccounts = [] } = useQuery<BankAccount[]>({
    queryKey: companyDataKey("/api/bank-accounts", selectedCompany?.id),
    enabled: !!selectedCompany,
    ...frontendQueryPolicies.reference,
  });
  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: companyDataKey("/api/suppliers", selectedCompany?.id),
    enabled: !!selectedCompany,
    ...frontendQueryPolicies.reference,
  });
  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: companyDataKey("/api/employees", selectedCompany?.id),
    enabled: !!selectedCompany,
    ...frontendQueryPolicies.reference,
  });
  const { data: fixedAssets = [] } = useQuery<FixedAsset[]>({
    queryKey: companyDataKey("/api/fixed-assets", selectedCompany?.id),
    enabled: !!selectedCompany,
    ...frontendQueryPolicies.reference,
  });

  useEffect(() => {
    setSelectedVoucher(null);
    setVoucherToEdit(null);
    setExpandedVoucherId(null);
    setViewDialogOpen(false);
    setEditDialogOpen(false);
    setVoucherPage(1);
  }, [selectedCompany?.id, setVoucherPage]);

  const [purchaseOrderData, setPurchaseOrderData] = useState<DaybookPurchaseOrderData | null>(null);
  const [poSupplierBalance, setPoSupplierBalance] = useState<string | null>(null);
  // Declared here — before any useEffect that references it — to avoid TDZ errors.
  const [balanceRefreshKey, setBalanceRefreshKey] = useState(0);
  const refreshBalances = () => setBalanceRefreshKey((k) => k + 1);

  useEffect(() => {
    if (!purchaseOrderData?.supplierId) {
      setPoSupplierBalance(null);
      return;
    }
    fetch(`/api/suppliers/${purchaseOrderData.supplierId}/balance`, { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPoSupplierBalance(d?.balance?.toString() ?? null))
      .catch(() => setPoSupplierBalance(null));
  }, [purchaseOrderData?.supplierId, balanceRefreshKey]);

  const viewEntriesUrl = selectedVoucher ? `/api/vouchers/${selectedVoucher.id}/view-entries` : "";
  const { data: viewVoucherEntriesRaw, isLoading: viewEntriesLoading } = useQuery<DaybookViewEntriesResponse>({
    queryKey: selectedVoucher ? companyDataKey(viewEntriesUrl, selectedCompany?.id, "daybook-view-entries") : [],
    enabled: !!selectedVoucher && viewDialogOpen,
    ...frontendQueryPolicies.live,
  });

  const viewVoucherEntries: ViewVoucherEntry[] = useMemo(() => {
    if (!viewVoucherEntriesRaw) return [];
    return Array.isArray(viewVoucherEntriesRaw) ? viewVoucherEntriesRaw : viewVoucherEntriesRaw.entries || [];
  }, [viewVoucherEntriesRaw]);

  const expandedEntriesUrl = expandedVoucherId ? `/api/vouchers/${expandedVoucherId}/view-entries` : "";
  const { data: expandedEntriesRaw, isLoading: expandedLoading } = useQuery<DaybookViewEntriesResponse>({
    queryKey: expandedVoucherId
      ? companyDataKey(expandedEntriesUrl, selectedCompany?.id, "daybook-expanded-entries")
      : [],
    enabled: !!expandedVoucherId,
    ...frontendQueryPolicies.live,
  });
  const expandedEntries: ViewVoucherEntry[] = useMemo(() => {
    if (!expandedEntriesRaw) return [];
    return Array.isArray(expandedEntriesRaw) ? expandedEntriesRaw : expandedEntriesRaw.entries || [];
  }, [expandedEntriesRaw]);

  const isStockTransferVoucher = !!(
    selectedVoucher &&
    (selectedVoucher.voucherType === "Stock Transfer" ||
      selectedVoucher.voucherType === "StockTransfer" ||
      selectedVoucher.voucherType === "Transfer")
  );
  const {
    data: voucherRevisions = [],
    isLoading: revisionsLoading,
    isError: revisionsError,
    error: revisionsErrorDetail,
    refetch: retryVoucherRevisions,
  } = useQuery({
    queryKey:
      selectedVoucher && isStockTransferVoucher && viewDialogOpen
        ? companyDataKey(
            `/api/stock-transfers/by-voucher/${selectedVoucher.id}/revisions`,
            selectedCompany?.id,
            "daybook-transfer-revisions"
          )
        : [],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/stock-transfers/by-voucher/${selectedVoucher!.id}/revisions`);
      if (!response.ok) throw new Error("Could not load revision history");
      const data = await response.json();
      return Array.isArray(data) ? data : (data?.revisions ?? []);
    },
    enabled: !!selectedVoucher && isStockTransferVoucher && viewDialogOpen,
    retry: 1,
  });

  useEffect(() => {
    setPurchaseOrderData(
      !viewVoucherEntriesRaw || Array.isArray(viewVoucherEntriesRaw) ? null : viewVoucherEntriesRaw.purchaseOrder
    );
  }, [viewVoucherEntriesRaw]);

  const cashAccountId = useMemo(
    () => selectCashAccountId(selectedVoucher, viewVoucherEntries),
    [selectedVoucher, viewVoucherEntries]
  );

  const [cashAccountBalance, setCashAccountBalance] = useState("0");
  const [entryBalances, setEntryBalances] = useState<Record<number, string>>({});
  // Incremented after any mutation that changes account balances, forcing a re-fetch.
  // Reset balance state immediately when the viewed voucher changes so stale
  // values from the previous voucher don't flash while the new fetch is in flight.
  useEffect(() => {
    setCashAccountBalance("0");
    setEntryBalances({});
  }, [selectedVoucher?.id]);

  useEffect(() => {
    if (!cashAccountId || !viewDialogOpen) return;
    fetch(`/api/accounts/ledger/${cashAccountId}/balance?balanceBasis=book`, {
      credentials: "include",
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCashAccountBalance(data?.balance?.toString() || "0"))
      .catch(() => {});
  }, [cashAccountId, viewDialogOpen, balanceRefreshKey]);

  useEffect(() => {
    if (!viewDialogOpen || !selectedVoucher) {
      setEntryBalances({});
      return;
    }
    const vt = selectedVoucher.voucherType;

    const displayEntries = selectBalanceDisplayEntries(vt, viewVoucherEntries);

    const results: Record<number, string> = {};
    Promise.all(
      displayEntries.map(async (entry) => {
        const url = entryBalanceUrl(entry);
        if (!url) return;
        try {
          const res = await fetch(url, { credentials: "include", cache: "no-store" });
          if (res.ok) {
            const d = await res.json();
            results[entry.id] = d.balance?.toString() || "0";
          }
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      })
    ).then(() => setEntryBalances(results));
  }, [viewDialogOpen, selectedVoucher, viewVoucherEntries, balanceRefreshKey]);

  useEffect(() => {
    setSelectedDialogRow(null);
  }, [viewDialogOpen]);
  useEffect(() => {
    if (selectedDialogRow !== null)
      document
        .querySelector(`[data-dialog-row="${selectedDialogRow}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedDialogRow]);

  useEffect(() => {
    if (!viewDialogOpen || !selectedVoucher) return;
    const salesItems = viewVoucherEntries.filter((e) => e.isStockItem || e.stockItemId);
    if (salesItems.length === 0) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedDialogRow((p) => (p === null ? 0 : Math.min(p + 1, salesItems.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedDialogRow((p) => (p === null ? salesItems.length - 1 : Math.max(p - 1, 0)));
      } else if (e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        const itemId = selectedDialogRow !== null ? salesItems[selectedDialogRow]?.stockItemId : null;
        if (itemId) {
          navigate(`/stock-query/${itemId}?from=daybook`);
          setViewDialogOpen(false);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [viewDialogOpen, selectedVoucher, viewVoucherEntries, navigate, selectedDialogRow]);

  const { data: voucherEntries = [], isLoading: entriesLoading } = useQuery<VoucherEntry[]>({
    queryKey: voucherToEdit
      ? companyDataKey(`/api/vouchers/${voucherToEdit.id}/entries`, selectedCompany?.id, "daybook-edit-entries")
      : [],
    enabled: !!voucherToEdit && editDialogOpen,
    ...frontendQueryPolicies.operational,
  });

  const editForm = useForm<EditVoucherForm>({
    resolver: zodResolver(createVoucherSchema),
    defaultValues: {
      voucherType: "Journal",
      voucherDate: format(new Date(), "yyyy-MM-dd"),
      description: "",
      optional: false,
      entries: [],
    },
  });
  const {
    fields: editFields,
    append: editAppend,
    remove: editRemove,
  } = useFieldArray({ control: editForm.control, name: "entries" });

  return {
    toast,
    selectedCompany,
    recordChanges,
    routineAccountingViewFiltered,
    vouchersBase,
    formatDisplayDate,
    formatDisplayTime,
    formatAmount,
    formatTransactionAmount,
    navigate,
    hideAmounts,
    activeDaybookTab,
    setActiveDaybookTab,
    isExportingReport,
    setIsExportingReport,
    periodFilter,
    filters,
    voucherPage,
    setVoucherPage,
    setPeriodFilter,
    setFilters,
    resetDaybookFilters,
    hasActiveDaybookFilters,
    shiftDay,
    viewDialogOpen,
    setViewDialogOpen,
    selectedVoucher,
    setSelectedVoucher,
    selectedDialogRow,
    setSelectedDialogRow,
    viewProfitFilter,
    setViewProfitFilter,
    editDialogOpen,
    setEditDialogOpen,
    voucherToEdit,
    editFormInitialized,
    setEditFormInitialized,
    deleteDialogOpen,
    setDeleteDialogOpen,
    voucherToDelete,
    setVoucherToDelete,
    selectedRowId,
    setSelectedRowId,
    hiddenRowIds,
    setHiddenRowIds,
    showHidden,
    setShowHidden,
    DAYBOOK_PAGE_SIZE,
    VOUCHER_PAGE_SIZE,
    daybookRowLimit,
    setDaybookRowLimit,
    viewMode,
    setViewMode,
    expandedVoucherId,
    setExpandedVoucherId,
    expandedCondensedGroups,
    setExpandedCondensedGroups,
    ledgerAccounts,
    bankAccounts,
    suppliers,
    employees,
    fixedAssets,
    purchaseOrderData,
    poSupplierBalance,
    refreshBalances,
    viewEntriesLoading,
    viewVoucherEntries,
    expandedLoading,
    expandedEntries,
    isStockTransferVoucher,
    voucherRevisions,
    revisionsLoading,
    revisionsError,
    revisionsErrorDetail,
    retryVoucherRevisions,
    cashAccountBalance,
    entryBalances,
    voucherEntries,
    entriesLoading,
    editForm,
    editFields,
    editAppend,
    editRemove,
  };
}
