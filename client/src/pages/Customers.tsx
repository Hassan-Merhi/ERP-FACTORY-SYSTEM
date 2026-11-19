import { Button } from "@/components/ui/button";
import { drCrClass } from "@/lib/formatNumber";
import { useCompany } from "@/contexts/CompanyContext";
import { Plus, Building2, Pencil, Users, Wallet, TrendingUp, TrendingDown, EyeOff, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { ErpListFilters, ErpListTable, ErpRecordAction } from "@/erp-core";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompanyCustomersState } from "./useCompanyCustomersState";
import { CompanyCustomersDialogSection } from "./CompanyCustomersDialogSection";
import { ErrorState } from "@/components/ui/page-state";

type CustomerCurrencyBalances = Record<string, { debit: number; credit: number; net: number }>;

function getCustomerCurrencyBalances(customer: unknown): CustomerCurrencyBalances | undefined {
  if (!customer || typeof customer !== "object") return undefined;
  const balances = (customer as { balancesByCurrency?: unknown }).balancesByCurrency;
  return balances && typeof balances === "object" ? (balances as CustomerCurrencyBalances) : undefined;
}

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
      <div className="border rounded-xl overflow-hidden">
        <ErpListTable
          pageKey="customers"
          companyId={selectedCompany?.id}
          mobileLayout="cards"
          scrollLabel="Customer accounts"
        >
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="text-xs h-9 font-semibold">Customer</TableHead>
              <TableHead className="text-xs h-9 font-semibold text-right">Balance</TableHead>
              <TableHead className="text-xs h-9 font-semibold w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(6)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-28" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-28 ml-auto" />
                  </TableCell>
                  <TableCell></TableCell>
                </TableRow>
              ))
            ) : customersError && customers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <ErrorState onAction={() => void refetchCustomers()} actionLabel="Try again" className="my-2" />
                </TableCell>
              </TableRow>
            ) : filteredCustomers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">No customers found</p>
                    <p className="text-xs text-muted-foreground">
                      {searchQuery ? "Try a different search term" : "Add your first customer to get started"}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredCustomers.map((customer) => (
                <TableRow
                  key={customer.id}
                  className="group cursor-pointer hover:bg-muted/40"
                  data-testid={`row-customer-${customer.id}`}
                  onClick={() => setStatementCustomer(customer)}
                >
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium text-sm" data-testid={`text-customer-name-${customer.id}`}>
                        {customer.legalName}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className={`font-mono font-semibold text-sm ${drCrClass(customer.balanceSide || "Dr")}`}>
                        {formatHistoricalBaseAmount(customer.balance || 0)}
                      </span>
                      <Badge variant="secondary" className={`text-xs ${drCrClass(customer.balanceSide || "Dr")}`}>
                        {customer.balanceSide || "Dr"}
                      </Badge>
                    </div>
                    {getCustomerCurrencyBalances(customer) &&
                      Object.keys(getCustomerCurrencyBalances(customer)!).length > 0 && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Native:{" "}
                          {Object.entries(getCustomerCurrencyBalances(customer)!)
                            .map(
                              ([currency, value]) =>
                                `${currency} ${Math.abs(value.net).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                            )
                            .join(" · ")}
                        </div>
                      )}
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex items-center justify-end opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity">
                      <ErpRecordAction
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (recordChanges.allowed) handleEditClick(customer);
                        }}
                        permitted={recordChanges.allowed}
                        deniedReason={recordChanges.reason}
                        aria-label={recordChanges.reason ?? "Edit customer"}
                        data-testid={`button-edit-customer-${customer.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </ErpRecordAction>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </ErpListTable>
      </div>

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
