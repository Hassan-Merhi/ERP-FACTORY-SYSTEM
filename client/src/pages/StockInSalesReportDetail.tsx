import { useLocation } from "wouter";
import { PackageMinus, PackagePlus, RefreshCw, TrendingDown } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { ErpReportExportMenu, ErpReportPrintFooter } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { useStockInSalesReportDetailModel } from "./StockInSalesReportDetailModel";
import { breakdownTitle, profitClassName } from "./StockInSalesReportDetailModel";

export default function StockInSalesReportDetail() {
  const [, navigate] = useLocation();
  const m = useStockInSalesReportDetailModel();

  if (!m.startDate || !m.endDate) {
    return (
      <div className="container mx-auto p-0 sm:p-6">
        <PageHeader title="Stock Flow Details" />
        <p className="mt-3 text-sm text-muted-foreground">A valid report period is required.</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate("/stock-in-sales-report")}>
          Back to report
        </Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-6 p-0 sm:p-6">
      <PageHeader
        title="Stock Flow Details"
        onBack={() => window.history.back()}
        meta={
          <span>
            {m.periodLabel}
            {m.selectedCompany?.name ? ` · ${m.selectedCompany.name}` : ""}
          </span>
        }
      >
        <ErpReportExportMenu
          size="sm"
          className="gap-2 print:hidden"
          busy={m.isExporting}
          disabled={m.isLoading}
          options={[
            { id: "stock-flow-excel", label: "Export Excel", kind: "excel", onSelect: m.exportExcel },
            { id: "stock-flow-print", label: "Print", kind: "print", onSelect: () => window.print() },
          ]}
        />
      </PageHeader>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {m.isLoading ? (
          Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-[98px] rounded-xl" />)
        ) : (
          <>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Opening Stock</p>
              <div className="mt-auto grid grid-cols-2 gap-3 pt-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Qty</p>
                  <p className="mt-1 whitespace-nowrap font-mono text-[17px] font-semibold leading-none tracking-tight tabular-nums">
                    {formatNumber(m.summary.openingStockQty, 0)}
                  </p>
                </div>
                <div className="min-w-0 text-right">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Value</p>
                  <p className="mt-1 whitespace-nowrap font-mono text-[15px] font-semibold leading-none tracking-tight tabular-nums 2xl:text-[16px]">
                    {m.roundedMoney(m.summary.openingStockValue)}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Stock In Qty</p>
              <p className="mt-auto whitespace-nowrap pt-3 font-mono text-[19px] font-semibold leading-none tracking-tight tabular-nums">
                {formatNumber(m.summary.stockInQty, 0)}
              </p>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Stock Out</p>
              <p className="mt-auto whitespace-nowrap pt-3 font-mono text-[19px] font-semibold leading-none tracking-tight tabular-nums">
                {formatNumber(m.summary.stockOutQty, 0)}
              </p>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Closing / In Hand</p>
              <div className="mt-auto grid grid-cols-2 gap-3 pt-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Qty</p>
                  <p className="mt-1 whitespace-nowrap font-mono text-[17px] font-semibold leading-none tracking-tight tabular-nums">
                    {formatNumber(m.summary.closingStockQty, 0)}
                  </p>
                </div>
                <div className="min-w-0 text-right">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Value</p>
                  <p className="mt-1 whitespace-nowrap font-mono text-[15px] font-semibold leading-none tracking-tight tabular-nums 2xl:text-[16px]">
                    {m.roundedMoney(m.summary.closingStockValue)}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Gross Profit</p>
              <p className="mt-auto whitespace-nowrap pt-3 font-mono text-[19px] font-semibold leading-none tracking-tight tabular-nums">
                {m.roundedMoney(m.summary.costProfit)}
              </p>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Avg Profit / Bale</p>
              <p className="mt-auto whitespace-nowrap pt-3 font-mono text-[19px] font-semibold leading-none tracking-tight tabular-nums">
                {m.roundedMoney(m.summary.avgProfitPerBale)}
              </p>
            </div>
          </>
        )}
      </div>

      {m.isFetching && !m.isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground print:hidden">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Refreshing details
        </div>
      )}

      {m.isError ? (
        <div className="rounded-xl border border-destructive/30 p-8 text-center">
          <TrendingDown className="mx-auto h-6 w-6 text-destructive" />
          <p className="mt-3 text-sm font-medium">Unable to load details</p>
          <p className="mt-1 text-xs text-muted-foreground">{m.error?.message}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => m.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <PackagePlus className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Container Stock In</h2>
              <span className="text-xs text-muted-foreground">
                {formatNumber(m.groupedStockIn.length, 0)} items · merged across all offloads
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border">
              <div className="max-h-[520px] overflow-auto">
                <Table className="min-w-[900px]" mobileLayout="cards">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Date</TableHead>
                      <TableHead>Container</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avg Rate</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {m.isLoading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={7}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : m.groupedStockIn.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                          No direct container offloads found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      <>
                        {m.groupedStockIn.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell
                              title={
                                row.dates.length > 1
                                  ? `Offloaded on:\n${row.dates.map(m.displayDate).join("\n")}`
                                  : undefined
                              }
                              className={
                                row.dates.length > 1 ? "cursor-help underline decoration-dotted underline-offset-4" : ""
                              }
                            >
                              {row.dates.length === 1 ? m.displayDate(row.dates[0]) : `${row.dates.length} dates`}
                            </TableCell>
                            <TableCell
                              className="cursor-help font-mono underline decoration-dotted underline-offset-4"
                              title={breakdownTitle("Containers / Qty", row.containers)}
                            >
                              {formatNumber(row.containers.length, 0)}{" "}
                              {row.containers.length === 1 ? "container" : "containers"}
                            </TableCell>
                            <TableCell
                              className={
                                row.locations.length > 1
                                  ? "cursor-help underline decoration-dotted underline-offset-4"
                                  : ""
                              }
                              title={
                                row.locations.length > 1 ? breakdownTitle("Locations / Qty", row.locations) : undefined
                              }
                            >
                              {row.locations.length === 1
                                ? row.locations[0].name
                                : `${formatNumber(row.locations.length, 0)} locations`}
                            </TableCell>
                            <TableCell className="font-medium">{row.stockItemName}</TableCell>
                            <TableCell className="text-right font-mono">{formatNumber(row.quantity, 0)}</TableCell>
                            <TableCell className="text-right font-mono">{m.rate(row.avgRate)}</TableCell>
                            <TableCell className="text-right font-mono">{m.formatAmount(row.totalValue)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="sticky bottom-0 z-10 border-t-2 bg-muted/95 font-semibold hover:bg-muted/95">
                          <TableCell colSpan={4} className="uppercase tracking-wide">
                            Total
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatNumber(m.stockInTotals.quantity, 0)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className="text-right font-mono">
                            {m.formatAmount(m.stockInTotals.value)}
                          </TableCell>
                        </TableRow>
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <PackagePlus className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Stock Adjustments</h2>
              <span className="text-xs text-muted-foreground">
                {formatNumber(m.adjustmentRows.length, 0)} lines · In {formatNumber(m.adjustmentTotals.inQty, 0)} · Out{" "}
                {formatNumber(m.adjustmentTotals.outQty, 0)}
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border">
              <div className="max-h-[420px] overflow-auto">
                <Table className="min-w-[1050px]" mobileLayout="cards">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Date</TableHead>
                      <TableHead>Voucher</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {m.isLoading ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={9}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : m.adjustmentRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                          No stock adjustments found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      m.adjustmentRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{m.displayDate(row.activityDate)}</TableCell>
                          <TableCell className="font-mono">{row.voucherNumber}</TableCell>
                          <TableCell>{row.adjustmentType}</TableCell>
                          <TableCell className="font-medium">
                            {row.direction === "In" ? "Stock In" : "Stock Out"}
                          </TableCell>
                          <TableCell>{row.locationName}</TableCell>
                          <TableCell className="font-medium">{row.stockItemName}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(row.quantity, 0)}</TableCell>
                          <TableCell className="text-right font-mono">{m.rate(row.unitRate)}</TableCell>
                          <TableCell className="text-right font-mono">{m.formatAmount(row.totalValue)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <PackageMinus className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Sales</h2>
              <span className="text-xs text-muted-foreground">
                {formatNumber(m.groupedSales.length, 0)} item/day totals
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border">
              <div className="max-h-[520px] overflow-auto">
                <Table className="min-w-[1100px]" mobileLayout="cards">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Date</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avg Rate</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="text-right">Profit / Bale</TableHead>
                      <TableHead className="text-right">Total Profit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {m.isLoading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={8}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : m.groupedSales.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                          No sales found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      <>
                        {m.groupedSales.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell>{m.displayDate(row.activityDate)}</TableCell>
                            <TableCell
                              className={
                                row.locations.length > 1
                                  ? "cursor-help underline decoration-dotted underline-offset-4"
                                  : ""
                              }
                              title={
                                row.locations.length > 1
                                  ? breakdownTitle("Locations / Qty Sold", row.locations)
                                  : undefined
                              }
                            >
                              {row.locations.length === 1
                                ? row.locations[0].name
                                : `${formatNumber(row.locations.length, 0)} locations`}
                            </TableCell>
                            <TableCell className="font-medium">{row.stockItemName}</TableCell>
                            <TableCell className="text-right font-mono">{formatNumber(row.quantity, 0)}</TableCell>
                            <TableCell className="text-right font-mono">{m.rate(row.avgRate)}</TableCell>
                            <TableCell className="text-right font-mono">{m.formatAmount(row.totalValue)}</TableCell>
                            <TableCell
                              className={`text-right font-mono font-medium ${profitClassName(row.profitPerBale)}`}
                            >
                              {m.rate(row.profitPerBale)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-mono font-medium ${profitClassName(row.totalProfit)}`}
                            >
                              {m.formatAmount(row.totalProfit)}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="sticky bottom-0 z-10 border-t-2 bg-muted/95 font-semibold hover:bg-muted/95">
                          <TableCell colSpan={3} className="uppercase tracking-wide">
                            Total
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatNumber(m.salesTotals.quantity, 0)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className="text-right font-mono">{m.formatAmount(m.salesTotals.value)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className={`text-right font-mono ${profitClassName(m.salesTotals.totalProfit)}`}>
                            {m.formatAmount(m.salesTotals.totalProfit)}
                          </TableCell>
                        </TableRow>
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>
        </>
      )}

      {(m.data?.stockIn.truncated || m.data?.stockOut.truncated || m.data?.adjustments?.truncated) && (
        <p className="text-xs text-amber-600">
          Detail data reached the 20,000-line safety limit; totals above remain based on the report summary.
        </p>
      )}

      <ErpReportPrintFooter
        title="Stock Flow Details"
        companyName={m.selectedCompany?.name}
        fromDate={m.startDate}
        toDate={m.endDate}
      />
    </div>
  );
}
