import type { StockTransferFormModel } from "./useStockTransferFormModel";

export function StockTransferTotals({ model }: { model: StockTransferFormModel }) {
  const { transferEntries, isPOS, formatAmount, transferTotal } = model;
  return (
    <div className={isPOS ? "pos-transfer-totals border-t p-4" : "border-t bg-muted/20 p-4"}>
      <div className="flex flex-wrap justify-end items-center gap-2 sm:gap-8 max-w-lg ml-auto">
        <div className="text-xs text-muted-foreground">Total Items:</div>
        <div className={isPOS ? "pos-transfer-total-value text-xs font-mono font-medium" : "text-xs font-mono font-medium"}>
          {transferEntries.filter((entry) => entry.stockItemId > 0).length}
        </div>
        <div className="text-xs text-muted-foreground">Total Qty:</div>
        <div className={isPOS ? "pos-transfer-total-value text-xs font-mono font-medium" : "text-xs font-mono font-medium"}>
          {Math.floor(transferEntries.reduce((sum, entry) => sum + parseFloat(entry.quantity || "0"), 0))}
        </div>
        {!isPOS && (
          <>
            <div className="text-xs font-semibold">Grand Total:</div>
            <div className="text-sm font-bold font-mono" data-testid="text-transfer-total">
              {formatAmount(transferTotal)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
