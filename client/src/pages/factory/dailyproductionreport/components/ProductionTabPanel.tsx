import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import {
  ChevronRight,
  ChevronLeft,
  FlaskConical,
  PackageCheck,
  Scale,
  TrendingUp,
  TrendingDown,
  Minus,
  Tag,
  Trash2,
} from "lucide-react";

import type { Preset } from "../types";
import { GRADE_COLORS, GRADE_ORDER, classifyByGrade, fmtKg, fmtMoney, fmtRate } from "../utils";
import { StatRow } from "./StatRow";
import { SkeletonBox } from "./SkeletonBox";
import { ExpandableCard } from "./ExpandableCard";
import { CategoryProductBreakdown } from "./CategoryProductBreakdown";
import { CategoryPieChart } from "./CategoryPieChart";
import { MiniPieChart } from "./MiniPieChart";
import type { DailyProductionReportState } from "../useDailyProductionReport";
import { SalaryOverviewSection } from "./SalaryOverviewSection";

export function ProductionTabPanel({ report }: { report: DailyProductionReportState }) {
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
    profitValue,
    valuationMode,
    setValuationMode,
  } = report;
  const costsHidden = Boolean(data?.costsHidden);
  // Top Profit KPI only:
  // selected bales value - (mix-batch value - remaining-on-table value).
  // The selected bales value follows the active Cost/Selling toggle.
  const selectedBalesValue = data?.production.totalValue ?? 0;
  const consumedMixValue = (data?.rawMaterial.totalCost ?? 0) - (data?.balanceOnTable.value ?? 0);
  const productionProfitValue = selectedBalesValue - consumedMixValue;
  const productionProfitMarginPct = selectedBalesValue > 0 ? (productionProfitValue / selectedBalesValue) * 100 : 0;
  return (
    <>
      {/* ── Production tab ── */}
      <TabsContent
        value="production"
        className="flex-1 overflow-y-auto p-4 gap-4 flex flex-col mt-0 data-[state=inactive]:hidden"
      >
        {/* Date filter + Pie chart row */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              onClick={() => stepDates(-1)}
              data-testid="button-date-prev"
              title="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
              <SelectTrigger className="w-40" data-testid="select-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.key} value={p.key} data-testid={`option-preset-${p.key}`}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {preset === "custom" && (
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="border rounded-md px-2 py-1 text-sm bg-background text-foreground"
                  data-testid="input-custom-from"
                />
                <span className="text-muted-foreground text-sm">to</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="border rounded-md px-2 py-1 text-sm bg-background text-foreground"
                  data-testid="input-custom-to"
                />
              </div>
            )}

            <Button
              size="icon"
              variant="outline"
              onClick={() => stepDates(1)}
              data-testid="button-date-next"
              title="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>

            {data && !costsHidden && (
              <div
                className="inline-flex items-center rounded-md border bg-muted/40 p-0.5"
                data-testid="production-valuation-toggle"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={valuationMode === "selling" ? "default" : "ghost"}
                  className="h-8 px-3"
                  onClick={() => setValuationMode("selling")}
                  data-testid="button-valuation-selling"
                >
                  Selling Price
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={valuationMode === "cost" ? "default" : "ghost"}
                  className="h-8 px-3"
                  onClick={() => setValuationMode("cost")}
                  data-testid="button-valuation-cost"
                >
                  Cost Price
                </Button>
              </div>
            )}
          </div>

          {/* Compact pie charts — same row as date picker */}
          {!isLoading &&
            data &&
            (() => {
              // For the Grade chart, use production.byCategory rows + ONE synthetic
              // "__WIPERS_GARBAGE__" row whose weight equals wipersGarbage.totalWeightKg.
              // This guarantees both charts show the identical Wipers & Garbage total,
              // regardless of the actual category names inside wipersGarbage.rows.
              const gradeRows: { categoryName: string; totalWeightKg: number }[] = [
                ...data.production.byCategory.map((c) => ({
                  categoryName: c.categoryName,
                  totalWeightKg: c.totalWeightKg,
                })),
                ...(data.wipersGarbage.totalWeightKg > 0
                  ? [{ categoryName: "__WIPERS_GARBAGE__", totalWeightKg: data.wipersGarbage.totalWeightKg }]
                  : []),
              ];
              const hasData = gradeRows.some((r) => r.totalWeightKg > 0);
              if (!hasData) return null;
              return (
                <div className="flex flex-wrap gap-6">
                  <CategoryPieChart
                    byCategory={data.production.byCategory}
                    wipersGarbageKg={data.wipersGarbage.totalWeightKg}
                  />
                  <MiniPieChart
                    title="By Grade"
                    allRows={gradeRows}
                    classifyFn={classifyByGrade}
                    order={GRADE_ORDER}
                    colors={GRADE_COLORS}
                    testId="card-grade-pie"
                  />
                </div>
              );
            })()}
        </div>

        {/* ── Top Summary Bar ── */}
        <Card data-testid="card-summary-bar">
          <CardContent className="py-3 px-4">
            {isLoading ? (
              <div className="flex gap-6 flex-wrap">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-5 w-40" />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {/* Row 1 — money summary */}
                {!costsHidden && (
                  <div className="flex flex-wrap items-center gap-6">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {valuationMode === "selling" ? "Selling Value" : "Cost Value"}
                      </span>
                      <span
                        className="text-base font-bold text-blue-600 dark:text-blue-400"
                        data-testid="text-production-value"
                      >
                        {fmtMoney(data?.summary.productionValue ?? 0)}
                      </span>
                    </div>
                    <div className="w-px h-5 bg-border" />
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Batch Cost
                      </span>
                      <span className="text-base font-bold" data-testid="text-batch-cost">
                        {fmtMoney(data?.summary.batchCost ?? 0)}
                      </span>
                    </div>
                    <div className="w-px h-5 bg-border" />
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Profit
                      </span>
                      <span
                        className={`text-base font-bold px-3 py-0.5 rounded-md ${
                          productionProfitValue > 0
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                            : productionProfitValue < 0
                              ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                              : "bg-muted text-muted-foreground"
                        }`}
                        data-testid="text-profit-value"
                      >
                        {productionProfitValue > 0 ? "+" : ""}
                        {fmtMoney(productionProfitValue)}
                      </span>
                      {productionProfitValue > 0 ? (
                        <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
                      ) : productionProfitValue === 0 ? (
                        <Minus className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-red-600 dark:text-red-400" />
                      )}
                    </div>
                    <div className="w-px h-5 bg-border" />
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Margin
                      </span>
                      <span className="text-base font-bold tabular-nums" data-testid="text-profit-margin">
                        {productionProfitMarginPct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                )}

                {/* Missing-price diagnostics are intentionally not shown in the Production Overview UI. */}

                {/* Row 2 — weight breakdown */}
                {(() => {
                  const origKg = data?.rawMaterial.totalWeightKg ?? 0;
                  const productionsKg =
                    (data?.production.totalWeightKg ?? 0) + (data?.wipersGarbage.totalWeightKg ?? 0);
                  // Total = Productions − Original Batches (material consumed → finished goods + waste)
                  const totalKg = productionsKg - origKg;
                  const isPositive = totalKg >= 0;
                  return (
                    <div
                      className={
                        costsHidden
                          ? "flex flex-wrap items-center gap-5"
                          : "flex flex-wrap items-center gap-5 pt-2 border-t border-border"
                      }
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-muted-foreground">Productions</span>
                        <span className="text-base font-bold" data-testid="text-weight-productions">
                          {fmtKg(productionsKg)}
                        </span>
                      </div>
                      <span className="text-muted-foreground text-base font-semibold">&#8722;</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-muted-foreground">Original Batches</span>
                        <span className="text-base font-bold" data-testid="text-weight-batches">
                          {fmtKg(origKg)}
                        </span>
                      </div>
                      <span className="text-muted-foreground text-base font-semibold">=</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-muted-foreground">Total</span>
                        <span
                          className={`text-base font-bold ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                          data-testid="text-weight-total"
                        >
                          {fmtKg(totalKg)}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </CardContent>
        </Card>

        <SalaryOverviewSection report={report} />

        {/* ── Four colored boxes ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
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
                      <StatRow
                        label="Batch Rate"
                        value={fmtRate(data?.rawMaterial.blendedCostPerKg ?? 0)}
                        sub="per kg"
                      />
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
                  {!costsHidden && (
                    <>
                      <StatRow
                        label={valuationMode === "selling" ? "Selling Value" : "Cost Value"}
                        value={fmtMoney(data?.production.totalValue ?? 0)}
                      />
                      {/* Big rate display */}
                      {(() => {
                        const kg = data?.production.totalWeightKg ?? 0;
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

          {/* 4 — Balance on Table */}
          <Card
            className="border-violet-200 dark:border-violet-800/50 bg-violet-50/60 dark:bg-violet-950/20"
            data-testid="card-balance-on-table"
          >
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-400 flex items-center gap-1.5">
                <Scale className="h-3.5 w-3.5" />
                Balance on Table
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-0.5">
              {isLoading ? (
                <SkeletonBox />
              ) : (
                <>
                  <StatRow label="Weight" value={fmtKg(data?.balanceOnTable.weightKg ?? 0)} />
                  {!costsHidden && (
                    <>
                      <StatRow label="Batch Rate" value={fmtRate(data?.balanceOnTable.costPerKg ?? 0)} sub="per kg" />
                      <StatRow label="Value" value={fmtMoney(data?.balanceOnTable.value ?? 0)} />
                      <div className="mt-2 pt-2 border-t border-violet-200 dark:border-violet-800/40 flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-400">
                          Production Profit
                        </span>
                        <span
                          className={`text-sm font-extrabold tabular-nums ${
                            profitValue > 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : profitValue < 0
                                ? "text-red-500 dark:text-red-400"
                                : "text-muted-foreground"
                          }`}
                        >
                          {profitValue > 0 ? "+" : ""}
                          {fmtMoney(profitValue)}
                        </span>
                      </div>
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Expandable detail rows ── */}

        {/* Production by Category (each category expands to show its products) */}
        {(() => {
          const wgCats: { categoryName: string; qty: number; totalWeightKg: number; totalValue: number }[] = [];
          const wgProds: {
            articleCode: string;
            productName: string;
            categoryName: string;
            qty: number;
            totalWeightKg: number;
            costPricePerBale: number;
            pricePerBale: number;
            totalValue: number;
          }[] = [];
          if (data) {
            const wipersRows = data.wipersGarbage.rows.filter((r) => r.subType === "wiper");
            const garbageRows = data.wipersGarbage.rows.filter((r) => r.subType !== "wiper");
            if (wipersRows.length > 0) {
              wgCats.push({
                categoryName: "Wipers",
                qty: wipersRows.reduce((s: number, r) => s + r.qty, 0),
                totalWeightKg: wipersRows.reduce((s: number, r) => s + r.totalWeightKg, 0),
                totalValue: wipersRows.reduce((s: number, r) => s + r.totalValue, 0),
              });
              wgProds.push(
                ...wipersRows.map((r) => ({
                  articleCode: r.categoryName.replace(/\s+/g, "-").toUpperCase(),
                  productName: r.categoryName,
                  categoryName: "Wipers",
                  qty: r.qty,
                  totalWeightKg: r.totalWeightKg,
                  costPricePerBale: 0,
                  pricePerBale: r.qty > 0 ? r.totalValue / r.qty : 0,
                  totalValue: r.totalValue,
                }))
              );
            }
            if (garbageRows.length > 0) {
              wgCats.push({
                categoryName: "Garbage",
                qty: garbageRows.reduce((s: number, r) => s + r.qty, 0),
                totalWeightKg: garbageRows.reduce((s: number, r) => s + r.totalWeightKg, 0),
                totalValue: garbageRows.reduce((s: number, r) => s + r.totalValue, 0),
              });
              wgProds.push(
                ...garbageRows.map((r) => ({
                  articleCode: r.categoryName.replace(/\s+/g, "-").toUpperCase(),
                  productName: r.categoryName,
                  categoryName: "Garbage",
                  qty: r.qty,
                  totalWeightKg: r.totalWeightKg,
                  costPricePerBale: 0,
                  pricePerBale: r.qty > 0 ? r.totalValue / r.qty : 0,
                  totalValue: r.totalValue,
                }))
              );
            }
          }
          const mergedCategories = [...(data?.production.byCategory ?? []), ...wgCats];
          const mergedProducts = [...(data?.production.byProduct ?? []), ...wgProds];
          const mergedTotalBales = (data?.production.totalBales ?? 0) + wgCats.reduce((s, c) => s + c.qty, 0);
          const mergedTotalWeightKg =
            (data?.production.totalWeightKg ?? 0) + wgCats.reduce((s, c) => s + c.totalWeightKg, 0);
          const mergedTotalValue = (data?.production.totalValue ?? 0) + wgCats.reduce((s, c) => s + c.totalValue, 0);
          return (
            <ExpandableCard
              title="Production by Category"
              badge={
                isLoading ? undefined : `${mergedCategories.length} categories · ${mergedProducts.length} products`
              }
              icon={Tag}
              testId="card-category-breakdown"
            >
              {isLoading ? (
                <div className="space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : !data || mergedCategories.length === 0 ? (
                <p className="text-center text-muted-foreground py-6 text-sm">No bales produced in this period</p>
              ) : (
                <CategoryProductBreakdown
                  categories={mergedCategories}
                  products={mergedProducts}
                  totalBales={mergedTotalBales}
                  totalWeightKg={mergedTotalWeightKg}
                  totalValue={mergedTotalValue}
                  hideCosts={costsHidden}
                  valuationMode={valuationMode}
                />
              )}
            </ExpandableCard>
          );
        })()}

        {/* Mix Batches */}
        <ExpandableCard
          title="Mix Batches"
          badge={
            isLoading
              ? undefined
              : `${data?.rawMaterial.totalBatches ?? 0} ${(data?.rawMaterial.totalBatches ?? 0) === 1 ? "batch" : "batches"}`
          }
          icon={FlaskConical}
          testId="card-mix-breakdown"
        >
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : !data || data.rawMaterial.batches.length === 0 ? (
            <p className="text-center text-muted-foreground py-6 text-sm">No mix batches in this period</p>
          ) : (
            <div className="table-responsive">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Weight (kg)</TableHead>
                    {!costsHidden && <TableHead className="text-right">Cost / kg</TableHead>}
                    {!costsHidden && <TableHead className="text-right">Total Cost</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rawMaterial.batches.map((b) => (
                    <TableRow key={b.id} data-testid={`row-batch-${b.id}`}>
                      <TableCell className="font-mono text-sm">{b.batchCode}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{b.name || "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {b.batchDate || b.createdAt?.slice(0, 10) || "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {fmtKg(parseFloat(b.totalWeightKg))}
                      </TableCell>
                      {!costsHidden && (
                        <TableCell className="text-right font-mono text-sm">
                          {`${Number(b.costPerKg || 0).toFixed(4)}`}
                        </TableCell>
                      )}
                      {!costsHidden && (
                        <TableCell className="text-right font-mono font-semibold">
                          {fmtMoney(parseFloat(b.totalCost))}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
                <tfoot>
                  <tr className="border-t-2">
                    <td colSpan={3} className="px-4 py-2 text-sm font-semibold text-muted-foreground">
                      Totals
                    </td>
                    <td className="px-4 py-2 text-right font-mono font-bold">
                      {fmtKg(data?.rawMaterial.totalWeightKg ?? 0)}
                    </td>
                    {!costsHidden && <td />}
                    {!costsHidden && (
                      <td className="px-4 py-2 text-right font-mono font-bold">
                        {fmtMoney(data?.rawMaterial.totalCost ?? 0)}
                      </td>
                    )}
                  </tr>
                </tfoot>
              </Table>
            </div>
          )}
        </ExpandableCard>
      </TabsContent>
    </>
  );
}
