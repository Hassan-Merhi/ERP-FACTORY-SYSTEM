// Extracted from ./ProductionTabPanel.tsx to keep that module under the source-size cap.
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FlaskConical, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { fmtKg, fmtMoney } from "../utils";
import { ExpandableCard } from "./ExpandableCard";
import { useProductionTabPanelState } from "./ProductionTabPanelSection";

export function ProductionTabPanelCardSummaryBar({
  data,
  isLoading,
  isOwner,
  productionProfitMarginPct,
  productionProfitValue,
  showMoneySummary,
  valuationMode,
}: Pick<
  ReturnType<typeof useProductionTabPanelState>,
  | "data"
  | "isLoading"
  | "isOwner"
  | "productionProfitMarginPct"
  | "productionProfitValue"
  | "showMoneySummary"
  | "valuationMode"
>) {
  return (
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
            {showMoneySummary && (
              <div className="production-premium-metrics">
                {(!isOwner || valuationMode === "cost") && (
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
                )}
                {!isOwner && (
                  <>
                    <div className="w-px h-5 bg-border" />
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Weight Cost
                      </span>
                      <span className="text-base font-bold" data-testid="text-weight-cost">
                        {fmtMoney(data?.summary.weightCost ?? data?.summary.batchCost ?? 0)}
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
                  </>
                )}
              </div>
            )}

            {/* Missing-price diagnostics are intentionally not shown in the Production Overview UI. */}

            {/* Row 2 — weight breakdown */}
            {(() => {
              const origKg = data?.rawMaterial.totalWeightKg ?? 0;
              const productionsKg = (data?.production.totalWeightKg ?? 0) + (data?.wipersGarbage.totalWeightKg ?? 0);
              // Total = Productions − Original Batches (material consumed → finished goods + waste)
              const totalKg = productionsKg - origKg;
              const isPositive = totalKg >= 0;
              return (
                <div
                  className={
                    showMoneySummary
                      ? "production-premium-weights flex flex-wrap items-center gap-5 pt-2 border-t border-border"
                      : "production-premium-weights flex flex-wrap items-center gap-5"
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
  );
}

export function ProductionTabPanelExpandableCardSection({
  costsHidden,
  data,
  isLoading,
  setSelectedMixBatchId,
}: Pick<
  ReturnType<typeof useProductionTabPanelState>,
  "costsHidden" | "data" | "isLoading" | "setSelectedMixBatchId"
>) {
  return (
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
                <TableRow
                  key={b.id}
                  data-testid={`row-batch-${b.id}`}
                  className="cursor-pointer hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  role="button"
                  tabIndex={0}
                  aria-label={`View mix batch ${b.batchCode} details`}
                  onClick={() => setSelectedMixBatchId(b.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedMixBatchId(b.id);
                    }
                  }}
                >
                  <TableCell className="font-mono text-sm text-primary hover:underline">{b.batchCode}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{b.name || "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {b.batchDate || b.createdAt?.slice(0, 10) || "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmtKg(parseFloat(b.totalWeightKg))}</TableCell>
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
  );
}
