import { MapPin, Globe, Eye, ArrowDownToLine, ArrowUpFromLine, Package, DollarSign, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { AuthMe } from "@shared/apiTypes";
import { useLocationMonthlySummaryState } from "./useLocationMonthlySummaryState";
import { LocationMonthlySummaryCardContentSection } from "./LocationMonthlySummaryCardContentSection";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

export default function LocationMonthlySummary(props: { posUser?: AuthMe }) {
  const {
    refetch,
    isError,
    data,
    detailData,
    detailDirection,
    detailLoading,
    detailMonthName,
    detailOpen,
    detailYear,
    fmtQty,
    fmtRate,
    fmtVal,
    formatAmount,
    handleBack,
    handleMonthClick,
    isAllLocationsMode,
    isLoading,
    mobileCards,
    mobileCardsSecondary,
    periodFilter,
    posUser,
    selectedRowIndex,
    setDetailDirection,
    setDetailMonth,
    setDetailMonthName,
    setDetailOpen,
    setDetailYear,
    setPeriodFilter,
    setShowAllMonths,
    showAllMonths,
    tableScrollContainer,
    visibleRows,
  } = useLocationMonthlySummaryState(props);

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-4">
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

  const uom = data?.stockItem?.uom || "Units";

  return (
    <div className="container mx-auto space-y-4 p-0 sm:p-6">
      {/* Header */}
      <PageHeader
        title={isAllLocationsMode ? "Item Monthly Summary" : "Stock Movement"}
        onBack={handleBack}
        meta={
          data?.stockItem && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-item-location">
              <span className="font-medium">{data.stockItem.name}</span>
              <span className="text-muted-foreground/50">({data.stockItem.code})</span>
              <span>•</span>
              {isAllLocationsMode ? (
                <>
                  <Globe className="h-3.5 w-3.5" />
                  <span>All Locations</span>
                </>
              ) : (
                <>
                  <MapPin className="h-3.5 w-3.5" />
                  <span>{data.location?.name || "Unknown"}</span>
                </>
              )}
            </div>
          )
        }
      >
        <Button
          variant={showAllMonths ? "default" : "outline"}
          size="sm"
          data-remote-control-safe="true"
          data-remote-control-action="toggle-view"
          onClick={() => {
            setShowAllMonths((v) => {
              const next = !v;
              // "Show all months" should genuinely show the full 12-month year, even if
              // a narrower custom range (e.g. a single month) is currently selected —
              // otherwise the toggle flips but the table still only has the months that
              // were already fetched, which looks like the button does nothing.
              if (next) {
                const parsed = periodFilter.fromDate ? new Date(periodFilter.fromDate) : new Date();
                const year = Number.isNaN(parsed.getTime()) ? new Date().getFullYear() : parsed.getFullYear();
                const fullYear = {
                  fromDate: `${year}-01-01`,
                  toDate: `${year}-12-31`,
                  preset: "custom" as const,
                };
                if (periodFilter.fromDate !== fullYear.fromDate || periodFilter.toDate !== fullYear.toDate) {
                  setPeriodFilter(fullYear);
                }
              }
              return next;
            });
          }}
          data-testid="button-show-all-months"
        >
          <Eye className="h-4 w-4 mr-1.5" />
          {showAllMonths ? "Hide empty months" : "Show all months"}
        </Button>
        <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />
      </PageHeader>

      {/* KPI Summary Cards */}
      {data?.grandTotal && (
        <div className="flex flex-wrap gap-3 items-stretch">
          <div className="flex-1 min-w-[140px] rounded-xl border bg-card p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <ArrowDownToLine className="h-3.5 w-3.5 text-emerald-500" />
              Total Stock In
            </div>
            <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
              {fmtQty(data.grandTotal.inwardQty)}{" "}
              <span className="text-sm font-normal text-muted-foreground">{uom}</span>
            </div>
            {!posUser && (
              <div className="text-xs font-mono text-muted-foreground">{fmtVal(data.grandTotal.inwardValue)}</div>
            )}
          </div>

          <div className="flex items-center self-center text-muted-foreground/40">
            <ArrowRight className="h-4 w-4" />
          </div>

          <div className="flex-1 min-w-[140px] rounded-xl border bg-card p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <ArrowUpFromLine className="h-3.5 w-3.5 text-rose-500" />
              Total Stock Out
            </div>
            <div className="text-xl font-bold font-mono text-rose-600 dark:text-rose-400">
              {fmtQty(data.grandTotal.outwardQty)}{" "}
              <span className="text-sm font-normal text-muted-foreground">{uom}</span>
            </div>
            {!posUser && (
              <div className="text-xs font-mono text-muted-foreground">{fmtVal(data.grandTotal.outwardValue)}</div>
            )}
          </div>

          <div className="flex items-center self-center text-muted-foreground/40">
            <ArrowRight className="h-4 w-4" />
          </div>

          <div className="flex-1 min-w-[140px] rounded-xl border bg-card p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
              <Package className="h-3.5 w-3.5 text-primary" />
              Closing Stock
            </div>
            <div
              className={`text-xl font-bold font-mono ${data.grandTotal.closingQty < 0 ? "text-rose-600 dark:text-rose-400" : "text-foreground"}`}
            >
              {fmtQty(data.grandTotal.closingQty)}{" "}
              <span className="text-sm font-normal text-muted-foreground">{uom}</span>
            </div>
            {!posUser && (
              <div className="text-xs font-mono text-muted-foreground">{fmtVal(data.grandTotal.closingValue)}</div>
            )}
          </div>

          {!posUser && (
            <>
              <div className="flex items-center self-center text-muted-foreground/40">
                <ArrowRight className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-[140px] rounded-xl border bg-primary/5 p-4 flex flex-col gap-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  <DollarSign className="h-3.5 w-3.5 text-primary" />
                  Closing Value
                </div>
                <div className="text-xl font-bold font-mono text-primary">{fmtVal(data.grandTotal.closingValue)}</div>
                <div className="text-xs font-mono text-muted-foreground">
                  avg {fmtRate(data.grandTotal.closingRate)} / {uom}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Tally-style Stock Movement Table */}
      <Card className="overflow-hidden flex flex-col">
        <CardHeader className="pb-2 shrink-0">
          <CardTitle className="text-base">
            Monthly Stock Movement
            <span className="ml-2 text-sm font-normal text-muted-foreground">({uom})</span>
          </CardTitle>
        </CardHeader>
        <LocationMonthlySummaryCardContentSection
          data={data}
          fmtQty={fmtQty}
          fmtRate={fmtRate}
          fmtVal={fmtVal}
          handleMonthClick={handleMonthClick}
          isAllLocationsMode={isAllLocationsMode}
          mobileCards={mobileCards}
          periodFilter={periodFilter}
          posUser={posUser}
          selectedRowIndex={selectedRowIndex}
          setDetailDirection={setDetailDirection}
          setDetailMonth={setDetailMonth}
          setDetailMonthName={setDetailMonthName}
          setDetailOpen={setDetailOpen}
          setDetailYear={setDetailYear}
          tableScrollContainer={tableScrollContainer}
          visibleRows={visibleRows}
        />
      </Card>

      {/* Legend */}
      {!isAllLocationsMode && (
        <p className="text-xs text-muted-foreground text-center">
          Click any month row to see voucher detail · Click Qty In/Out to drill into transactions
        </p>
      )}

      {/* ── Drill-down detail dialog ── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl flex flex-col" style={{ maxHeight: "75vh" }}>
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              {detailDirection === "in" ? (
                <span className="text-green-700 dark:text-green-400">Stock In</span>
              ) : (
                <span className="text-red-700 dark:text-red-400">Stock Out</span>
              )}
              <span className="text-muted-foreground font-normal">—</span>
              <span>
                {detailMonthName} {detailYear}
              </span>
            </DialogTitle>
            <DialogDescription>
              {data?.stockItem?.name} · {data?.location?.name}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-auto min-h-0 border rounded-md">
            {detailLoading ? (
              <div className="space-y-2 p-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              (() => {
                const rows =
                  detailDirection === "in" ? (detailData?.inTransactions ?? []) : (detailData?.outTransactions ?? []);

                const typeBadgeClass = (type: string) => {
                  if (type === "Sale") return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
                  if (type.startsWith("Transfer In"))
                    return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
                  if (type.startsWith("Transfer Out"))
                    return "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300";
                  if (type.startsWith("Adjustment"))
                    return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
                  if (type === "Credit Note")
                    return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
                  return "bg-muted text-muted-foreground";
                };

                if (!rows.length) {
                  return <EmptyState title="No transactions found for this period." className="m-4 py-12" />;
                }

                const totalQty = rows.reduce((s: number, r) => s + (r.qty || 0), 0);
                const totalValue = rows.reduce((s: number, r) => s + (r.value || 0), 0);
                const avgRate = totalQty > 0 ? totalValue / totalQty : 0;

                return (
                  <table {...mobileCardsSecondary.tableProps} className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 z-10 bg-muted border-b">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Type</th>
                        <th className="text-left px-3 py-2 font-medium">Date</th>
                        <th className="text-left px-3 py-2 font-medium">Reference</th>
                        <th className="text-right px-3 py-2 font-medium">Qty</th>
                        <th className="text-right px-3 py-2 font-medium">Rate</th>
                        <th className="text-right px-3 py-2 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((tx, i: number) => (
                        <tr key={i} className="border-b hover:bg-muted/30 transition-colors">
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${typeBadgeClass(tx.type)}`}
                            >
                              {tx.type}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{tx.date}</td>
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{tx.reference}</td>
                          <td className="text-right px-3 py-2 tabular-nums font-medium">
                            {(tx.qty || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums text-muted-foreground">
                            {(tx.rate || 0).toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums">{formatAmount(tx.value || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="sticky bottom-0 bg-muted border-t-2 font-semibold">
                      <tr>
                        <td colSpan={3} className="px-3 py-2 text-xs text-muted-foreground">
                          {rows.length} transaction{rows.length !== 1 ? "s" : ""} · Avg rate:{" "}
                          {avgRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="text-right px-3 py-2 tabular-nums">
                          {totalQty.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td />
                        <td className="text-right px-3 py-2 tabular-nums">{formatAmount(totalValue)}</td>
                      </tr>
                    </tfoot>
                  </table>
                );
              })()
            )}
          </div>

          <DialogFooter className="shrink-0 pt-2">
            <Button variant="outline" onClick={() => setDetailOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
