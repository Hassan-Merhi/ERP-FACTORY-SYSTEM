import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

interface PosAnalyticsSale {
  id: number;
  saleNumber: string;
  txDate: string;
  customerId?: number | null;
  customerName?: string | null;
  paymentType?: string | null;
  totalAmount: string;
  depositAmount?: string | null;
  currencyCode?: string | null;
  status: string;
}

interface PosAnalyticsSaleItem {
  id: number;
  productName: string;
  articleCode?: string | null;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
  currencyCode?: string | null;
}

interface PosAnalyticsSaleDetail extends PosAnalyticsSale {
  items: PosAnalyticsSaleItem[];
  notes?: string | null;
}

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
    setFactoryOrderStatus,
    setFactorySalesEndDate,
    setFactorySalesStartDate,
    setRangeEnd,
    setRangeStart,
    setSelectedLocationForDetails,
    setSelectedPeriod,
    transactions,
    transactionsLoading,
    navigate,
  } = analytics;
  const [expandedOrderCustomers, setExpandedOrderCustomers] = useState<Set<string>>(new Set());
  const [selectedPosCustomer, setSelectedPosCustomer] = useState<{
    customerId: number | null;
    customerName: string;
  } | null>(null);
  const [expandedPosSaleId, setExpandedPosSaleId] = useState<number | null>(null);

  const { data: posSales = [], isLoading: loadingPosSales } = useQuery<PosAnalyticsSale[]>({
    queryKey: ["/api/factory/pos/sales", "analytics-customer-detail"],
    queryFn: async () => {
      const res = await fetch("/api/factory/pos/sales", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load POS sales");
      return res.json();
    },
    enabled: !!selectedPosCustomer,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const { data: expandedPosSale, isLoading: loadingExpandedPosSale } = useQuery<PosAnalyticsSaleDetail>({
    queryKey: ["/api/factory/pos/sales", expandedPosSaleId, "analytics-detail"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/pos/sales/${expandedPosSaleId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load POS sale details");
      return res.json();
    },
    enabled: !!expandedPosSaleId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const selectedPosSales = selectedPosCustomer
    ? posSales.filter((sale) => {
        if (sale.status === "VOID") return false;
        if (factorySalesStartDate && sale.txDate < factorySalesStartDate) return false;
        if (factorySalesEndDate && sale.txDate > factorySalesEndDate) return false;

        if (selectedPosCustomer.customerId !== null) {
          return sale.customerId === selectedPosCustomer.customerId;
        }

        if (sale.customerId != null) return false;
        const saleName = (sale.customerName || "Walk-in / Cash").trim().toLowerCase();
        return saleName === selectedPosCustomer.customerName.trim().toLowerCase();
      })
    : [];

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

              {/* ── Customer orders grouped by customer ─────────────── */}
              <Card className="p-4 md:p-6">
                <div className="flex flex-col gap-1 mb-4">
                  <h3 className="text-lg font-medium">Customer Order Analytics</h3>
                  <p className="text-sm text-muted-foreground">
                    Expand a customer to see each loading, verified or finalized invoice. Totals below exclude freight
                    and extra charges.
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5 mb-4">
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
                      <SelectItem value="all">Loading + Verified + Finalized</SelectItem>
                      <SelectItem value="LOADING">Loading</SelectItem>
                      <SelectItem value="VERIFIED">Verified</SelectItem>
                      <SelectItem value="FINALIZED">Finalized</SelectItem>
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
                        <div className="text-xs text-muted-foreground">Invoice Total (No Charges)</div>
                        <div className="font-semibold font-mono">
                          {formatAmount(factoryCustomerOrderAnalytics.summary.totalInvoiceAmount)}
                        </div>
                      </div>
                    </div>

                    {factoryCustomerOrderAnalytics.rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No customer invoices match these filters
                      </p>
                    ) : (
                      <div className="table-responsive">
                        <Table>
                          <TableHeader className="sticky top-0 z-30 bg-background">
                            <TableRow>
                              <TableHead>Customer / Container</TableHead>
                              <TableHead className="text-right">Total Weight</TableHead>
                              <TableHead className="text-right">Total Cost (No Charges)</TableHead>
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
                                          <div className="font-semibold">{customerRow.customerName || "Unknown customer"}</div>
                                          <div className="text-xs text-muted-foreground">
                                            {formatNumber(customerRow.invoiceCount)}{" "}
                                            {customerRow.invoiceCount === 1 ? "invoice" : "invoices"} ·{" "}
                                            {formatNumber(customerRow.totalBales)} bales
                                          </div>
                                        </div>
                                      </button>
                                    </TableCell>
                                    <TableCell className="text-right font-mono">
                                      {customerRow.totalWeightKg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg
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
                                                onClick={() => navigate(`/factory/sales/invoices/${order.orderId}?view=no-charges&from=analytics`)}
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
                                            {order.totalWeightKg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg
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
                          <TableRow
                            key={row.customerId ?? `${row.customerName}-${idx}`}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => {
                              setSelectedPosCustomer({
                                customerId: row.customerId,
                                customerName: row.customerName || "Walk-in / Cash",
                              });
                              setExpandedPosSaleId(null);
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
                                  setExpandedPosSaleId(null);
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

              <Dialog
                open={selectedPosCustomer !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    setSelectedPosCustomer(null);
                    setExpandedPosSaleId(null);
                  }
                }}
              >
                <DialogContent className="w-[95vw] max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
                  <DialogHeader>
                    <DialogTitle>
                      {selectedPosCustomer?.customerName || "POS Customer"} — Sales Details
                    </DialogTitle>
                  </DialogHeader>

                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {loadingPosSales ? (
                      <div className="space-y-3">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-14 w-full" />
                        ))}
                      </div>
                    ) : selectedPosSales.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No POS sales found for this customer in the selected date range.
                      </p>
                    ) : (
                      <Table>
                        <TableHeader className="sticky top-0 z-30 bg-background">
                          <TableRow>
                            <TableHead>Sale</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Payment</TableHead>
                            <TableHead className="text-right">Total</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedPosSales.map((sale) => {
                            const expanded = expandedPosSaleId === sale.id;
                            return (
                              <Fragment key={sale.id}>
                                <TableRow
                                  className="cursor-pointer"
                                  onClick={() => setExpandedPosSaleId(expanded ? null : sale.id)}
                                  data-testid={`row-pos-sale-${sale.id}`}
                                >
                                  <TableCell>
                                    <div className="flex items-center gap-2">
                                      <ChevronRight
                                        className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
                                      />
                                      <span className="font-mono font-semibold">{sale.saleNumber}</span>
                                    </div>
                                  </TableCell>
                                  <TableCell>{formatDisplayDate(sale.txDate)}</TableCell>
                                  <TableCell>{sale.paymentType || "CASH"}</TableCell>
                                  <TableCell className="text-right font-mono font-semibold">
                                    {formatAmount(parseFloat(sale.totalAmount || "0"))}
                                  </TableCell>
                                </TableRow>

                                {expanded && (
                                  <TableRow>
                                    <TableCell colSpan={4} className="bg-muted/20 p-0">
                                      <div className="p-4">
                                        {loadingExpandedPosSale ? (
                                          <div className="space-y-2">
                                            <Skeleton className="h-10 w-full" />
                                            <Skeleton className="h-10 w-full" />
                                          </div>
                                        ) : expandedPosSale?.id !== sale.id ? (
                                          <p className="text-sm text-muted-foreground">Loading sale details…</p>
                                        ) : expandedPosSale.items?.length ? (
                                          <div className="overflow-x-auto">
                                            <Table>
                                              <TableHeader>
                                                <TableRow>
                                                  <TableHead>Item</TableHead>
                                                  <TableHead>Article</TableHead>
                                                  <TableHead className="text-right">Qty</TableHead>
                                                  <TableHead className="text-right">Unit Price</TableHead>
                                                  <TableHead className="text-right">Total</TableHead>
                                                </TableRow>
                                              </TableHeader>
                                              <TableBody>
                                                {expandedPosSale.items.map((item) => (
                                                  <TableRow key={item.id}>
                                                    <TableCell className="font-medium">{item.productName}</TableCell>
                                                    <TableCell className="font-mono text-sm">
                                                      {item.articleCode || "—"}
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono">
                                                      {formatNumber(Number(item.quantity || 0))}
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono">
                                                      {formatAmount(parseFloat(item.unitPrice || "0"))}
                                                    </TableCell>
                                                    <TableCell className="text-right font-mono font-semibold">
                                                      {formatAmount(parseFloat(item.totalAmount || "0"))}
                                                    </TableCell>
                                                  </TableRow>
                                                ))}
                                              </TableBody>
                                            </Table>
                                          </div>
                                        ) : (
                                          <p className="text-sm text-muted-foreground">No sale items found.</p>
                                        )}

                                        {expandedPosSale?.id === sale.id && expandedPosSale.notes && (
                                          <div className="mt-3 text-sm">
                                            <span className="text-muted-foreground">Notes: </span>
                                            {expandedPosSale.notes}
                                          </div>
                                        )}
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                )}
                              </Fragment>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
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
