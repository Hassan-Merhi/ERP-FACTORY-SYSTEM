import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Search, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/contexts/CompanyContext";
import { RetailNav } from "./RetailNav";
import { getJson, money, type Location } from "./retailInventoryTypes";
import {
  fetchRetailCustomerHistory,
  searchRetailCustomers,
  searchRetailSalesHistory,
} from "@/pages/pos/retailWave2Api";
import type { RetailCustomerSummary } from "@/pages/pos/retailWave2Types";
import type { RetailSale } from "@/pages/pos/retailPosTypes";

function SaleBreakdown({ sale }: { sale: RetailSale }) {
  return (
    <div className="space-y-2">
      {sale.items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm" data-no-translate>
          <span className="min-w-0 flex-1 truncate">
            {item.name} · {item.color} · {item.size} <span className="text-muted-foreground">× {item.quantity}</span>
          </span>
          {Number(item.lineDiscountAmount ?? 0) > 0 && (
            <span className="text-xs text-destructive">-{money(item.lineDiscountAmount ?? 0)}</span>
          )}
          <span className="font-medium">
            {money(item.lineTotal ?? item.quantity * (item.grossUnitPrice ?? item.unitPrice))}
          </span>
        </div>
      ))}
      <div className="space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{money(sale.listSubtotal ?? sale.totalAmount)}</span>
        </div>
        {Number(sale.discountTotal ?? 0) > 0 && (
          <div className="flex justify-between text-destructive">
            <span>Discount{sale.orderDiscountReason ? ` · ${sale.orderDiscountReason}` : ""}</span>
            <span>-{money(sale.discountTotal ?? 0)}</span>
          </div>
        )}
        {sale.taxEnabled && (
          <div className="flex justify-between">
            <span>{sale.taxLabel || "Tax"}</span>
            <span>{money(sale.taxAmount ?? 0)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm font-semibold text-foreground">
          <span>Total</span>
          <span>{money(sale.totalAmount)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Retail history workspace: find any past sale by receipt number, customer, item/barcode or date,
 * and inspect one customer's purchases, receipts, returns and exchanges.
 */
export default function RetailSalesHistory() {
  const { selectedCompany } = useCompany();
  const retailEnabled = selectedCompany?.companyType === "retail";
  const [filters, setFilters] = useState({
    receipt: "",
    search: "",
    barcode: "",
    dateFrom: "",
    dateTo: "",
    locationId: "" as number | "",
  });
  const [submittedFilters, setSubmittedFilters] = useState<typeof filters | null>(null);
  const [customerTerm, setCustomerTerm] = useState("");
  const [customer, setCustomer] = useState<RetailCustomerSummary | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["retail-history-locations"],
    queryFn: () => getJson<Location[]>("/api/locations"),
    enabled: retailEnabled,
  });

  const customersQuery = useQuery({
    queryKey: ["retail-history-customers", customerTerm],
    queryFn: () => searchRetailCustomers(customerTerm, 10),
    enabled: retailEnabled && !customer && customerTerm.trim().length > 1,
  });

  const historyQuery = useQuery({
    queryKey: ["retail-history-sales", submittedFilters, customer?.id],
    queryFn: () =>
      searchRetailSalesHistory({
        receipt: submittedFilters?.receipt || undefined,
        search: submittedFilters?.search || undefined,
        barcode: submittedFilters?.barcode || undefined,
        dateFrom: submittedFilters?.dateFrom || undefined,
        dateTo: submittedFilters?.dateTo || undefined,
        locationId: submittedFilters?.locationId || undefined,
        customerId: customer?.id,
        limit: 50,
      }),
    enabled: retailEnabled && (Boolean(submittedFilters) || Boolean(customer)),
  });

  const customerHistoryQuery = useQuery({
    queryKey: ["retail-customer-history", customer?.id],
    queryFn: () => fetchRetailCustomerHistory(customer!.id),
    enabled: retailEnabled && Boolean(customer),
  });

  if (!retailEnabled) return null;

  const sales = historyQuery.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-3 pb-24 md:p-5 xl:pb-5">
      <RetailNav />
      <div className="rounded-xl border bg-card p-4 shadow-xs">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <History className="h-6 w-6" /> Sales &amp; customer history
        </h1>
        <p className="text-sm text-muted-foreground">
          Search old receipts by number, customer, barcode/item or date. Returns and exchanges are refunded from the
          amount the customer actually paid.
        </p>
      </div>

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
              <Input
                value={customerTerm}
                onChange={(event) => setCustomerTerm(event.target.value)}
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
              <Input
                id="retail-history-item"
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
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
            <div>
              <Label htmlFor="retail-history-from">From</Label>
              <Input
                id="retail-history-from"
                type="date"
                value={filters.dateFrom}
                onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="retail-history-to">To</Label>
              <Input
                id="retail-history-to"
                type="date"
                value={filters.dateTo}
                onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="retail-history-location">Location</Label>
              <select
                id="retail-history-location"
                className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                value={filters.locationId}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    locationId: event.target.value ? Number(event.target.value) : "",
                  }))
                }
              >
                <option value="">All locations</option>
                {(locationsQuery.data ?? [])
                  .filter((location) => location.id > 0)
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
              </select>
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
        {submittedFilters && !historyQuery.isLoading && !sales.length && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground lg:col-span-2">
            No sales match those filters.
          </div>
        )}
      </div>
    </div>
  );
}
