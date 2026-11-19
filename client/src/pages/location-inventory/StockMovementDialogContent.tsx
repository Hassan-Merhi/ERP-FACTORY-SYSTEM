// Extracted from ./StockMovementDialog.tsx
import { format } from "date-fns";
import { Package } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { cn } from "@/lib/utils";
import { voucherEditPath } from "@/pages/daybook/voucherEditRoute";
import { StockMovementDialogSection, useStockMovementDialogState } from "./useStockMovementDialogState";
import { StockMovementDialogSection2 } from "./StockMovementDialogSection2";

export function StockMovementDialogContent({
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
  outNumberCell,
  refetchSmDrill,
  refetchStockMovement,
  setDrillMonth,
  smDrillData,
  smDrillError,
  smDrillLoading,
  smRowsWithYear,
  stockMovementData,
  stockMovementError,
  stockMovementItem,
  stockMovementLoading,
}: Pick<
  ReturnType<typeof useStockMovementDialogState>,
  | "closingNumberCell"
  | "drillMonth"
  | "fmtA"
  | "fmtN"
  | "formatAmount"
  | "inNumberCell"
  | "isAllTime"
  | "mobileCards"
  | "mobileCardsSecondary"
  | "mutedNumberCell"
  | "outNumberCell"
  | "refetchSmDrill"
  | "refetchStockMovement"
  | "setDrillMonth"
  | "smDrillData"
  | "smDrillError"
  | "smDrillLoading"
  | "smRowsWithYear"
  | "stockMovementData"
  | "stockMovementError"
  | "stockMovementItem"
  | "stockMovementLoading"
>) {
  return (
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
                    return txn.voucherId
                      ? voucherEditPath({
                          id: txn.voucherId,
                          voucherType: vt === "production" ? "Production" : "Consumption",
                        })
                      : null;
                  if (vt.startsWith("pos") || vt.includes("pos"))
                    return txn.voucherId ? `/pos/edit/${txn.voucherId}` : null;
                  if (vt.startsWith("stock transfer"))
                    return txn.voucherId ? voucherEditPath({ id: txn.voucherId, voucherType: "Stock Transfer" }) : null;
                  if (vt === "sales")
                    return txn.voucherId ? voucherEditPath({ id: txn.voucherId, voucherType: "Sales" }) : null;
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
                    <td className={outNumberCell}>{fmtA(txn.posSellingRate ? txn.posSellingRate : txn.outwardRate)}</td>
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
  );
}
