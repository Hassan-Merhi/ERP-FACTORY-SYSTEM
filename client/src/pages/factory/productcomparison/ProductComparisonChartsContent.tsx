// Extracted from ./ProductComparisonCharts.tsx
import { ArrowLeftRight, Package, Scale } from "lucide-react";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { pctChange } from "@/pages/factory/productioncomparison/utils";
import { Button } from "@/components/ui/button";
import { type ProductComparisonPeriod } from "./utils";
import { localizedProductName, metricValue, productKey } from "./ProductComparisonChartsStat";
import { useProductComparisonChartsState } from "./useProductComparisonChartsState";

export function ProductComparisonChartsContent({
  comparisonLabel,
  comparisonRows,
  copy,
  direction,
  language,
  metric,
  period,
  ranges,
  selectedCatalogRows,
  selectedLabel,
  selectedRows,
  setDirection,
  setMetric,
  setPeriod,
  totals,
}: Pick<
  ReturnType<typeof useProductComparisonChartsState>,
  | "comparisonLabel"
  | "comparisonRows"
  | "copy"
  | "direction"
  | "language"
  | "metric"
  | "period"
  | "ranges"
  | "selectedCatalogRows"
  | "selectedLabel"
  | "selectedRows"
  | "setDirection"
  | "setMetric"
  | "setPeriod"
  | "totals"
>) {
  return (
    <div className="pc-toolbar flex flex-wrap items-center gap-2">
      {(
        [
          ["day", copy.daily],
          ["month", copy.monthly],
          ["year", copy.yearly],
          ["custom", copy.custom],
        ] as [ProductComparisonPeriod, string][]
      ).map(([value, label]) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={period === value ? "default" : "outline"}
          className="pc-control-button"
          aria-pressed={period === value}
          onClick={() => setPeriod(value)}
          data-testid={`product-comparison-period-${value}`}
        >
          {label}
        </Button>
      ))}

      {period !== "custom" ? (
        <div className="pc-switch-group ml-0 flex items-center gap-1 rounded-xl border p-1 sm:ml-2">
          <Button
            type="button"
            size="sm"
            variant={direction === "previous" ? "secondary" : "ghost"}
            className="pc-control-button"
            aria-pressed={direction === "previous"}
            onClick={() => setDirection("previous")}
            data-testid="product-comparison-direction-previous"
          >
            {copy.previous}
          </Button>
          <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
          <Button
            type="button"
            size="sm"
            variant={direction === "next" ? "secondary" : "ghost"}
            className="pc-control-button"
            aria-pressed={direction === "next"}
            onClick={() => setDirection("next")}
            data-testid="product-comparison-direction-next"
          >
            {copy.next}
          </Button>
        </div>
      ) : null}

      <RowsExportMenu
        title={`${copy.title} ${metric === "bales" ? copy.bales : copy.weight}`}
        sheetName={copy.title}
        rows={selectedCatalogRows}
        columns={[
          { header: copy.products, value: (product) => localizedProductName(product, language) },
          {
            header: `${copy.current}: ${selectedLabel}`,
            value: (product) => metricValue(selectedRows.get(productKey(product)), metric),
            type: "number",
          },
          {
            header: `${copy.compared}: ${comparisonLabel}`,
            value: (product) => metricValue(comparisonRows.get(productKey(product)), metric),
            type: "number",
          },
          {
            header: copy.difference,
            value: (product) =>
              metricValue(selectedRows.get(productKey(product)), metric) -
              metricValue(comparisonRows.get(productKey(product)), metric),
            type: "number",
          },
          {
            header: `${copy.change} %`,
            value: (product) =>
              pctChange(
                metricValue(selectedRows.get(productKey(product)), metric),
                metricValue(comparisonRows.get(productKey(product)), metric)
              ),
            type: "number",
          },
        ]}
        footer={[copy.selectedTotal, totals.selected, totals.comparison, totals.difference, totals.change]}
        period={{ from: ranges.selected.from, to: ranges.selected.to }}
        resource="factory.production"
        className="pc-control-button"
      />

      <div className="pc-switch-group ml-0 flex items-center gap-1 rounded-xl border p-1 sm:ml-auto">
        <Button
          type="button"
          size="sm"
          variant={metric === "bales" ? "secondary" : "ghost"}
          className="pc-control-button"
          aria-pressed={metric === "bales"}
          onClick={() => setMetric("bales")}
          data-testid="product-comparison-metric-bales"
        >
          <Package className="mr-1.5 h-4 w-4" />
          {copy.bales}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={metric === "weight" ? "secondary" : "ghost"}
          className="pc-control-button"
          aria-pressed={metric === "weight"}
          onClick={() => setMetric("weight")}
          data-testid="product-comparison-metric-weight"
        >
          <Scale className="mr-1.5 h-4 w-4" />
          {copy.weight}
        </Button>
      </div>
    </div>
  );
}
