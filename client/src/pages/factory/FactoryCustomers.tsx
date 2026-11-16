import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, RotateCcw, History, Eye, EyeOff, Users, Wallet, Scale } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ui/page-state";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { PaginationBar } from "@/components/PaginationBar";
import { FactoryCustomerFormDialogs } from "./factorycustomers/FactoryCustomerFormDialogs";
import { useFactoryCustomersState } from "./useFactoryCustomersState";
import { FactoryCustomersSection, FactoryCustomersSection2 } from "./FactoryCustomersSection";

export default function FactoryCustomers() {
  const {
    balanceFilter,
    createMutation,
    customers,
    deleteMutation,
    deletedCustomers,
    deletingCustomer,
    editingCustomer,
    error,
    exportVisibleCustomers,
    formData,
    formatCashAmount,
    handleCreate,
    handleUpdate,
    isCreateOpen,
    isError,
    isLoading,
    navigate,
    netBalance,
    openCreate,
    openEdit,
    pageSize,
    pagedCustomers,
    prefs,
    recordChanges,
    refetchCustomers,
    resetForm,
    restoreMutation,
    safePage,
    saving,
    search,
    setBalanceFilter,
    setColumnVisible,
    setDeletingCustomer,
    setEditingCustomer,
    setFormData,
    setIsCreateOpen,
    setPage,
    setPrefs,
    setSearch,
    setShowZeroBalance,
    showActionsColumn,
    showBalanceColumn,
    showDeleted,
    showZeroBalance,
    totalCredit,
    totalDebit,
    totalPages,
    updateMutation,
    visibleCustomers,
    zeroBalanceCount,
  } = useFactoryCustomersState();

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-6 gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col h-full p-6 gap-4">
        <PageHeader title="Customers" />
        <ErrorState
          title="Customers could not be loaded"
          description={error?.message || "Please try again."}
          actionLabel="Retry"
          onAction={() => {
            void refetchCustomers();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6" data-testid="factory-customers-directory">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="customer-balance-summary">
        <div className="rounded-2xl border border-blue-500/25 bg-blue-500/5 p-3 shadow-sm sm:p-4 dark:border-blue-400/30 dark:bg-blue-500/10">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-blue-500/15 p-2.5 text-blue-600 dark:text-blue-400">
              <Users className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Customers</p>
              <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl" data-testid="metric-customers-total">
                {customers.length}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-3 shadow-sm sm:p-4 dark:border-emerald-400/30 dark:bg-emerald-500/10">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-emerald-500/15 p-2.5 text-emerald-600 dark:text-emerald-400">
              <Wallet className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Debit</p>
              <p
                className="mt-1 break-all text-base font-bold tabular-nums text-emerald-600 sm:text-xl dark:text-emerald-400"
                data-testid="metric-customers-debit"
              >
                {formatCashAmount(totalDebit)}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-rose-500/25 bg-rose-500/5 p-3 shadow-sm sm:p-4 dark:border-rose-400/30 dark:bg-rose-500/10">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-rose-500/15 p-2.5 text-rose-600 dark:text-rose-400">
              <Wallet className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Credit</p>
              <p
                className="mt-1 break-all text-base font-bold tabular-nums text-rose-600 sm:text-xl dark:text-rose-400"
                data-testid="metric-customers-credit"
              >
                {formatCashAmount(totalCredit)}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-violet-500/25 bg-violet-500/5 p-3 shadow-sm sm:p-4 dark:border-violet-400/30 dark:bg-violet-500/10">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-violet-500/15 p-2.5 text-violet-600 dark:text-violet-400">
              <Scale className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Net Balance</p>
              <p
                className={`mt-1 break-all text-base font-bold tabular-nums sm:text-xl ${netBalance < -0.001 ? "text-rose-600 dark:text-rose-400" : netBalance > 0.001 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}
                data-testid="metric-customers-net"
              >
                {netBalance < -0.001 ? "−" : ""}
                {formatCashAmount(Math.abs(netBalance))}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-blue-500/10 p-2.5 text-blue-600 dark:text-sky-400">
            <Users className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
              Customers
            </h1>
            <p className="text-sm text-muted-foreground">{customers.length} total customers</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {zeroBalanceCount > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                setShowZeroBalance((visible) => !visible);
                setPage(1);
              }}
              aria-pressed={showZeroBalance}
              data-testid="button-toggle-zero-balance"
              size="sm"
              className="h-9 gap-2 rounded-lg px-4"
            >
              {showZeroBalance ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              {showZeroBalance ? "Hide 0 Balance" : `Show 0 Balance (${zeroBalanceCount})`}
            </Button>
          )}
          {!recordChanges.isCreateOnly && (
            <Button
              onClick={openCreate}
              data-testid="button-add-customer"
              size="sm"
              className="h-10 gap-2 rounded-xl bg-blue-600 px-4 text-white shadow-sm hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              Add Customer
            </Button>
          )}
        </div>
      </div>

      <DataTableToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Search by name, code, or phone..."
        searchTestId="input-search-customers"
        className="mb-0"
        actions={
          <FactoryCustomersSection2
            balanceFilter={balanceFilter}
            exportVisibleCustomers={exportVisibleCustomers}
            refetchCustomers={refetchCustomers}
            setBalanceFilter={setBalanceFilter}
            setColumnVisible={setColumnVisible}
            setPage={setPage}
            showActionsColumn={showActionsColumn}
            showBalanceColumn={showBalanceColumn}
          />
        }
      />

      <FactoryCustomersSection
        formatCashAmount={formatCashAmount}
        navigate={navigate}
        openEdit={openEdit}
        pagedCustomers={pagedCustomers}
        prefs={prefs}
        recordChanges={recordChanges}
        search={search}
        setDeletingCustomer={setDeletingCustomer}
        showActionsColumn={showActionsColumn}
        showBalanceColumn={showBalanceColumn}
        visibleCustomers={visibleCustomers}
        zeroBalanceCount={zeroBalanceCount}
      />
      <PaginationBar
        page={safePage}
        totalPages={totalPages}
        total={visibleCustomers.length}
        pageSize={pageSize}
        onPageChange={setPage}
        noun="customers"
        onPageSizeChange={(size) => {
          setPrefs({ pageSize: size });
          setPage(1);
        }}
      />

      {showDeleted && (
        <div className="rounded-xl border overflow-hidden mt-6">
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Deleted Customers</span>
            {deletedCustomers.length > 0 && (
              <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate text-xs">
                {deletedCustomers.length}
              </Badge>
            )}
          </div>
          {deletedCustomers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8 px-4">No deleted customers found</p>
          ) : (
            <div className="table-responsive">
              <Table mobileLayout="cards">
                <TableHeader className="sticky top-0 z-30">
                  <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                    <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                      Name
                    </TableHead>
                    <TableHead className="w-[80px] py-2"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deletedCustomers.map((customer) => (
                    <TableRow key={customer.id} data-testid={`row-deleted-customer-${customer.id}`}>
                      <TableCell className="font-medium text-muted-foreground">{customer.legalName}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => restoreMutation.mutate(customer.id)}
                          disabled={restoreMutation.isPending || !recordChanges.allowed}
                          title={recordChanges.reason ?? undefined}
                          data-testid={`button-restore-customer-${customer.id}`}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Restore
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <FactoryCustomerFormDialogs
        isCreateOpen={isCreateOpen}
        editingCustomer={editingCustomer}
        formData={formData}
        setFormData={setFormData}
        saving={saving}
        createPending={createMutation.isPending}
        updatePending={updateMutation.isPending}
        onCloseCreate={() => {
          setIsCreateOpen(false);
          resetForm();
        }}
        onCloseEdit={() => {
          setEditingCustomer(null);
          resetForm();
        }}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />

      <ConfirmDialog
        open={!!deletingCustomer}
        onOpenChange={(open) => {
          if (!open) setDeletingCustomer(null);
        }}
        title="Delete Customer"
        tone="destructive"
        confirmText={deleteMutation.isPending ? "Deleting..." : "Delete"}
        loading={deleteMutation.isPending}
        onConfirm={async () => {
          if (deletingCustomer) await deleteMutation.mutateAsync(deletingCustomer.id);
        }}
        description={
          <span>
            Are you sure you want to delete <strong>{deletingCustomer?.legalName}</strong>? They will be hidden from the
            customers list. You can restore them later from the "Deleted Customers" section.
          </span>
        }
      />
    </div>
  );
}
