import { Button } from "@/components/ui/button";
import { useCompany } from "@/contexts/CompanyContext";
import { Plus, Users, Wallet, TrendingUp, TrendingDown, EyeOff, Eye } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { ErpListFilters } from "@/erp-core";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useCompanyCustomersState } from "./useCompanyCustomersState";
import { CompanyCustomersDialogSection } from "./CompanyCustomersDialogSection";
import { CompanyCustomersContent } from "./CompanyCustomersContent";

// Remount the filters on company switches, so the Retail default does not
// inherit the previous company's hide-zero preference while context loads.
export default function Customers() {
  const { selectedCompany } = useCompany();
  return <CompanyCustomers key={selectedCompany?.id ?? "loading"} />;
}

function CompanyCustomers() {
  const {
    customers,
    refetchCustomers,
    customersError,
    CustomerForm,
    filteredCustomers,
    form,
    formatHistoricalBaseAmount,
    handleEditClick,
    hasActiveFilters,
    hideZero,
    isCreateOpen,
    isEditOpen,
    isLoading,
    ledgerTxns,
    recordChanges,
    resetFilters,
    retailHistory,
    retailHistoryError,
    retailHistoryLoading,
    searchQuery,
    selectedCompany,
    setEditingCustomer,
    setFilter,
    setIsCreateOpen,
    setIsEditOpen,
    setStatementCustomer,
    statementCustomer,
    totalCustomers,
    totalPayable,
    totalReceivable,
    txnsLoading,
    withBalance,
  } = useCompanyCustomersState();

  return (
    <div className="flex flex-col h-full gap-5 py-3 sm:p-6">
      {/* Header */}
      <PageHeader title="Customers" subtitle="Manage customer accounts and receivables" showBackButton={false}>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-customer">
              <Plus className="mr-2 h-4 w-4" />
              New Customer
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Customer</DialogTitle>
            </DialogHeader>
            <CustomerForm isEdit={false} />
          </DialogContent>
        </Dialog>
      </PageHeader>

      {/* Stats pills: a two-column grid on phones so no pill is orphaned on its own row. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-3 [&>*]:min-w-0">
        {isLoading ? (
          <>
            <Skeleton className="h-10 w-40 rounded-lg" />
            <Skeleton className="h-10 w-40 rounded-lg" />
            <Skeleton className="h-10 w-44 rounded-lg" />
            <Skeleton className="h-10 w-44 rounded-lg" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Total Customers</span>
              <span className="font-semibold">{totalCustomers}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">With Balance</span>
              <span className="font-semibold">{withBalance}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <TrendingUp className="h-4 w-4 text-blue-500" />
              <span className="text-muted-foreground">Receivable</span>
              <span className="font-semibold font-mono">{formatHistoricalBaseAmount(totalReceivable)}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <TrendingDown className="h-4 w-4 text-red-500" />
              <span className="text-muted-foreground">Payable</span>
              <span className="font-semibold font-mono">{formatHistoricalBaseAmount(totalPayable)}</span>
            </div>
          </>
        )}
      </div>

      {/* Shared search and phone filter sheet; original persisted filters remain unchanged. */}
      <ErpListFilters
        search={searchQuery}
        onSearchChange={(value) => setFilter("searchQuery", value)}
        searchPlaceholder="Search customers..."
        searchTestId="input-search-customers"
        mobileFilters
        filterLabel="Customer filters"
        activeFilterCount={hasActiveFilters ? 1 : 0}
        onResetFilters={resetFilters}
        filters={
          <Button
            variant="outline"
            type="button"
            onClick={() => setFilter("hideZero", !hideZero)}
            data-testid="button-toggle-hide-zero"
          >
            {hideZero ? <Eye className="mr-2 h-4 w-4" /> : <EyeOff className="mr-2 h-4 w-4" />}
            {hideZero ? "Show Zero" : "Hide Zero"}
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

      {/* Table */}
      <CompanyCustomersContent
        customers={customers}
        customersError={customersError}
        filteredCustomers={filteredCustomers}
        formatHistoricalBaseAmount={formatHistoricalBaseAmount}
        handleEditClick={handleEditClick}
        isLoading={isLoading}
        recordChanges={recordChanges}
        refetchCustomers={refetchCustomers}
        searchQuery={searchQuery}
        selectedCompany={selectedCompany}
        setStatementCustomer={setStatementCustomer}
      />

      {/* Edit Dialog */}
      <Dialog
        open={isEditOpen}
        onOpenChange={(open) => {
          setIsEditOpen(open);
          if (!open) {
            setEditingCustomer(null);
            form.reset({
              companyId: selectedCompany?.id || 0,
              legalName: "",
              phone: "",
              openingBalance: "0",
              openingBalanceSide: "Dr",
            });
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Customer</DialogTitle>
          </DialogHeader>
          <CustomerForm isEdit={true} />
        </DialogContent>
      </Dialog>

      {/* Statement Dialog */}
      <CompanyCustomersDialogSection
        formatHistoricalBaseAmount={formatHistoricalBaseAmount}
        ledgerTxns={ledgerTxns}
        retailHistory={retailHistory}
        retailHistoryError={retailHistoryError}
        retailHistoryLoading={retailHistoryLoading}
        selectedCompany={selectedCompany}
        setStatementCustomer={setStatementCustomer}
        statementCustomer={statementCustomer}
        txnsLoading={txnsLoading}
      />
    </div>
  );
}
