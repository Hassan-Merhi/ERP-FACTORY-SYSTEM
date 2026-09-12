import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AuditLog } from "@/pages/settings/AuditLog";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { PageHeader } from "@/components/PageHeader";
import { PaginationBar } from "@/components/PaginationBar";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  canonicalApiUrl,
  companyDataKey,
  frontendQueryPolicies,
  invalidateCompanyApiFamily,
} from "@/lib/frontendDataArchitecture";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EyeOff, Plus, ChevronDown, FileDown, LayoutList, Layers } from "lucide-react";
import { format, addDays } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { cn } from "@/lib/utils";
import { isGoldenCoastProgrammeVoucher, isVoucherMutationBlocked } from "@/lib/migratedVoucherGuard";
import { isBlockingQueryError } from "@/lib/abortError";
import { utils, writeFile } from "@/lib/excelHelper";
import { useDateJump } from "@/hooks/use-date-jump";
import { buildDetailedDaybookRows } from "@/lib/daybook-export";
import { createVoucherSchema } from "./daybook/types";
import type {
  LedgerAccount,
  BankAccount,
  Supplier,
  Employee,
  FixedAsset,
  EditVoucherForm,
  Voucher,
  OffloadListItem,
  DaybookRow,
  DaybookPurchaseOrderData,
  DaybookUser,
  DaybookViewEntriesResponse,
  VoucherEntry,
  ViewVoucherEntry,
} from "./daybook/types";
import { loadDaybookState, saveDaybookState } from "./daybook/state";
import { DaybookFilters } from "./daybook/DaybookFilters";
import { DaybookTable } from "./daybook/DaybookTable";
import { VoucherDetailsDialog } from "./daybook/VoucherDetailsDialog";
import { VoucherEditDialog } from "./daybook/VoucherEditDialog";
import { usePaginatedDaybookVouchers } from "./daybook/usePaginatedDaybookVouchers";
import { VOUCHER_TYPE_ORDER } from "./daybook/constants";
import { useDaybookFilterState } from "./daybook/useDaybookFilterState";
import { entryBalanceUrl, selectBalanceDisplayEntries, selectCashAccountId } from "./daybook/voucherBalanceSelection";

