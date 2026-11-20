import {
  ChevronRight,
  Coins,
  GitCompare,
  PackageMinus,
  PackagePlus,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { ErpListTable, ErpReportExportMenu, ErpReportPrintFooter } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { PeriodFilter } from "@/components/ui/period-filter";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";

import StockInSalesReportComparison from "./StockInSalesReportComparison";
import StockInSalesReportDetail from "./StockInSalesReportDetail";
import { MultiSelectFilter, SummaryPill } from "./StockInSalesReportFilters";
import { useStockInSalesReportSummaryModel } from "./StockInSalesReportSummaryModel";

export default function StockInSalesReport() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "detail") return <StockInSalesReportDetail />;
  if (view === "comparison") return <StockInSalesReportComparison />;
  return <StockInSalesReportSummary />;
}

function StockInSalesReportSummary() {
  const m = useStockInSalesReportSummaryModel();

  return (
    <div className="container mx-auto space-y-5 p-0 sm:p-6">
      <PageHeader
        title="Stock & Sales Report"
        onBack={() => m.navigate("/sales-report")}
        backButtonTestId="button-back-stock-in-sales"
        meta={<span>Stock and sales overview{m.selectedCompany?.name ? ` · ${m.selectedCompany.name}` : ""}</span>}
      >
        <Button variant="outline" size="sm" onClick={m.openComparison} data-testid="button-stock-in-sales-compare">
          <GitCompare className="mr-2 h-4 w-4" /> Compare
        </Button>
        <ErpReportExportMenu
          size="sm"
          className="gap-2"
          busy={m.isExporting}
          disabled={m.rows.length === 0 || m.isFetching || m.isLoading}
          options={[
            { id: "stock-sales-excel", label: "Export Excel", kind: "excel", onSelect: m.exportExcel },
            { id: "stock-sales-csv", label: "Export CSV", kind: "csv", onSelect: m.exportCsv },
            { id: "stock-sales-print", label: "Print", kind: "print", onSelect: () => window.print() },
          ]}
        />
      </PageHeader>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" aria-busy={m.isLoading || m.isFetching}>
        {m.isLoading ? (
          Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-14 rounded-lg" />)
        ) : (
          <>
            <SummaryPill
              label="Opening Stock"
              value={formatNumber(m.summary.openingStockQty, 0)}
              icon={PackagePlus}
              testId="text-opening-stock-qty"
            />
            <SummaryPill
              label="Stock In"
              value={formatNumber(m.summary.stockInQty, 0)}
              icon={PackagePlus}
              testId="text-stock-in-qty"
            />
            <SummaryPill
              label="Stock in Hand"
              value={formatNumber(m.summary.closingStockQty, 0)}
              icon={PackageMinus}
              testId="text-stock-in-hand-qty"
            />
            <SummaryPill
              label="Stock Value"
              value={m.formatRoundedAmount(m.summary.closingStockValue)}
              icon={Coins}
              testId="text-stock-in-hand-value"
            />
            <SummaryPill
              label="Sales"
              value={m.formatRoundedAmount(m.summary.totalSales)}
              icon={TrendingUp}
              testId="text-stock-in-sales-total-sales"
            />
            <SummaryPill
              label="Gross Profit"
              value={m.formatSignedRoundedAmount(m.summary.costProfit)}
              icon={m.summary.costProfit < 0 ? TrendingDown : TrendingUp}
              tone={m.profitTone}
              testId="text-stock-in-sales-profit"
            />
          </>
        )}
      </div>

      <ErpMobileFilters
        label="Stock in and sales filters"
        className="print:hidden"
        primary={
          <PeriodFilter
            value={m.periodFilter}
            onChange={m.setPeriodFilter}
            data-testid="period-filter-stock-in-sales-report"
          />
        }
        quick={<SearchField placeholder="Search items..." value={m.searchTerm} onValueChange={m.setSearchTerm} />}
        activeCount={m.stockInSalesActiveFilterCount}
        onClear={m.clearFilters}
        canClear={m.stockInSalesActiveFilterCount > 0 || !!m.searchTerm || m.periodFilter.preset !== "this_year"}
        data-testid="stock-in-sales-filters"
      >
        {(layout) =>
          layout === "sheet" ? (
            <div className="grid gap-3">
              <MultiSelectFilter
                label="Locations"
                singularLabel="Location"
                items={m.sortedLocations}
                selectedIds={m.selectedLocations}
                onChange={m.setSelectedLocations}
                testId="button-stock-in-sales-location-filter"
              />
              <MultiSelectFilter
                label="Groups"
                singularLabel="Group"
                items={m.sortedStockGroups}
                selectedIds={m.selectedStockGroups}
                onChange={m.setSelectedStockGroups}
                testId="button-stock-in-sales-group-filter"
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <PeriodFilter
                value={m.periodFilter}
                onChange={m.setPeriodFilter}
                data-testid="period-filter-stock-in-sales-report"
              />
              <MultiSelectFilter
                label="Locations"
                singularLabel="Location"
                items={m.sortedLocations}
                selectedIds={m.selectedLocations}
                onChange={m.setSelectedLocations}
                testId="button-stock-in-sales-location-filter"
              />
              <MultiSelectFilter
                label="Groups"
                singularLabel="Group"
                items={m.sortedStockGroups}
                selectedIds={m.selectedStockGroups}
                onChange={m.setSelectedStockGroups}
                testId="button-stock-in-sales-group-filter"
              />
              <SearchField
                placeholder="Search items..."
                value={m.searchTerm}
                onValueChange={m.setSearchTerm}
                wrapperClassName="w-48"
                className="h-9"
              />
              <Button variant="ghost" size="sm" onClick={m.clearFilters}>
                Clear
              </Button>
              {m.isFetching && !m.isLoading && (
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Refreshing" />
              )}
            </div>
          )
        }
      </ErpMobileFilters>

      <div>
        <p className="mb-3 text-xs text-muted-foreground">
          {m.grouping === "daily"
            ? "Daily stock movement and profitability · Click a day for that day's full details"
            : m.grouping === "yearly"
              ? "Yearly stock movement and profitability · Click a year for full details"
              : "Monthly stock movement and profitability · Click a month for full details"}
        </p>
        <div className="overflow-hidden rounded-xl border max-sm:overflow-visible max-sm:border-0">
          <div className="overflow-x-auto">
            <ErpListTable
              pageKey="stock-in-sales-report"
              companyId={m.selectedCompany?.id}
              className="min-w-[900px]"
              mobileLayout="cards"
              scrollLabel="Stock and sales reporting"
            >
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>{m.periodColumnLabel}</TableHead>
                  <TableHead className="text-right">Opening</TableHead>
                  <TableHead className="text-right">Stock In</TableHead>
                  <TableHead className="text-right">Stock Out</TableHead>
                  <TableHead className="text-right">Stock in Hand</TableHead>
                  <TableHead className="text-right">Stock Value</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">Gross Profit</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.isLoading ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <TableRow key={index}>
                      {Array.from({ length: 9 }).map((__, cellIndex) => (
                        <TableCell key={cellIndex}>
                          <Skeleton className={`h-4 ${cellIndex === 0 ? "w-28" : "ml-auto w-20"}`} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : m.isError ? (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <div className="flex flex-col items-center gap-3 py-10 text-center">
                        <TrendingDown className="h-6 w-6 text-destructive" />
                        <p className="text-sm font-medium">Unable to load the report</p>
                        <p className="text-xs text-muted-foreground">{m.error?.message}</p>
                        <Button variant="outline" size="sm" onClick={() => m.refetch()}>
                          Retry
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : m.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                      No stock or sales activity found for these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {m.rows.map((row) => {
                      const profitClass =
                        row.costProfit > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : row.costProfit < 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-muted-foreground";
                      return (
                        <TableRow
                          key={row.periodKey}
                          className="cursor-pointer hover:bg-muted/40"
                          onClick={() => m.openDetail(row)}
                        >
                          <TableCell className="py-3 font-medium">{m.formatPeriodLabel(row)}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(row.openingStockQty, 0)}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(row.stockInQty, 0)}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(row.stockOutQty, 0)}</TableCell>
                          <TableCell className="text-right font-mono font-semibold">
                            {formatNumber(row.closingStockQty, 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {m.formatAmount(row.closingStockValue)}
                          </TableCell>
                          <TableCell className="text-right font-mono">{m.formatAmount(row.totalSales)}</TableCell>
                          <TableCell className={`text-right font-mono font-semibold ${profitClass}`}>
                            {m.formatSignedAmount(row.costProfit)}
                          </TableCell>
                          <TableCell>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                      <TableCell className="text-xs uppercase tracking-wide text-muted-foreground">Total</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatNumber(m.summary.openingStockQty, 0)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(m.summary.stockInQty, 0)}</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(m.summary.stockOutQty, 0)}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatNumber(m.summary.closingStockQty, 0)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {m.formatAmount(m.summary.closingStockValue)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{m.formatAmount(m.summary.totalSales)}</TableCell>
                      <TableCell className="text-right font-mono">
                        {m.formatSignedAmount(m.summary.costProfit)}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </>
                )}
              </TableBody>
            </ErpListTable>
          </div>
        </div>
      </div>

      <ErpReportPrintFooter
        title="Stock & Sales Report"
        companyName={m.selectedCompany?.name}
        fromDate={m.periodFilter.fromDate}
        toDate={m.periodFilter.toDate}
      />
    </div>
  );
}
