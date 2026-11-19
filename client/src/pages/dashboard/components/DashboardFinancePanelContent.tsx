// Extracted from ./DashboardFinancePanel.tsx
import { cn } from "@/lib/utils";
import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import { useDashboardFinancePanelState } from "./useDashboardFinancePanelState";

export function DashboardFinancePanelContent({
  formatAmount,
  isFactoryMode,
  profitData,
}: Pick<ReturnType<typeof useDashboardFinancePanelState>, "formatAmount" | "isFactoryMode" | "profitData">) {
  return (
    <div className={cn("grid gap-3", isFactoryMode ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2")}>
      {/* What We Have */}
      <div className="rounded-md bg-chart-2/5 border border-chart-2/20 p-4">
        <h4 className="text-sm font-semibold text-chart-2 mb-3 flex items-center gap-2">
          <ArrowDownLeft className="h-3.5 w-3.5" />
          What We Have
        </h4>
        <div className="space-y-1.5 text-sm">
          {(profitData?.forUs?.breakdown ?? []).map((item, idx) => (
            <div key={idx} className="flex justify-between gap-2">
              <span className="text-muted-foreground truncate">{item.name}</span>
              <span className="font-mono shrink-0">{formatAmount(item.value)}</span>
            </div>
          ))}
          <div className="border-t border-chart-2/20 pt-2 mt-2 flex justify-between font-semibold">
            <span>Total Assets</span>
            <span className="font-mono text-chart-2">{formatAmount(profitData?.forUsTotal ?? 0)}</span>
          </div>
        </div>
      </div>

      {/* What We Owe */}
      <div className="rounded-md bg-destructive/5 border border-destructive/20 p-4">
        <h4 className="text-sm font-semibold text-destructive mb-3 flex items-center gap-2">
          <ArrowUpRight className="h-3.5 w-3.5" />
          What We Owe
        </h4>
        <div className="space-y-1.5 text-sm">
          {(profitData?.onUs?.breakdown ?? []).map((item, idx) => (
            <div key={idx} className="flex justify-between gap-2">
              <span className="text-muted-foreground truncate">{item.name}</span>
              <span className="font-mono shrink-0 text-destructive">{formatAmount(item.value)}</span>
            </div>
          ))}
          <div className="border-t border-destructive/20 pt-2 mt-2 flex justify-between font-semibold">
            <span>Total Liabilities</span>
            <span className="font-mono text-destructive">{formatAmount(profitData?.onUsTotal ?? 0)}</span>
          </div>
        </div>
      </div>

      {/* What We Spent — ERP only */}
      {!isFactoryMode && (
        <div className="rounded-md bg-orange-500/5 border border-orange-500/20 p-4">
          <h4 className="text-sm font-semibold text-orange-600 dark:text-orange-400 mb-3 flex items-center gap-2">
            <Wallet className="h-3.5 w-3.5" />
            What We Spent
          </h4>
          <div className="space-y-1.5 text-sm">
            {(profitData?.expenses?.breakdown ?? []).map((item, idx) => (
              <div key={idx} className="flex justify-between gap-2">
                <span className="text-muted-foreground truncate">{item.name}</span>
                <span className="font-mono shrink-0 text-orange-600 dark:text-orange-400">
                  {formatAmount(item.value)}
                </span>
              </div>
            ))}
            <div className="border-t border-orange-500/20 pt-2 mt-2 flex justify-between font-semibold">
              <span>Total Expenses</span>
              <span className="font-mono text-orange-600 dark:text-orange-400">
                {formatAmount(profitData?.expensesTotal ?? 0)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Net Position result */}
      <div
        className={cn(
          "rounded-md p-4 flex flex-col justify-between",
          (profitData?.netPosition ?? 0) >= 0
            ? "bg-chart-2/10 border border-chart-2/30"
            : "bg-destructive/10 border border-destructive/30"
        )}
      >
        <h4 className="text-sm font-semibold mb-3">Net Position</h4>
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Assets</span>
            <span className="font-mono text-chart-2">{formatAmount(profitData?.forUsTotal ?? 0)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">− Liabilities</span>
            <span className="font-mono text-destructive">{formatAmount(profitData?.onUsTotal ?? 0)}</span>
          </div>
          {!isFactoryMode && (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">− Expenses</span>
              <span className="font-mono text-orange-600 dark:text-orange-400">
                {formatAmount(profitData?.expensesTotal ?? 0)}
              </span>
            </div>
          )}
          <div className="border-t pt-3 mt-2 flex justify-between items-baseline">
            <span className="font-semibold">=</span>
            <span
              className={cn(
                "text-2xl font-bold font-mono",
                (profitData?.netPosition ?? 0) >= 0 ? "text-chart-2" : "text-destructive"
              )}
            >
              {formatAmount(profitData?.netPosition ?? 0)}
            </span>
          </div>
        </div>
        {profitData?.netPositionLabel && (
          <p
            className={cn(
              "text-xs font-medium mt-3 text-center py-1 rounded-xs",
              (profitData.netPosition ?? 0) >= 0 ? "bg-chart-2/20 text-chart-2" : "bg-destructive/20 text-destructive"
            )}
          >
            {profitData.netPositionLabel}
          </p>
        )}
      </div>
    </div>
  );
}
