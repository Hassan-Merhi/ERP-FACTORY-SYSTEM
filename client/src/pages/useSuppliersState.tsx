// Extracted from ./Suppliers.tsx to keep that module under the source-size cap.
import { searchIncludes } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/use-debounce";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import {
  erpCanDenialMessage as canDenialMessage,
  erpReportFileName,
  exportErpReportRowsExcel,
  useErpCan as useCan,
  useErpRecordChangeAccess as useExistingRecordChangeAccess,
} from "@/erp-core";
import { erpCompanyDataKey, invalidateErpDataFamilies } from "@/erp-core/erpData";
import { Skeleton } from "@/components/ui/skeleton";
import { Container, DollarSign, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { type Company, useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { intercompanyTradingSetupText } from "@/i18n/intercompanyTradingSetupTranslations";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { suppliersApi } from "@/api/suppliersApi";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useSuppliersFilters } from "./suppliers/useSuppliersFilters";
import type { SupplierLedgerRow, SupplierPurchaseOrder, SupplierWithStats } from "./suppliers/supplierDisplay";
import {
  filterLedgerRowsByDate,
  matchesSupplierDestination,
  supplierLedgerToExportRows,
  voucherTabForType,
} from "./suppliers/ledgerSummaries";
import type { SupplierDetailTab } from "./suppliers/SupplierDetailDialog";

export function useSuppliersState() {
  const [selectedSupplier, setSelectedSupplier] = useState<SupplierWithStats | null>(null);
  const [dialogTab, setDialogTab] = useState<SupplierDetailTab>("transactions");
  const [destinationFilter, setDestinationFilter] = useState("all");
  const [supplierToDelete, setSupplierToDelete] = useState<{ id: number; name: string } | null>(null);

  useEscapeBack(selectedSupplier ? () => setSelectedSupplier(null) : null);

  const { selectedCompany, selectCompany } = useCompany();
  const isProperties = selectedCompany?.companyType === "properties";
  const tradingCopy = intercompanyTradingSetupText(useApplicationLanguageCode());
  const { formatAmount: legacyFormatAmount, formatHistoricalBaseAmount } = useCurrencyContext();
  // Keep lightweight page-test providers and older embedded consumers working
  // while production uses the historical-base formatter.
  const formatAmount = formatHistoricalBaseAmount ?? legacyFormatAmount;
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const {
    filters: { companyFilter, hideZeroBalance, searchTerm, dateFilter, hidePayments },
    setFilter,
    resetFilters,
    hasActiveFilters,
    setCompanyFilter,
    setDateFilter,
    setHidePayments,
  } = useSuppliersFilters(selectedCompany?.id, isProperties);
  const debouncedSearch = useDebounce(searchTerm, 300);
  const mayDeleteSupplier = useCan("erp.suppliers", "delete", { legacyAllowed: selectedCompany?.role !== "POS" });
  const mayExportSupplier = useCan("erp.suppliers", "export", { legacyAllowed: true, featureKey: "exp_excel" });
  // View Only and Create Only roles cannot change existing suppliers.
  const recordChanges = useExistingRecordChangeAccess();

  const deleteMutation = useMutation({
    mutationFn: (id: number) => {
      if (!mayDeleteSupplier.allowed) throw new Error(canDenialMessage(mayDeleteSupplier.reason));
      return suppliersApi.delete(id);
    },
    onSuccess: () => {
      void invalidateErpDataFamilies(queryClient, ["/api/suppliers"]);
      toast({ title: "Supplier deleted" });
      setSupplierToDelete(null);
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      setSupplierToDelete(null);
    },
  });

  // Keep Properties supplier drilldowns in the Properties shell. When an
  // authorized cross-company row is opened, use that company's shell.
  const partyPath = (companyId: number | null | undefined, path: string) => {
    const company = companies.find((entry) => entry.id === companyId);
    return (company?.companyType === "properties" || (!company && isProperties) ? "/properties" : "") + path;
  };

  const handleTransactionClick = async (txn: SupplierLedgerRow) => {
    const targetCompany = companies.find((c) => c.id === txn.companyId);
    if (targetCompany && (!selectedCompany || selectedCompany.id !== txn.companyId)) {
      await apiRequest("POST", "/api/auth/set-company", { companyId: txn.companyId });
      selectCompany(targetCompany);
    }
    setSelectedSupplier(null);
    const tabName = voucherTabForType(txn.voucherType);
    if (tabName) {
      navigate(partyPath(txn.companyId, `/vouchers?edit=${txn.voucherId}&tab=${tabName}`));
    } else {
      navigate(partyPath(txn.companyId, `/voucher-detail/${txn.voucherId}`));
    }
  };

  const { data: suppliers = [], isLoading } = useQuery<SupplierWithStats[]>({
    queryKey: erpCompanyDataKey("/api/suppliers/stats", selectedCompany?.id),
    enabled: selectedCompany?.id != null,
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const unifiedLedgerUrl =
    companyFilter !== "all"
      ? `/api/suppliers/${selectedSupplier?.id}/unified-ledger?companyId=${companyFilter}`
      : `/api/suppliers/${selectedSupplier?.id}/unified-ledger`;

  const { data: unifiedLedger = [], isLoading: ledgerLoading } = useQuery<SupplierLedgerRow[]>({
    queryKey: erpCompanyDataKey(unifiedLedgerUrl, selectedCompany?.id),
    enabled: !!selectedSupplier && selectedCompany?.id != null,
  });

  const purchaseOrdersUrl =
    companyFilter !== "all"
      ? `/api/suppliers/${selectedSupplier?.id}/purchase-orders?companyId=${companyFilter}`
      : `/api/suppliers/${selectedSupplier?.id}/purchase-orders?includeAccessibleCompanies=1`;

  const { data: purchaseOrders = [], isLoading: posLoading } = useQuery<SupplierPurchaseOrder[]>({
    queryKey: erpCompanyDataKey(purchaseOrdersUrl, selectedCompany?.id),
    enabled: !!selectedSupplier && selectedCompany?.id != null,
  });

  const activeSuppliers = suppliers.filter((s) => s.active);
  const totalContainers = suppliers.reduce((sum, s) => sum + Number(s.containerCount || 0), 0);
  const totalBalance = suppliers.reduce((sum, s) => sum + Number(s.balance || 0), 0);

  const sortedSuppliers = [...suppliers]
    .filter((s) => (hideZeroBalance ? s.balance !== 0 : true))
    .filter((s) => !debouncedSearch.trim() || searchIncludes(s.legalName, debouncedSearch))
    .sort((a, b) => a.legalName.localeCompare(b.legalName));

  const handleSupplierClick = (supplier: SupplierWithStats) => {
    setSelectedSupplier(supplier);
    setCompanyFilter("all");
    setDestinationFilter("all");
    setDialogTab("transactions");
    setDateFilter("all");
  };

  const handleCloseDialog = () => {
    setSelectedSupplier(null);
    setCompanyFilter("all");
    setDestinationFilter("all");
    setDialogTab("transactions");
    setDateFilter("all");
  };

  const handlePOClick = async (po: SupplierPurchaseOrder) => {
    const targetCompany = companies.find((c) => c.id === po.companyId);
    if (targetCompany && (!selectedCompany || selectedCompany.id !== po.companyId)) {
      await apiRequest("POST", "/api/auth/set-company", { companyId: po.companyId });
      selectCompany(targetCompany);
    }
    setSelectedSupplier(null);
    navigate(partyPath(po.companyId, `/purchase-orders/${po.id}/edit`));
  };

  const handleContainerClick = async (po: { companyId: number | null; containerId?: number | null }) => {
    if (!po.containerId) return;
    const targetCompany = companies.find((c) => c.id === po.companyId);
    if (targetCompany && (!selectedCompany || selectedCompany.id !== po.companyId)) {
      await apiRequest("POST", "/api/auth/set-company", { companyId: po.companyId });
      selectCompany(targetCompany);
    }
    setSelectedSupplier(null);
    navigate(partyPath(po.companyId, `/containers/${po.containerId}`));
  };

  const handleExportToExcel = async () => {
    if (!selectedSupplier || unifiedLedger.length === 0) return;
    if (!mayExportSupplier.allowed) {
      toast({
        title: "Export unavailable",
        description: canDenialMessage(mayExportSupplier.reason),
        variant: "destructive",
      });
      return;
    }
    const exportRows = filterLedgerRowsByDate(
      unifiedLedger.filter(
        (row) =>
          matchesSupplierDestination(row.destinationCompanyId, destinationFilter) &&
          (destinationFilter === "all" || row.type !== "opening")
      ),
      dateFilter
    );
    if (!exportRows.length) {
      toast({ title: "No transactions to export", description: "Change the destination or date filter." });
      return;
    }
    await exportErpReportRowsExcel({
      rows: supplierLedgerToExportRows(exportRows),
      sheetName: "Supplier Ledger",
      fileName: erpReportFileName(`${selectedSupplier.legalName}_Ledger`, "xlsx"),
      universalDesign: true,
      companyName: selectedCompany?.name,
    });
  };
  return {
    activeSuppliers,
    companies,
    companyFilter,
    dateFilter,
    deleteMutation,
    destinationFilter,
    dialogTab,
    formatAmount,
    handleCloseDialog,
    handleContainerClick,
    handleExportToExcel,
    handlePOClick,
    handleSupplierClick,
    handleTransactionClick,
    hasActiveFilters,
    hidePayments,
    hideZeroBalance,
    isLoading,
    isProperties,
    ledgerLoading,
    mayDeleteSupplier,
    mayExportSupplier,
    navigate,
    posLoading,
    purchaseOrders,
    recordChanges,
    resetFilters,
    searchTerm,
    selectedCompany,
    selectedSupplier,
    setCompanyFilter,
    setDateFilter,
    setDestinationFilter,
    setDialogTab,
    setFilter,
    setHidePayments,
    setSupplierToDelete,
    sortedSuppliers,
    supplierToDelete,
    suppliers,
    totalBalance,
    totalContainers,
    tradingCopy,
    unifiedLedger,
  };
}

export function SuppliersSection({
  activeSuppliers,
  formatAmount,
  isLoading,
  totalBalance,
  totalContainers,
}: Pick<
  ReturnType<typeof useSuppliersState>,
  "activeSuppliers" | "formatAmount" | "isLoading" | "totalBalance" | "totalContainers"
>) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {isLoading ? (
        [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)
      ) : (
        <>
          <div className="rounded-xl border bg-card p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Active Suppliers</p>
              <p className="text-2xl font-bold leading-tight" data-testid="text-active-suppliers">
                {activeSuppliers.length}
              </p>
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
              <Container className="w-5 h-5 text-violet-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Containers</p>
              <p className="text-2xl font-bold leading-tight" data-testid="text-total-containers">
                {totalContainers}
              </p>
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
              <DollarSign className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Outstanding</p>
              <p className="text-xl font-bold leading-tight font-mono" data-testid="text-total-balance">
                {formatAmount(totalBalance)}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
