import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";

import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";

export function SalesSectionPanel({ analytics }: { analytics: AnalyticsLegacyState }) {
  const {
    activeSection,
    appMode,
    detailsPeriod,
    factoryPosSummary,
    factoryCustomerOrderAnalytics,
    factoryCustomerOrderAnalyticsError,
    factoryOrderCustomerSearch,
    factoryOrderDestinationSearch,
    factoryOrderItemSearch,
    factoryOrderLocationSearch,
    factoryOrderPage,
    factoryOrderProfitFilter,
    factoryOrderStatus,
    factorySalesByCustomer,
    factorySalesEndDate,
    factorySalesStartDate,
    formatAmount,
    formatDisplayDate,
    loadingFactoryPos,
    loadingFactoryCustomerOrders,
    loadingFactorySales,
    rangeEnd,
    rangeStart,
    salesData,
    salesLoading,
    selectedLocationForDetails,
    selectedPeriod,
    setDetailsPeriod,
    setFactoryOrderCustomerSearch,
    setFactoryOrderDestinationSearch,
    setFactoryOrderItemSearch,
    setFactoryOrderLocationSearch,
    setFactoryOrderPage,
    setFactoryOrderProfitFilter,
    setFactoryOrderStatus,
    setFactorySalesEndDate,
    setFactorySalesStartDate,
    setRangeEnd,
    setRangeStart,
    setSelectedLocationForDetails,
    setSelectedPeriod,
    transactions,
    transactionsLoading,
  } = analytics;
  return (
    <>
      {activeSection === "sales" && (
        <>
          {appMode === "factory" ? (
            <>
              {/* ── Date filter row ─────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <Label className="text-sm text-muted-foreground shrink-0">Date range:</Label>
                <DatePickerInput
                  value={factorySalesStartDate}
                  onChange={setFactorySalesStartDate}
                  placeholder="Start date"
                />
                <span className="text-muted-foreground text-sm">—</span>
                <DatePickerInput value={factorySalesEndDate} onChange={setFactorySalesEndDate} placeholder="End date" />
                {(factorySalesStartDate || factorySalesEndDate) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFactorySalesStartDate("");
                      setFactorySalesEndDate("");
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {/* ── Customer orders / item profitability ───────────── */}
              <Card className="p-4 md:p-6">
                <div className="flex flex-col gap-1 mb-4">
                  <h3 className="text-lg font-medium">Customer Order Analytics</h3>
                  <p className="text-sm text-muted-foreground">
                    Sold customer orders with item-level sales, historical cost and gross profit
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6 mb-4">
                  <Input
                    value={factoryOrderItemSearch}
                    onChange={(e) => {
                      setFactoryOrderItemSearch(e.target.value);
                      setFactoryOrderPage(1);
                    }}
                    placeholder="Item / article"
                    data-testid="input-factory-order-item"
                  />
                  <Input
                    value={factoryOrderCustomerSearch}
                    onChange={(e) => {
                      setFactoryOrderCustomerSearch(e.target.value);
                      setFactoryOrderPage(1);
                    }}
                    placeholder="Customer"
                    data-testid="input-factory-order-customer"
                  />
                  <Input
                    value={factoryOrderDestinationSearch}
                    onChange={(e) => {
                      setFactoryOrderDestinationSearch(e.target.value);
                      setFactoryOrderPage(1);
                    }}
                    placeholder="Destination"
                    data-testid="input-factory-order-destination"
                  />
                  <Input
                    value={factoryOrderLocationSearch}
                    onChange={(e) => {
                      setFactoryOrderLocationSearch(e.target.value);
                      setFactoryOrderPage(1);
                    }}
                    placeholder="Location"
                    data-testid="input-factory-order-location"
                  />
                  <Select
                    value={factoryOrderStatus}
                    onValueChange={(value) => {
                      setFactoryOrderStatus(value);
                      setFactoryOrderPage(1);
                    }}
                  >
                    <SelectTrigger data-testid="select-factory-order-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="FINALIZED">Finalized</SelectItem>
                      <SelectItem value="VERIFIED">Verified</SelectItem>
                      <SelectItem value="all">Verified + Finalized</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={factoryOrderProfitFilter}
                    onValueChange={(value) => {
                      setFactoryOrderProfitFilter(value);
                      setFactoryOrderPage(1);
                    }}
                  >
                    <SelectTrigger data-testid="select-factory-order-profit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Profit Results</SelectItem>
                      <SelectItem value="profitable">Profitable</SelectItem>
                      <SelectItem value="loss">Loss Making</SelectItem>
                      <SelectItem value="break-even">Break Even</SelectItem>
                    </SelectContent>
                  </Select>
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
                    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 mb-4">
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
                        <div className="text-xs text-muted-foreground">Sales</div>
                        <div className="font-semibold font-mono">{formatAmount(factoryCustomerOrderAnalytics.summary.totalSales)}</div>
                      </div>
                      <div className="rounded-md border p-3">
                        <div className="text-xs text-muted-foreground">Cost</div>
                        <div className="font-semibold font-mono">{formatAmount(factoryCustomerOrderAnalytics.summary.totalCost)}</div>
                      </div>
                      <div className="rounded-md border p-3">
                        <div className="text-xs text-muted-foreground">Gross Profit</div>
                        <div className={`font-semibold font-mono ${factoryCustomerOrderAnalytics.summary.grossProfit < 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
                          {formatAmount(factoryCustomerOrderAnalytics.summary.grossProfit)}
                        </div>
                      </div>
                      <div className="rounded-md border p-3">
                        <div className="text-xs text-muted-foreground">Margin</div>
                        <div className="font-semibold">{factoryCustomerOrderAnalytics.summary.marginPct.toFixed(1)}%</div>
                      </div>
                      <div className="rounded-md border p-3">
                        <div className="text-xs text-muted-foreground">Profit / Bale</div>
                        <div className="font-semibold font-mono">{formatAmount(factoryCustomerOrderAnalytics.summary.avgProfitPerBale)}</div>
                      </div>
                    </div>

                    {factoryCustomerOrderAnalytics.rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No sold customer order items match these filters
                      </p>
                    ) : (
                      <div className="table-responsive">
                        <Table>
                          <TableHeader className="sticky top-0 z-30 bg-background">
                            <TableRow>
                              <TableHead>Item</TableHead>
                              <TableHead>Customers</TableHead>
                              <TableHead className="text-right">Qty</TableHead>
                              <TableHead className="text-right">Total Price</TableHead>
                              <TableHead className="text-right">Last Sold</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {factoryCustomerOrderAnalytics.rows.map((row) => {
                              const onlyCustomer = row.customerBreakdown[0];
                              return (
                                <TableRow key={row.articleCode}>
                                  <TableCell>
                                    <div className="font-medium">{row.itemName || row.articleCode}</div>
                                    <div className="text-xs text-muted-foreground">
                                      {row.articleCode}
                                      {row.category ? ` · ${row.category}` : ""}
                                      {row.grade ? ` · ${row.grade}` : ""}
                                    </div>
                                  </TableCell>
                                  <TableCell className="font-medium">
                                    {row.customerCount === 1
                                      ? onlyCustomer?.customerName || "1 customer"
                                      : `${formatNumber(row.customerCount)} customers`}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <HoverCard openDelay={150} closeDelay={100}>
                                      <HoverCardTrigger asChild>
                                        <button
                                          type="button"
                                          className="font-mono font-semibold cursor-help underline decoration-dotted underline-offset-4"
                                          aria-label={`Show customer quantity breakdown for ${row.itemName || row.articleCode}`}
                                        >
                                          {formatNumber(row.qty)}
                                        </button>
                                      </HoverCardTrigger>
                                      <HoverCardContent className="w-80 p-0" align="end">
                                        <div className="border-b px-4 py-3">
                                          <div className="font-medium">{row.itemName || row.articleCode}</div>
                                          <div className="text-xs text-muted-foreground mt-0.5">
                                            Customer breakdown · {formatNumber(row.qty)} total qty · {formatAmount(row.salesAmount)}
                                          </div>
                                        </div>
                                        <div className="max-h-64 overflow-y-auto">
                                          {row.customerBreakdown.map((customerRow, index) => (
                                            <div
                                              key={`${row.articleCode}-${customerRow.customerId ?? "unknown"}-${index}`}
                                              className="px-4 py-3 border-b last:border-b-0"
                                            >
                                              <div className="font-medium text-sm">
                                                {customerRow.customerName ||
                                                  (customerRow.customerId
                                                    ? `Customer #${customerRow.customerId}`
                                                    : "Unknown customer")}
                                              </div>
                                              <div className="mt-1 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                                                <span>Qty {formatNumber(customerRow.qty)}</span>
                                                <span className="text-right">{formatAmount(customerRow.salesAmount)}</span>
                                                <span className="text-right">
                                                  {formatNumber(customerRow.orders)} {customerRow.orders === 1 ? "order" : "orders"}
                                                </span>
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      </HoverCardContent>
                                    </HoverCard>
                                  </TableCell>
                                  <TableCell className="text-right font-mono font-semibold">
                                    {formatAmount(row.salesAmount)}
                                  </TableCell>
                                  <TableCell className="text-right whitespace-nowrap">
                                    {formatDisplayDate(row.orderDate)}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}

                    {factoryCustomerOrderAnalytics.pagination.totalPages > 1 && (
                      <div className="flex items-center justify-between gap-3 pt-4">
                        <div className="text-sm text-muted-foreground">
                          Page {factoryCustomerOrderAnalytics.pagination.page} of {factoryCustomerOrderAnalytics.pagination.totalPages}
                          {" · "}
                          {formatNumber(factoryCustomerOrderAnalytics.pagination.totalRows)} items
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
                            disabled={factoryCustomerOrderAnalytics.pagination.page >= factoryCustomerOrderAnalytics.pagination.totalPages}
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

              {/* ── Factory OS – By Customer ─────────────────────── */}
              <Card className="p-6">
                <div className="mb-4">
                  <h3 className="text-lg font-medium">Factory OS — By Customer</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Container sales from the factory system, grouped by customer
                  </p>
                </div>
                {loadingFactorySales ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : factorySalesByCustomer.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No factory OS sales data available</p>
                ) : (
                  <div className="table-responsive">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Customer</TableHead>
                          <TableHead className="text-right hidden sm:table-cell">Containers</TableHead>
                          <TableHead className="text-right hidden sm:table-cell">Total Value</TableHead>
                          <TableHead className="text-right hidden sm:table-cell">Paid</TableHead>
                          <TableHead className="text-right">Outstanding</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {factorySalesByCustomer.map((row) => (
                          <TableRow key={row.customerId ?? "null"}>
                            <TableCell className="font-medium">
                              {row.customerName || `Customer #${row.customerId}`}
                            </TableCell>
                            <TableCell className="text-right hidden sm:table-cell">{row.containers}</TableCell>
                            <TableCell className="text-right font-mono hidden sm:table-cell">
                              {formatAmount(parseFloat(row.totalAmount))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-green-600 dark:text-green-400 hidden sm:table-cell">
                              {formatAmount(parseFloat(row.paidAmount))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-amber-600 dark:text-amber-400">
                              {formatAmount(parseFloat(row.totalAmount) - parseFloat(row.paidAmount))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                      <TableBody className="font-semibold border-t-2">
                        <TableRow>
                          <TableCell>Total</TableCell>
                          <TableCell className="text-right hidden sm:table-cell">
                            {factorySalesByCustomer.reduce((s: number, r) => s + Number(r.containers), 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono hidden sm:table-cell">
                            {formatAmount(
                              factorySalesByCustomer.reduce((s: number, r) => s + parseFloat(r.totalAmount), 0)
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono hidden sm:table-cell">
                            {formatAmount(
                              factorySalesByCustomer.reduce((s: number, r) => s + parseFloat(r.paidAmount), 0)
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatAmount(
                              factorySalesByCustomer.reduce(
                                (s: number, r) => s + parseFloat(r.totalAmount) - parseFloat(r.paidAmount),
                                0
                              )
                            )}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
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
                          <TableRow key={row.customerId ?? idx}>
                            <TableCell className="font-medium">{row.customerName}</TableCell>
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
