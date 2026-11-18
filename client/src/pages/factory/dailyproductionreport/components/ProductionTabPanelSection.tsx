// Extracted from ./ProductionTabPanel.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FactoryMixBatch } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Filter, FlaskConical, Minus, PackageCheck, Scale, Trash2, TrendingDown, TrendingUp } from "lucide-react";
import type { AuthMe } from "@shared/apiTypes";
import { fmtKg, fmtMoney, fmtRate } from "../utils";
import { StatRow } from "./StatRow";
import { SkeletonBox } from "./SkeletonBox";
import type { DailyProductionReportState } from "../useDailyProductionReport";

export function useProductionTabPanelState({ report }: { report: DailyProductionReportState }) {
  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    stepDates,
    data,
    isLoading,
    presets,
    valuationMode,
    setValuationMode,
  } = report;
  const [selectedMixBatchId, setSelectedMixBatchId] = useState<number | null>(null);
  const { data: selectedMixBatch, isError: selectedMixBatchError } = useQuery<FactoryMixBatch>({
    queryKey: ["/api/factory/mix-batches", selectedMixBatchId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/mix-batches/${selectedMixBatchId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Unable to load mix batch details");
      return res.json();
    },
    enabled: selectedMixBatchId !== null,
    staleTime: 30_000,
  });
  const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const effectiveRole = currentUser?.currentRole ?? currentUser?.role ?? "";
  const isOwner = effectiveRole === "Owner";
  const costsHidden = Boolean(data?.costsHidden);
  const showMoneySummary = !costsHidden && (!isOwner || valuationMode === "cost");
  // Profit is calculated once on the backend from the period-scoped remaining
  // material value. Do not rebuild it from the Balance on Table card here.
  const productionProfitValue = data?.summary.profitValue ?? 0;
  const productionProfitMarginPct = data?.summary.profitMarginPct ?? 0;
  return {
    costsHidden,
    customFrom,
    customTo,
    data,
    isLoading,
    isOwner,
    preset,
    presets,
    productionProfitMarginPct,
    productionProfitValue,
    report,
    selectedMixBatch,
    selectedMixBatchError,
    selectedMixBatchId,
    setCustomFrom,
    setCustomTo,
    setPreset,
    setSelectedMixBatchId,
    setValuationMode,
    showMoneySummary,
    stepDates,
    valuationMode,
  };
}

