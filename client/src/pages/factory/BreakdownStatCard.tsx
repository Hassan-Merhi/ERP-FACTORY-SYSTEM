// Extracted from ./FactoryLocationInventoryProductView.tsx
import { type ReactNode } from "react";
import type { useFactoryLocationInventory } from "./FactoryLocationInventoryModel";

export type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;

type BreakdownStatCardProps = {
  icon: ReactNode;
  label: string;
  total: string;
  regular: string;
  special: string;
  unit: string;
  accent: string;
};

export function BreakdownStatCard({ icon, label, total, regular, special, unit, accent }: BreakdownStatCardProps) {
  return (
    <div
      className="inventory-kpi-card min-w-0 rounded-xl border bg-card/40 shadow-xs"
      data-testid={`stat-${label.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${accent}`}>{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="text-xl font-bold leading-tight tracking-tight tabular-nums">{total}</div>
          <div className="mt-2 grid grid-cols-2 gap-2 border-t pt-2">
            <div className="min-w-0">
              <div className="text-[11px] leading-tight text-muted-foreground">Regular {unit}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{regular}</div>
            </div>
            <div className="min-w-0 border-l pl-2">
              <div className="text-[11px] leading-tight text-muted-foreground">Wipers &amp; Garbage {unit}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{special}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
