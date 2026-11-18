import { MapPin, Eye, ArrowDownToLine, ArrowUpFromLine, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { PeriodFilter } from "@/components/ui/period-filter";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { stockVoucherExportColumns, stockVoucherExportFooter } from "@/pages/stock-ledger/stockVoucherExportColumns";
import type { DisplayRow } from "./LocationVouchersTypes";
import { useLocationVouchersState } from "./useLocationVouchersState";
import { LocationVouchersSection, LocationVouchersSection2 } from "./LocationVouchersSection2";

export default function LocationVouchers(props: { posUser?: unknown }) {
  const {
    refetch,
    isError,
    calculatedTotals,
    data,
    displayRows,
    filteredTransactions,
    formatAmount,
    formatDate,
    formatNumber,
    getTransactionEditUrl,
    getVchTypeBadge,
    handleParticularsClick,
    isLoading,
    locationId,
    mobileCards,
    navigableRows,
    navigate,
    periodFilter,
    posUser,
    selectedRowIndex,
    setPeriodFilter,
    setSelectedRowIndex,
    setShowAllMonths,
    setShowStockTransfers,
    showAllMonths,
    showStockTransfers,
    stockItemId,
    tableScrollContainer,
    year,
  } = useLocationVouchersState(props);

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="container mx-auto p-0 sm:p-6">
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
      </div>
    );
  }

  const colSpanFull = posUser ? 6 : 12;

  return (
    <div className="container mx-auto space-y-4 p-0 sm:p-6">
      <PageHeader
        title="Location Vouchers"
        onBack={() => navigate(`/locations/${locationId}/stock-items/${stockItemId}/history`)}
        meta={
          data?.stockItem &&
          data?.location && (
            <div className="flex items-center gap-2 text-muted-foreground" data-testid="text-item-location">
              <span>
                {data.stockItem.name} ({data.stockItem.code})
              </span>
              <span>•</span>
              <MapPin className="h-4 w-4" />
              <span>{data.location.name}</span>
              <span>•</span>
              <span>{showAllMonths ? String(year) : `${"monthName" in data ? data.monthName : ""} ${year}`}</span>
            </div>
          )
        }
      >
        <Button
          variant={showAllMonths ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setShowAllMonths((v) => !v);
            setSelectedRowIndex(-1);
          }}
          data-testid="button-show-all-months"
          data-remote-control-safe="true"
          data-remote-control-action="toggle-view"
        >
          <Eye className="h-4 w-4 mr-1.5" />
          {showAllMonths ? "This month only" : "Show all months"}
        </Button>
        {!showAllMonths && <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />}
        <RowsExportMenu
          title={`${data?.stockItem?.name ?? "Stock Item"} ${data?.location?.name ?? ""} Vouchers`}
          sheetName="Location Vouchers"
          rows={displayRows.filter((row: DisplayRow) => !row._isSeparator)}
          columns={stockVoucherExportColumns(formatDate, !!posUser)}
          footer={filteredTransactions.length > 0 ? stockVoucherExportFooter(calculatedTotals, !!posUser) : undefined}
          resource="erp.inventory"
          period={showAllMonths ? undefined : { from: periodFilter.fromDate, to: periodFilter.toDate }}
        />
      </PageHeader>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="show-stock-transfers"
            checked={showStockTransfers}
            onCheckedChange={(checked) => setShowStockTransfers(checked === true)}
            data-testid="checkbox-show-stock-transfers"
          />
          <Label htmlFor="show-stock-transfers" className="text-sm cursor-pointer">
            Show Stock Transfers
          </Label>
        </div>
      </div>

      {/* KPI Summary Cards */}
      {filteredTransactions.length > 0 && (
        <div className="flex flex-wrap gap-3 items-stretch">
          <div className="flex-1 min-w-[130px] rounded-xl border bg-card p-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <ArrowDownToLine className="h-3.5 w-3.5 text-emerald-500" />
              Total In
            </div>
            <div className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-400">
              {calculatedTotals.inwardQty > 0
                ? calculatedTotals.inwardQty.toLocaleString(undefined, { maximumFractionDigits: 0 })
                : "—"}
            </div>
            {!posUser && calculatedTotals.inwardValue > 0 && (
              <div className="text-xs font-mono text-muted-foreground">
                {formatAmount(calculatedTotals.inwardValue)}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-[130px] rounded-xl border bg-card p-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <ArrowUpFromLine className="h-3.5 w-3.5 text-rose-500" />
              Total Out
            </div>
            <div className="text-lg font-bold font-mono text-rose-600 dark:text-rose-400">
              {calculatedTotals.outwardQty > 0
                ? calculatedTotals.outwardQty.toLocaleString(undefined, { maximumFractionDigits: 0 })
                : "—"}
            </div>
            {!posUser && calculatedTotals.outwardValue > 0 && (
              <div className="text-xs font-mono text-muted-foreground">
                {formatAmount(calculatedTotals.outwardValue)}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-[130px] rounded-xl border bg-primary/5 p-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <Layers className="h-3.5 w-3.5 text-primary" />
              Closing
            </div>
            <div
              className={`text-lg font-bold font-mono ${calculatedTotals.closingQty < 0 ? "text-rose-600 dark:text-rose-400" : "text-foreground"}`}
            >
              {calculatedTotals.closingQty.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
            {!posUser && (
              <div className="text-xs font-mono text-muted-foreground">
                {formatAmount(calculatedTotals.closingValue)}
              </div>
            )}
          </div>
        </div>
      )}

      <Card className="overflow-hidden flex flex-col">
        <CardHeader className="pb-2 shrink-0">
          <CardTitle className="text-base">
            {showAllMonths
              ? `All Transactions — ${year}`
              : `Transactions — ${"monthName" in (data ?? {}) ? (data as { monthName: unknown }).monthName : ""} ${year}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto flex-1 p-0" ref={tableScrollContainer}>
          <table {...mobileCards.tableProps} className="w-full text-sm border-collapse">
            <LocationVouchersSection2 posUser={posUser} />
            <tbody>
              {displayRows.map((txn: DisplayRow, idx: number) => {
                // Month separator row
                if (txn._isSeparator) {
                  return (
                    <tr key={`sep-${idx}`} className="bg-primary/10 border-b border-t">
                      <td colSpan={colSpanFull} className="px-4 py-1.5">
                        <span className="text-xs font-bold uppercase tracking-wider text-primary">
                          {txn._separatorLabel}
                        </span>
                      </td>
                    </tr>
                  );
                }

                const navIndex = txn.isOpeningBalance ? -1 : navigableRows.indexOf(txn);
                const isSelected = navIndex >= 0 && selectedRowIndex === navIndex;

                return (
                  <tr
                    key={idx}
                    data-testid={`row-txn-${idx}`}
                    className={`border-b transition-colors ${txn.isOpeningBalance ? "bg-muted/30 font-medium" : isSelected ? "bg-primary/10 ring-1 ring-inset ring-primary" : "hover:bg-muted/30"}`}
                    data-row-index={navIndex >= 0 ? navIndex : undefined}
                  >
                    <td className="px-4 py-2.5 border-r tabular-nums text-muted-foreground text-xs">
                      {txn.isOpeningBalance ? "" : formatDate(txn.date)}
                    </td>
                    <td className={`px-4 py-2.5 border-r ${txn.isOpeningBalance ? "font-semibold" : ""}`}>
                      {getTransactionEditUrl(txn) ? (
                        <button
                          onClick={() => handleParticularsClick(txn)}
                          className="text-left text-primary hover:underline cursor-pointer"
                          data-testid={`link-particulars-${idx}`}
                        >
                          {txn.particulars}
                        </button>
                      ) : (
                        txn.particulars
                      )}
                    </td>
                    <td className="px-4 py-2.5 border-r">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getVchTypeBadge(txn.vchType)}`}
                      >
                        {txn.vchType}
                      </span>
                    </td>
                    <td className="text-right px-2 py-2.5 tabular-nums border-r font-medium text-emerald-700 dark:text-emerald-400">
                      {formatNumber(txn.inwardQty, 0)}
                    </td>
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                        {formatAmount(txn.inwardRate)}
                      </td>
                    )}
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums border-r text-muted-foreground">
                        {formatAmount(txn.inwardValue)}
                      </td>
                    )}
                    <td className="text-right px-2 py-2.5 tabular-nums border-r font-medium text-rose-700 dark:text-rose-400">
                      {formatNumber(txn.outwardQty, 0)}
                    </td>
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                        {formatAmount(txn.isPOS && txn.posSellingRate ? txn.posSellingRate : txn.outwardRate)}
                      </td>
                    )}
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums border-r text-muted-foreground">
                        {formatAmount(txn.isPOS && txn.posSellingValue ? txn.posSellingValue : txn.outwardValue)}
                      </td>
                    )}
                    <td className="text-right px-2 py-2.5 tabular-nums font-semibold text-foreground">
                      {formatNumber(txn.closingQty, 0)}
                    </td>
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
                        {formatAmount(txn.closingRate)}
                      </td>
                    )}
                    {!posUser && (
                      <td className="text-right px-2 py-2.5 tabular-nums font-medium">
                        {formatAmount(txn.closingValue)}
                      </td>
                    )}
                  </tr>
                );
              })}

              {displayRows.filter((r: DisplayRow) => !r._isSeparator).length === 0 && (
                <tr>
                  <td colSpan={colSpanFull} className="text-center text-muted-foreground py-8">
                    No transactions found
                  </td>
                </tr>
              )}

              {filteredTransactions.length > 0 && (
                <LocationVouchersSection
                  calculatedTotals={calculatedTotals}
                  formatAmount={formatAmount}
                  formatNumber={formatNumber}
                  posUser={posUser}
                />
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
