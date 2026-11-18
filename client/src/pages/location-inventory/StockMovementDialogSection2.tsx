// Extracted from ./StockMovementDialog.tsx to keep that module under the source-size cap.
import { ChevronRight, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStockMovementDialogState } from "./useStockMovementDialogState";

export function StockMovementDialogSection2({
  closingNumberCell,
  fmtA,
  fmtN,
  formatAmount,
  inNumberCell,
  isAllTime,
  mobileCardsSecondary,
  mutedNumberCell,
  outNumberCell,
  setDrillMonth,
  smRowsWithYear,
  stockMovementData,
}: Pick<
  ReturnType<typeof useStockMovementDialogState>,
  | "closingNumberCell"
  | "fmtA"
  | "fmtN"
  | "formatAmount"
  | "inNumberCell"
  | "isAllTime"
  | "mobileCardsSecondary"
  | "mutedNumberCell"
  | "outNumberCell"
  | "setDrillMonth"
  | "smRowsWithYear"
  | "stockMovementData"
>) {
  return (
    <table
      {...mobileCardsSecondary.tableProps}
      className="w-full border-separate border-spacing-0 text-sm"
      style={{ minWidth: 1180 }}
    >
      <thead className="sticky top-0 z-20 shadow-[0_1px_0_0_hsl(var(--border))]">
        <tr className="bg-muted/95 backdrop-blur-sm">
          <th
            rowSpan={2}
            className="w-36 border-r border-border/50 px-5 py-3 text-left align-bottom text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            Month
          </th>
          <th
            colSpan={3}
            className="border-r border-border/50 bg-muted/35 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            Opening
          </th>
          <th
            colSpan={3}
            className="border-r border-border/50 bg-emerald-500/6 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-600 dark:text-emerald-400"
          >
            Stock In
          </th>
          <th
            colSpan={3}
            className="border-r border-border/50 bg-rose-500/6 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-rose-600 dark:text-rose-400"
          >
            Stock Out
          </th>
          <th
            colSpan={3}
            className="bg-blue-500/6 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 dark:text-blue-400"
          >
            Closing
          </th>
        </tr>
        <tr className="bg-muted/95 text-[11px] backdrop-blur-sm">
          {["Qty", "Rate", "Value", "Qty", "Rate", "Value", "Qty", "Rate", "Value", "Qty", "Rate", "Value"].map(
            (h, i) => (
              <th
                key={`${h}-${i}`}
                className={cn(
                  "min-w-[86px] whitespace-nowrap px-4 py-2.5 text-right font-medium",
                  i < 3
                    ? "bg-muted/20 text-muted-foreground"
                    : i < 6
                      ? "bg-emerald-500/[0.035] text-emerald-600 dark:text-emerald-400"
                      : i < 9
                        ? "bg-rose-500/[0.035] text-rose-600 dark:text-rose-400"
                        : "bg-blue-500/[0.035] text-blue-600 dark:text-blue-400",
                  i === 2 || i === 5 || i === 8 ? "border-r border-border/50" : ""
                )}
              >
                {h}
              </th>
            )
          )}
        </tr>
      </thead>
      <tbody>
        {smRowsWithYear.length === 0 && (
          <tr>
            <td colSpan={13} className="px-6 py-20 text-center">
              <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <Package className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="font-medium text-foreground">No stock movement for this period</p>
                <p className="text-xs text-muted-foreground">
                  {isAllTime
                    ? "Months with no stock activity are hidden from All Time view."
                    : "Try another period to see movement history."}
                </p>
              </div>
            </td>
          </tr>
        )}

        {smRowsWithYear.map((m) => {
          const fmtQ = (value: unknown) => fmtN(value, 0);
          const fmtR = (value: unknown) => fmtN(value, 2);
          const fmtV = (value: unknown) => fmtA(value);

          return (
            <tr
              key={`${m.year}-${m.month}`}
              data-testid={`row-sm-month-${m.month}`}
              className="group cursor-pointer bg-background transition-colors hover:bg-muted/30"
              onClick={() => setDrillMonth({ year: m.year, month: m.month, monthName: m.monthName })}
            >
              <td className="border-r border-t border-border/40 px-5 py-4 font-semibold whitespace-nowrap">
                <span className="flex items-center justify-between gap-3">
                  <span>{m.monthName}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground/70" />
                </span>
              </td>
              <td className={cn(mutedNumberCell, "border-t border-border/40")}>{fmtQ(m.openingQty)}</td>
              <td className={cn(mutedNumberCell, "border-t border-border/40")}>{fmtR(m.openingRate)}</td>
              <td className={cn(mutedNumberCell, "border-r border-t border-border/40")}>{fmtV(m.openingValue)}</td>
              <td className={cn(inNumberCell, "border-t border-border/40")}>{fmtQ(m.inwardQty)}</td>
              <td className={cn(inNumberCell, "border-t border-border/40")}>{fmtR(m.inwardRate)}</td>
              <td className={cn(inNumberCell, "border-r border-t border-border/40")}>{fmtV(m.inwardValue)}</td>
              <td className={cn(outNumberCell, "border-t border-border/40")}>{fmtQ(m.outwardQty)}</td>
              <td className={cn(outNumberCell, "border-t border-border/40")}>{fmtR(m.outwardRate)}</td>
              <td className={cn(outNumberCell, "border-r border-t border-border/40")}>{fmtV(m.outwardValue)}</td>
              <td className={cn(closingNumberCell, "border-t border-border/40")}>{fmtQ(m.closingQty)}</td>
              <td className={cn(closingNumberCell, "border-t border-border/40")}>{fmtR(m.closingRate)}</td>
              <td className={cn(closingNumberCell, "border-t border-border/40")}>{fmtV(m.closingValue)}</td>
            </tr>
          );
        })}

        {smRowsWithYear.length > 0 &&
          stockMovementData?.grandTotal &&
          (() => {
            const gt = stockMovementData.grandTotal;
            const inRate = gt.inwardQty > 0 ? gt.inwardValue / gt.inwardQty : 0;
            const outRate = gt.outwardQty > 0 ? gt.outwardValue / gt.outwardQty : 0;
            const clsRate = gt.closingQty > 0 ? gt.closingValue / gt.closingQty : 0;
            const fmtQ = (n: number) =>
              n === 0 ? (
                <span className="text-muted-foreground/35">—</span>
              ) : (
                <>{n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</>
              );
            const fmtR = (n: number) =>
              n === 0 ? (
                <span className="text-muted-foreground/35">—</span>
              ) : (
                <>{n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
              );
            const fmtV = (n: number) =>
              n === 0 ? <span className="text-muted-foreground/35">—</span> : <>{formatAmount(n)}</>;

            return (
              <tr className="sticky bottom-0 z-10 bg-card/95 font-semibold shadow-[0_-1px_0_0_hsl(var(--border))] backdrop-blur-sm">
                <td className="border-r border-border/50 px-5 py-4 text-sm">Total</td>
                <td className={mutedNumberCell}>{fmtQ(smRowsWithYear[0]?.openingQty ?? 0)}</td>
                <td className={mutedNumberCell}>{fmtR(smRowsWithYear[0]?.openingRate ?? 0)}</td>
                <td className={cn(mutedNumberCell, "border-r border-border/50")}>
                  {fmtV(smRowsWithYear[0]?.openingValue ?? 0)}
                </td>
                <td className={inNumberCell}>{fmtQ(gt.inwardQty)}</td>
                <td className={inNumberCell}>{fmtR(inRate)}</td>
                <td className={cn(inNumberCell, "border-r border-border/50")}>{fmtV(gt.inwardValue)}</td>
                <td className={outNumberCell}>{fmtQ(gt.outwardQty)}</td>
                <td className={outNumberCell}>{fmtR(outRate)}</td>
                <td className={cn(outNumberCell, "border-r border-border/50")}>{fmtV(gt.outwardValue)}</td>
                <td className={closingNumberCell}>{fmtQ(gt.closingQty)}</td>
                <td className={closingNumberCell}>{fmtR(clsRate)}</td>
                <td className={closingNumberCell}>{fmtV(gt.closingValue)}</td>
              </tr>
            );
          })()}
      </tbody>
    </table>
  );
}
