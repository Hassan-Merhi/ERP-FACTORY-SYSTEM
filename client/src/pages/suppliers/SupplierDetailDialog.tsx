/**
 * Supplier detail dialog (KPIs + transactions/purchase-orders tabs).
 *
 * Extracted from Suppliers.tsx during the P1 god-file split. The dialog is
 * purely presentational: queries, company switching, and navigation are
 * owned by the page, which passes data and handlers down. Ledger derivations
 * (date filtering, KPIs, payment hiding, PO totals) come from
 * ./ledgerSummaries so the numbers stay identical to the pre-extraction page.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DollarSign, Download, ExternalLink, EyeOff, FileText } from "lucide-react";
import { format } from "date-fns";
import type { Company } from "@/contexts/CompanyContext";
import { typeBadgeClass } from "./supplierDisplay";
import type { SupplierLedgerRow, SupplierPurchaseOrder, SupplierWithStats } from "./supplierDisplay";
import {
  computeLedgerKpis,
  currentLedgerBalance,
  displayedLedgerRows,
  enrichPurchaseOrderTotals,
  filterLedgerRowsByDate,
  matchesSupplierDestination,
  filterPurchaseOrdersByDate,
  hiddenPaymentsCount,
  purchaseOrderGrandTotal,
  type SupplierDateFilter,
} from "./ledgerSummaries";

export type SupplierDetailTab = "transactions" | "purchase-orders";

export interface SupplierDetailDialogProps {
  supplier: SupplierWithStats | null;
  companies: Company[];
  formatAmount: (amount: number) => string;
  companyFilter: string;
  onCompanyFilterChange: (value: string) => void;
  destinationFilter: string;
  onDestinationFilterChange: (value: string) => void;
  dateFilter: SupplierDateFilter;
  onDateFilterChange: (value: SupplierDateFilter) => void;
  hidePayments: boolean;
  onToggleHidePayments: () => void;
  unifiedLedger: SupplierLedgerRow[];
  ledgerLoading: boolean;
  purchaseOrders: SupplierPurchaseOrder[];
  posLoading: boolean;
  dialogTab: SupplierDetailTab;
  onDialogTabChange: (tab: SupplierDetailTab) => void;
  onClose: () => void;
  onExport: () => void;
  canExport?: boolean;
  exportUnavailableReason?: string;
  onTransactionClick: (txn: SupplierLedgerRow) => void;
  onPOClick: (po: SupplierPurchaseOrder) => void;
  onContainerClick: (po: { companyId: number | null; containerId?: number | null }) => void;
}

export function SupplierDetailDialog({
  supplier,
  companies,
  formatAmount,
  companyFilter,
  onCompanyFilterChange,
  destinationFilter,
  onDestinationFilterChange,
  dateFilter,
  onDateFilterChange,
  hidePayments,
  onToggleHidePayments,
  unifiedLedger,
  ledgerLoading,
  purchaseOrders,
  posLoading,
  dialogTab,
  onDialogTabChange,
  onClose,
  onExport,
  canExport = true,
  exportUnavailableReason,
  onTransactionClick,
  onPOClick,
  onContainerClick,
}: SupplierDetailDialogProps) {
  const matchesDestination = (id: number | null | undefined) => matchesSupplierDestination(id, destinationFilter);
  const openingEntry = destinationFilter === "all" ? unifiedLedger.find((t) => t.type === "opening") : undefined;
  const ledgerRows = unifiedLedger.filter((t) => t.type !== "opening");
  const filteredLedgerRows = filterLedgerRowsByDate(ledgerRows, dateFilter).filter((row) =>
    matchesDestination(row.destinationCompanyId)
  );
  const { txCount, totalPurchases, totalPayments, totalPurchasesQty } = computeLedgerKpis(filteredLedgerRows);
  // A single destination cannot inherit the combined supplier opening balance.
  // In this mode display the period's net movement, not a misleading global balance.
  const currentBalance =
    destinationFilter === "all"
      ? currentLedgerBalance(unifiedLedger)
      : filteredLedgerRows.reduce((sum, row) => sum + Number(row.credit || 0) - Number(row.debit || 0), 0);
  const runningDestinationNet = new Map<SupplierLedgerRow, number>();
  let destinationNet = 0;
  for (const row of filteredLedgerRows) {
    destinationNet += Number(row.credit || 0) - Number(row.debit || 0);
    runningDestinationNet.set(row, destinationNet);
  }
  const displayedRows = displayedLedgerRows(filteredLedgerRows, hidePayments);
  const hiddenCount = hiddenPaymentsCount(filteredLedgerRows, hidePayments);
  const sortedPOs = enrichPurchaseOrderTotals(
    filterPurchaseOrdersByDate(purchaseOrders, dateFilter).filter((po) => matchesDestination(po.destinationCompanyId))
  );
  const grandTotal = purchaseOrderGrandTotal(sortedPOs);
  const destinations = new Map<number, string>();
  for (const row of [...purchaseOrders, ...ledgerRows]) {
    if (row.destinationCompanyId != null) {
      destinations.set(
        row.destinationCompanyId,
        row.destinationCompanyName ||
          companies.find((company) => company.id === row.destinationCompanyId)?.name ||
          "Unknown"
      );
    }
  }
  const destinationOptions = [...destinations.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const hasUnassigned = ledgerRows.some((row) => row.destinationCompanyId == null);

  return (
    <Dialog open={!!supplier} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl w-[95vw] max-h-[90vh] overflow-hidden flex flex-col gap-0 p-0">
        {/* ── Header ─ */}
        <DialogHeader className="px-6 pt-5 pb-4 border-b shrink-0 gap-0">
          {/* Row 1: name + controls */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <DialogTitle className="text-lg font-bold mr-auto">{supplier?.legalName}</DialogTitle>
            <Select value={companyFilter} onValueChange={onCompanyFilterChange}>
              <SelectTrigger className="w-40" data-testid="select-company-filter">
                <SelectValue placeholder="All Companies" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Companies</SelectItem>
                {companies.map((company) => (
                  <SelectItem key={company.id} value={company.id.toString()}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={destinationFilter} onValueChange={onDestinationFilterChange}>
              <SelectTrigger
                className="w-48"
                data-testid="select-destination-filter"
                aria-label="Filter destination company"
              >
                <SelectValue placeholder="All Destinations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Destinations</SelectItem>
                {destinationOptions.map(([id, name]) => (
                  <SelectItem key={id} value={String(id)}>
                    {name}
                  </SelectItem>
                ))}
                {hasUnassigned && <SelectItem value="unassigned">Unassigned</SelectItem>}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="default"
              onClick={onExport}
              disabled={unifiedLedger.length === 0 || !canExport}
              title={!canExport ? exportUnavailableReason : undefined}
              data-testid="button-export-excel"
            >
              <Download className="h-4 w-4 mr-1.5" />
              Export
            </Button>
          </div>

          {/* Row 2: KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
            <div className="rounded-lg border bg-muted/30 px-4 py-2.5">
              <p className="text-xs text-muted-foreground mb-1">Total Purchases</p>
              {ledgerLoading ? (
                <Skeleton className="h-5 w-24" />
              ) : (
                <p className="font-mono font-semibold text-sm">{formatAmount(totalPurchases)}</p>
              )}
            </div>
            <div className="rounded-lg border bg-muted/30 px-4 py-2.5">
              <p className="text-xs text-muted-foreground mb-1">Total Payments</p>
              {ledgerLoading ? (
                <Skeleton className="h-5 w-24" />
              ) : (
                <p className="font-mono font-semibold text-sm text-green-600 dark:text-green-400">
                  {formatAmount(totalPayments)}
                </p>
              )}
            </div>
            <div className="rounded-lg border bg-muted/30 px-4 py-2.5">
              <p className="text-xs text-muted-foreground mb-1">Purchases Qty</p>
              {ledgerLoading ? (
                <Skeleton className="h-5 w-10" />
              ) : (
                <p className="font-semibold text-sm">{totalPurchasesQty}</p>
              )}
            </div>
            <div className="rounded-lg border bg-muted/30 px-4 py-2.5">
              <p className="text-xs text-muted-foreground mb-1">Transactions</p>
              {ledgerLoading ? <Skeleton className="h-5 w-10" /> : <p className="font-semibold text-sm">{txCount}</p>}
            </div>
            <div className="rounded-lg border bg-muted/30 px-4 py-2.5">
              <p className="text-xs text-muted-foreground mb-1">
                {destinationFilter === "all" ? "Balance" : "Destination Net"}
              </p>
              {ledgerLoading ? (
                <Skeleton className="h-5 w-24" />
              ) : (
                <p className="font-mono font-semibold text-sm">{formatAmount(currentBalance)}</p>
              )}
            </div>
          </div>

          {/* Row 3: date filter */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {(["all", "today", "yesterday", "this_month", "this_year"] as const).map((f) => (
              <Button
                key={f}
                variant={dateFilter === f ? "default" : "outline"}
                size="sm"
                className="text-xs"
                onClick={() => onDateFilterChange(f)}
                data-testid={`button-date-filter-${f}`}
              >
                {f === "all"
                  ? "All"
                  : f === "today"
                    ? "Today"
                    : f === "yesterday"
                      ? "Yesterday"
                      : f === "this_month"
                        ? "This Month"
                        : "This Year"}
              </Button>
            ))}
            {dateFilter !== "all" && (
              <span className="ml-1 text-xs text-muted-foreground">
                {txCount} result{txCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </DialogHeader>

        {/* ── Tabs ── */}
        <Tabs
          value={dialogTab}
          onValueChange={(v) => onDialogTabChange(v as SupplierDetailTab)}
          className="flex-1 flex flex-col overflow-hidden min-h-0"
        >
          <div className="px-6 pt-3 pb-0 shrink-0 flex items-center gap-3 flex-wrap">
            <div className="erp-mobile-scroll-tabs min-w-0 max-w-full flex-1 pb-1">
              <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Supplier details">
                <TabsTrigger value="transactions" data-testid="tab-transactions">
                  <DollarSign className="h-3.5 w-3.5 mr-1.5" />
                  Transactions
                </TabsTrigger>
                <TabsTrigger value="purchase-orders" data-testid="tab-purchase-orders">
                  <FileText className="h-3.5 w-3.5 mr-1.5" />
                  Purchase Orders {sortedPOs.length > 0 && `(${sortedPOs.length})`}
                </TabsTrigger>
              </TabsList>
            </div>
            {dialogTab === "transactions" && (
              <Button
                variant={hidePayments ? "default" : "outline"}
                size="sm"
                className="text-xs gap-1.5 ml-auto"
                onClick={onToggleHidePayments}
                data-testid="button-hide-payments"
              >
                <EyeOff className="h-3.5 w-3.5" />
                {hidePayments ? `Payments hidden (${hiddenCount})` : "Hide Payments"}
              </Button>
            )}
          </div>

          {/* Transactions tab */}
          <TabsContent value="transactions" className="mt-0 px-6 pb-5 pt-3 flex-1 overflow-hidden">
            {ledgerLoading ? (
              <div className="border rounded-lg overflow-hidden">
                <div className="bg-muted/40 px-4 py-2.5 border-b flex gap-6">
                  {[80, 100, 120, 80, 150, 80, 80, 80].map((w, i) => (
                    <Skeleton key={i} className="h-3.5 rounded-sm" style={{ width: w }} />
                  ))}
                </div>
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="px-4 py-3 border-b last:border-b-0 flex gap-6 items-center">
                    {[80, 100, 120, 80, 150, 80, 80, 80].map((w, j) => (
                      <Skeleton key={j} className="h-3 rounded-sm" style={{ width: w }} />
                    ))}
                  </div>
                ))}
              </div>
            ) : filteredLedgerRows.length === 0 && !openingEntry ? (
              <div className="border rounded-lg bg-muted/20 flex flex-col items-center justify-center py-16 gap-3 text-center">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                  <DollarSign className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">No transactions</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    No transactions found for the selected company, destination, or date
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {openingEntry && (
                  <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-2.5">
                    <span className="text-xs font-medium text-muted-foreground">Opening Balance</span>
                    <span className="font-mono font-semibold text-sm">{formatAmount(openingEntry.balance)}</span>
                  </div>
                )}
                <Table wrapperClassName="max-h-[calc(90vh-390px)]" mobileLayout="cards">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="h-9 text-xs font-semibold">Date</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Company</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Destination</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Type</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Ref</TableHead>
                      <TableHead className="h-9 text-xs font-semibold text-right">Debit</TableHead>
                      <TableHead className="h-9 text-xs font-semibold text-right">Credit</TableHead>
                      <TableHead className="h-9 text-xs font-semibold text-right">
                        {destinationFilter === "all" ? "Balance" : "Net"}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayedRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-10 text-sm text-muted-foreground">
                          {hidePayments && filteredLedgerRows.length > 0
                            ? "All transactions are payments — toggle off to show them."
                            : "No transactions in this period"}
                        </TableCell>
                      </TableRow>
                    ) : (
                      displayedRows.map((txn, idx: number) => {
                        const isPayment = txn.voucherType === "Payment" || txn.debit > 0;
                        return (
                          <TableRow key={`${txn.type}-${txn.docNumber}-${idx}`} className="text-xs">
                            <TableCell className="py-2.5 font-mono text-muted-foreground whitespace-nowrap">
                              {txn.date ? format(new Date(txn.date), "dd MMM yyyy") : "-"}
                            </TableCell>
                            <TableCell className="py-2.5">
                              <Badge variant="secondary" className="text-xs">
                                {txn.companyName}
                              </Badge>
                            </TableCell>
                            <TableCell className="py-2.5">{txn.destinationCompanyName || "Unassigned"}</TableCell>
                            <TableCell className="py-2.5">
                              <Badge
                                variant="secondary"
                                className={`text-xs ${typeBadgeClass[isPayment ? "Payment" : txn.voucherType] || ""}`}
                              >
                                {isPayment ? "Payment" : txn.voucherType}
                              </Badge>
                            </TableCell>
                            <TableCell className="py-2.5">
                              {txn.containerNumber ? (
                                <button
                                  onClick={() => onContainerClick(txn)}
                                  className="font-mono text-xs text-primary hover:underline cursor-pointer flex items-center gap-1"
                                  data-testid={`link-container-${idx}`}
                                >
                                  {txn.containerNumber}
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </button>
                              ) : (
                                <button
                                  onClick={() => onTransactionClick(txn)}
                                  className="text-xs text-muted-foreground hover:text-primary hover:underline cursor-pointer flex items-center gap-1"
                                  data-testid={`link-transaction-${idx}`}
                                >
                                  {txn.docNumber || "-"}
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </button>
                              )}
                            </TableCell>
                            <TableCell className="py-2.5 text-right font-mono">
                              {txn.debit > 0 ? formatAmount(txn.debit) : "—"}
                            </TableCell>
                            <TableCell className="py-2.5 text-right font-mono">
                              {txn.credit > 0 ? formatAmount(txn.credit) : "—"}
                            </TableCell>
                            <TableCell className="py-2.5 text-right font-mono font-semibold">
                              {formatAmount(
                                destinationFilter === "all" ? txn.balance : (runningDestinationNet.get(txn) ?? 0)
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Purchase Orders tab */}
          <TabsContent value="purchase-orders" className="mt-0 px-6 pb-5 pt-3 flex-1 overflow-hidden">
            {posLoading ? (
              <div className="border rounded-lg overflow-hidden">
                <div className="bg-muted/40 px-4 py-2.5 border-b flex gap-6">
                  {[160, 120, 100, 100].map((w, i) => (
                    <Skeleton key={i} className="h-3.5 rounded-sm" style={{ width: w }} />
                  ))}
                </div>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="px-4 py-3.5 border-b last:border-b-0 flex gap-6 items-center">
                    {[160, 120, 100, 100].map((w, j) => (
                      <Skeleton key={j} className="h-3 rounded-sm" style={{ width: w }} />
                    ))}
                  </div>
                ))}
              </div>
            ) : sortedPOs.length === 0 ? (
              <div className="border rounded-lg bg-muted/20 flex flex-col items-center justify-center py-16 gap-3 text-center">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                  <FileText className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">No purchase orders</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    No purchase orders found for the selected company, destination, or date
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Table wrapperClassName="max-h-[calc(90vh-340px)]">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="h-9 text-xs font-semibold">Container</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Import Date</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Company</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Destination</TableHead>
                      <TableHead className="h-9 text-xs font-semibold text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedPOs.map((po, idx: number) => (
                      <TableRow key={po.id} className="text-sm cursor-pointer" onClick={() => onPOClick(po)}>
                        <TableCell className="py-3">
                          {po.containerId ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onContainerClick(po);
                              }}
                              className="flex items-center gap-1.5 font-mono font-semibold text-primary hover:underline"
                              data-testid={`link-po-container-${idx}`}
                            >
                              {po.containerNumber || "-"}
                              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                            </button>
                          ) : (
                            <span className="font-mono font-semibold">{po.containerNumber || "-"}</span>
                          )}
                        </TableCell>
                        <TableCell className="py-3 font-mono text-sm text-muted-foreground">
                          {po.importDate ? format(new Date(po.importDate), "dd MMM yyyy") : "-"}
                        </TableCell>
                        <TableCell className="py-3">
                          <Badge variant="secondary" className="text-xs">
                            {po.companyName}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-3 text-sm">{po.destinationCompanyName || "Unassigned"}</TableCell>
                        <TableCell className="py-3 text-right font-mono font-semibold">
                          {formatAmount(po.totalAmount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex justify-end">
                  <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-2 text-sm">
                    <span className="text-muted-foreground">
                      {sortedPOs.length} PO{sortedPOs.length === 1 ? "" : "s"} · Grand Total
                    </span>
                    <span className="font-mono font-semibold">{formatAmount(grandTotal)}</span>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
