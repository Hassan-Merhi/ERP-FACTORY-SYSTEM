import "./production-overview-premium.css";
import { EditMixBatchDialog } from "@/components/EditMixBatchDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { ChevronRight, ChevronLeft, CalendarDays, Tag } from "lucide-react";
import type { Preset } from "../types";
import { GRADE_COLORS, GRADE_ORDER, classifyByGrade } from "../utils";
import { ExpandableCard } from "./ExpandableCard";
import { CategoryProductBreakdown } from "./CategoryProductBreakdown";
import { CategoryPieChart } from "./CategoryPieChart";
import { MiniPieChart } from "./MiniPieChart";
import type { DailyProductionReportState } from "../useDailyProductionReport";
import { SalaryOverviewSection } from "./SalaryOverviewSection";
import { ProductionTabPanelSection, useProductionTabPanelState } from "./ProductionTabPanelSection";
import {
  ProductionTabPanelCardSummaryBar,
  ProductionTabPanelExpandableCardSection,
} from "./ProductionTabPanelCardSummaryBar";

export function ProductionTabPanel(props: { report: DailyProductionReportState }) {
  const {
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
  } = useProductionTabPanelState(props);
  return (
    <>
      {/* ── Production tab ── */}
      <TabsContent
        value="production"
        className="factory-production-premium flex-1 overflow-y-auto p-4 gap-3 flex flex-col mt-0 data-[state=inactive]:hidden"
      >
        {/* Presentation-only controls: existing date and valuation handlers are unchanged. */}
        <div className="production-premium-topbar">
          <div className="production-premium-heading">
            <h2>
              Production <span>Overview</span>
            </h2>
            <p>Monitor production, batches, costs and profitability</p>
          </div>
          <div className="production-premium-controls">
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
                <CalendarDays className="h-4 w-4 shrink-0 text-blue-500" aria-hidden="true" />
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
        </div>

        {/* Production charts — derived from exactly the same report data as before. */}
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
              <div className="production-premium-chart-grid">
                <CategoryPieChart
                  byCategory={data.production.byCategory}
                  wipersGarbageKg={data.wipersGarbage.totalWeightKg}
                />
                <MiniPieChart
                  title="Production by Grade"
                  allRows={gradeRows}
                  classifyFn={classifyByGrade}
                  order={GRADE_ORDER}
                  colors={GRADE_COLORS}
                  testId="card-grade-pie"
                />
              </div>
            );
          })()}

        {/* ── Top Summary Bar ── */}
        <ProductionTabPanelCardSummaryBar
          data={data}
          isLoading={isLoading}
          isOwner={isOwner}
          productionProfitMarginPct={productionProfitMarginPct}
          productionProfitValue={productionProfitValue}
          showMoneySummary={showMoneySummary}
          valuationMode={valuationMode}
        />

        <SalaryOverviewSection report={report} />

        {/* Four matching KPI cards. The fourth contains both table balances. */}
        <ProductionTabPanelSection
          costsHidden={costsHidden}
          data={data}
          isLoading={isLoading}
          isOwner={isOwner}
          valuationMode={valuationMode}
        />

        {/* ── Expandable detail rows ── */}

        {/* Production by Category (each category expands to show its products) */}
        {(() => {
          // One expandable category, matching Location Inventory. The API supplies
          // real wiper/garbage products rather than synthetic category-name rows.
          const wgCats =
            data && data.wipersGarbage.rows.length > 0
              ? [
                  {
                    categoryName: "Wipers & Garbage",
                    qty: data.wipersGarbage.totalWipersQty + data.wipersGarbage.totalGarbageQty,
                    totalWeightKg: data.wipersGarbage.totalWeightKg,
                    totalValue: data.wipersGarbage.totalValue,
                  },
                ]
              : [];
          const wgProds = (data?.wipersGarbage.products ?? []).map((product) => ({
            ...product,
            categoryName: "Wipers & Garbage",
          }));
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
        <ProductionTabPanelExpandableCardSection
          costsHidden={costsHidden}
          data={data}
          isLoading={isLoading}
          setSelectedMixBatchId={setSelectedMixBatchId}
        />
      </TabsContent>
      <EditMixBatchDialog
        batch={selectedMixBatch ?? null}
        open={selectedMixBatchId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedMixBatchId(null);
        }}
        readOnly
        hideCosts={costsHidden || (isOwner && valuationMode !== "cost")}
        errorMessage={selectedMixBatchError ? "Unable to load this mix batch's details. Please try again." : null}
      />
    </>
  );
}
