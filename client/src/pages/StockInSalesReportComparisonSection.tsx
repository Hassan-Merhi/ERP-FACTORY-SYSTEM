// Extracted from ./StockInSalesReportComparison.tsx to keep that module under the source-size cap.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ITEM_PAGE_SIZE,
  METRICS,
  useStockInSalesReportComparisonState,
  type MetricKey,
} from "./useStockInSalesReportComparisonState";

export function StockInSalesReportComparisonSection({
  data,
  formatPeriod,
  isLoading,
  itemMetric,
  itemPage,
  itemTotalPages,
  pagedItemRows,
  renderValue,
  selectedItemMetric,
  setItemMetric,
  setItemPage,
  sideALabel,
  sideBLabel,
  summary,
}: Pick<
  ReturnType<typeof useStockInSalesReportComparisonState>,
  | "data"
  | "formatPeriod"
  | "isLoading"
  | "itemMetric"
  | "itemPage"
  | "itemTotalPages"
  | "pagedItemRows"
  | "renderValue"
  | "selectedItemMetric"
  | "setItemMetric"
  | "setItemPage"
  | "sideALabel"
  | "sideBLabel"
  | "summary"
>) {
  return (
    <>
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Overall comparison</h2>
          <p className="text-xs text-muted-foreground">All metrics use the same date range and active search filter.</p>
        </div>
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>Metric</TableHead>
                <TableHead className="text-right">{sideALabel}</TableHead>
                <TableHead className="text-right">{sideBLabel}</TableHead>
                <TableHead className="text-right">Difference (A − B)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading
                ? METRICS.map((metric) => (
                    <TableRow key={metric.key}>
                      <TableCell>{metric.label}</TableCell>
                      {[0, 1, 2].map((cell) => (
                        <TableCell key={cell}>
                          <Skeleton className="ml-auto h-4 w-24" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : METRICS.map((metric) => (
                    <TableRow key={metric.key}>
                      <TableCell className="font-medium">{metric.label}</TableCell>
                      <TableCell className="text-right">
                        {renderValue(metric.key, metric.kind, summary.sideA[metric.key])}
                      </TableCell>
                      <TableCell className="text-right">
                        {renderValue(metric.key, metric.kind, summary.sideB[metric.key])}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {renderValue(metric.key, metric.kind, summary.difference[metric.key], true)}
                      </TableCell>
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Period comparison</h2>
            <p className="text-xs text-muted-foreground">
              Each period shows Side A, Side B, and the difference for every report metric.
            </p>
          </div>
          {data && (
            <p className="text-xs text-muted-foreground">
              {data.rowCount} period{data.rowCount === 1 ? "" : "s"}
            </p>
          )}
        </div>
        <div className="overflow-hidden rounded-xl border">
          <div className="overflow-x-auto">
            <Table className="min-w-[850px]">
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Period</TableHead>
                  <TableHead>Metric</TableHead>
                  <TableHead className="text-right">{sideALabel}</TableHead>
                  <TableHead className="text-right">{sideBLabel}</TableHead>
                  <TableHead className="text-right">Difference (A − B)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 8 }).map((_, index) => (
                    <TableRow key={index}>
                      {Array.from({ length: 5 }).map((__, cell) => (
                        <TableCell key={cell}>
                          <Skeleton className="h-4 w-full max-w-28" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : !data || data.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                      No activity was found for either side with the selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.rows.flatMap((row) =>
                    METRICS.map((metric, metricIndex) => (
                      <TableRow key={`${row.periodKey}-${metric.key}`}>
                        {metricIndex === 0 && (
                          <TableCell rowSpan={METRICS.length} className="align-top font-semibold">
                            {formatPeriod(row)}
                          </TableCell>
                        )}
                        <TableCell className="font-medium text-muted-foreground">{metric.label}</TableCell>
                        <TableCell className="text-right">
                          {renderValue(metric.key, metric.kind, row.sideA[metric.key])}
                        </TableCell>
                        <TableCell className="text-right">
                          {renderValue(metric.key, metric.kind, row.sideB[metric.key])}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {renderValue(metric.key, metric.kind, row.difference[metric.key], true)}
                        </TableCell>
                      </TableRow>
                    ))
                  )
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Item comparison</h2>
            <p className="text-xs text-muted-foreground">
              Choose any report metric to compare every matching stock item across the two sides.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={itemMetric} onValueChange={(value) => setItemMetric(value as MetricKey)}>
              <SelectTrigger className="w-52" data-testid="select-item-comparison-metric">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METRICS.map((metric) => (
                  <SelectItem key={metric.key} value={metric.key}>
                    {metric.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {data && (
              <span className="text-xs text-muted-foreground">
                {data.itemRowCount} item{data.itemRowCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border">
          <div className="overflow-x-auto">
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Item</TableHead>
                  <TableHead>Stock Group</TableHead>
                  <TableHead className="text-right">{sideALabel}</TableHead>
                  <TableHead className="text-right">{sideBLabel}</TableHead>
                  <TableHead className="text-right">Difference (A − B)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 8 }).map((_, index) => (
                    <TableRow key={index}>
                      {Array.from({ length: 5 }).map((__, cell) => (
                        <TableCell key={cell}>
                          <Skeleton className="h-4 w-full max-w-28" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : pagedItemRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                      No matching stock items found.
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedItemRows.map((row) => (
                    <TableRow key={row.stockItemId}>
                      <TableCell>
                        <div className="font-medium">{row.stockItemName}</div>
                        <div className="text-xs text-muted-foreground">{row.stockItemCode}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.stockGroupName}</TableCell>
                      <TableCell className="text-right">
                        {renderValue(itemMetric, selectedItemMetric.kind, row.sideA[itemMetric])}
                      </TableCell>
                      <TableCell className="text-right">
                        {renderValue(itemMetric, selectedItemMetric.kind, row.sideB[itemMetric])}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {renderValue(itemMetric, selectedItemMetric.kind, row.difference[itemMetric], true)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {data && data.itemRowCount > ITEM_PAGE_SIZE && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-xs text-muted-foreground">
                Page {itemPage} of {itemTotalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setItemPage((page) => Math.max(1, page - 1))}
                  disabled={itemPage <= 1}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" /> Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setItemPage((page) => Math.min(itemTotalPages, page + 1))}
                  disabled={itemPage >= itemTotalPages}
                >
                  Next <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
