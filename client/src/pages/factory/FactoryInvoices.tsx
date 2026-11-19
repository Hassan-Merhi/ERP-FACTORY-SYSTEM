import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, EyeOff, SlidersHorizontal, ChevronDown, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { InvoiceDashboardMetrics } from "./factoryinvoices/InvoiceDashboardMetrics";
import { InvoiceSummaryBar } from "@/components/InvoiceSummaryBar";
import { getEstimatedKg, getEstimatedPrice, getRemainingBales } from "./factoryinvoices/invoiceCalculations";
import { ShippingAvailabilityTable } from "./factoryshippingcontainers/components/ShippingAvailabilityTable";
import { ScheduledContainersTable } from "./factoryshippingcontainers/components/ScheduledContainersTable";
import { FactoryInvoicesSection, useFactoryInvoicesState } from "./FactoryInvoicesSection";
import { InvoiceListExport } from "./factoryinvoices/InvoiceListExport";
import { SearchField } from "@/components/ui/search-field";
import { PeriodFilter } from "@/components/ui/period-filter";

export default function FactoryInvoices() {
  const {
    allowedInvoiceColumns,
    changeCustomerMutation,
    changingCustomerOrderId,
    colCount,
    customerFilter,
    customerGroups,
    customers,
    dragIdxRef,
    dropIdx,
    expandedCustomers,
    filteredOrders,
    formatDisplayDate,
    fromDate,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    handleDrop,
    hideTotalsUsd,
    isColumnVisible,
    isError,
    isLoading,
    newCustomerId,
    orderRowContext,
    orderedCustomerGroups,
    scopedOrders,
    searchTerm,
    setChangingCustomerOrderId,
    setColumnVisible,
    setCustomerFilter,
    setFromDate,
    setNewCustomerId,
    setSearchTerm,
    setShowHidden,
    setShowMoreFilters,
    setStatusFilter,
    setTablePrefs,
    setToDate,
    showHidden,
    showMoreFilters,
    statusFilter,
    statusFilters,
    toDate,
    toggleCustomer,
    visibleOptionalColumns,
  } = useFactoryInvoicesState();

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4" data-testid="invoicing-modern-dashboard">
      <Dialog
        open={changingCustomerOrderId !== null}
        onOpenChange={(open) => {
          if (!open) setChangingCustomerOrderId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change loading customer</DialogTitle>
            <DialogDescription>
              Keep all existing loaded bales and container information. The current customer's proforma will be
              unlinked; select a new proforma afterward if needed.
            </DialogDescription>
          </DialogHeader>
          <Select value={newCustomerId} onValueChange={setNewCustomerId}>
            <SelectTrigger data-testid="select-new-loading-customer">
              <SelectValue placeholder="Choose new customer" />
            </SelectTrigger>
            <SelectContent>
              {customers.map((customer) => (
                <SelectItem key={customer.id} value={String(customer.id)}>
                  {customer.legalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangingCustomerOrderId(null)}>
              Cancel
            </Button>
            <Button
              disabled={!newCustomerId || changeCustomerMutation.isPending}
              onClick={() => {
                if (changingCustomerOrderId !== null && newCustomerId) {
                  changeCustomerMutation.mutate({
                    orderId: changingCustomerOrderId,
                    customerId: Number(newCustomerId),
                  });
                }
              }}
            >
              Save customer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {isError && (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-testid="error-invoices-load"
        >
          Failed to load data. Please check your connection or try refreshing the page.
        </div>
      )}

      {!isLoading && <InvoiceDashboardMetrics orders={scopedOrders} hideTotalsUsd={hideTotalsUsd} />}
      <div className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm dark:bg-card">
        {/* Toolbar strip */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border/60 bg-blue-500/[0.025] px-3 py-3">
          <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-tabs">
            {statusFilters.map((f) => (
              <Button
                key={f.key}
                variant={statusFilter === f.key ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(f.key)}
                data-testid={`button-filter-${f.key.toLowerCase()}`}
                className={cn(
                  "h-9 rounded-lg border px-3 text-xs font-semibold",
                  statusFilter === f.key &&
                    (f.key === "LOADING"
                      ? "border-blue-500 bg-blue-600 text-white hover:bg-blue-500"
                      : f.key === "VERIFIED"
                        ? "border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-500"
                        : "border-violet-500 bg-violet-600 text-white hover:bg-violet-500")
                )}
              >
                {f.label} <span className="ml-1 opacity-70">({f.count})</span>
              </Button>
            ))}
            <Button
              variant={statusFilter === "ALL" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter("ALL")}
              data-testid="button-filter-all"
              className="h-9 rounded-lg border px-3 text-xs font-semibold"
            >
              All ({scopedOrders.length})
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={showHidden ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setShowHidden((v) => !v)}
              data-testid="button-toggle-show-hidden"
              className="h-9 rounded-lg px-3 text-xs gap-1.5"
              title={showHidden ? "Hide hidden loadings" : "Show hidden loadings"}
            >
              {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {showHidden ? "Showing hidden" : "Show hidden"}
            </Button>
            <div className="w-44 sm:w-48">
              <Select value={customerFilter} onValueChange={setCustomerFilter}>
                <SelectTrigger className="h-9 rounded-lg text-xs" data-testid="select-customer-filter">
                  <SelectValue placeholder="All customers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Customers</SelectItem>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id.toString()} data-testid={`select-customer-option-${c.id}`}>
                      {c.legalName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Search and column controls retain all existing invoice actions. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <SearchField
            value={searchTerm}
            onValueChange={setSearchTerm}
            placeholder="Search customer, loading, container, destination..."
            wrapperClassName="min-w-[210px] flex-1"
            className="h-9 rounded-lg border-border/70 bg-background/80 text-xs"
            data-testid="input-invoice-search"
          />
          <Button
            size="sm"
            variant={showMoreFilters || fromDate || toDate ? "secondary" : "outline"}
            className="h-9 rounded-lg text-xs"
            onClick={() => setShowMoreFilters((value) => !value)}
            aria-expanded={showMoreFilters}
            data-testid="button-invoice-more-filters"
          >
            <Filter className="mr-1.5 h-3.5 w-3.5" /> More Filters
            <ChevronDown className={cn("ml-1.5 h-3.5 w-3.5 transition-transform", showMoreFilters && "rotate-180")} />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-9 rounded-lg text-xs"
                title="Choose visible invoice columns"
                data-testid="button-invoice-columns"
              >
                <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
                Columns{" "}
                <span className="ml-1 text-muted-foreground">
                  ({visibleOptionalColumns}/{allowedInvoiceColumns.length})
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-3" data-testid="invoice-columns-menu">
              <div className="text-sm font-semibold">Visible columns</div>
              <p className="mt-0.5 text-xs text-muted-foreground">Your choices are saved on this device.</p>
              <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
                {allowedInvoiceColumns.map(({ key, label }) => (
                  <label
                    key={key}
                    htmlFor={`invoice-column-${key}`}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                  >
                    <Checkbox
                      id={`invoice-column-${key}`}
                      checked={isColumnVisible(key)}
                      onCheckedChange={(checked) => setColumnVisible(key, checked === true)}
                      data-testid={`checkbox-invoice-column-${key}`}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                <span className="text-[11px] text-muted-foreground">Customer & Actions stay visible</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-xs"
                  onClick={() => setTablePrefs((previous) => ({ ...previous, columns: {} }))}
                  data-testid="button-invoice-show-all-columns"
                >
                  Show all
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <InvoiceListExport
            orders={orderedCustomerGroups.flatMap((group) => group.orders)}
            isColumnVisible={isColumnVisible}
            formatDisplayDate={formatDisplayDate}
            period={{ from: fromDate, to: toDate }}
          />
        </div>
        {showMoreFilters && (
          <div className="flex flex-wrap items-end gap-3 border-b border-border/60 bg-muted/20 px-3 py-3">
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>Period</span>
              <PeriodFilter
                value={{ fromDate, toDate, preset: fromDate || toDate ? "custom" : "all_time" }}
                onChange={(v) => {
                  setFromDate(v.fromDate);
                  setToDate(v.toDate);
                }}
                data-testid="invoice-period-filter"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-lg text-xs"
              onClick={() => {
                setFromDate("");
                setToDate("");
                setSearchTerm("");
              }}
              data-testid="button-reset-invoice-filters"
            >
              Clear dates / search
            </Button>
          </div>
        )}

        {/* Summary bar */}
        {!isLoading && filteredOrders.length > 0 && (
          <details className="group border-b border-border/60 bg-muted/[0.06]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/20">
              <span className="inline-flex items-center gap-2">
                <ChevronDown className="h-3.5 w-3.5 -rotate-90 transition-transform group-open:rotate-0" />
                Loading analysis · {filteredOrders.length} orders
              </span>
              <span className="text-[11px] font-normal">Bales, weight and remaining</span>
            </summary>
            <div className="px-3 pt-2">
              <InvoiceSummaryBar
                orders={filteredOrders}
                hideTotalsUsd={hideTotalsUsd}
                getRemainingBales={getRemainingBales}
                getEstimatedKg={getEstimatedKg}
                getEstimatedPrice={getEstimatedPrice}
              />
            </div>
          </details>
        )}

        {isLoading ? (
          <div className="space-y-3 p-4">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : (
          <FactoryInvoicesSection
            colCount={colCount}
            customerGroups={customerGroups}
            dragIdxRef={dragIdxRef}
            dropIdx={dropIdx}
            expandedCustomers={expandedCustomers}
            handleDragEnd={handleDragEnd}
            handleDragOver={handleDragOver}
            handleDragStart={handleDragStart}
            handleDrop={handleDrop}
            isColumnVisible={isColumnVisible}
            orderRowContext={orderRowContext}
            orderedCustomerGroups={orderedCustomerGroups}
            toggleCustomer={toggleCustomer}
          />
        )}

        {/* Scheduled containers above existing container availability */}
        <div className="space-y-3 border-t border-border/60 bg-muted/[0.04] px-3 py-3">
          <ScheduledContainersTable />
          <ShippingAvailabilityTable />
        </div>
      </div>
    </div>
  );
}
