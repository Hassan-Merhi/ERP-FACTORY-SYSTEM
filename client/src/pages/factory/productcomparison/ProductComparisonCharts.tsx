import { AlertTriangle, BarChart3, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ResponsiveMetricGrid, ResponsiveReportGrid } from "@/components/ui/responsive-report";
import { MultiSelectFilter } from "@/pages/factory/productioncomparison/components/MultiSelectFilter";
import { fmtNum } from "@/pages/factory/productioncomparison/utils";

import "./product-comparison-premium.css";
import {
  LazyProductChartCard,
  Stat,
  formatMetric,
  localizedProductName,
  productKey,
} from "./ProductComparisonChartsStat";
import { ProductComparisonChartsCardSection, useProductComparisonChartsState } from "./useProductComparisonChartsState";
import { ProductComparisonChartsContent } from "./ProductComparisonChartsContent";

export default function ProductComparisonCharts() {
  const {
    categoryOptions,
    comparisonLabel,
    comparisonRangeValid,
    comparisonRows,
    copy,
    customA,
    customB,
    day,
    direction,
    error,
    gradeOptions,
    hasFilter,
    isLoading,
    language,
    metric,
    month,
    period,
    productOptions,
    ranges,
    selectedCatalogRows,
    selectedCategories,
    selectedGrades,
    selectedLabel,
    selectedProducts,
    selectedRangeValid,
    selectedRows,
    setCustomA,
    setCustomB,
    setDay,
    setDirection,
    setMetric,
    setMonth,
    setPeriod,
    setSelectedCategories,
    setSelectedGrades,
    setSelectedProducts,
    setYear,
    totals,
    year,
  } = useProductComparisonChartsState();

  return (
    <div className="product-comparison-premium space-y-5" data-testid="factory-product-comparison">
      <div className="pc-page-heading flex items-center gap-4">
        <span className="pc-heading-icon" aria-hidden="true">
          <BarChart3 className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h2 className="text-2xl font-extrabold tracking-tight">{copy.title}</h2>
          <p className="mt-0.5 text-sm pc-heading-subtitle">{copy.subtitle}</p>
        </div>
      </div>

      <ProductComparisonChartsContent
        comparisonLabel={comparisonLabel}
        comparisonRows={comparisonRows}
        copy={copy}
        direction={direction}
        language={language}
        metric={metric}
        period={period}
        ranges={ranges}
        selectedCatalogRows={selectedCatalogRows}
        selectedLabel={selectedLabel}
        selectedRows={selectedRows}
        setDirection={setDirection}
        setMetric={setMetric}
        setPeriod={setPeriod}
        totals={totals}
      />

      <ProductComparisonChartsCardSection
        comparisonLabel={comparisonLabel}
        comparisonRangeValid={comparisonRangeValid}
        copy={copy}
        customA={customA}
        customB={customB}
        day={day}
        month={month}
        period={period}
        selectedLabel={selectedLabel}
        selectedRangeValid={selectedRangeValid}
        setCustomA={setCustomA}
        setCustomB={setCustomB}
        setDay={setDay}
        setMonth={setMonth}
        setYear={setYear}
        year={year}
      />

      <div className="pc-filters flex flex-wrap items-center gap-2">
        <MultiSelectFilter
          options={categoryOptions}
          selected={selectedCategories}
          onChange={setSelectedCategories}
          placeholder={copy.categories}
          allLabel={copy.allCategories}
          className="w-full sm:w-48"
          testId="product-comparison-categories"
        />
        <MultiSelectFilter
          options={gradeOptions}
          selected={selectedGrades}
          onChange={setSelectedGrades}
          placeholder={copy.grades}
          allLabel={copy.allGrades}
          className="w-full sm:w-40"
          testId="product-comparison-grades"
        />
        <MultiSelectFilter
          options={productOptions}
          selected={selectedProducts}
          onChange={setSelectedProducts}
          placeholder={copy.products}
          allLabel={copy.selectProducts}
          className="w-full sm:w-[360px]"
          testId="product-comparison-products"
        />
        {hasFilter || selectedProducts.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedCategories([]);
              setSelectedGrades([]);
              setSelectedProducts([]);
            }}
          >
            {copy.clear}
          </Button>
        ) : null}
      </div>

      {selectedCatalogRows.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label={copy.selectedProducts}>
          {selectedCatalogRows.map((product) => {
            const key = productKey(product);
            return (
              <Badge key={key} variant="secondary" className="pc-product-chip max-w-full gap-1.5 px-3 py-1.5">
                <span className="max-w-[260px] truncate">{localizedProductName(product, language)}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 hover:bg-background/70"
                  onClick={() => setSelectedProducts((current) => current.filter((value) => value !== key))}
                  aria-label={`${copy.clear} ${localizedProductName(product, language)}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      ) : null}

      {selectedProducts.length === 0 ? (
        <Card className="pc-empty-state border-dashed">
          <CardContent className="flex min-h-[240px] flex-col items-center justify-center p-8 text-center">
            <BarChart3 className="mb-3 h-10 w-10 text-muted-foreground" />
            <p className="font-semibold">{copy.noSelectionTitle}</p>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">{copy.noSelectionBody}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <ResponsiveMetricGrid>
            <Stat label={copy.selectedProducts} value={fmtNum(selectedProducts.length)} kind="products" tone="violet" />
            <Stat
              label={copy.selectedTotal}
              value={formatMetric(totals.selected, metric)}
              sub={selectedLabel}
              kind="selected"
              tone="blue"
            />
            <Stat
              label={copy.comparisonTotal}
              value={formatMetric(totals.comparison, metric)}
              sub={comparisonLabel}
              kind="compared"
              tone="green"
            />
            <Stat
              label={copy.difference}
              kind="difference"
              tone={totals.difference < 0 ? "rose" : totals.difference > 0 ? "green" : "blue"}
              value={`${totals.difference > 0 ? "+" : ""}${formatMetric(totals.difference, metric)}`}
              sub={
                totals.change === null
                  ? copy.notAvailable
                  : `${totals.change > 0 ? "+" : ""}${totals.change.toFixed(1)}%`
              }
            />
          </ResponsiveMetricGrid>

          {error ? (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">{copy.loadFailed}</p>
                <p className="mt-0.5 text-xs opacity-80">{(error as Error).message}</p>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <ResponsiveReportGrid aria-label={copy.charts}>
              {selectedProducts.map((key) => (
                <Skeleton key={key} className="h-[410px] rounded-xl" />
              ))}
            </ResponsiveReportGrid>
          ) : !error ? (
            <ResponsiveReportGrid aria-label={copy.charts}>
              {selectedCatalogRows.map((product) => {
                const key = productKey(product);
                return (
                  <LazyProductChartCard
                    key={key}
                    product={product}
                    selectedRow={selectedRows.get(key)}
                    comparisonRow={comparisonRows.get(key)}
                    selectedLabel={selectedLabel}
                    comparisonLabel={comparisonLabel}
                    metric={metric}
                    language={language}
                    currentLabel={copy.current}
                    comparedLabel={copy.compared}
                    differenceLabel={copy.difference}
                    changeLabel={copy.change}
                    noProductionLabel={copy.noProduction}
                    inactiveLabel={copy.inactive}
                    balesLabel={copy.bales}
                    weightLabel={copy.weight}
                    chartRegionLabel={copy.chartRegion}
                    notAvailableLabel={copy.notAvailable}
                  />
                );
              })}
            </ResponsiveReportGrid>
          ) : null}
        </>
      )}
    </div>
  );
}
