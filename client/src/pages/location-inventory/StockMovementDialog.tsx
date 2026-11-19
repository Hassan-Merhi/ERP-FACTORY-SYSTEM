import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Package, ArrowLeft, ArrowRight } from "lucide-react";
import { PeriodFilter } from "@/components/ui/period-filter";
import { useStockMovementDialogState, type StockMovementDialogProps } from "./useStockMovementDialogState";
import { StockMovementDialogContent } from "./StockMovementDialogContent";

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
          <StockMovementDialogContent
            closingNumberCell={closingNumberCell}
            drillMonth={drillMonth}
            fmtA={fmtA}
            fmtN={fmtN}
            formatAmount={formatAmount}
            inNumberCell={inNumberCell}
            isAllTime={isAllTime}
            mobileCards={mobileCards}
            mobileCardsSecondary={mobileCardsSecondary}
            mutedNumberCell={mutedNumberCell}
            outNumberCell={outNumberCell}
            refetchSmDrill={refetchSmDrill}
            refetchStockMovement={refetchStockMovement}
            setDrillMonth={setDrillMonth}
            smDrillData={smDrillData}
            smDrillError={smDrillError}
            smDrillLoading={smDrillLoading}
            smRowsWithYear={smRowsWithYear}
            stockMovementData={stockMovementData}
            stockMovementError={stockMovementError}
            stockMovementItem={stockMovementItem}
            stockMovementLoading={stockMovementLoading}
          />
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
