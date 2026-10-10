/**
 * StatCard — extracted sub-component.
 *
 * Extracted from FactoryLocationInventory.tsx during the Phase 4 god-file split.
 */

import type { StatCardProps } from "../types";

export function StatCard({ icon, label, value, sub, accent }: StatCardProps) {
  return (
    <div className="min-w-0 rounded-xl border bg-card/40 shadow-xs">
      <div className="flex min-h-[82px] items-center gap-3 px-3.5 py-3">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${accent ?? "bg-muted"}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="truncate text-xl font-bold leading-tight tracking-tight">{value}</div>
          {sub && <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">{sub}</div>}
        </div>
      </div>
    </div>
  );
}
