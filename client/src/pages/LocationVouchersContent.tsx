// Extracted from ./LocationVouchers.tsx
import { ArrowDownToLine, ArrowUpFromLine, Layers } from "lucide-react";
import { useLocationVouchersState } from "./useLocationVouchersState";

export function LocationVouchersContent({
  calculatedTotals,
  formatAmount,
  posUser,
}: Pick<ReturnType<typeof useLocationVouchersState>, "calculatedTotals" | "formatAmount" | "posUser">) {
  return (
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
          <div className="text-xs font-mono text-muted-foreground">{formatAmount(calculatedTotals.inwardValue)}</div>
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
          <div className="text-xs font-mono text-muted-foreground">{formatAmount(calculatedTotals.outwardValue)}</div>
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
          <div className="text-xs font-mono text-muted-foreground">{formatAmount(calculatedTotals.closingValue)}</div>
        )}
      </div>
    </div>
  );
}
