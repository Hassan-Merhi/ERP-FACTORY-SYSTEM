import { RowsExportMenu, type RowsExportSheet } from "@/components/export/RowsExportMenu";
import {
  METRICS,
  useStockInSalesReportComparisonState,
  type ComparisonRow,
  type ItemComparisonRow,
  type MetricKey,
} from "./useStockInSalesReportComparisonState";

type ComparisonState = ReturnType<typeof useStockInSalesReportComparisonState>;

/** Excel export of the overall, period and item comparisons, with the values formatted as the tables show them. */
export function StockInSalesReportComparisonExport({
  data,
  formatMetric,
  formatPeriod,
  itemMetric,
  period,
  selectedItemMetric,
  sideALabel,
  sideBLabel,
  summary,
}: Pick<
  ComparisonState,
  | "data"
  | "formatMetric"
  | "formatPeriod"
  | "itemMetric"
  | "period"
  | "selectedItemMetric"
  | "sideALabel"
  | "sideBLabel"
  | "summary"
>) {
  if (!data) return null;
  /** The difference cell's text: a leading "+" on gains, as the table shows it. */
  const signedMetric = (key: MetricKey, kind: "qty" | "money" | "rate", value: number) =>
    (value > 0 ? "+" : "") + formatMetric(key, kind, value);
  return (
    <RowsExportMenu
      title="Stock and Sales Comparison"
      period={{ from: period.fromDate, to: period.toDate }}
      filters={[
        { label: "Side A", value: sideALabel },
        { label: "Side B", value: sideBLabel },
      ]}
      sheetName="Overall comparison"
      rows={METRICS}
      columns={[
        { header: "Metric", value: (metric) => metric.label },
        {
          header: sideALabel,
          value: (metric) => formatMetric(metric.key, metric.kind, summary.sideA[metric.key]),
        },
        {
          header: sideBLabel,
          value: (metric) => formatMetric(metric.key, metric.kind, summary.sideB[metric.key]),
        },
        {
          header: "Difference (A − B)",
          value: (metric) => signedMetric(metric.key, metric.kind, summary.difference[metric.key]),
        },
      ]}
      extraSheets={[
        {
          name: "Period comparison",
          rows: data.rows.flatMap((row) => METRICS.map((metric) => ({ row, metric }))),
          columns: [
            { header: "Period", value: ({ row }) => formatPeriod(row) },
            { header: "Metric", value: ({ metric }) => metric.label },
            {
              header: sideALabel,
              value: ({ row, metric }) => formatMetric(metric.key, metric.kind, row.sideA[metric.key]),
            },
            {
              header: sideBLabel,
              value: ({ row, metric }) => formatMetric(metric.key, metric.kind, row.sideB[metric.key]),
            },
            {
              header: "Difference (A − B)",
              value: ({ row, metric }) => signedMetric(metric.key, metric.kind, row.difference[metric.key]),
            },
          ],
        } satisfies RowsExportSheet<{ row: ComparisonRow; metric: (typeof METRICS)[number] }>,
        {
          // Every matching item, not only the page on screen.
          name: `Items - ${selectedItemMetric.label}`,
          rows: data.itemRows,
          columns: [
            { header: "Item", value: (row) => row.stockItemName },
            { header: "Code", value: (row) => row.stockItemCode },
            { header: "Stock Group", value: (row) => row.stockGroupName },
            {
              header: sideALabel,
              value: (row) => formatMetric(itemMetric, selectedItemMetric.kind, row.sideA[itemMetric]),
            },
            {
              header: sideBLabel,
              value: (row) => formatMetric(itemMetric, selectedItemMetric.kind, row.sideB[itemMetric]),
            },
            {
              header: "Difference (A − B)",
              value: (row) => signedMetric(itemMetric, selectedItemMetric.kind, row.difference[itemMetric]),
            },
          ],
        } satisfies RowsExportSheet<ItemComparisonRow>,
      ]}
      resource="erp.inventory"
      data-testid="button-export-stock-sales-comparison"
    />
  );
}
