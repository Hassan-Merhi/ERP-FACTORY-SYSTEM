import { PageHeader } from "@/components/PageHeader";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Users, DollarSign } from "lucide-react";
import { drCrClass } from "@/lib/formatNumber";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePOSCustomersState } from "./usePOSCustomersState";
import { POSCustomersDialogSection } from "./POSCustomersDialogSection";
import { POSCustomersSection } from "./POSCustomersSection";

export default function POSCustomers() {
  const {
    closingBalance,
    createMutation,
    filteredCustomers,
    form,
    formatAmount,
    formatCashAmount,
    handlePrint,
    hasActiveFilters,
    isCreateOpen,
    isLoading,
    onSubmit,
    openingBalance,
    printRef,
    resetFilters,
    searchQuery,
    selectedCompany,
    setFilter,
    setIsCreateOpen,
    setStatementCustomer,
    sorted,
    statementCustomer,
    totalCr,
    totalCustomers,
    totalDr,
    totalReceivables,
    txnsLoading,
  } = usePOSCustomersState();

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Customers" subtitle="Manage customer accounts" />
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" data-testid="button-create-customer">
              <Plus className="mr-2 h-4 w-4" />
              New Customer
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Customer</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                <FormField
                  control={form.control}
                  name="legalName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Customer Name *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Enter customer name" data-testid="input-legal-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone Number</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value || ""}
                          placeholder="+1234567890"
                          data-testid="input-phone"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="openingBalance"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Opening Balance</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value || "0"}
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            data-testid="input-opening-balance"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="openingBalanceSide"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Balance Side</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value || "Dr"}>
                          <FormControl>
                            <SelectTrigger data-testid="select-balance-side">
                              <SelectValue placeholder="Select side" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="Dr">Dr (Debit)</SelectItem>
                            <SelectItem value="Cr">Cr (Credit)</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsCreateOpen(false)}
                    data-testid="button-cancel"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-customer">
                    {createMutation.isPending ? "Creating..." : "Create Customer"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats pill bar */}
      <div className="flex flex-wrap gap-3">
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3">
          <Users className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Total Customers</p>
            {isLoading ? (
              <Skeleton className="h-5 w-10 mt-0.5" />
            ) : (
              <p className="text-lg font-semibold leading-none" data-testid="text-total-customers">
                {totalCustomers}
              </p>
            )}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3">
          <DollarSign className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Total Receivables</p>
            {isLoading ? (
              <Skeleton className="h-5 w-20 mt-0.5" />
            ) : (
              <p className="text-lg font-semibold leading-none font-mono" data-testid="text-total-receivables">
                {formatCashAmount(totalReceivables)}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Search + customer table */}
      <div className="space-y-3">
        <DataTableToolbar
          search={searchQuery}
          onSearchChange={(value) => setFilter("searchQuery", value)}
          searchPlaceholder="Search customers..."
          searchTestId="input-search-customers"
          actions={
            hasActiveFilters ? (
              <Button variant="outline" type="button" onClick={resetFilters} data-testid="button-reset-filters">
                Reset filters
              </Button>
            ) : undefined
          }
        />

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : filteredCustomers.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium">{searchQuery ? "No customers found" : "No customers yet"}</p>
            <p className="text-sm mt-1">
              {searchQuery ? "Try a different search term" : "Create your first customer to get started"}
            </p>
          </div>
        ) : (
          <div className="border rounded-xl overflow-hidden">
            <div className="table-responsive">
              <Table mobileLayout="cards">
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="text-xs">Customer Name</TableHead>
                    <TableHead className="text-xs hidden sm:table-cell">Phone</TableHead>
                    <TableHead className="text-xs text-right">Balance</TableHead>
                    <TableHead className="text-xs">Side</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCustomers.map((customer) => (
                    <TableRow
                      key={customer.id}
                      className="cursor-pointer hover-elevate"
                      onClick={() => setStatementCustomer(customer)}
                      data-testid={`row-customer-${customer.id}`}
                    >
                      <TableCell className="font-medium text-sm">
                        <span className="underline decoration-dotted underline-offset-2">{customer.legalName}</span>
                      </TableCell>
                      <TableCell className="text-sm hidden sm:table-cell text-muted-foreground">
                        {customer.phone || "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatCashAmount(customer.balance || 0)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={drCrClass(customer.balanceSide || "Dr")}
                          data-testid={`badge-balance-side-${customer.id}`}
                        >
                          {customer.balanceSide || "Dr"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      {/* Customer Statement Dialog */}
      <POSCustomersDialogSection
        closingBalance={closingBalance}
        formatAmount={formatAmount}
        formatCashAmount={formatCashAmount}
        handlePrint={handlePrint}
        openingBalance={openingBalance}
        setStatementCustomer={setStatementCustomer}
        sorted={sorted}
        statementCustomer={statementCustomer}
        totalCr={totalCr}
        totalDr={totalDr}
        txnsLoading={txnsLoading}
      />

      {/* Hidden print template */}
      <POSCustomersSection
        closingBalance={closingBalance}
        formatAmount={formatAmount}
        formatCashAmount={formatCashAmount}
        openingBalance={openingBalance}
        printRef={printRef}
        selectedCompany={selectedCompany}
        sorted={sorted}
        statementCustomer={statementCustomer}
        totalCr={totalCr}
        totalDr={totalDr}
      />
    </div>
  );
}