export default function Daybook({ user }: { user?: DaybookUser | null } = {}) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const vouchersBase = selectedCompany?.companyType === "properties" ? "/properties/vouchers" : "/vouchers";
  const { formatDisplayDate, formatDisplayTime } = useDateFormat();
  const { formatHistoricalBaseAmount: formatAmount, formatTransactionAmount } = useCurrencyContext();
  const [, navigate] = useLocation();
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({ queryKey: ["/api/my-erp-pages"] });
  const hiddenErpCosts = myErpPages?.hiddenErpCostFields ?? [];
  const hideAmounts = hiddenErpCosts.includes("daybook_amounts");
  const [activeDaybookTab, setActiveDaybookTab] = useState<"transactions" | "activity">("transactions");
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasAnyOpenDialog()) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const isBack = e.key === "-" || e.code === "Minus";
      const isForward = (e.key === "+" && e.shiftKey) || (e.code === "Equal" && e.shiftKey) || e.key === "=";
      if (isBack) {
        e.preventDefault();
        shiftDay(-1);
      } else if (isForward) {
        e.preventDefault();
        shiftDay(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [shiftDay]);
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
  const _scrollYRef = useRef(0);
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
    fetch(`/api/accounts/ledger/${cashAccountId}/balance`, { credentials: "include", cache: "no-store" })
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
  }, [voucherToEdit, voucherEntries, entriesLoading, editFormInitialized, editForm]);

  const [accountNameCache] = useState<Record<number, string>>({});
  const {
    response: voucherPageResponse,
    vouchers,
    isLoading,
    isError,
    error,
    refetch: refetchVouchers,
    loadAllVouchers,
  } = usePaginatedDaybookVouchers({
    companyId: selectedCompany?.id,
    fromDate: periodFilter.fromDate,
    toDate: periodFilter.toDate,
    filters,
    page: voucherPage,
    pageSize: VOUCHER_PAGE_SIZE,
  });

  // A cancelled request is not a failure, and a failed refetch that left the
  // previous page on screen is not worth a full-table error either.
  const daybookErrorMessage = isBlockingQueryError(isError ? error : null, vouchers.length > 0)
    ? error instanceof Error
      ? error.message
      : "Failed to load transactions"
    : null;

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
  ]);

  const offloadsUrl = useMemo(
    () =>
      canonicalApiUrl("/api/offloads", {
        startDate: periodFilter.fromDate,
        endDate: periodFilter.toDate,
      }),
    [periodFilter.fromDate, periodFilter.toDate]
  );
  const { data: offloads = [], isLoading: _offloadsLoading } = useQuery<OffloadListItem[]>({
    queryKey: companyDataKey(offloadsUrl, selectedCompany?.id, "daybook-offloads"),
    queryFn: async ({ signal }) => {
      const response = await fetch(offloadsUrl, { credentials: "include", signal });
      if (!response.ok) throw new Error("Failed to load offloads");
      return response.json();
    },
    enabled: !!selectedCompany,
    ...frontendQueryPolicies.operational,
  });

  const filteredVouchers = useMemo(() => {
    return vouchers
      .filter((v) => {
        if (filters.voucherType !== "all" && v.voucherType !== filters.voucherType) return false;
        if (filters.statusFilter === "active" && v.optional) return false;
        if (filters.statusFilter === "optional" && !v.optional) return false;
        if (filters.minAmount && parseFloat(v.totalAmount) < parseFloat(filters.minAmount)) return false;
        if (filters.maxAmount && parseFloat(v.totalAmount) > parseFloat(filters.maxAmount)) return false;
        if (filters.searchQuery) {
          const s = filters.searchQuery.toLowerCase();
          return (
            v.voucherNumber.toLowerCase().includes(s) ||
            (v.description || "").toLowerCase().includes(s) ||
            (v as { locationName: { toLowerCase: () => { includes: (arg0: string) => unknown } } }).locationName
              ?.toLowerCase()
              .includes(s)
          );
        }
        return true;
      })
      .sort((a, b) => (filters.sortOrder === "asc" ? a.id - b.id : b.id - a.id));
  }, [vouchers, filters]);

  const allRows: DaybookRow[] = useMemo(() => {
    // Offloads are shown when: (a) no type filter ("all"), or (b) "Offload" is
    // explicitly selected. Filtering by any other voucher type hides offloads so
    // they don't bleed through and confuse a filtered view.
    const includeOffloads = filters.voucherType === "all" || filters.voucherType === "Offload";
    const rows: DaybookRow[] = [
      ...filteredVouchers.map((v) => ({ _type: "voucher" as const, data: v })),
      ...(voucherPage === 1 && includeOffloads ? offloads.map((o) => ({ _type: "offload" as const, data: o })) : []),
    ];
    return rows.sort((a, b) => {
      const da = a._type === "voucher" ? a.data.voucherDate : a.data.offloadedAt.slice(0, 10);
      const db = b._type === "voucher" ? b.data.voucherDate : b.data.offloadedAt.slice(0, 10);
      if (da !== db) return filters.sortOrder === "asc" ? da.localeCompare(db) : db.localeCompare(da);
      const typeA = a._type === "voucher" ? (VOUCHER_TYPE_ORDER[a.data.voucherType] ?? 99) : 99;
      const typeB = b._type === "voucher" ? (VOUCHER_TYPE_ORDER[b.data.voucherType] ?? 99) : 99;
      if (typeA !== typeB) return typeA - typeB;
      const idA = a.data.id,
        idB = b.data.id;
      return filters.sortOrder === "asc" ? idA - idB : idB - idA;
    });
  }, [filters.voucherType, filters.sortOrder, filteredVouchers, voucherPage, offloads]);

  const visibleRows = useMemo(
    () =>
      allRows.filter(
        (r) => showHidden || !hiddenRowIds.has(r._type === "voucher" ? `voucher-${r.data.id}` : `offload-${r.data.id}`)
      ),
    [allRows, hiddenRowIds, showHidden]
  );
  const displayedRows = useMemo(() => visibleRows.slice(0, daybookRowLimit), [visibleRows, daybookRowLimit]);

  const canEdit = (v: Voucher) =>
    v.voucherType !== "Purchase" &&
    user?.role !== "POS" &&
    !isGoldenCoastProgrammeVoucher(v) &&
    !isVoucherMutationBlocked(v);
  const canDelete = () => !!(user?.role === "Developer" || user?.role === "Admin" || user?.canDeleteRecords);
  const handleView = (v: Voucher) => {
    setSelectedVoucher(v);
    setViewProfitFilter("all");
    setViewDialogOpen(true);
  };
  const handleEdit = (v: Voucher) => {
    if (v.voucherType === "Sales" || v.voucherType === "POS") {
      navigate(`/pos/edit/${v.id}`);
      return;
    }
    // Purchase lock icon → navigate directly to the container page for that PO
    if (v.voucherType === "Purchase") {
      fetch(`/api/vouchers/${v.id}/view-entries`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const po = data && !Array.isArray(data) ? data.purchaseOrder : null;
          if (po?.containerId) {
            navigate(`/containers/${po.containerId}`);
          } else {
            navigate(`${vouchersBase}?edit=${v.id}&tab=purchase&from=daybook`);
          }
        })
        .catch(() => navigate(`${vouchersBase}?edit=${v.id}&tab=purchase&from=daybook`));
      return;
    }
    const map: Record<string, string> = {
      PurchaseOrder: "purchase-order",
      Payment: "payment",
      Receipt: "receipt",
      Journal: "journal",
      Contra: "contra",
      StockTransfer: "transferorder",
      "Stock Transfer": "transferorder",
      Transfer: "transfer",
      "Credit Note": "credit-note",
      "Debit Note": "credit-note",
      Production: "adjustment",
      Consumption: "adjustment",
      Mixed: "adjustment",
    };
    const tab = map[v.voucherType];
    if (tab) navigate(`${vouchersBase}?edit=${v.id}&tab=${tab}&from=daybook`);
    else toast({ title: "Info", description: `Editing ${v.voucherType} not supported.`, variant: "destructive" });
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/vouchers/${id}`),
    onSuccess: () => {
      void invalidateCompanyApiFamily(queryClient, "/api/vouchers", selectedCompany?.id);
      refreshBalances();
      toast({ title: "Success", description: "Voucher deleted" });
      setDeleteDialogOpen(false);
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: EditVoucherForm }) =>
      apiRequest("PATCH", `/api/vouchers/${id}`, updates),
    onSuccess: () => {
      void invalidateCompanyApiFamily(queryClient, "/api/vouchers", selectedCompany?.id);
      refreshBalances();
      toast({ title: "Success", description: "Voucher updated" });
      setEditDialogOpen(false);
    },
  });

  const handleExportToExcel = async () => {
    const exportVouchers = await loadAllVouchers();
    const data = exportVouchers.map((v) => ({
      "Voucher Number": v.voucherNumber,
      Date: formatDisplayDate(v.voucherDate),
      Type: v.voucherType,
      Description: v.description || "",
      "Total Amount": formatAmount(v.totalAmount),
      Optional: v.optional ? "Yes" : "No",
    }));
    const ws = utils.json_to_sheet(data);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Daybook");
    await writeFile(wb, `Daybook_${format(new Date(), "yyyy-MM-dd")}.xlsx`);
  };
  const handleExportDetailedToExcel = async () => {
    const exportVouchers = await loadAllVouchers();
    const detailRows = buildDetailedDaybookRows(
      exportVouchers as unknown as Array<Record<string, unknown>>,
      formatDisplayDate
    );
    const ws = utils.json_to_sheet(detailRows);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Daybook Detail");
    await writeFile(wb, `Daybook_Detail_${format(new Date(), "yyyy-MM-dd")}.xlsx`);
    toast({ title: "Export complete", description: `${detailRows.length} detail rows exported.` });
  };

  return (
    <div className="flex flex-col gap-4 md:gap-6 p-3 md:p-6">
      <PageHeader title="Daybook" subtitle="View all accounting transactions chronologically" showBackButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2">
              <FileDown className="w-4 h-4" />
              Export
              <ChevronDown className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={handleExportToExcel}>Summary</DropdownMenuItem>
            <DropdownMenuItem onClick={handleExportDetailedToExcel}>Detailed</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button onClick={() => navigate(vouchersBase)} className="gap-2">
          <Plus className="w-4 h-4" />
          New Voucher
        </Button>
      </PageHeader>

      {/* Tab selector: Transactions / Edits & Activity */}
      <Tabs
        value={activeDaybookTab}
        onValueChange={(value) => setActiveDaybookTab(value as "transactions" | "activity")}
      >
        <TabsList className="w-fit">
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="activity">Edits &amp; Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="transactions" className="space-y-4 mt-0">
          <DaybookFilters
            periodFilter={periodFilter}
            setPeriodFilter={setPeriodFilter}
            filters={filters}
            setFilters={setFilters}
            hasActiveFilters={hasActiveDaybookFilters}
            onResetFilters={resetDaybookFilters}
            onPrevDay={() => shiftDay(-1)}
            onNextDay={() => shiftDay(1)}
          />

          <div>
            <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
              <div>
                <h2 className="text-base font-semibold">Transactions</h2>
                <p className="text-sm text-muted-foreground">All accounting vouchers and transactions</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowHidden(!showHidden)}
                  disabled={hiddenRowIds.size === 0}
                  className={cn("gap-1.5", showHidden && "text-foreground")}
                  data-testid="button-show-hidden"
                >
                  <EyeOff className="w-4 h-4" />
                  {showHidden ? "Showing hidden" : "Show hidden"}
                </Button>
                <div className="flex border rounded-md overflow-hidden">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setViewMode("detailed");
                      saveDaybookState({ viewMode: "detailed" });
                    }}
                    className={cn("rounded-none gap-1.5", viewMode === "detailed" && "bg-muted font-medium")}
                    data-testid="button-view-detailed"
                  >
                    <LayoutList className="w-4 h-4" />
                    Detailed
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setViewMode("condensed");
                      saveDaybookState({ viewMode: "condensed" });
                    }}
                    className={cn("rounded-none gap-1.5", viewMode === "condensed" && "bg-muted font-medium")}
                    data-testid="button-view-condensed"
                  >
                    <Layers className="w-4 h-4" />
                    Condensed
                  </Button>
                </div>
              </div>
            </div>
            <DaybookTable
              displayedRows={displayedRows}
              visibleRows={visibleRows}
              viewMode={viewMode}
              selectedRowId={selectedRowId}
              setSelectedRowId={setSelectedRowId}
              hiddenRowIds={hiddenRowIds}
              setHiddenRowIds={setHiddenRowIds}
              showHidden={showHidden}
              expandedVoucherId={expandedVoucherId}
              setExpandedVoucherId={setExpandedVoucherId}
              expandedCondensedGroups={expandedCondensedGroups}
              setExpandedCondensedGroups={setExpandedCondensedGroups}
              hideAmounts={hideAmounts}
              accountNameCache={accountNameCache}
              expandedLoading={expandedLoading}
              expandedEntries={expandedEntries}
              formatAmount={formatAmount}
              formatTransactionAmount={formatTransactionAmount}
              formatDisplayDate={formatDisplayDate}
              formatDisplayTime={formatDisplayTime}
              handleView={handleView}
              handleEdit={handleEdit}
              handleDelete={(v) => {
                setVoucherToDelete(v);
                setDeleteDialogOpen(true);
              }}
              canEdit={canEdit}
              canDelete={canDelete}
              daybookRowLimit={daybookRowLimit}
              setDaybookRowLimit={setDaybookRowLimit}
              DAYBOOK_PAGE_SIZE={DAYBOOK_PAGE_SIZE}
              navigate={navigate}
              isLoading={isLoading}
              errorMessage={daybookErrorMessage}
              onRetry={() => void refetchVouchers()}
            />
            <PaginationBar
              page={voucherPageResponse?.page ?? voucherPage}
              totalPages={voucherPageResponse?.totalPages ?? 0}
              total={voucherPageResponse?.total ?? 0}
              pageSize={voucherPageResponse?.pageSize ?? VOUCHER_PAGE_SIZE}
              onPageChange={(nextPage) => {
                setVoucherPage(nextPage);
                setDaybookRowLimit(DAYBOOK_PAGE_SIZE);
              }}
              noun="vouchers"
            />
          </div>

          <VoucherDetailsDialog
            open={viewDialogOpen}
            onOpenChange={setViewDialogOpen}
            selectedVoucher={selectedVoucher}
            viewEntriesLoading={viewEntriesLoading}
            viewVoucherEntries={viewVoucherEntries}
            isStockTransferVoucher={isStockTransferVoucher}
            voucherRevisions={voucherRevisions}
            revisionsLoading={revisionsLoading}
            revisionsError={revisionsError}
            revisionsErrorMessage={revisionsErrorDetail instanceof Error ? revisionsErrorDetail.message : undefined}
            retryVoucherRevisions={() => void retryVoucherRevisions()}
            formatAmount={formatAmount}
            formatDisplayDate={formatDisplayDate}
            formatDisplayTime={formatDisplayTime}
            cashAccountBalance={cashAccountBalance}
            entryBalances={entryBalances}
            purchaseOrderData={purchaseOrderData}
            poSupplierBalance={poSupplierBalance}
            selectedDialogRow={selectedDialogRow}
            setSelectedDialogRow={setSelectedDialogRow}
            viewProfitFilter={viewProfitFilter}
            setViewProfitFilter={setViewProfitFilter}
            user={user}
            handleEdit={handleEdit}
            canEdit={canEdit}
            navigate={navigate}
            employees={employees}
            ledgerAccounts={ledgerAccounts}
            bankAccounts={bankAccounts}
          />

          <VoucherEditDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            voucherToEdit={voucherToEdit}
            entriesLoading={entriesLoading}
            editForm={editForm}
            editFields={editFields}
            editAppend={editAppend}
            editRemove={editRemove}
            handleSaveEdit={(d) => voucherToEdit && editMutation.mutate({ id: voucherToEdit.id, updates: d })}
            editMutationPending={editMutation.isPending}
            ledgerAccounts={ledgerAccounts}
            bankAccounts={bankAccounts}
            suppliers={suppliers}
            employees={employees}
            fixedAssets={fixedAssets}
            formatAmount={formatAmount}
          />
        </TabsContent>

        <TabsContent value="activity" className="mt-2">
          {activeDaybookTab === "activity" && <AuditLog context="daybook" defaultActions="all" />}
        </TabsContent>
      </Tabs>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => voucherToDelete && deleteMutation.mutate(voucherToDelete.id)}
              className="bg-destructive"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
