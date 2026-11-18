import { ExportButton } from "@/components/export/ReportExportMenu";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, Layers3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtKg, fmtUsd, costPerKgUsd } from "../utils";
import { MultiSelectFilter } from "./MultiSelectFilter";
import { DiffCell } from "./DiffCell";
import { SupplierDailyTrend } from "./SupplierDailyTrend";
import type { ProductionComparisonModel } from "../useProductionComparisonModel";

export function SupplierMixSection({ m }: { m: ProductionComparisonModel }) {
  return (
    <>
      {(m.supplierBreakdownA.length > 0 || m.supplierBreakdownB.length > 0) && (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm dark:bg-[hsl(var(--factory-hue)_44%_11%)]">
          {/* Supplier comparison; all financial fields obey cost visibility. */}
          <div className="flex flex-col gap-3 border-b border-border/70 bg-gradient-to-r from-blue-500/[0.05] to-violet-500/[0.04] px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-300">
                <Layers3 className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h3 className="font-bold tracking-tight">Raw Material by Supplier</h3>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Mix batch usage · {m.labelA}: {fmtKg(m.totalSupAKg)} kg
                  {!m.costsHidden && <> / {fmtUsd(m.totalSupACost)}</>}
                  {" · "}
                  {m.labelB}: {fmtKg(m.totalSupBKg)} kg
                  {!m.costsHidden && <> / {fmtUsd(m.totalSupBCost)}</>}
                </p>
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <MultiSelectFilter
                options={m.allSuppliers}
                selected={m.filterSuppliers}
                onChange={m.setFilterSuppliers}
                placeholder="Suppliers"
                allLabel="All Suppliers"
                className="w-44 shrink-0"
              />
              <ExportButton
                kind="csv"
                variant="outline"
                size="sm"
                className="h-9 rounded-lg border-blue-500/30 bg-blue-600 text-white hover:bg-blue-700 hover:text-white dark:bg-blue-600 dark:hover:bg-blue-500"
                onClick={m.exportSupplierCsv}
                disabled={m.supplierSummary.length === 0}
                data-testid="button-export-supplier-comparison"
              />
            </div>
          </div>

          <Table mobileLayout="cards" className="text-xs" wrapperClassName="overflow-x-auto">
            <TableHeader>
              <TableRow className="bg-slate-100/80 hover:bg-slate-100/80 dark:bg-[hsl(var(--factory-hue)_44%_17%)] dark:hover:bg-[hsl(var(--factory-hue)_44%_17%)]">
                <TableHead className="w-9">#</TableHead>
                <TableHead className="min-w-[150px] font-semibold">Supplier</TableHead>
                <TableHead className="min-w-[105px] text-right font-semibold text-blue-700 dark:text-sky-300">
                  {m.labelA} · KG
                </TableHead>
                {!m.costsHidden && (
                  <TableHead className="text-right font-semibold text-blue-700 dark:text-sky-300">
                    {m.labelA} · Cost
                  </TableHead>
                )}
                {!m.costsHidden && (
                  <TableHead className="text-right font-semibold text-blue-700 dark:text-sky-300">
                    {m.labelA} · Rate/kg
                  </TableHead>
                )}
                <TableHead className="text-right font-semibold text-violet-700 dark:text-violet-300">
                  {m.labelB} · KG
                </TableHead>
                {!m.costsHidden && (
                  <TableHead className="text-right font-semibold text-violet-700 dark:text-violet-300">
                    {m.labelB} · Cost
                  </TableHead>
                )}
                {!m.costsHidden && (
                  <TableHead className="text-right font-semibold text-violet-700 dark:text-violet-300">
                    {m.labelB} · Rate/kg
                  </TableHead>
                )}
                <TableHead className="text-right font-semibold">KG Diff</TableHead>
                {!m.costsHidden && <TableHead className="text-right font-semibold">Cost Diff</TableHead>}
                <TableHead className="text-right font-semibold">% Change</TableHead>
                <TableHead className="text-right font-semibold">Daily Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.supplierSummary.map((row, index) => {
                const kd = row.aKg - row.bKg;
                const cd = row.aCost - row.bCost;
                const percent = row.bKg > 0 ? (kd / row.bKg) * 100 : null;
                return (
                  <TableRow
                    key={row.supplier}
                    className="border-border/40 transition-colors hover:bg-blue-500/[0.04] dark:hover:bg-blue-500/[0.08]"
                  >
                    <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                    <TableCell className="font-semibold">{row.supplier}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{fmtKg(row.aKg)} kg</TableCell>
                    {!m.costsHidden && (
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmtUsd(row.aCost)}
                      </TableCell>
                    )}
                    {!m.costsHidden && (
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {costPerKgUsd(row.aCost, row.aKg)}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{fmtKg(row.bKg)} kg</TableCell>
                    {!m.costsHidden && (
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmtUsd(row.bCost)}
                      </TableCell>
                    )}
                    {!m.costsHidden && (
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {costPerKgUsd(row.bCost, row.bKg)}
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <DiffCell value={kd} fmt={(n) => (n > 0 ? "+" : "") + fmtKg(n) + " kg"} />
                    </TableCell>
                    {!m.costsHidden && (
                      <TableCell className="text-right">
                        <DiffCell value={cd} fmt={(n) => (n > 0 ? "+" : "") + fmtUsd(Math.abs(n))} />
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      {percent == null ? (
                        <span className="text-muted-foreground">{row.aKg > 0 ? "New" : "—"}</span>
                      ) : (
                        <span
                          className={cn(
                            "font-semibold tabular-nums",
                            percent > 0
                              ? "text-emerald-600 dark:text-emerald-300"
                              : percent < 0
                                ? "text-red-500 dark:text-red-300"
                                : "text-muted-foreground"
                          )}
                        >
                          {percent > 0 ? "+" : ""}
                          {percent.toFixed(1)}%
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <SupplierDailyTrend rows={m.supplierBreakdownA} supplier={row.supplier} increased={kd >= 0} />
                    </TableCell>
                  </TableRow>
                );
              })}
              {m.supplierSummary.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={m.costsHidden ? 7 : 12}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    {m.hasSupplierFilter ? "No data for selected suppliers." : "No mix batch data."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {m.supplierSummary.length > 0 && (
              <TableFooter>
                <TableRow className="border-t-2 border-blue-500/30 bg-blue-600/10 font-bold hover:bg-blue-600/15 dark:bg-blue-600/20 dark:hover:bg-blue-600/25">
                  <TableCell className="text-blue-700 dark:text-blue-100">∑</TableCell>
                  <TableCell className="whitespace-nowrap font-bold text-blue-700 dark:text-blue-100">
                    Total ({m.supplierSummary.length} suppliers)
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums">{fmtKg(m.totalSupAKg)} kg</TableCell>
                  {!m.costsHidden && (
                    <TableCell className="text-right font-bold tabular-nums">{fmtUsd(m.totalSupACost)}</TableCell>
                  )}
                  {!m.costsHidden && (
                    <TableCell className="text-right font-bold tabular-nums">
                      {costPerKgUsd(m.totalSupACost, m.totalSupAKg)}
                    </TableCell>
                  )}
                  <TableCell className="text-right font-bold tabular-nums">{fmtKg(m.totalSupBKg)} kg</TableCell>
                  {!m.costsHidden && (
                    <TableCell className="text-right font-bold tabular-nums">{fmtUsd(m.totalSupBCost)}</TableCell>
                  )}
                  {!m.costsHidden && (
                    <TableCell className="text-right font-bold tabular-nums">
                      {costPerKgUsd(m.totalSupBCost, m.totalSupBKg)}
                    </TableCell>
                  )}
                  <TableCell className="text-right font-bold">
                    <DiffCell value={m.totalSupKgDiff} fmt={(n) => (n > 0 ? "+" : "") + fmtKg(n) + " kg"} />
                  </TableCell>
                  {!m.costsHidden && (
                    <TableCell className="text-right font-bold">
                      <DiffCell value={m.totalSupCostDiff} fmt={(n) => (n > 0 ? "+" : "") + fmtUsd(Math.abs(n))} />
                    </TableCell>
                  )}
                  <TableCell className="text-right font-bold tabular-nums">
                    {m.totalSupBKg > 0 ? ((m.totalSupKgDiff / m.totalSupBKg) * 100).toFixed(1) + "%" : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <SupplierDailyTrend rows={m.supplierBreakdownA} increased={m.totalSupKgDiff >= 0} />
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>

          {/* Daily detail (collapsible-style: always shown when ≤30 rows, hidden behind toggle otherwise) */}
          {m.dailyBreakdown.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none select-none items-center gap-2 border-t border-border/70 bg-muted/20 px-4 py-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/40">
                <ChevronDown className="h-3.5 w-3.5 group-open:rotate-180 transition-transform" />
                Per-day breakdown ({m.dailyBreakdown.length} rows)
              </summary>
              <div className="overflow-x-auto">
                <Table mobileLayout="cards">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[110px]">Date</TableHead>
                      <TableHead className="w-[80px]">Period</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead className="text-right">kg Used</TableHead>
                      {!m.costsHidden && <TableHead className="text-right">Cost</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {m.dailyBreakdown.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="tabular-nums text-sm">{r.date}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs font-normal">
                            {r.period}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-medium text-sm">{r.supplierName}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{fmtKg(r.totalKg)} kg</TableCell>
                        {!m.costsHidden && (
                          <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                            {fmtUsd(r.totalCost ?? 0)}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          )}
        </div>
      )}
    </>
  );
}
