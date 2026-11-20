import { History, Search, UserRound } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Label } from "@/components/ui/label";
import { PeriodFilter } from "@/components/ui/period-filter";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RetailNav } from "./RetailNav";
import { money } from "./retailInventoryTypes";
import { SaleBreakdown } from "./SaleBreakdown";
import { useRetailSalesHistoryState } from "./useRetailSalesHistoryState";

/**
 * Retail history workspace: find any past sale by receipt number, customer, item/barcode or date,
 * and inspect one customer's purchases, receipts, returns and exchanges.
 */
export default function RetailSalesHistory() {
  const {
    retailEnabled,
    filters,
    setFilters,
    setSubmittedFilters,
    submittedFilters,
    customerTerm,
    setCustomerTerm,
    customer,
    setCustomer,
    locationsQuery,
    customersQuery,
    historyQuery,
    customerHistoryQuery,
  } = useRetailSalesHistoryState();

  if (!retailEnabled) return null;

  const sales = historyQuery.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-3 pb-24 md:p-5 xl:pb-5">
      <RetailNav />
      <PageHeader
        title="Sales & customer history"
        icon={<History className="h-6 w-6" />}
        subtitle="Search old receipts by number, customer, barcode/item or date. Returns and exchanges are refunded from the amount the customer actually paid."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <UserRound className="h-5 w-5" /> Customer
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {customer ? (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2 text-sm" data-no-translate>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{customer.legalName}</div>
                <div className="text-xs text-muted-foreground">
                  {customer.code}
                  {customer.phone ? ` · ${customer.phone}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>
                Clear
              </Button>
            </div>
          ) : (
            <>
              <SearchField
                value={customerTerm}
                onValueChange={setCustomerTerm}
                placeholder="Search customer by name, phone or code"
                data-testid="retail-history-customer-search"
              />
              <div className="space-y-1">
                {(customersQuery.data ?? []).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="flex w-full items-center justify-between rounded-sm border px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                    onClick={() => setCustomer(entry)}
                    data-no-translate
                  >
                    <span className="truncate">{entry.legalName}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{entry.code}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {customerHistoryQuery.data && (
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-sm border p-2">
                  <div className="text-muted-foreground">Purchases</div>
                  <strong>{customerHistoryQuery.data.summary.saleCount}</strong>
                </div>
                <div className="rounded-sm border p-2">
                  <div className="text-muted-foreground">Total spent</div>
                  <strong>{money(customerHistoryQuery.data.summary.totalSpent)}</strong>
                </div>
                <div className="rounded-sm border p-2">
                  <div className="text-muted-foreground">Refunded</div>
                  <strong>{money(customerHistoryQuery.data.summary.totalRefunded)}</strong>
                </div>
                <div className="rounded-sm border p-2">
                  <div className="text-muted-foreground">Last purchase</div>
                  <strong>
                    {customerHistoryQuery.data.summary.lastPurchaseAt
                      ? new Date(customerHistoryQuery.data.summary.lastPurchaseAt).toLocaleDateString()
                      : "—"}
                  </strong>
                </div>
              </div>
              {customerHistoryQuery.data.returns.length > 0 && (
                <div className="space-y-1 rounded-sm border p-2 text-xs">
                  <div className="font-medium">Returns</div>
                  {customerHistoryQuery.data.returns.map((entry) => (
                    <div key={entry.id} className="flex justify-between gap-2" data-no-translate>
                      <span>
                        Sale #{entry.saleId} · {entry.items.length} item(s)
                      </span>
                      <span>-{money(entry.refundAmount)}</span>
                    </div>
                  ))}
                </div>
              )}
              {customerHistoryQuery.data.exchanges.length > 0 && (
                <div className="space-y-1 rounded-sm border p-2 text-xs">
                  <div className="font-medium">Exchanges</div>
                  {customerHistoryQuery.data.exchanges.map((entry) => (
                    <div key={entry.id} className="flex justify-between gap-2" data-no-translate>
                      <span>
                        Sale #{entry.originalSaleId} → #{entry.newSaleId}
                      </span>
                      <span>{money(entry.refundValue)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Find a sale</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-6">
            <div>
              <Label htmlFor="retail-history-receipt">Receipt #</Label>
              <Input
                id="retail-history-receipt"
                value={filters.receipt}
                onChange={(event) => setFilters((current) => ({ ...current, receipt: event.target.value }))}
                placeholder="123, #123, R-000123"
                data-testid="retail-history-receipt"
              />
            </div>
            <div>
              <Label htmlFor="retail-history-item">Item / name / SKU</Label>
              <SearchField
                id="retail-history-item"
                value={filters.search}
                onValueChange={(value) => setFilters((current) => ({ ...current, search: value }))}
                placeholder="Search items..."
              />
            </div>
            <div>
              <Label htmlFor="retail-history-barcode">Barcode</Label>
              <Input
                id="retail-history-barcode"
                value={filters.barcode}
                onChange={(event) => setFilters((current) => ({ ...current, barcode: event.target.value }))}
              />
            </div>
            <div className="lg:col-span-2">
              <Label>Period</Label>
              <PeriodFilter
                value={{
                  fromDate: filters.dateFrom,
                  toDate: filters.dateTo,
                  preset: filters.dateFrom || filters.dateTo ? "custom" : "all_time",
                }}
                onChange={(v) => setFilters((current) => ({ ...current, dateFrom: v.fromDate, dateTo: v.toDate }))}
                data-testid="retail-history-period"
              />
            </div>
            <div>
              <Label htmlFor="retail-history-location">Location</Label>
              <Select
                value={filters.locationId === "" ? "__all__" : String(filters.locationId)}
                onValueChange={(v) =>
                  setFilters((current) => ({
                    ...current,
                    locationId: v !== "__all__" ? Number(v) : "",
                  }))
                }
              >
                <SelectTrigger id="retail-history-location" className="h-10 w-full px-2 text-sm">
                  <SelectValue placeholder="All locations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All locations</SelectItem>
                  {(locationsQuery.data ?? [])
                    .filter((location) => location.id > 0)
                    .map((location) => (
                      <SelectItem key={location.id} value={String(location.id)}>
                        {location.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={() => setSubmittedFilters({ ...filters })} data-testid="retail-history-search">
            <Search className="mr-1 h-4 w-4" /> Search
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {sales.map((sale) => (
          <Card key={sale.id} data-testid="retail-history-sale">
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                <span data-no-translate>Sale #{sale.id}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  {new Date(sale.createdAt).toLocaleString()}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-no-translate>
                <span>{sale.customerName || "Walk-in"}</span>
                <span className="rounded-full bg-muted px-2 py-0.5">{sale.status}</span>
                {sale.approvedByName && <span>Approved by {sale.approvedByName}</span>}
              </div>
              <SaleBreakdown sale={sale} />
            </CardContent>
          </Card>
        ))}
        {historyQuery.isError && !historyQuery.data ? (
          <ErrorState
            onAction={() => void historyQuery.refetch()}
            actionLabel="Try again"
            className="p-6 lg:col-span-2"
          />
        ) : (
          submittedFilters &&
          !historyQuery.isLoading &&
          !sales.length && <EmptyState title="No sales match those filters." className="p-6 lg:col-span-2" />
        )}
      </div>
    </div>
  );
}