export function ProductionTabPanelSection({
  costsHidden,
  data,
  isLoading,
  isOwner,
  valuationMode,
}: Pick<
  ReturnType<typeof useProductionTabPanelState>,
  "costsHidden" | "data" | "isLoading" | "isOwner" | "valuationMode"
>) {
  return (
    <div className="production-premium-kpis grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {/* 1 — Original Batches */}
      <Card
        className="border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/20"
        data-testid="card-original-batches"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
          <CardTitle className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
            <FlaskConical className="h-3.5 w-3.5" />
            Original Batches
          </CardTitle>
          {!isLoading && data && (
            <Badge
              variant="secondary"
              className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 no-default-active-elevate"
            >
              {data.rawMaterial.totalBatches} {data.rawMaterial.totalBatches === 1 ? "batch" : "batches"}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="pt-0 space-y-0.5">
          {isLoading ? (
            <SkeletonBox />
          ) : (
            <>
              <StatRow label="Weight" value={fmtKg(data?.rawMaterial.totalWeightKg ?? 0)} />
              {!costsHidden && (
                <>
                  <StatRow label="Batch Rate" value={fmtRate(data?.rawMaterial.blendedCostPerKg ?? 0)} sub="per kg" />
                  <StatRow label="Value" value={fmtMoney(data?.rawMaterial.totalCost ?? 0)} />
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 2 — Bales Produced */}
      <Card
        className="border-blue-200 dark:border-blue-800/50 bg-blue-50/60 dark:bg-blue-950/20"
        data-testid="card-bales-produced"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
          <CardTitle className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
            <PackageCheck className="h-3.5 w-3.5" />
            Bales Produced
          </CardTitle>
          {!isLoading && data && (
            <Badge
              variant="secondary"
              className="text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 no-default-active-elevate"
            >
              QTY
            </Badge>
          )}
        </CardHeader>
        <CardContent className="pt-0 space-y-0.5">
          {isLoading ? (
            <SkeletonBox />
          ) : (
            <>
              <div className="flex items-center justify-between py-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"># Bales</span>
                <span className="text-sm font-bold">{data?.production.totalBales ?? 0}</span>
              </div>
              <StatRow label="Weight" value={fmtKg(data?.production.totalWeightKg ?? 0)} />
              {!costsHidden && (!isOwner || valuationMode === "cost") && (
                <>
                  <StatRow
                    label={valuationMode === "selling" ? "Selling Value" : "Cost Value"}
                    value={fmtMoney(data?.production.totalValue ?? 0)}
                  />
                  {/* Big rate display */}
                  {(() => {
                    // Match the "Productions" KG shown in the weight breakdown (bales + wipers/garbage).
                    // Only the displayed per-KG rate changes; the value and weight totals stay untouched.
                    const kg = (data?.production.totalWeightKg ?? 0) + (data?.wipersGarbage.totalWeightKg ?? 0);
                    const val = data?.production.totalValue ?? 0;
                    const rate = kg > 0 ? val / kg : 0;
                    return (
                      <div className="flex flex-col items-center justify-center py-3 mt-1 border-t border-blue-200 dark:border-blue-800/40">
                        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-0.5">
                          {valuationMode === "selling" ? "Selling / kg" : "Cost / kg"}
                        </span>
                        <span className="text-3xl font-extrabold text-blue-600 dark:text-blue-400 tabular-nums">
                          {fmtRate(rate)}
                        </span>
                      </div>
                    );
                  })()}
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 3 — Wipers & Garbage */}
      <Card
        className="border-red-200 dark:border-red-800/50 bg-red-50/60 dark:bg-red-950/20"
        data-testid="card-wipers-garbage"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
          <CardTitle className="text-xs font-bold uppercase tracking-wide text-red-700 dark:text-red-400 flex items-center gap-1.5">
            <Trash2 className="h-3.5 w-3.5" />
            Wipers &amp; Garbage
          </CardTitle>
          {!isLoading && data && (
            <Badge
              variant="secondary"
              className="text-xs bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 no-default-active-elevate"
            >
              QTY
            </Badge>
          )}
        </CardHeader>
        <CardContent className="pt-0 space-y-0.5">
          {isLoading ? (
            <SkeletonBox />
          ) : (
            <>
              <div className="flex items-center justify-between py-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Wipers</span>
                <span className="text-sm font-bold">
                  <span className="font-bold">{data?.wipersGarbage.totalWipersQty ?? 0}</span>
                  <span className="text-xs font-normal text-muted-foreground ml-3">
                    {fmtKg(data?.wipersGarbage.totalWipersKg ?? 0)}
                  </span>
                </span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Garbage</span>
                <span className="text-sm font-bold flex items-center gap-2">
                  <span className="font-bold">{data?.wipersGarbage.totalGarbageQty ?? 0}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {fmtKg(data?.wipersGarbage.totalGarbageKg ?? 0)}
                  </span>
                </span>
              </div>
              {!costsHidden && (
                <StatRow
                  label={valuationMode === "selling" ? "Selling Value" : "Cost Value"}
                  value={fmtMoney(data?.wipersGarbage.totalValue ?? 0)}
                />
              )}
              <div className="mt-2 pt-2 border-t border-red-200 dark:border-red-800/40 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wide text-red-700 dark:text-red-400">
                  Total Wiper + Garbage
                </span>
                <span className="text-sm font-extrabold tabular-nums">
                  {(data?.wipersGarbage.totalWipersQty ?? 0) + (data?.wipersGarbage.totalGarbageQty ?? 0)}
                  <span className="text-xs font-normal text-muted-foreground ml-3">
                    {fmtKg(data?.wipersGarbage.totalWeightKg ?? 0)}
                  </span>
                </span>
              </div>
              {(() => {
                const wgKg = data?.wipersGarbage.totalWeightKg ?? 0;
                const rawKg = data?.rawMaterial.totalWeightKg ?? 0;
                const pct = rawKg > 0 ? (wgKg / rawKg) * 100 : 0;
                const color =
                  pct > 10
                    ? "text-red-600 dark:text-red-400"
                    : pct > 5
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-green-600 dark:text-green-400";
                return (
                  <div className="flex flex-col items-center justify-center py-3 mt-1 border-t border-red-200 dark:border-red-800/40">
                    <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-0.5">
                      % of Input
                    </span>
                    <span className={`text-3xl font-extrabold tabular-nums ${color}`} data-testid="text-wg-pct">
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                );
              })()}
            </>
          )}
        </CardContent>
      </Card>

      {/* 4 — One KPI, internally split into overall and filtered balance. */}
      <Card
        className="min-w-0 border-violet-200 dark:border-violet-800/50 bg-violet-50/60 dark:bg-violet-950/20"
        data-testid="card-balance-on-table"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
          <CardTitle className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-400 flex items-center gap-1.5">
            <Scale className="h-3.5 w-3.5" />
            Overall Balance on Table
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {isLoading ? (
            <SkeletonBox />
          ) : (
            <>
              <div className="space-y-0.5" data-testid="section-overall-balance-on-table">
                <StatRow label="Weight" value={fmtKg(data?.balanceOnTable.weightKg ?? 0)} />
                {!costsHidden && (
                  <>
                    <StatRow label="Cumulative Rate" value={fmtRate(data?.balanceOnTable.costPerKg ?? 0)} />
                    <StatRow label="Value" value={fmtMoney(data?.balanceOnTable.value ?? 0)} />
                  </>
                )}
              </div>
              <div
                className="space-y-0.5 border-t border-violet-200 dark:border-violet-800/50 pt-2"
                data-testid="card-filtered-balance-on-table"
              >
                <div className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-teal-700 dark:text-teal-400">
                  <Filter className="h-3 w-3 shrink-0" />
                  Filtered Balance on Table
                  <span className="ml-auto text-muted-foreground" title={data?.filteredBalanceOnTable?.direction}>
                    {data?.filteredBalanceOnTable?.direction === "decrease" ? (
                      <TrendingDown className="h-3.5 w-3.5 text-red-500" />
                    ) : data?.filteredBalanceOnTable?.direction === "increase" ? (
                      <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Minus className="h-3.5 w-3.5" />
                    )}
                  </span>
                </div>
                <StatRow label="Weight" value={fmtKg(data?.filteredBalanceOnTable?.weightKg ?? 0)} />
                {!costsHidden && (
                  <>
                    <StatRow label="Period Batch Rate" value={fmtRate(data?.filteredBalanceOnTable?.costPerKg ?? 0)} />
                    <StatRow label="Value" value={fmtMoney(data?.filteredBalanceOnTable?.value ?? 0)} />
                  </>
                )}
                <div className="truncate text-[10px] text-muted-foreground">
                  {data?.from && data?.to ? `${data.from} – ${data.to}` : "All Time"}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
