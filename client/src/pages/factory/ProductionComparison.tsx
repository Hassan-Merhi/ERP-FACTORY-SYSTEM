import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Package, Scale, BarChart3, TrendingUp, Coins, Layers3 } from "lucide-react";
import { fmtDateRange, fmtKg, fmtMoney, fmtNum } from "./productioncomparison/utils";
import { BaleComparisonFilters } from "./productioncomparison/components/BaleComparisonFilters";
import { StatCard } from "./productioncomparison/components/StatCard";
import { ComparisonPresetPicker } from "./productioncomparison/components/ComparisonPresetPicker";
import { PeriodOverviewCard } from "./productioncomparison/components/PeriodOverviewCard";
import type { RouteComponentProps } from "wouter";
import { useProductionComparisonModel } from "./productioncomparison/useProductionComparisonModel";
import { BaleComparisonTable } from "./productioncomparison/components/BaleComparisonTable";
import { SupplierMixSection } from "./productioncomparison/components/SupplierMixSection";

/** Routed standalone (receives route props) or embedded as a hub tab panel. */
type EmbeddablePageProps = { embedded?: boolean } & Partial<RouteComponentProps>;
// ── Date helpers ─────────────────────────────────────────────────────────────

/** `embedded`: rendered as the Others hub "Comparison" tab, whose PageHeader already titles the page. */
export default function ProductionComparison({ embedded = false }: EmbeddablePageProps) {
  const m = useProductionComparisonModel();

  return (
    <div className="flex min-w-0 flex-col gap-4 p-3 sm:p-4 lg:p-5" data-testid="production-comparison-dashboard">
      {/* Header + preset buttons */}
      {embedded ? (
        // Others hub "Comparison" tab: the hub PageHeader titles the page; keep the period picker only.
        <div className="flex flex-wrap justify-end">
          <ComparisonPresetPicker preset={m.preset} onChange={m.setPreset} />
        </div>
      ) : (
        <PageHeader
          title="Production Comparison"
          subtitle="Compare output, weight, cost and profit across selected periods"
          icon={<BarChart3 className="h-5 w-5" />}
        >
          <ComparisonPresetPicker preset={m.preset} onChange={m.setPreset} />
        </PageHeader>
      )}

      {/* Custom date pickers */}
      {m.preset === "custom" && (
        <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-semibold">Period A</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                className="rounded-lg border bg-background px-3 py-2 text-sm"
                value={m.customA[0]}
                onChange={(e) => m.setCustomA([e.target.value, m.customA[1]])}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                className="rounded-lg border bg-background px-3 py-2 text-sm"
                value={m.customA[1]}
                onChange={(e) => m.setCustomA([m.customA[0], e.target.value])}
              />
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold">Period B</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                className="rounded-lg border bg-background px-3 py-2 text-sm"
                value={m.customB[0]}
                onChange={(e) => m.setCustomB([e.target.value, m.customB[1]])}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                className="rounded-lg border bg-background px-3 py-2 text-sm"
                value={m.customB[1]}
                onChange={(e) => m.setCustomB([m.customB[0], e.target.value])}
              />
            </div>
          </div>
        </div>
      )}

      {/* Loading skeletons */}
      {m.isLoading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      )}

      {/* Error state */}
      {!m.isLoading && m.fetchError && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Failed to load production data</p>
            <p className="text-xs mt-0.5 opacity-80">{(m.fetchError as Error).message}</p>
          </div>
        </div>
      )}

      {/* Content */}
      {!m.isLoading && !m.fetchError && (
        <>
          {/* Period cards: the bars represent real product quantities, not invented history. */}
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <PeriodOverviewCard
              label={m.labelA}
              range={fmtDateRange(m.rangeA[0], m.rangeA[1])}
              bales={m.totalABales}
              kilograms={m.totalAKg}
              products={m.filtered.map((r) => ({
                articleCode: r.articleCode,
                productName: r.productName,
                categoryName: r.categoryName,
                qty: r.aQty,
                totalWeightKg: r.aKg,
              }))}
              tone="blue"
            />
            <PeriodOverviewCard
              label={m.labelB}
              range={fmtDateRange(m.rangeB[0], m.rangeB[1])}
              bales={m.totalBBales}
              kilograms={m.totalBKg}
              products={m.filtered.map((r) => ({
                articleCode: r.articleCode,
                productName: r.productName,
                categoryName: r.categoryName,
                qty: r.bQty,
                totalWeightKg: r.bKg,
              }))}
              tone="violet"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            <StatCard
              title="Bale Difference"
              value={(m.baleDiff > 0 ? "+" : "") + fmtNum(m.baleDiff)}
              sub={
                m.labelA +
                " vs " +
                m.labelB +
                (m.totalBBales > 0 ? " · " + ((m.baleDiff / m.totalBBales) * 100).toFixed(1) + "%" : "")
              }
              accent={m.baleDiff > 0 ? "green" : m.baleDiff < 0 ? "red" : "neutral"}
              tone="emerald"
              icon={<Package className="h-5 w-5" />}
              valueClass={
                m.baleDiff > 0
                  ? "text-emerald-600 dark:text-emerald-300"
                  : m.baleDiff < 0
                    ? "text-red-600 dark:text-red-300"
                    : ""
              }
            />
            <StatCard
              title="Kilogram Difference"
              value={(m.kgDiff > 0 ? "+" : "") + fmtKg(m.kgDiff) + " kg"}
              sub={
                m.labelA +
                " vs " +
                m.labelB +
                (m.totalBKg > 0 ? " · " + ((m.kgDiff / m.totalBKg) * 100).toFixed(1) + "%" : "")
              }
              accent={m.kgDiff > 0 ? "green" : m.kgDiff < 0 ? "red" : "neutral"}
              tone="blue"
              icon={<Scale className="h-5 w-5" />}
              valueClass={
                m.kgDiff > 0
                  ? "text-emerald-600 dark:text-emerald-300"
                  : m.kgDiff < 0
                    ? "text-red-600 dark:text-red-300"
                    : ""
              }
            />
            {!m.costsHidden && (m.profitA != null || m.profitB != null) && (
              <>
                <StatCard
                  title={m.labelA + " — Production Profit"}
                  value={m.profitA != null ? fmtMoney(m.profitA) : "—"}
                  sub={fmtDateRange(m.rangeA[0], m.rangeA[1])}
                  tone="amber"
                  accent={m.profitA != null ? (m.profitA > 0 ? "green" : m.profitA < 0 ? "red" : "neutral") : "neutral"}
                  valueClass={
                    m.profitA != null
                      ? m.profitA > 0
                        ? "text-emerald-600 dark:text-emerald-300"
                        : m.profitA < 0
                          ? "text-red-600 dark:text-red-300"
                          : ""
                      : ""
                  }
                  icon={<Coins className="h-5 w-5" />}
                />
                <StatCard
                  title={m.labelB + " — Production Profit"}
                  value={m.profitB != null ? fmtMoney(m.profitB) : "—"}
                  sub={fmtDateRange(m.rangeB[0], m.rangeB[1])}
                  tone="violet"
                  accent={m.profitB != null ? (m.profitB > 0 ? "green" : m.profitB < 0 ? "red" : "neutral") : "neutral"}
                  valueClass={
                    m.profitB != null
                      ? m.profitB > 0
                        ? "text-emerald-600 dark:text-emerald-300"
                        : m.profitB < 0
                          ? "text-red-600 dark:text-red-300"
                          : ""
                      : ""
                  }
                  icon={<Coins className="h-5 w-5" />}
                />
                <StatCard
                  title="Profit Difference"
                  value={m.profitDiff != null ? fmtMoney(m.profitDiff) : "—"}
                  sub={
                    m.labelA +
                    " vs " +
                    m.labelB +
                    (m.profitDiff != null && m.profitB != null && m.profitB !== 0
                      ? " · " + ((m.profitDiff / Math.abs(m.profitB)) * 100).toFixed(1) + "%"
                      : "")
                  }
                  tone="teal"
                  accent={
                    m.profitDiff != null
                      ? m.profitDiff > 0
                        ? "green"
                        : m.profitDiff < 0
                          ? "red"
                          : "neutral"
                      : "neutral"
                  }
                  valueClass={
                    m.profitDiff != null
                      ? m.profitDiff > 0
                        ? "text-emerald-600 dark:text-emerald-300"
                        : m.profitDiff < 0
                          ? "text-red-600 dark:text-red-300"
                          : ""
                      : ""
                  }
                  icon={<TrendingUp className="h-5 w-5" />}
                />
              </>
            )}
          </div>
          {/* Existing batch metrics remain available and keep the same filters. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border/60 bg-muted/25 px-4 py-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2 font-semibold text-foreground">
              <Layers3 className="h-4 w-4 text-blue-500" /> Mix batches
            </span>
            <span>
              <strong className="text-foreground">{m.labelA}:</strong> {fmtNum(m.totalABatches)} batches /{" "}
              {fmtKg(m.totalABatchAmount)} kg
            </span>
            <span>
              <strong className="text-foreground">{m.labelB}:</strong> {fmtNum(m.totalBBatches)} batches /{" "}
              {fmtKg(m.totalBBatchAmount)} kg
            </span>
            <span className="sm:ml-auto">Responds to production filters</span>
          </div>

          {/* ── Mix by Supplier ── */}
          <SupplierMixSection m={m} />
          {/* ── Bale filters ── */}
          <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-sm sm:p-4">
            <BaleComparisonFilters
              categories={m.categories}
              grades={m.grades}
              workerOptions={m.workerOptions}
              filterCategories={m.filterCategories}
              setFilterCategories={m.setFilterCategories}
              filterGrades={m.filterGrades}
              setFilterGrades={m.setFilterGrades}
              filterWorkers={m.filterWorkers}
              setFilterWorkers={m.setFilterWorkers}
              filterProduct={m.filterProduct}
              setFilterProduct={m.setFilterProduct}
              shownCount={m.filtered.length}
              totalCount={m.mergedAll.length}
            />
          </div>

          <BaleComparisonTable m={m} />
        </>
      )}
    </div>
  );
}
