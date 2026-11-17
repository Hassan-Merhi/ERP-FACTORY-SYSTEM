import { PageHeader } from "@/components/PageHeader";
import { ErpListFilters, ErpConfirmDialog, ErpRecordAction, erpCanDenialMessage as canDenialMessage } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Edit, Eye, EyeOff, FileText, Search, Truck, Plus } from "lucide-react";
import { getAvatarColor, getInitials } from "./suppliers/supplierDisplay";
import { type SupplierDateFilter } from "./suppliers/ledgerSummaries";
import { SupplierDetailDialog } from "./suppliers/SupplierDetailDialog";
import { SuppliersSection, useSuppliersState } from "./useSuppliersState";

export default function Suppliers() {
  const {
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
  } = useSuppliersState();

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
      <SuppliersSection
        activeSuppliers={activeSuppliers}
        formatAmount={formatAmount}
        isLoading={isLoading}
        totalBalance={totalBalance}
        totalContainers={totalContainers}
      />

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
        destinationFilter={destinationFilter}
        onDestinationFilterChange={setDestinationFilter}
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
