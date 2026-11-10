import { Package, PackageCheck, PackageX, PieChart, Truck } from "lucide-react";

interface CustomerLoadingSummary {
  totalProducts: number;
  loadedProducts: number;
  neverLoadedProducts: number;
  productCoveragePct: number;
  totalBalesLoaded: number;
  totalKgLoaded: number;
}

interface CustomerLoadingSummaryCardsProps {
  summary?: CustomerLoadingSummary;
  formatNumber: (value: number, maximumFractionDigits?: number) => string;
}

const cardBase =
  "relative min-w-0 overflow-hidden rounded-2xl border px-5 py-5 shadow-sm transition-shadow hover:shadow-md";

export function CustomerLoadingSummaryCards({ summary, formatNumber }: CustomerLoadingSummaryCardsProps) {
  const coverage = Math.max(0, Math.min(100, summary?.productCoveragePct ?? 0));

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="customer-loading-summary">
      <div
        className={`${cardBase} border-blue-200 bg-gradient-to-br from-blue-50 via-white to-blue-100/80 dark:border-blue-500/50 dark:from-[hsl(var(--factory-hue)_61%_24%)] dark:via-[hsl(var(--factory-hue)_60%_20%)] dark:to-[hsl(var(--factory-hue)_61%_15%)]`}
      >
        <div className="absolute -bottom-6 -right-4 opacity-[0.09] dark:opacity-20" aria-hidden="true">
          <Package className="h-28 w-28 text-blue-600 dark:text-blue-300" />
        </div>
        <div className="relative flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-blue-900 dark:text-blue-100">Total Products</span>
          <div className="rounded-xl bg-blue-100 p-2.5 text-blue-700 dark:bg-blue-400/20 dark:text-blue-200">
            <Package className="h-5 w-5" />
          </div>
        </div>
        <div className="relative mt-3 text-3xl font-bold tracking-tight tabular-nums text-slate-950 dark:text-white">
          {formatNumber(summary?.totalProducts ?? 0)}
        </div>
        <div className="relative mt-1 text-xs text-blue-800/75 dark:text-blue-100/70">Products in catalog</div>
      </div>

      <div
        className={`${cardBase} border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-100/80 dark:border-emerald-500/50 dark:from-[#104b39] dark:via-[#103c31] dark:to-[#0d2926]`}
      >
        <div className="absolute -bottom-6 -right-4 opacity-[0.09] dark:opacity-20" aria-hidden="true">
          <PackageCheck className="h-28 w-28 text-emerald-600 dark:text-emerald-300" />
        </div>
        <div className="relative flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-emerald-900 dark:text-emerald-100">Loaded Products</span>
          <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-200">
            <PackageCheck className="h-5 w-5" />
          </div>
        </div>
        <div className="relative mt-3 text-3xl font-bold tracking-tight tabular-nums text-slate-950 dark:text-white">
          {formatNumber(summary?.loadedProducts ?? 0)}
        </div>
        <div className="relative mt-1 text-xs text-emerald-800/75 dark:text-emerald-100/70">Previously loaded</div>
      </div>

      <div
        className={`${cardBase} border-amber-200 bg-gradient-to-br from-amber-50 via-white to-orange-100/80 dark:border-amber-500/50 dark:from-[#60401f] dark:via-[#49311f] dark:to-[#30241e]`}
      >
        <div className="absolute -bottom-6 -right-4 opacity-[0.09] dark:opacity-20" aria-hidden="true">
          <PackageX className="h-28 w-28 text-amber-600 dark:text-amber-300" />
        </div>
        <div className="relative flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-amber-950 dark:text-amber-100">Never Loaded</span>
          <div className="rounded-xl bg-amber-100 p-2.5 text-amber-700 dark:bg-amber-400/20 dark:text-amber-200">
            <PackageX className="h-5 w-5" />
          </div>
        </div>
        <div className="relative mt-3 text-3xl font-bold tracking-tight tabular-nums text-slate-950 dark:text-white">
          {formatNumber(summary?.neverLoadedProducts ?? 0)}
        </div>
        <div className="relative mt-1 text-xs text-amber-900/70 dark:text-amber-100/70">Not yet loaded</div>
      </div>

      <div
        className={`${cardBase} border-violet-200 bg-gradient-to-br from-violet-50 via-white to-fuchsia-100/80 dark:border-violet-500/50 dark:from-[hsl(var(--factory-hue)_45%_30%)] dark:via-[hsl(var(--factory-hue)_39%_23%)] dark:to-[hsl(var(--factory-hue)_38%_18%)]`}
      >
        <div className="relative flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-violet-950 dark:text-violet-100">Product Coverage</span>
          <div className="rounded-xl bg-violet-100 p-2.5 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200">
            <PieChart className="h-5 w-5" />
          </div>
        </div>
        <div className="mt-3 text-3xl font-bold tracking-tight tabular-nums text-slate-950 dark:text-white">
          {formatNumber(summary?.productCoveragePct ?? 0, 1)}%
        </div>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-violet-200/80 dark:bg-violet-100/20"
          role="progressbar"
          aria-label="Product coverage"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={coverage}
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500"
            style={{ width: `${coverage}%` }}
          />
        </div>
      </div>

      <div
        className={`${cardBase} border-cyan-200 bg-gradient-to-br from-cyan-50 via-white to-sky-100/80 dark:border-cyan-500/50 dark:from-[hsl(var(--factory-hue)_68%_22%)] dark:via-[hsl(var(--factory-hue)_64%_17%)] dark:to-[hsl(var(--factory-hue)_56%_14%)]`}
      >
        <div className="absolute -bottom-6 -right-4 opacity-[0.09] dark:opacity-20" aria-hidden="true">
          <Truck className="h-28 w-28 text-cyan-600 dark:text-cyan-300" />
        </div>
        <div className="relative flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-cyan-950 dark:text-cyan-100">Total Bales Loaded</span>
          <div className="rounded-xl bg-cyan-100 p-2.5 text-cyan-700 dark:bg-cyan-400/20 dark:text-cyan-200">
            <Truck className="h-5 w-5" />
          </div>
        </div>
        <div className="relative mt-3 text-3xl font-bold tracking-tight tabular-nums text-slate-950 dark:text-white">
          {formatNumber(summary?.totalBalesLoaded ?? 0)}
        </div>
        <div className="relative mt-1 text-xs font-medium tabular-nums text-cyan-900/75 dark:text-cyan-100/80">
          {formatNumber(summary?.totalKgLoaded ?? 0, 1)} kg
        </div>
      </div>
    </div>
  );
}
