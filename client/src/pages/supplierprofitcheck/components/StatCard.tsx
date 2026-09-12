/**
 * StatCard — extracted sub-component.
 *
 * Extracted from SupplierProfitCheck.tsx during the Phase 4 god-file split.
 */

import type { LucideIcon } from "lucide-react";

export // ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({
  icon: Icon,
  iconBg,
  label,
  value,
  sub,
  valueColor,
}: {
  icon: LucideIcon;
  iconBg: string;
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 flex items-center gap-3">
      <div className={`p-2.5 rounded-lg shrink-0 ${iconBg}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className={`text-xl font-bold leading-tight tabular-nums ${valueColor ?? ""}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
