// Extracted from ./SalesSectionPanel.tsx to keep that module under the source-size cap.
import { Fragment } from "react";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { useSalesSectionPanelState } from "./useSalesSectionPanelState";

export function SalesSectionPanelCardSection({
  expandedOrderCustomers,
  factoryCustomerOrderAnalytics,
  factoryCustomerOrderAnalyticsError,
  factoryOrderDestination,
  factoryOrderIncludeCharges,
  factoryOrderPage,
  factoryOrderStatus,
  formatAmount,
  formatDisplayDate,
  loadingFactoryCustomerOrders,
  navigate,
  setFactoryOrderDestination,
  setFactoryOrderIncludeCharges,
  setFactoryOrderPage,
  setFactoryOrderStatus,
  toggleOrderCustomer,
}: Pick<
  ReturnType<typeof useSalesSectionPanelState>,
  | "expandedOrderCustomers"
  | "factoryCustomerOrderAnalytics"
  | "factoryCustomerOrderAnalyticsError"
  | "factoryOrderDestination"
  | "factoryOrderIncludeCharges"
  | "factoryOrderPage"
  | "factoryOrderStatus"
  | "formatAmount"
  | "formatDisplayDate"
  | "loadingFactoryCustomerOrders"
  | "navigate"
  | "setFactoryOrderDestination"
  | "setFactoryOrderIncludeCharges"
  | "setFactoryOrderPage"
  | "setFactoryOrderStatus"
  | "toggleOrderCustomer"
>) {
  return (
    <Card className="p-4 md:p-6">
      <div className="flex flex-col gap-3 mb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-medium">Customer Order Analytics</h3>
          <p className="text-sm text-muted-foreground">
            {factoryOrderIncludeCharges
              ? "Expand a customer to see each loading, verified or finalized invoice. Totals below include freight and extra charges."
              : "Expand a customer to see each loading, verified or finalized invoice. Totals below exclude freight and extra charges."}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={factoryOrderStatus}
            onValueChange={(value) => {
              setFactoryOrderStatus(value);
              setFactoryOrderPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-[190px]" data-testid="select-factory-order-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="LOADING">Loading</SelectItem>
              <SelectItem value="VERIFIED">Verified</SelectItem>
              <SelectItem value="VERIFIED_FINALIZED">Verified + Finalized</SelectItem>
              <SelectItem value="FINALIZED">Finalized</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={factoryOrderDestination}
            onValueChange={(value) => {
              setFactoryOrderDestination(value);
              setFactoryOrderPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-[180px]" data-testid="select-factory-order-destination">
              <SelectValue placeholder="All destinations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All destinations</SelectItem>
              {(factoryCustomerOrderAnalytics?.destinations ?? []).map((destination) => (
                <SelectItem key={destination} value={destination}>
                  {destination}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant={factoryOrderIncludeCharges ? "default" : "outline"}
            size="sm"
            className="shrink-0"
            onClick={() => {
              setFactoryOrderIncludeCharges((current) => !current);
              setFactoryOrderPage(1);
            }}
            data-testid="button-toggle-factory-order-charges"
          >
            {factoryOrderIncludeCharges ? "Freight + Charges: Included" : "Freight + Charges: Excluded"}
          </Button>
        </div>
      </div>

      {loadingFactoryCustomerOrders ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : factoryCustomerOrderAnalyticsError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <div className="font-medium text-destructive">Could not load customer order analytics</div>
          <div className="mt-1 text-muted-foreground">
            Please retry or narrow the date range. The rest of Analytics is still available.
          </div>
        </div>
      ) : !factoryCustomerOrderAnalytics ? (
        <p className="text-sm text-muted-foreground text-center py-8">Customer order analytics are unavailable</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 mb-4">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Orders</div>
              <div className="font-semibold">{formatNumber(factoryCustomerOrderAnalytics.summary.totalOrders)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Customers</div>
              <div className="font-semibold">{formatNumber(factoryCustomerOrderAnalytics.summary.uniqueCustomers)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Bales Sold</div>
              <div className="font-semibold">{formatNumber(factoryCustomerOrderAnalytics.summary.totalBales)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total Weight</div>
              <div className="font-semibold font-mono">
                {factoryCustomerOrderAnalytics.summary.totalWeightKg.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}{" "}
                kg
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">
                {factoryOrderIncludeCharges ? "Invoice Total (With Charges)" : "Invoice Total (No Charges)"}
              </div>
              <div className="font-semibold font-mono">
                {formatAmount(factoryCustomerOrderAnalytics.summary.totalInvoiceAmount)}
              </div>
            </div>
          </div>

          {factoryCustomerOrderAnalytics.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No customer invoices for this period</p>
          ) : (
            <div className="table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Customer / Container</TableHead>
                    <TableHead>Destination</TableHead>
                    <TableHead className="text-right">Total Weight</TableHead>
                    <TableHead className="text-right">
                      {factoryOrderIncludeCharges ? "Total Cost (With Charges)" : "Total Cost (No Charges)"}
                    </TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {factoryCustomerOrderAnalytics.rows.map((customerRow, customerIndex) => {
                    const customerKey = String(customerRow.customerId ?? `unknown-${customerIndex}`);
                    const expanded = expandedOrderCustomers.has(customerKey);
                    const destinations = Array.from(
                      new Set(
                        customerRow.orders
                          .map((order) => order.destination?.trim())
                          .filter((value): value is string => !!value)
                      )
                    );
                    return (
                      <Fragment key={customerKey}>
                        <TableRow className="bg-muted/20">
                          <TableCell>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 text-left"
                              onClick={() => toggleOrderCustomer(customerKey)}
                              aria-expanded={expanded}
                              data-testid={`button-expand-customer-${customerRow.customerId ?? customerIndex}`}
                            >
                              <ChevronRight
                                className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
                              />
                              <div>
                                <div className="font-semibold">{customerRow.customerName || "Unknown customer"}</div>
                                <div className="text-xs text-muted-foreground">
                                  {formatNumber(customerRow.invoiceCount)}{" "}
                                  {customerRow.invoiceCount === 1 ? "invoice" : "invoices"} ·{" "}
                                  {formatNumber(customerRow.totalBales)} bales
                                </div>
                              </div>
                            </button>
                          </TableCell>
                          <TableCell className="text-sm">
                            {destinations.length === 0
                              ? "—"
                              : destinations.length === 1
                                ? destinations[0]
                                : "Multiple destinations"}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {customerRow.totalWeightKg.toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            })}{" "}
                            kg
                          </TableCell>
                          <TableCell className="text-right font-mono font-semibold">
                            {formatAmount(customerRow.invoiceTotal)}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatNumber(customerRow.invoiceCount)} total
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            {formatDisplayDate(customerRow.latestOrderDate)}
                          </TableCell>
                        </TableRow>

                        {expanded &&
                          customerRow.orders.map((order) => {
                            const identifier =
                              order.containerNumber || order.invoiceNumber || `Order #${order.orderId}`;
                            const statusLabel =
                              order.status === "FINALIZED"
                                ? "Finalized"
                                : order.status === "VERIFIED"
                                  ? "Verified"
                                  : "Loading";
                            return (
                              <TableRow key={order.orderId} className="bg-background">
                                <TableCell>
                                  <div className="pl-6">
                                    <button
                                      type="button"
                                      className="font-mono font-semibold text-primary underline underline-offset-4 hover:no-underline"
                                      onClick={() =>
                                        navigate(
                                          factoryOrderIncludeCharges
                                            ? `/factory/sales/invoices/${order.orderId}?from=analytics`
                                            : `/factory/sales/invoices/${order.orderId}?view=no-charges&from=analytics`
                                        )
                                      }
                                      data-testid={`button-open-order-${order.orderId}`}
                                    >
                                      {identifier}
                                    </button>
                                    {order.containerNumber && order.invoiceNumber && (
                                      <div className="text-xs text-muted-foreground mt-0.5">
                                        Invoice {order.invoiceNumber}
                                      </div>
                                    )}
                                    {!order.containerNumber && (
                                      <div className="text-xs text-muted-foreground mt-0.5">Invoice</div>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="text-sm">{order.destination?.trim() || "—"}</TableCell>
                                <TableCell className="text-right font-mono">
                                  {order.totalWeightKg.toLocaleString(undefined, {
                                    maximumFractionDigits: 2,
                                  })}{" "}
                                  kg
                                </TableCell>
                                <TableCell className="text-right font-mono font-semibold">
                                  {formatAmount(order.invoiceTotal)}
                                </TableCell>
                                <TableCell>{statusLabel}</TableCell>
                                <TableCell className="text-right whitespace-nowrap">
                                  {formatDisplayDate(order.orderDate)}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {factoryCustomerOrderAnalytics.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between gap-3 pt-4">
              <div className="text-sm text-muted-foreground">
                Page {factoryCustomerOrderAnalytics.pagination.page} of{" "}
                {factoryCustomerOrderAnalytics.pagination.totalPages}
                {" · "}
                {formatNumber(factoryCustomerOrderAnalytics.pagination.totalRows)} customers
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={factoryCustomerOrderAnalytics.pagination.page <= 1}
                  onClick={() => setFactoryOrderPage(Math.max(1, factoryOrderPage - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    factoryCustomerOrderAnalytics.pagination.page >= factoryCustomerOrderAnalytics.pagination.totalPages
                  }
                  onClick={() => setFactoryOrderPage(factoryOrderPage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
