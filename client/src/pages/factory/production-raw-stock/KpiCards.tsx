import { ArrowDownCircle, ArrowUpCircle, Package } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";

interface KpiCardsProps {
  totalReceived: number;
  totalReceivedValue: number;
  totalUsed: number;
  totalUsedValue: number;
  totalFree: number;
  totalValue: number;
}

/**
 * Presentation-only KPI cards. Values and their authoritative calculation
 * continue to come from ProductionRawStock; no costing logic lives here.
 */
export function KpiCards({
  totalReceived,
  totalReceivedValue,
  totalUsed,
  totalUsedValue,
  totalFree,
  totalValue,
}: KpiCardsProps) {
  const fmtKg = (n: number) => formatNumber(n, 3);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3 lg:gap-4" data-testid="raw-production-kpis">
      <div className="relative isolate min-w-0 overflow-hidden rounded-2xl border border-blue-200/80 bg-linear-to-br from-blue-50 via-card to-slate-50 p-4 shadow-sm transition-shadow hover:shadow-md dark:border-blue-400/20 dark:from-[hsl(var(--factory-hue)_40%_14%)] dark:via-[hsl(var(--factory-hue)_28%_12%)] dark:to-[hsl(var(--factory-hue)_49%_19%)] sm:p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-16 -right-14 -z-10 h-40 w-56 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-400/15"
        />
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-blue-300/60 bg-blue-500/10 shadow-sm dark:border-blue-400/20 dark:bg-blue-400/15">
            <ArrowDownCircle className="h-5 w-5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-600 dark:text-slate-300">
              Total Received
            </p>
            <p
              className="font-mono text-xl font-bold leading-tight tracking-tight tabular-nums text-foreground lg:text-2xl"
              data-testid="text-total-received"
            >
              {fmtKg(totalReceived)} <span className="text-xs font-semibold text-muted-foreground">kg</span>
            </p>
            <p
              className="mt-2 font-mono text-xs font-medium tabular-nums text-muted-foreground"
              data-testid="text-total-received-value"
            >
              ${formatNumber(totalReceivedValue)}
            </p>
          </div>
        </div>
      </div>

      <div className="relative isolate min-w-0 overflow-hidden rounded-2xl border border-amber-200/80 bg-linear-to-br from-amber-50 via-card to-orange-50/60 p-4 shadow-sm transition-shadow hover:shadow-md dark:border-amber-400/20 dark:from-[#29251e] dark:via-[#211f1c] dark:to-[#382715] sm:p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-16 -right-14 -z-10 h-40 w-56 rounded-full bg-amber-400/10 blur-3xl dark:bg-amber-400/15"
        />
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-300/60 bg-amber-500/10 shadow-sm dark:border-amber-400/20 dark:bg-amber-400/15">
            <ArrowUpCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-600 dark:text-slate-300">
              Total Used
            </p>
            <p
              className="font-mono text-xl font-bold leading-tight tracking-tight tabular-nums text-foreground lg:text-2xl"
              data-testid="text-total-used"
            >
              {fmtKg(totalUsed)} <span className="text-xs font-semibold text-muted-foreground">kg</span>
            </p>
            <p
              className="mt-2 font-mono text-xs font-medium tabular-nums text-muted-foreground"
              data-testid="text-total-used-value"
            >
              ${formatNumber(totalUsedValue)}
            </p>
          </div>
        </div>
      </div>

      <div className="relative isolate min-w-0 overflow-hidden rounded-2xl border border-emerald-200/80 bg-linear-to-br from-emerald-50 via-card to-teal-50 p-4 shadow-sm transition-shadow hover:shadow-md dark:border-emerald-400/25 dark:from-[#102b25] dark:via-[#15231f] dark:to-[#074532] sm:p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-16 -right-14 -z-10 h-40 w-56 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-400/20"
        />
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-300/60 bg-emerald-500/10 shadow-sm dark:border-emerald-400/20 dark:bg-emerald-400/15">
            <Package className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-600 dark:text-slate-300">
              Free Available
            </p>
            <p
              className="font-mono text-xl font-bold leading-tight tracking-tight tabular-nums text-emerald-700 dark:text-emerald-400 lg:text-2xl"
              data-testid="text-total-free"
            >
              {fmtKg(totalFree)}{" "}
              <span className="text-xs font-semibold text-emerald-600/80 dark:text-emerald-400/80">kg</span>
            </p>
            <p className="mt-2 text-xs font-medium text-muted-foreground" data-testid="text-total-value">
              Stock Value:{" "}
              <span className="font-mono font-bold tabular-nums text-foreground">${formatNumber(totalValue)}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
