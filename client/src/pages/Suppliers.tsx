import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { ErpListFilters, ErpConfirmDialog, erpCanDenialMessage as canDenialMessage } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Eye, EyeOff, Search, Truck, Plus } from "lucide-react";
import { type SupplierDateFilter } from "./suppliers/ledgerSummaries";
import { SupplierDetailDialog } from "./suppliers/SupplierDetailDialog";
import { SuppliersSection, useSuppliersState } from "./useSuppliersState";
import { SuppliersContent } from "./SuppliersContent";

export default function Suppliers() {
  const {
    refetch,
    isError,
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
        <RowsExportMenu
          title="Suppliers"
          rows={sortedSuppliers}
          columns={[
            { header: "Supplier", value: (supplier) => supplier.legalName },
            { header: "Status", value: (supplier) => (supplier.active ? "Active" : "Inactive") },
            { header: "Containers", value: (supplier) => supplier.containerCount, type: "number" },
            {
              header: "Balance",
              value: (supplier) => (supplier.balance === 0 ? null : Math.abs(supplier.balance)),
              type: "number",
            },
            {
              header: "Dr/Cr",
              value: (supplier) => (supplier.balance === 0 ? "" : supplier.balance > 0 ? "Cr" : "Dr"),
            },
          ]}
          resource="erp.suppliers"
          size="default"
        />
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
      ) : isError && suppliers.length === 0 ? (
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="py-16" />
      ) : suppliers.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No suppliers found"
          description={
            isProperties
              ? "Use Add Supplier above to create your first supplier"
              : "Create suppliers in the Master Data page"
          }
          className="py-16"
        />
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
        <SuppliersContent
          formatAmount={formatAmount}
          handleSupplierClick={handleSupplierClick}
          isProperties={isProperties}
          navigate={navigate}
          recordChanges={recordChanges}
          sortedSuppliers={sortedSuppliers}
        />
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
