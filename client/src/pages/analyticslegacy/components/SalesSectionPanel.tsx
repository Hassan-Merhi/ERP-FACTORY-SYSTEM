import { Fragment, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";

import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";
import { PosCustomerSalesDialog, type PosAnalyticsCustomer } from "./PosCustomerSalesDialog";

export function SalesSectionPanel({ analytics }: { analytics: AnalyticsLegacyState }) {
  const {
    activeSection,
    appMode,
    periodFilter,
    detailsPeriod,
    factoryPosSummary,
    factoryCustomerOrderAnalytics,
    factoryCustomerOrderAnalyticsError,
    factoryOrderPage,
    factoryOrderIncludeCharges,
    formatAmount,
    formatDisplayDate,
    loadingFactoryPos,
    loadingFactoryCustomerOrders,
    rangeEnd,
    rangeStart,
    salesData,
    salesLoading,
    selectedLocationForDetails,
    selectedPeriod,
    setDetailsPeriod,
    setFactoryOrderPage,
    setFactoryOrderIncludeCharges,
    setRangeEnd,
    setRangeStart,
    setSelectedLocationForDetails,
    setSelectedPeriod,
    transactions,
    transactionsLoading,
    navigate,
  } = analytics;
  const [expandedOrderCustomers, setExpandedOrderCustomers] = useState<Set<string>>(new Set());
  const [selectedPosCustomer, setSelectedPosCustomer] = useState<PosAnalyticsCustomer | null>(null);

  const toggleOrderCustomer = (key: string) => {
    setExpandedOrderCustomers((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      {activeSection === "sales" && (
        <>
          {appMode === "factory" ? (
            <>
              {/* ── Customer orders grouped by customer ─────────────── */}
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
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Customer order analytics are unavailable
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 mb-4">
                      <div className="rounded-md border p-3">
                        <div className="text-xs text-muted-foreground">Orders</div>
                        <div className="font-semibold">
                          {formatNumber(factoryCustomerOrderAnalytics.summary.totalOrders)}
                        </div>
                      </div>
                      <div className="rounded-md border p-3">
                        <div className="text-xs text-muted-foreground">Customers</div>
                        <div className="font-semibold">
                          {formatNumber(factoryCustomerOrderAnalytics.summary.uniqueCustomers)}
                        </div>
                      </div>
                      <div className="rounded-md border p-3">
                        <div className="text-xs text-muted-foreground">Bales Sold</div>
                        <div className="font-semibold">
                          {formatNumber(factoryCustomerOrderAnalytics.summary.totalBales)}
                        </div>
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
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No customer invoices for this period
                      </p>
                    ) : (
                      <div className="table-responsive">
                        <Table>
                          <TableHeader className="sticky top-0 z-30 bg-background">
                            <TableRow>
                              <TableHead>Customer / Container</TableHead>
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
                                          <div className="font-semibold">
                                            {customerRow.customerName || "Unknown customer"}
                                          </div>
                                          <div className="text-xs text-muted-foreground">
                                            {formatNumber(customerRow.invoiceCount)}{" "}
                                            {customerRow.invoiceCount === 1 ? "invoice" : "invoices"} ·{" "}
                                            {formatNumber(customerRow.totalBales)} bales
                                          </div>
                                        </div>
                                      </button>
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
                              factoryCustomerOrderAnalytics.pagination.page >=
                              factoryCustomerOrderAnalytics.pagination.totalPages
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


              {/* ── Factory POS ──────────────────────────────────── */}
              <Card className="p-6">
                <div className="mb-4">
                  <h3 className="text-lg font-medium">Factory POS</h3>
                  <p className="text-sm text-muted-foreground mt-1">Point-of-sale transactions, by customer</p>
                </div>
                {loadingFactoryPos ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : !factoryPosSummary || (factoryPosSummary.byCustomer ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No factory POS sales data available</p>
                ) : (
                  <div className="table-responsive">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Customer</TableHead>
                          <TableHead className="text-right hidden sm:table-cell">Transactions</TableHead>
                          <TableHead className="text-right">Total Sales</TableHead>
                          <TableHead className="text-right hidden sm:table-cell">Cash Sales</TableHead>
                          <TableHead className="text-right hidden sm:table-cell">Credit Sales</TableHead>
                          <TableHead className="text-right hidden sm:table-cell">Deposit Collected</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(factoryPosSummary.byCustomer ?? []).map((row, idx: number) => (
                          <TableRow
                            key={row.customerId ?? `${row.customerName}-${idx}`}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => {
                              setSelectedPosCustomer({
                                customerId: row.customerId,
                                customerName: row.customerName || "Walk-in / Cash",
                              });
                            }}
                            data-testid={`row-pos-customer-${row.customerId ?? idx}`}
                          >
                            <TableCell className="font-medium">
                              <button
                                type="button"
                                className="text-left text-primary underline underline-offset-4 hover:no-underline"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedPosCustomer({
                                    customerId: row.customerId,
                                    customerName: row.customerName || "Walk-in / Cash",
                                  });
                                }}
                                data-testid={`button-pos-customer-${row.customerId ?? idx}`}
                              >
                                {row.customerName || "Walk-in / Cash"}
                              </button>
                            </TableCell>
                            <TableCell className="text-right hidden sm:table-cell">{row.sales}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatAmount(parseFloat(row.totalAmount))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-green-600 dark:text-green-400 hidden sm:table-cell">
                              {formatAmount(parseFloat(row.cashSales))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-blue-600 dark:text-blue-400 hidden sm:table-cell">
                              {formatAmount(parseFloat(row.creditSales))}
                            </TableCell>
                            <TableCell className="text-right font-mono hidden sm:table-cell">
                              {formatAmount(parseFloat(row.depositAmount))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                      {factoryPosSummary.grand && (
                        <TableBody className="font-semibold border-t-2">
                          <TableRow>
                            <TableCell>Total</TableCell>
                            <TableCell className="text-right hidden sm:table-cell">
                              {factoryPosSummary.grand.sales}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {formatAmount(parseFloat(factoryPosSummary.grand.totalAmount))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-green-600 dark:text-green-400 hidden sm:table-cell">
                              {formatAmount(parseFloat(factoryPosSummary.grand.cashSales))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-blue-600 dark:text-blue-400 hidden sm:table-cell">
                              {formatAmount(parseFloat(factoryPosSummary.grand.creditSales))}
                            </TableCell>
                            <TableCell className="text-right font-mono hidden sm:table-cell">
                              {formatAmount(parseFloat(factoryPosSummary.grand.depositAmount))}
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      )}
                    </Table>
                  </div>
                )}
              </Card>

              <PosCustomerSalesDialog
                customer={selectedPosCustomer}
                onClose={() => setSelectedPosCustomer(null)}
                startDate={periodFilter.fromDate}
                endDate={periodFilter.toDate}
                formatAmount={formatAmount}
                formatDisplayDate={formatDisplayDate}
              />
            </>
          ) : (
            <Card className="p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <h3 className="text-lg font-medium">Sales by Location</h3>
                <div className="flex flex-wrap items-center gap-2">
                  {selectedPeriod === "range" && (
                    <>
                      <Input
                        type="date"
                        className="w-auto"
                        value={rangeStart}
                        onChange={(e) => setRangeStart(e.target.value)}
                        data-testid="input-range-start"
                      />
                      <span className="text-muted-foreground text-sm">to</span>
                      <Input
                        type="date"
                        className="w-auto"
                        value={rangeEnd}
                        onChange={(e) => setRangeEnd(e.target.value)}
                        data-testid="input-range-end"
                      />
                    </>
                  )}
                  <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                    <SelectTrigger className="w-full sm:w-[180px]" data-testid="select-sales-period">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Time</SelectItem>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="month">This Month</SelectItem>
                      <SelectItem value="year">This Year</SelectItem>
                      <SelectItem value="range">Custom Range</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {salesLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : salesData.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No sales data available</p>
              ) : (
                <>
                  <div className="hidden md:block">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Location</TableHead>
                          <TableHead className="text-right">Bales Sold</TableHead>
                          <TableHead className="text-right">Total Sales</TableHead>
                          <TableHead className="text-right">Transactions</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...salesData]
                          .sort((a, b) => (a.locationName ?? "").localeCompare(b.locationName ?? ""))
                          .map((location) => (
                            <TableRow key={location.locationId}>
                              <TableCell className="font-medium">{location.locationName}</TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(location.totalQuantity ?? 0)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatAmount(location.totalSales)}
                              </TableCell>
                              <TableCell className="text-right">{location.totalTransactions}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setSelectedLocationForDetails(location.locationId)}
                                >
                                  View Details
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                      <TableBody className="font-semibold border-t-2 bg-muted/40">
                        <TableRow>
                          <TableCell>Total</TableCell>
                          <TableCell className="text-right font-mono">
                            {formatNumber(salesData.reduce((s, l) => s + (l.totalQuantity ?? 0), 0))}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatAmount(salesData.reduce((s, l) => s + l.totalSales, 0))}
                          </TableCell>
                          <TableCell className="text-right">
                            {salesData.reduce((s, l) => s + l.totalTransactions, 0)}
                          </TableCell>
                          <TableCell />
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                  <div className="md:hidden space-y-3">
                    {[...salesData]
                      .sort((a, b) => (a.locationName ?? "").localeCompare(b.locationName ?? ""))
                      .map((location) => (
                        <Card
                          key={location.locationId}
                          className="hover-elevate cursor-pointer"
                          onClick={() => setSelectedLocationForDetails(location.locationId)}
                        >
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">{location.locationName}</span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div className="grid grid-cols-3 mt-2 text-sm gap-2">
                              <span className="text-muted-foreground">
                                Bales:{" "}
                                <span className="font-mono text-foreground">
                                  {formatNumber(location.totalQuantity ?? 0)}
                                </span>
                              </span>
                              <span className="text-muted-foreground">
                                Sales:{" "}
                                <span className="font-mono text-foreground">{formatAmount(location.totalSales)}</span>
                              </span>
                              <span className="text-muted-foreground text-right">
                                Txns: <span className="text-foreground">{location.totalTransactions}</span>
                              </span>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    {/* Mobile totals card */}
                    <Card className="bg-muted/40">
                      <CardContent className="p-4">
                        <div className="font-semibold mb-2">Total</div>
                        <div className="grid grid-cols-3 text-sm gap-2">
                          <span className="text-muted-foreground">
                            Bales:{" "}
                            <span className="font-mono text-foreground font-semibold">
                              {formatNumber(salesData.reduce((s, l) => s + (l.totalQuantity ?? 0), 0))}
                            </span>
                          </span>
                          <span className="text-muted-foreground">
                            Sales:{" "}
                            <span className="font-mono text-foreground font-semibold">
                              {formatAmount(salesData.reduce((s, l) => s + l.totalSales, 0))}
                            </span>
                          </span>
                          <span className="text-muted-foreground text-right">
                            Txns:{" "}
                            <span className="text-foreground font-semibold">
                              {salesData.reduce((s, l) => s + l.totalTransactions, 0)}
                            </span>
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </>
              )}
            </Card>
          )}

          {/* Sales Details Dialog (ERP only) */}
          {appMode !== "factory" && (
            <Dialog
              open={selectedLocationForDetails !== null}
              onOpenChange={(open) => !open && setSelectedLocationForDetails(null)}
            >
              <DialogContent className="w-[95vw] max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
                <DialogHeader>
                  <DialogTitle>
                    Sales Details - {salesData.find((l) => l.locationId === selectedLocationForDetails)?.locationName}
                  </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4 overflow-hidden flex-1 min-h-0">
                  <Select value={detailsPeriod} onValueChange={setDetailsPeriod}>
                    <SelectTrigger className="w-full sm:w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Time</SelectItem>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="month">This Month</SelectItem>
                      <SelectItem value="year">This Year</SelectItem>
                    </SelectContent>
                  </Select>

                  {transactionsLoading ? (
                    <div className="space-y-3">
                      {[1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-14 w-full" />
                      ))}
                    </div>
                  ) : transactions.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No transactions found</p>
                  ) : (
                    <>
                      <div className="overflow-y-auto flex-1 min-h-0">
                        <div className="hidden md:block">
                          <Table>
                            <TableHeader className="sticky top-0 z-30 bg-background">
                              <TableRow>
                                <TableHead>Date</TableHead>
                                {selectedLocationForDetails === -1 && <TableHead>Customer</TableHead>}
                                <TableHead>Cash Account</TableHead>
                                <TableHead className="text-right">Items</TableHead>
                                <TableHead className="text-right">Quantity</TableHead>
                                <TableHead className="text-right">Amount</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {transactions.map((transaction) => (
                                <TableRow key={transaction.id}>
                                  <TableCell>
                                    <button
                                      className="text-left hover:underline text-primary cursor-pointer"
                                      onClick={() => {
                                        const params = new URLSearchParams();
                                        params.set("displayDate", formatDisplayDate(transaction.voucherDate));
                                        params.set("grouping", "daily");
                                        params.set("startDate", transaction.voucherDate);
                                        params.set("endDate", transaction.voucherDate);
                                        if (selectedLocationForDetails !== null && selectedLocationForDetails !== -1) {
                                          params.set("locationId", String(selectedLocationForDetails));
                                        }
                                        setSelectedLocationForDetails(null);
                                        window.open(`/sales-report/detail?${params.toString()}`, "_blank");
                                      }}
                                    >
                                      {formatDisplayDate(transaction.voucherDate)}
                                    </button>
                                  </TableCell>
                                  {selectedLocationForDetails === -1 && (
                                    <TableCell className="text-muted-foreground">
                                      {transaction.customerName || "—"}
                                    </TableCell>
                                  )}
                                  <TableCell className="text-muted-foreground text-sm">
                                    {transaction.cashAccountName || "—"}
                                  </TableCell>
                                  <TableCell className="text-right">{transaction.itemCount}</TableCell>
                                  <TableCell className="text-right">{transaction.totalQuantity}</TableCell>
                                  <TableCell className="text-right font-mono">
                                    {formatAmount(transaction.totalAmount)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                        <div className="md:hidden space-y-3">
                          {transactions.map((transaction) => (
                            <Card
                              key={transaction.id}
                              className="hover-elevate cursor-pointer"
                              onClick={() => {
                                const params = new URLSearchParams();
                                params.set("displayDate", formatDisplayDate(transaction.voucherDate));
                                params.set("grouping", "daily");
                                params.set("startDate", transaction.voucherDate);
                                params.set("endDate", transaction.voucherDate);
                                if (selectedLocationForDetails !== null && selectedLocationForDetails !== -1) {
                                  params.set("locationId", String(selectedLocationForDetails));
                                }
                                setSelectedLocationForDetails(null);
                                window.open(`/sales-report/detail?${params.toString()}`, "_blank");
                              }}
                            >
                              <CardContent className="p-3 space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-sm font-medium text-primary">
                                    {formatDisplayDate(transaction.voucherDate)}
                                  </span>
                                  <span className="font-mono font-medium">{formatAmount(transaction.totalAmount)}</span>
                                </div>
                                {selectedLocationForDetails === -1 && transaction.customerName && (
                                  <div className="text-sm text-muted-foreground">{transaction.customerName}</div>
                                )}
                                {transaction.cashAccountName && (
                                  <div className="text-sm text-muted-foreground">{transaction.cashAccountName}</div>
                                )}
                                <div className="flex items-center justify-between text-sm">
                                  <span className="text-muted-foreground">
                                    Items: {transaction.itemCount} | Qty: {transaction.totalQuantity}
                                  </span>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      </div>

                      <div className="border-t pt-4 shrink-0">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Total Transactions:</span>
                          <span className="font-medium">{transactions.length}</span>
                        </div>
                        <div className="flex justify-between text-sm mt-2">
                          <span className="text-muted-foreground">Total Quantity:</span>
                          <span className="font-medium">
                            {transactions.reduce((sum, t) => sum + t.totalQuantity, 0)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm mt-2">
                          <span className="text-muted-foreground">Total Amount:</span>
                          <span className="font-mono font-medium">
                            {formatAmount(transactions.reduce((sum, t) => sum + t.totalAmount, 0))}
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          )}
        </>
      )}
    </>
  );
}
