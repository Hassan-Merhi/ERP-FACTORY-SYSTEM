// Extracted from ./FactoryStockQueryWorkspaceSection.tsx
import { ChartNoAxesColumnIncreasing } from "lucide-react";
import { fmt, useFactoryStockQueryWorkspaceState } from "./useFactoryStockQueryWorkspaceState";

export function FactoryStockQueryWorkspaceSection2({
  maxTrend,
  trend,
}: Pick<ReturnType<typeof useFactoryStockQueryWorkspaceState>, "maxTrend" | "trend">) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <ChartNoAxesColumnIncreasing className="h-4 w-4" /> Recent sales quantity by date
      </h3>
      <div className="flex h-44 items-end gap-1 overflow-x-auto rounded-xl border px-3 pb-2 pt-4">
        {!trend.length ? (
          <p className="m-auto text-sm text-muted-foreground">No finalized sales in selected period</p>
        ) : (
          trend.map(([day, qty]) => (
            <div
              key={day}
              className="flex min-w-9 flex-1 flex-col items-center justify-end gap-1"
              title={`${day}: ${qty} bales`}
            >
              <span className="text-[10px] text-muted-foreground">{fmt(qty)}</span>
              <div
                className="w-full max-w-14 rounded-t bg-primary"
                style={{ height: `${Math.max(4, Math.round((qty / maxTrend) * 112))}px` }}
              />
              <span className="text-[10px] text-muted-foreground">{day.slice(5)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
