import { searchIncludes } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/use-debounce";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  ErpListFilters,
  ErpConfirmDialog,
  ErpRecordAction,
  erpReportFileName,
  exportErpReportRowsExcel,
  useErpCan as useCan,
  erpCanDenialMessage as canDenialMessage,
  useErpRecordChangeAccess as useExistingRecordChangeAccess,
} from "@/erp-core";
import { erpCompanyDataKey, invalidateErpDataFamilies } from "@/erp-core/erpData";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Edit, Eye, EyeOff, FileText, Search, Truck, Users, Container, DollarSign, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { intercompanyTradingSetupText } from "@/i18n/intercompanyTradingSetupTranslations";

import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { suppliersApi } from "@/api/suppliersApi";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useSuppliersFilters } from "./suppliers/useSuppliersFilters";
import type { Company } from "@/contexts/CompanyContext";
import type { SupplierLedgerRow, SupplierPurchaseOrder, SupplierWithStats } from "./suppliers/supplierDisplay";
import { getAvatarColor, getInitials } from "./suppliers/supplierDisplay";
import { supplierLedgerToExportRows, voucherTabForType, type SupplierDateFilter } from "./suppliers/ledgerSummaries";
import { SupplierDetailDialog, type SupplierDetailTab } from "./suppliers/SupplierDetailDialog";

