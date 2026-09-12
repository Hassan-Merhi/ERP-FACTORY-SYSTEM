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
  onTransactionClick,
  onPOClick,
  onContainerClick,
}: SupplierDetailDialogProps) {
  const openingEntry = unifiedLedger.find((t) => t.type === "opening");
  const ledgerRows = unifiedLedger.filter((t) => t.type !== "opening");
  const filteredLedgerRows = filterLedgerRowsByDate(ledgerRows, dateFilter);
  const { txCount, totalPurchases, totalPayments, totalPurchasesQty } = computeLedgerKpis(filteredLedgerRows);
  const currentBalance = currentLedgerBalance(unifiedLedger);
  const displayedRows = displayedLedgerRows(filteredLedgerRows, hidePayments);
  const hiddenCount = hiddenPaymentsCount(filteredLedgerRows, hidePayments);
  const sortedPOs = enrichPurchaseOrderTotals(purchaseOrders);
  const grandTotal = purchaseOrderGrandTotal(sortedPOs);

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
            <Button
              variant="outline"
              size="default"
              onClick={onExport}
              disabled={unifiedLedger.length === 0}
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
              <p className="text-xs text-muted-foreground mb-1">Balance</p>
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
            <TabsList className="w-fit">
              <TabsTrigger value="transactions" className="text-xs" data-testid="tab-transactions">
                <DollarSign className="h-3.5 w-3.5 mr-1.5" />
                Transactions
              </TabsTrigger>
              <TabsTrigger value="purchase-orders" className="text-xs" data-testid="tab-purchase-orders">
                <FileText className="h-3.5 w-3.5 mr-1.5" />
                Purchase Orders {purchaseOrders.length > 0 && `(${purchaseOrders.length})`}
              </TabsTrigger>
            </TabsList>
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
                  {[80, 100, 80, 150, 80, 80, 80].map((w, i) => (
                    <Skeleton key={i} className="h-3.5 rounded" style={{ width: w }} />
                  ))}
                </div>
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="px-4 py-3 border-b last:border-b-0 flex gap-6 items-center">
                    {[80, 100, 80, 150, 80, 80, 80].map((w, j) => (
                      <Skeleton key={j} className="h-3 rounded" style={{ width: w }} />
                    ))}
                  </div>
                ))}
              </div>
            ) : unifiedLedger.length === 0 ? (
              <div className="border rounded-lg bg-muted/20 flex flex-col items-center justify-center py-16 gap-3 text-center">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                  <DollarSign className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">No transactions</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    No transactions found{companyFilter !== "all" ? " for this company" : ""}
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
                <Table wrapperClassName="max-h-[calc(90vh-390px)]">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead className="h-9 text-xs font-semibold">Date</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Company</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Type</TableHead>
                      <TableHead className="h-9 text-xs font-semibold">Ref</TableHead>
                      <TableHead className="h-9 text-xs font-semibold text-right">Debit</TableHead>
                      <TableHead className="h-9 text-xs font-semibold text-right">Credit</TableHead>
                      <TableHead className="h-9 text-xs font-semibold text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayedRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-10 text-sm text-muted-foreground">
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
                              {formatAmount(txn.balance)}
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
                    <Skeleton key={i} className="h-3.5 rounded" style={{ width: w }} />
                  ))}
                </div>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="px-4 py-3.5 border-b last:border-b-0 flex gap-6 items-center">
                    {[160, 120, 100, 100].map((w, j) => (
                      <Skeleton key={j} className="h-3 rounded" style={{ width: w }} />
                    ))}
                  </div>
                ))}
              </div>
            ) : purchaseOrders.length === 0 ? (
              <div className="border rounded-lg bg-muted/20 flex flex-col items-center justify-center py-16 gap-3 text-center">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                  <FileText className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">No purchase orders</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    No purchase orders found{companyFilter !== "all" ? " for this company" : ""}
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
                        <TableCell className="py-3 text-right font-mono font-semibold">
                          {formatAmount(po.totalAmount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex justify-end">
                  <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-2 text-sm">
                    <span className="text-muted-foreground">Grand Total</span>
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
