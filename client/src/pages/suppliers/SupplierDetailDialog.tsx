/**
 * Supplier detail dialog (KPIs + transactions/purchase-orders tabs).
 *
 * Extracted from Suppliers.tsx during the P1 god-file split. The dialog is
 * purely presentational: queries, company switching, and navigation are
 * owned by the page, which passes data and handlers down. Ledger derivations
 * (date filtering, KPIs, payment hiding, PO totals) come from
 * ./ledgerSummaries so the numbers stay identical to the pre-extraction page.
 */

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Download } from "lucide-react";
import { useSupplierDetailDialogState, type SupplierDetailDialogProps } from "./useSupplierDetailDialogState";
import { SupplierDetailDialogTabsSection } from "./SupplierDetailDialogTabsSection";
export type { SupplierDetailDialogProps, SupplierDetailTab } from "./useSupplierDetailDialogState";

export function SupplierDetailDialog(props: SupplierDetailDialogProps) {
  const {
    canExport,
    companies,
    companyFilter,
    currentBalance,
    dateFilter,
    destinationFilter,
    destinationOptions,
    dialogTab,
    displayedRows,
    exportUnavailableReason,
    filteredLedgerRows,
    formatAmount,
    grandTotal,
    hasUnassigned,
    hiddenCount,
    hidePayments,
    ledgerLoading,
    onClose,
    onCompanyFilterChange,
    onContainerClick,
    onDateFilterChange,
    onDestinationFilterChange,
    onDialogTabChange,
    onExport,
    onPOClick,
    onToggleHidePayments,
    onTransactionClick,
    openingEntry,
    posLoading,
    runningDestinationNet,
    sortedPOs,
    supplier,
    totalPayments,
    totalPurchases,
    totalPurchasesQty,
    txCount,
    unifiedLedger,
  } = useSupplierDetailDialogState(props);

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
        <SupplierDetailDialogTabsSection
          destinationFilter={destinationFilter}
          dialogTab={dialogTab}
          displayedRows={displayedRows}
          filteredLedgerRows={filteredLedgerRows}
          formatAmount={formatAmount}
          grandTotal={grandTotal}
          hiddenCount={hiddenCount}
          hidePayments={hidePayments}
          ledgerLoading={ledgerLoading}
          onContainerClick={onContainerClick}
          onDialogTabChange={onDialogTabChange}
          onPOClick={onPOClick}
          onToggleHidePayments={onToggleHidePayments}
          onTransactionClick={onTransactionClick}
          openingEntry={openingEntry}
          posLoading={posLoading}
          runningDestinationNet={runningDestinationNet}
          sortedPOs={sortedPOs}
        />
      </DialogContent>
    </Dialog>
  );
}