export default function Suppliers() {
  const [selectedSupplier, setSelectedSupplier] = useState<SupplierWithStats | null>(null);
  const [dialogTab, setDialogTab] = useState<SupplierDetailTab>("transactions");
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      : `/api/suppliers/${selectedSupplier?.id}/purchase-orders`;

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
    setDialogTab("transactions");
    setDateFilter("all");
  };

  const handleCloseDialog = () => {
    setSelectedSupplier(null);
    setCompanyFilter("all");
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
    await exportErpReportRowsExcel({
      rows: supplierLedgerToExportRows(unifiedLedger),
      sheetName: "Supplier Ledger",
      fileName: erpReportFileName(`${selectedSupplier.legalName}_Ledger`, "xlsx"),
    });
  };

  return (
    <div className="space-y-5 py-3 sm:p-6">
      <PageHeader
        title="Suppliers"
        subtitle="Manage supplier accounts and track container shipments"
        showBackButton={false}
      >
        {isProperties && ["Owner", "Developer", "Admin", "Create Only"].includes(selectedCompany?.role || "") && (
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/properties/master-data?entity=supplier")}
            data-testid="button-properties-add-supplier"
          >
            <Plus className="h-4 w-4 mr-2" /> {tradingCopy.addSupplier}
          </Button>
        )}
      </PageHeader>

      {/* Stat cards */}
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

      <ErpListFilters
        search={searchTerm}
        onSearchChange={(value) => setFilter("searchTerm", value)}
        searchPlaceholder="Search suppliers..."
        searchTestId="input-supplier-search"
        mobileFilters
        filterLabel="Supplier filters"
        activeFilterCount={hasActiveFilters ? 1 : 0}
        onResetFilters={resetFilters}
        filters={
          <Button
            variant={hideZeroBalance ? "secondary" : "outline"}
            type="button"
            onClick={() => setFilter("hideZeroBalance", !hideZeroBalance)}
            data-testid="button-toggle-zero-balance"
          >
            {hideZeroBalance ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
            {hideZeroBalance ? "Hide Zero" : "Show All"}
          </Button>
        }
        actions={
          hasActiveFilters ? (
            <Button variant="outline" type="button" onClick={resetFilters} data-testid="button-reset-filters">
              Reset filters
            </Button>
          ) : undefined
        }
      />

      {/* Supplier list */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-xl border bg-card p-4 flex items-center gap-4">
              <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-40 rounded-sm" />
                <Skeleton className="h-3 w-24 rounded-sm" />
              </div>
              <Skeleton className="h-6 w-28 rounded-md" />
            </div>
          ))}
        </div>
      ) : suppliers.length === 0 ? (
        <div className="border rounded-xl bg-muted/20 flex flex-col items-center justify-center py-16 gap-3 text-center">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
            <Truck className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">No suppliers found</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isProperties
                ? "Use Add Supplier above to create your first supplier"
                : "Create suppliers in the Master Data page"}
            </p>
          </div>
        </div>
      ) : sortedSuppliers.length === 0 ? (
        <div className="border rounded-xl bg-muted/20 flex flex-col items-center justify-center py-12 gap-3 text-center">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
            <Search className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">No results</p>
            <p className="text-xs text-muted-foreground mt-0.5">Try adjusting your search or filter</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedSuppliers.map((supplier) => (
            <div
              key={supplier.id}
              className="rounded-xl border bg-card p-4 cursor-pointer hover-elevate flex items-center gap-4 group"
              onClick={() => handleSupplierClick(supplier)}
              data-testid={`row-supplier-${supplier.id}`}
            >
              {/* Avatar */}
              <div
                className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold ${getAvatarColor(supplier.id)}`}
              >
                {getInitials(supplier.legalName)}
              </div>

              {/* Name + meta */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm" data-testid={`button-supplier-name-${supplier.id}`}>
                    {supplier.legalName}
                  </span>
                  {!supplier.active && (
                    <Badge variant="secondary" className="text-xs">
                      Inactive
                    </Badge>
                  )}
                </div>
                {supplier.containerCount > 0 ? (
                  <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-containers-${supplier.id}`}>
                    {supplier.containerCount} container{supplier.containerCount !== 1 ? "s" : ""}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-0.5">No containers</p>
                )}
              </div>

              {/* Balance */}
              <div className="shrink-0 text-right hidden sm:block">
                {supplier.balance === 0 ? (
                  <span className="text-xs text-muted-foreground" data-testid={`text-balance-${supplier.id}`}>
                    —
                  </span>
                ) : (
                  <span
                    className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-mono font-semibold ${
                      supplier.balance > 0
                        ? "bg-red-500/10 text-red-600 dark:text-red-400"
                        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    }`}
                    data-testid={`text-balance-${supplier.id}`}
                  >
                    {formatAmount(Math.abs(supplier.balance))}
                    <span className="ml-1 opacity-70 text-[11px]">{supplier.balance > 0 ? "Cr" : "Dr"}</span>
                  </span>
                )}
              </div>

              {/* Mobile balance */}
              <div className="shrink-0 sm:hidden">
                {supplier.balance !== 0 && (
                  <span
                    className={`text-xs font-mono font-semibold ${
                      supplier.balance > 0 ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"
                    }`}
                    data-testid={`text-balance-mobile-${supplier.id}`}
                  >
                    {formatAmount(Math.abs(supplier.balance))}
                  </span>
                )}
              </div>

              {/* Actions */}
              <div
                className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => navigate(`${isProperties ? "/properties" : ""}/suppliers/${supplier.id}/proformas`)}
                  data-testid={`button-proformas-supplier-${supplier.id}`}
                  title="Proformas"
                >
                  <FileText className="h-4 w-4" />
                </Button>
                <ErpRecordAction
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (recordChanges.allowed)
                      navigate(`${isProperties ? "/properties" : ""}/suppliers/${supplier.id}/edit`);
                  }}
                  permitted={recordChanges.allowed}
                  deniedReason={recordChanges.reason}
                  data-testid={`button-edit-supplier-${supplier.id}`}
                  title={recordChanges.reason ?? "Edit"}
                  aria-label={recordChanges.reason ?? "Edit supplier"}
                >
                  <Edit className="h-4 w-4" />
                </ErpRecordAction>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Supplier Details Dialog */}
      <SupplierDetailDialog
        supplier={selectedSupplier}
        companies={companies}
        formatAmount={formatAmount}
        companyFilter={companyFilter}
        onCompanyFilterChange={setCompanyFilter}
        dateFilter={dateFilter}
        onDateFilterChange={(v: SupplierDateFilter) => setDateFilter(v)}
        hidePayments={hidePayments}
        onToggleHidePayments={() => setHidePayments((v) => !v)}
        unifiedLedger={unifiedLedger}
        ledgerLoading={ledgerLoading}
        purchaseOrders={purchaseOrders}
        posLoading={posLoading}
        dialogTab={dialogTab}
        onDialogTabChange={setDialogTab}
        onClose={handleCloseDialog}
        onExport={handleExportToExcel}
        canExport={mayExportSupplier.allowed}
        exportUnavailableReason={canDenialMessage(mayExportSupplier.reason)}
        onTransactionClick={handleTransactionClick}
        onPOClick={handlePOClick}
        onContainerClick={handleContainerClick}
      />

      {/* Centralized destructive confirmation, with the existing permission checks. */}
      <ErpConfirmDialog
        open={supplierToDelete !== null}
        onOpenChange={(open) => !open && setSupplierToDelete(null)}
        title="Delete Supplier"
        description={
          <>
            Are you sure you want to delete <strong>{supplierToDelete?.name}</strong>? This action cannot be undone.
          </>
        }
        tone="destructive"
        confirmText="Delete"
        confirmButtonTestId="button-confirm-delete-supplier"
        confirmDisabled={!mayDeleteSupplier.allowed || !recordChanges.allowed}
        loading={deleteMutation.isPending}
        onConfirm={async () => {
          if (!supplierToDelete || !mayDeleteSupplier.allowed || !recordChanges.allowed) return;
          await deleteMutation.mutateAsync(supplierToDelete.id);
        }}
      />
    </div>
  );
}
