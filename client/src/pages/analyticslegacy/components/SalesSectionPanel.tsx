import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";
import { PosCustomerSalesDialog } from "./PosCustomerSalesDialog";
import { useSalesSectionPanelState } from "./useSalesSectionPanelState";
import { SalesSectionPanelCardSection } from "./SalesSectionPanelCardSection";
import { SalesSectionPanelCardSection2, SalesSectionPanelCardSection3 } from "./SalesSectionPanelCardSection3";
import { EmptyState } from "@/components/ui/page-state";

export function SalesSectionPanel(props: { analytics: AnalyticsLegacyState }) {
  const {
    activeSection,
    appMode,
    detailsPeriod,
    expandedOrderCustomers,
    factoryCustomerOrderAnalytics,
    factoryCustomerOrderAnalyticsError,
    factoryOrderDestination,
    factoryOrderIncludeCharges,
    factoryOrderPage,
    factoryOrderStatus,
    factoryPosSummary,
    formatAmount,
    formatDisplayDate,
    loadingFactoryCustomerOrders,
    loadingFactoryPos,
    navigate,
    periodFilter,
    rangeEnd,
    rangeStart,
    salesData,
    salesLoading,
    selectedLocationForDetails,
    selectedPeriod,
    selectedPosCustomer,
    setDetailsPeriod,
    setFactoryOrderDestination,
    setFactoryOrderIncludeCharges,
    setFactoryOrderPage,
    setFactoryOrderStatus,
    setRangeEnd,
    setRangeStart,
    setSelectedLocationForDetails,
    setSelectedPeriod,
    setSelectedPosCustomer,
    toggleOrderCustomer,
    transactions,
    transactionsLoading,
  } = useSalesSectionPanelState(props);

  return (
    <>
      {activeSection === "sales" && (
        <>
          {appMode === "factory" ? (
            <>
              {/* ── Customer orders grouped by customer ─────────────── */}
              <SalesSectionPanelCardSection
                expandedOrderCustomers={expandedOrderCustomers}
                factoryCustomerOrderAnalytics={factoryCustomerOrderAnalytics}
                factoryCustomerOrderAnalyticsError={factoryCustomerOrderAnalyticsError}
                factoryOrderDestination={factoryOrderDestination}
                factoryOrderIncludeCharges={factoryOrderIncludeCharges}
                factoryOrderPage={factoryOrderPage}
                factoryOrderStatus={factoryOrderStatus}
                formatAmount={formatAmount}
                formatDisplayDate={formatDisplayDate}
                loadingFactoryCustomerOrders={loadingFactoryCustomerOrders}
                navigate={navigate}
                setFactoryOrderDestination={setFactoryOrderDestination}
                setFactoryOrderIncludeCharges={setFactoryOrderIncludeCharges}
                setFactoryOrderPage={setFactoryOrderPage}
                setFactoryOrderStatus={setFactoryOrderStatus}
                toggleOrderCustomer={toggleOrderCustomer}
              />

              {/* ── Factory POS ──────────────────────────────────── */}
              <SalesSectionPanelCardSection2
                factoryPosSummary={factoryPosSummary}
                formatAmount={formatAmount}
                loadingFactoryPos={loadingFactoryPos}
                setSelectedPosCustomer={setSelectedPosCustomer}
              />

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
            <SalesSectionPanelCardSection3
              formatAmount={formatAmount}
              rangeEnd={rangeEnd}
              rangeStart={rangeStart}
              salesData={salesData}
              salesLoading={salesLoading}
              selectedPeriod={selectedPeriod}
              setRangeEnd={setRangeEnd}
              setRangeStart={setRangeStart}
              setSelectedLocationForDetails={setSelectedLocationForDetails}
              setSelectedPeriod={setSelectedPeriod}
            />
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
                    <EmptyState title="No transactions found" />
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
