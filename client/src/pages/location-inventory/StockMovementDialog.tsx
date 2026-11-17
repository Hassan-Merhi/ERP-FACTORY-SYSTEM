import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Package, ArrowLeft, ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { cn } from "@/lib/utils";
import { PeriodFilter } from "@/components/ui/period-filter";
import {
  StockMovementDialogSection,
  useStockMovementDialogState,
  type StockMovementDialogProps,
} from "./useStockMovementDialogState";
import { StockMovementDialogSection2 } from "./StockMovementDialogSection2";

export function StockMovementDialog(props: StockMovementDialogProps) {
  const {
    stockMovementError,
    smDrillError,
    refetchStockMovement,
    refetchSmDrill,
    closingNumberCell,
    drillMonth,
    fmtA,
    fmtN,
    formatAmount,
    inNumberCell,
    isAllTime,
    mobileCards,
    mobileCardsSecondary,
    mutedNumberCell,
    navigate,
    outNumberCell,
    setDrillMonth,
    setStockMovementItem,
    setStockMovementOpen,
    setStockMovementPeriod,
    smDrillData,
    smDrillLoading,
    smRowsWithYear,
    stockMovementData,
    stockMovementItem,
    stockMovementLoading,
    stockMovementOpen,
    stockMovementPeriod,
  } = useStockMovementDialogState(props);

  return (
    <Dialog open={stockMovementOpen} onOpenChange={setStockMovementOpen}>
      <DialogContent
        className="flex h-[88vh] w-[96vw] max-w-[1440px] flex-col gap-0 overflow-hidden rounded-2xl border border-border/60 bg-card p-0 shadow-2xl sm:max-w-[1440px] sm:p-0"
        onEscapeKeyDown={(event) => {
          if (drillMonth) {
            event.preventDefault();
            setDrillMonth(null);
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border/60 bg-linear-to-b from-muted/30 to-card px-5 py-5 pr-14 md:px-7 md:py-6 md:pr-16">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/15">
                <Package className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-xl font-semibold tracking-tight md:text-[22px]">
                    Stock Movement
                  </DialogTitle>
                  {drillMonth && (
                    <span className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-xs">
                      {drillMonth.monthName} {drillMonth.year}
                    </span>
                  )}
                </div>
                <DialogDescription className="mt-1 truncate text-[13px]">
                  <span className="font-medium text-foreground/80">{stockMovementItem?.stockItemName}</span>
                  <span className="mx-1.5 text-muted-foreground/50">•</span>
                  {stockMovementItem?.locationName || "All Locations"}
                </DialogDescription>
              </div>
            </div>

            {!drillMonth && (
              <div className="flex flex-col items-start gap-1.5 sm:items-end">
                <PeriodFilter value={stockMovementPeriod} onChange={setStockMovementPeriod} />
                {isAllTime && (
                  <span className="pr-1 text-[11px] text-muted-foreground">Only months with movement are shown</span>
                )}
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden bg-muted/10 p-3 md:p-5">
          <div className="h-full overflow-auto rounded-xl border border-border/60 bg-background shadow-xs scrollbar-thin">
            {drillMonth ? (
              smDrillLoading ? (
                <div className="space-y-3 p-6">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                    <Skeleton key={i} className="h-11 w-full rounded-lg" />
                  ))}
                </div>
              ) : smDrillError && !smDrillData ? (
                <ErrorState
                  onAction={() => void refetchSmDrill()}
                  actionLabel="Try again"
                  className="rounded-none border-0 p-6"
                />
              ) : (
                <table
                  {...mobileCards.tableProps}
                  className="w-full border-separate border-spacing-0 text-sm"
                  style={{ minWidth: 1240 }}
                >
                  <StockMovementDialogSection />
                  <tbody>
                    {(!smDrillData?.transactions || smDrillData.transactions.length === 0) && (
                      <tr>
                        <td colSpan={12} className="px-6 py-20 text-center">
                          <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                              <Package className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <p className="font-medium text-foreground">No transactions found</p>
                            <p className="text-xs text-muted-foreground">
                              There are no movements for {drillMonth.monthName} {drillMonth.year}.
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}

                    {smDrillData?.transactions?.map((txn, idx: number) => {
                      const editUrl = (() => {
                        if (txn.isOpeningBalance) return null;
                        const vt = (txn.vchType || "").toLowerCase();
                        if (vt === "purchase import") return txn.poId ? `/purchase-orders/${txn.poId}/edit` : null;
                        if (vt === "production" || vt === "consumption")
                          return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
                        if (vt.startsWith("pos") || vt.includes("pos"))
                          return txn.voucherId ? `/pos/edit/${txn.voucherId}` : null;
                        if (vt.startsWith("stock transfer"))
                          return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
                        if (vt === "sales") return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
                        return null;
                      })();

                      const dispDate = (() => {
                        if (txn.isOpeningBalance) return "";
                        try {
                          return format(new Date(txn.date), "dd MMM");
                        } catch {
                          return txn.date || "";
                        }
                      })();

                      return (
                        <tr
                          key={idx}
                          data-testid={`row-drill-txn-${idx}`}
                          className={cn(
                            "group border-b border-border/40 transition-colors hover:bg-muted/30",
                            txn.isOpeningBalance ? "bg-muted/25 font-medium" : "bg-background"
                          )}
                        >
                          <td className="border-r border-border/40 px-4 py-3.5 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                            {dispDate}
                          </td>
                          <td className="border-r border-border/40 px-4 py-3.5">
                            {editUrl ? (
                              <button
                                onClick={() => {
                                  window.open(editUrl, "_blank", "noopener,noreferrer");
                                }}
                                className="max-w-[260px] truncate text-left font-medium text-foreground transition-colors hover:text-primary hover:underline"
                                data-testid={`link-drill-particulars-${idx}`}
                              >
                                {txn.particulars}
                              </button>
                            ) : (
                              <div className="max-w-[260px]">
                                <span className="block truncate font-medium text-foreground">{txn.particulars}</span>
                                {txn.isOpeningBalance && (
                                  <span
                                    className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground"
                                    data-testid={`text-opening-balance-location-${idx}`}
                                  >
                                    {stockMovementItem?.locationName || "All Locations"}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="border-r border-border/40 px-4 py-3.5 text-xs text-muted-foreground whitespace-nowrap">
                            {txn.vchType}
                          </td>
                          <td className={inNumberCell}>{fmtN(txn.inwardQty, 0)}</td>
                          <td className={inNumberCell}>{fmtA(txn.inwardRate)}</td>
                          <td className={cn(inNumberCell, "border-r border-border/40")}>{fmtA(txn.inwardValue)}</td>
                          <td className={outNumberCell}>{fmtN(txn.outwardQty, 0)}</td>
                          <td className={outNumberCell}>
                            {fmtA(txn.posSellingRate ? txn.posSellingRate : txn.outwardRate)}
                          </td>
                          <td className={cn(outNumberCell, "border-r border-border/40")}>
                            {fmtA(txn.posSellingValue ? txn.posSellingValue : txn.outwardValue)}
                          </td>
                          <td className={closingNumberCell}>{fmtN(txn.closingQty, 0)}</td>
                          <td className={closingNumberCell}>{fmtA(txn.closingRate)}</td>
                          <td className={closingNumberCell}>{fmtA(txn.closingValue)}</td>
                        </tr>
                      );
                    })}

                    {smDrillData?.totals &&
                      smDrillData.transactions?.length > 0 &&
                      (() => {
                        const t = smDrillData.totals;
                        const lastTxn = smDrillData.transactions[smDrillData.transactions.length - 1];
                        return (
                          <tr className="sticky bottom-0 z-10 bg-card/95 font-semibold shadow-[0_-1px_0_0_hsl(var(--border))] backdrop-blur-sm">
                            <td colSpan={3} className="border-r border-border/50 px-4 py-3.5 text-sm">
                              Total
                            </td>
                            <td className={inNumberCell}>{fmtN(t.inwardQty, 0)}</td>
                            <td className={inNumberCell}>{fmtA(t.inwardRate)}</td>
                            <td className={cn(inNumberCell, "border-r border-border/50")}>{fmtA(t.inwardValue)}</td>
                            <td className={outNumberCell}>{fmtN(t.outwardQty, 0)}</td>
                            <td className={outNumberCell}>{fmtA(t.outwardRate)}</td>
                            <td className={cn(outNumberCell, "border-r border-border/50")}>{fmtA(t.outwardValue)}</td>
                            <td className={closingNumberCell}>{fmtN(lastTxn.closingQty, 0)}</td>
                            <td className={closingNumberCell}>{fmtA(lastTxn.closingRate)}</td>
                            <td className={closingNumberCell}>{fmtA(lastTxn.closingValue)}</td>
                          </tr>
                        );
                      })()}
                  </tbody>
                </table>
              )
            ) : stockMovementLoading ? (
              <div className="space-y-3 p-6">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : stockMovementError && !stockMovementData ? (
              <ErrorState
                onAction={() => void refetchStockMovement()}
                actionLabel="Try again"
                className="rounded-none border-0 p-6"
              />
            ) : (
              <StockMovementDialogSection2
                closingNumberCell={closingNumberCell}
                fmtA={fmtA}
                fmtN={fmtN}
                formatAmount={formatAmount}
                inNumberCell={inNumberCell}
                isAllTime={isAllTime}
                mobileCardsSecondary={mobileCardsSecondary}
                mutedNumberCell={mutedNumberCell}
                outNumberCell={outNumberCell}
                setDrillMonth={setDrillMonth}
                smRowsWithYear={smRowsWithYear}
                stockMovementData={stockMovementData}
              />
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-border/60 bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between md:px-7">
          <div className="min-h-4">
            {drillMonth && (
              <span className="text-xs text-muted-foreground">Press Esc to return to monthly summary</span>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            {drillMonth ? (
              <Button
                variant="outline"
                className="rounded-lg"
                onClick={() => setDrillMonth(null)}
                data-testid="button-sm-back-to-months"
              >
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Back to months
              </Button>
            ) : (
              <Button
                variant="outline"
                className="rounded-lg"
                onClick={() => setStockMovementOpen(false)}
                data-testid="button-sm-close"
              >
                Close
              </Button>
            )}

            {stockMovementItem && (
              <Button
                className="rounded-lg shadow-xs"
                onClick={() => {
                  const locId = stockMovementItem.locationId;
                  const sid = stockMovementItem.stockItemId;
                  if (drillMonth) {
                    if (locId) {
                      navigate(
                        `/locations/${locId}/stock-items/${sid}/vouchers/${drillMonth.year}/${drillMonth.month}`
                      );
                    }
                  } else if (locId) {
                    navigate(`/locations/${locId}/stock-items/${sid}/history`);
                  } else {
                    navigate(`/stock-items/${sid}/monthly-summary`);
                  }
                  setDrillMonth(null);
                  setStockMovementOpen(false);
                  setStockMovementItem(null);
                }}
                data-testid="button-sm-open-full"
              >
                <ArrowRight className="mr-1.5 h-4 w-4" />
                {drillMonth ? "Open in full view" : "Open full history"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
