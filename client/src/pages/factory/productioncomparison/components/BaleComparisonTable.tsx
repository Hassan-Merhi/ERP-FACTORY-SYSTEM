import type { ProductionComparisonModel } from "../useProductionComparisonModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtKg, fmtNum } from "../utils";
import { DiffCell } from "./DiffCell";
import { WorkerSummaryHover } from "./WorkerSummaryHover";

export function BaleComparisonTable({ m }: { m: ProductionComparisonModel }) {
  return (
    <>
      {/* ── Bale comparison table ── */}
      {m.filtered.length === 0 ? (
        <div className="rounded-xl border p-12 text-center text-sm text-muted-foreground">
          {m.mergedAll.length === 0
            ? "No production data found for either period."
            : "No products match the active filters."}
        </div>
      ) : (
        <div className="space-y-2">
          {/* Phones read one card per product by default; the full matrix stays one tap away. */}
          {m.isPhoneLayout && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={m.phoneTableView}
                onClick={() => m.setPhoneTableView((current) => !current)}
                data-testid="button-comparison-table-view"
              >
                {m.phoneTableView ? "Card view" : "Table view"}
              </Button>
            </div>
          )}
          <div
            className={cn(
              "overflow-hidden",
              !m.comparisonCards.cards && "rounded-2xl border border-border/70 bg-card shadow-sm"
            )}
          >
            <div className="overflow-x-auto">
              <table
                className="w-full border-collapse text-sm"
                {...m.comparisonCards.tableProps}
                data-testid="table-production-comparison"
              >
                <thead>
                  {/* Group row */}
                  <tr className="border-b border-border bg-blue-500/[0.055] dark:bg-[hsl(var(--factory-hue)_48%_16%)]">
                    <th
                      rowSpan={2}
                      className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground min-w-[200px] border-r border-border/50 align-bottom"
                    >
                      Product
                    </th>
                    <th
                      rowSpan={2}
                      className="px-3 py-3 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground border-r border-border/50 align-bottom min-w-[180px]"
                    >
                      Product (Arabic)
                    </th>
                    <th
                      rowSpan={2}
                      className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground border-r border-border/50 align-bottom"
                    >
                      Category
                    </th>
                    <th
                      rowSpan={2}
                      className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground border-r border-border/50 align-bottom"
                    >
                      Grade
                    </th>
                    <th
                      rowSpan={2}
                      className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground border-r border-border/50 align-bottom min-w-[100px]"
                    >
                      Workers
                    </th>
                    <th
                      colSpan={3}
                      className="px-4 py-2 text-center text-xs font-bold uppercase tracking-widest text-blue-600 dark:text-blue-400 border-b border-border/50 border-r border-border/50"
                    >
                      Quantity (Bales)
                    </th>
                    <th
                      colSpan={3}
                      className="px-4 py-2 text-center text-xs font-bold uppercase tracking-widest text-violet-600 dark:text-violet-400 border-b border-border/50"
                    >
                      Weight (kg)
                    </th>
                  </tr>
                  {/* Sub-header row */}
                  <tr className="border-b border-border bg-violet-500/[0.035] dark:bg-[hsl(var(--factory-hue)_47%_15%)]">
                    <th className="px-4 py-2 text-right text-xs font-semibold text-foreground whitespace-nowrap">
                      {m.labelA}
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap">
                      {m.labelB}
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-foreground border-r border-border/50">
                      Diff
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-foreground whitespace-nowrap">
                      {m.labelA}
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap">
                      {m.labelB}
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-foreground">Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {m.filtered.map((row, idx) => {
                    const qDiff = row.aQty - row.bQty;
                    const kDiff = row.aKg - row.bKg;
                    const workerSummary = m.workerSummaryByArticle.get(row.articleCode) ?? [];
                    const arabicName = m.arabicNameByArticle.get(row.articleCode.trim().toUpperCase()) ?? "";
                    return (
                      <tr
                        key={row.articleCode}
                        className={cn(
                          "border-b border-border/30 hover:bg-accent/40 transition-colors",
                          idx % 2 === 1 && "bg-muted/10"
                        )}
                      >
                        <td className="px-4 py-2.5 border-r border-border/30">
                          <span className="font-medium text-sm leading-snug">{row.productName || row.articleCode}</span>
                        </td>
                        <td
                          className="px-3 py-2.5 text-sm text-right border-r border-border/30 min-w-[180px]"
                          dir="rtl"
                        >
                          <span className={arabicName ? "font-medium" : "text-muted-foreground"}>
                            {arabicName || "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-sm text-muted-foreground border-r border-border/30">
                          {row.categoryName || "—"}
                        </td>
                        <td className="px-3 py-2.5 border-r border-border/30">
                          {row.grade !== "—" ? (
                            <Badge variant="secondary" className="text-xs font-semibold px-2">
                              {row.grade}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 border-r border-border/30">
                          <WorkerSummaryHover workers={workerSummary} labelA={m.labelA} labelB={m.labelB} />
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-foreground">
                          {fmtNum(row.aQty)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {fmtNum(row.bQty)}
                        </td>
                        <td className="px-4 py-2.5 text-right border-r border-border/30">
                          <DiffCell value={qDiff} fmt={(n) => (n > 0 ? "+" : "") + fmtNum(n)} />
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-foreground">
                          {fmtKg(row.aKg)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtKg(row.bKg)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <DiffCell value={kDiff} fmt={(n) => (n > 0 ? "+" : "") + fmtKg(n)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
