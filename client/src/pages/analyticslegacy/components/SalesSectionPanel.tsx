import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";

import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";

export function SalesSectionPanel({ analytics }: { analytics: AnalyticsLegacyState }) {
  const {
    activeSection,
    appMode,
    detailsPeriod,
    factoryPosSummary,
    factorySalesByCustomer,
    factorySalesEndDate,
    factorySalesStartDate,
    formatAmount,
    formatDisplayDate,
    loadingFactoryPos,
    loadingFactorySales,
    rangeEnd,
    rangeStart,
    salesData,
    salesLoading,
    selectedLocationForDetails,
    selectedPeriod,
    setDetailsPeriod,
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
