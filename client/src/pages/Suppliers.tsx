import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/use-debounce";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Edit, Eye, EyeOff, FileText, Search, Truck, Users, Container, DollarSign } from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { companyDataKey } from "@/lib/frontendDataArchitecture";
import { suppliersApi } from "@/api/suppliersApi";
import { format } from "date-fns";
import { utils, writeFile } from "@/lib/excelHelper";
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
  const { formatAmount: legacyFormatAmount, formatHistoricalBaseAmount } = useCurrencyContext();
  // Keep lightweight page-test providers and older embedded consumers working
  // while production uses the historical-base formatter.
  const formatAmount = formatHistoricalBaseAmount ?? legacyFormatAmount;
  const { toast } = useToast();
  const [_location, navigate] = useLocation();
  const {
    filters: { companyFilter, hideZeroBalance, searchTerm, dateFilter, hidePayments },
    setFilter,
    resetFilters,
    hasActiveFilters,
    setCompanyFilter,
    setDateFilter,
    setHidePayments,
  } = useSuppliersFilters(selectedCompany?.id);
  const debouncedSearch = useDebounce(searchTerm, 300);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => suppliersApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers/stats"] });
      toast({ title: "Supplier deleted" });
      setSupplierToDelete(null);
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setSupplierToDelete(null);
    },
  });

  const handleTransactionClick = async (txn: SupplierLedgerRow) => {
    const targetCompany = companies.find((c) => c.id === txn.companyId);
    if (targetCompany && (!selectedCompany || selectedCompany.id !== txn.companyId)) {
      await apiRequest("POST", "/api/auth/set-company", { companyId: txn.companyId });
      selectCompany(targetCompany);
    }
    setSelectedSupplier(null);
    const tabName = voucherTabForType(txn.voucherType);
    if (tabName) {
      navigate(`/vouchers?edit=${txn.voucherId}&tab=${tabName}`);
    } else {
      navigate(`/voucher-detail/${txn.voucherId}`);
    }
  };

  const { data: suppliers = [], isLoading } = useQuery<SupplierWithStats[]>({
    queryKey: companyDataKey("/api/suppliers/stats", selectedCompany?.id),
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const unifiedLedgerUrl =
    companyFilter !== "all"
      ? `/api/suppliers/${selectedSupplier?.id}/unified-ledger?companyId=${companyFilter}`
      : `/api/suppliers/${selectedSupplier?.id}/unified-ledger`;

  const { data: unifiedLedger = [], isLoading: ledgerLoading } = useQuery<SupplierLedgerRow[]>({
    queryKey: [unifiedLedgerUrl],
    enabled: !!selectedSupplier,
  });

  const purchaseOrdersUrl =
    companyFilter !== "all"
      ? `/api/suppliers/${selectedSupplier?.id}/purchase-orders?companyId=${companyFilter}`
      : `/api/suppliers/${selectedSupplier?.id}/purchase-orders`;

  const { data: purchaseOrders = [], isLoading: posLoading } = useQuery<SupplierPurchaseOrder[]>({
    queryKey: [purchaseOrdersUrl],
    enabled: !!selectedSupplier,
  });

  const activeSuppliers = suppliers.filter((s) => s.active);
  const totalContainers = suppliers.reduce((sum, s) => sum + Number(s.containerCount || 0), 0);
  const totalBalance = suppliers.reduce((sum, s) => sum + Number(s.balance || 0), 0);

  const sortedSuppliers = [...suppliers]
    .filter((s) => (hideZeroBalance ? s.balance !== 0 : true))
    .filter((s) => debouncedSearch.trim() === "" || s.legalName.toLowerCase().includes(debouncedSearch.toLowerCase()))
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
    navigate(`/purchase-orders/${po.id}/edit`);
  };

  const handleContainerClick = async (po: { companyId: number | null; containerId?: number | null }) => {
    if (!po.containerId) return;
    const targetCompany = companies.find((c) => c.id === po.companyId);
    if (targetCompany && (!selectedCompany || selectedCompany.id !== po.companyId)) {
      await apiRequest("POST", "/api/auth/set-company", { companyId: po.companyId });
      selectCompany(targetCompany);
    }
    setSelectedSupplier(null);
    navigate(`/containers/${po.containerId}`);
  };

  const handleExportToExcel = async () => {
    if (!selectedSupplier || unifiedLedger.length === 0) return;
    const worksheet = utils.json_to_sheet(supplierLedgerToExportRows(unifiedLedger));
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "Supplier Ledger");
    const fileName = `${selectedSupplier.legalName}_Ledger_${format(new Date(), "yyyy-MM-dd")}.xlsx`;
    await writeFile(workbook, fileName);
  };

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Suppliers"
        subtitle="Manage supplier accounts and track container shipments"
        showBackButton={false}
      />

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

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search suppliers..."
            value={searchTerm}
            onChange={(e) => setFilter("searchTerm", e.target.value)}
            className="pl-9"
            data-testid="input-supplier-search"
          />
        </div>
        <Button
          variant={hideZeroBalance ? "secondary" : "outline"}
          size="default"
          onClick={() => setFilter("hideZeroBalance", !hideZeroBalance)}
          data-testid="button-toggle-zero-balance"
        >
          {hideZeroBalance ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
          {hideZeroBalance ? "Hide Zero" : "Show All"}
        </Button>
        {hasActiveFilters && (
          <Button variant="outline" type="button" onClick={resetFilters} data-testid="button-reset-filters">
            Reset filters
          </Button>
        )}
      </div>

      {/* Supplier list */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-xl border bg-card p-4 flex items-center gap-4">
              <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-40 rounded" />
                <Skeleton className="h-3 w-24 rounded" />
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
            <p className="text-xs text-muted-foreground mt-0.5">Create suppliers in the Master Data page</p>
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
                    <span className="ml-1 opacity-70 text-[10px]">{supplier.balance > 0 ? "Cr" : "Dr"}</span>
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
                className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => navigate(`/suppliers/${supplier.id}/proformas`)}
                  data-testid={`button-proformas-supplier-${supplier.id}`}
                  title="Proformas"
                >
                  <FileText className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => navigate(`/suppliers/${supplier.id}/edit`)}
                  data-testid={`button-edit-supplier-${supplier.id}`}
                  title="Edit"
                >
                  <Edit className="h-4 w-4" />
                </Button>
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
        onTransactionClick={handleTransactionClick}
        onPOClick={handlePOClick}
        onContainerClick={handleContainerClick}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!supplierToDelete} onOpenChange={(open) => !open && setSupplierToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Supplier</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{supplierToDelete?.name}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => supplierToDelete && deleteMutation.mutate(supplierToDelete.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-supplier"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
