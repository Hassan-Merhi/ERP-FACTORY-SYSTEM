import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { PeriodFilter } from "@/components/ui/period-filter";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";

import { PageHeader } from "@/components/PageHeader";
import { ErpReportExportMenu, ErpReportPrintFooter } from "@/erp-core";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, TrendingDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/formatNumber";
import { ErrorState } from "@/components/ui/page-state";

import { SalesReportFilterControls } from "./salesreportlegacy/SalesReportFilterControls";
import { useSalesReportLegacyModel } from "./SalesReportLegacyModel";

export default function SalesReport() {
  const sr = useSalesReportLegacyModel();

  return (
    <div className="container mx-auto space-y-6 p-0 sm:p-6">
      {/* Header */}
      <PageHeader
        title="Sales Report"
        subtitle="Analyze profit and loss from POS transactions"
        meta={sr.isMultiCompanyMode ? <span>All Companies</span> : undefined}
      >
        <ErpReportExportMenu
          size="sm"
          className="gap-2"
          disabled={sr.groupedData.length === 0}
          data-testid="button-export-dropdown"
          options={[
            {
              id: "sales-excel",
              testId: "menu-export-excel",
              label: "Export Excel",
              kind: "excel",
              onSelect: sr.handleExportExcel,
            },
            {
              id: "sales-print",
              testId: "menu-export-pdf",
              label: "Print",
              kind: "print",
              onSelect: sr.handleExportPDF,
            },
          ]}
        />
      </PageHeader>

      {/* Summary Pills */}
      <div className="flex flex-wrap gap-2">
        {sr.isLoading ? (
          <>
            <Skeleton className="h-9 w-36 rounded-lg" />
            <Skeleton className="h-9 w-36 rounded-lg" />
            <Skeleton className="h-9 w-40 rounded-lg" />
            <Skeleton className="h-9 w-40 rounded-lg" />
            <Skeleton className="h-9 w-44 rounded-lg" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground text-xs">Total Sales</span>
              <span className="font-semibold font-mono text-sm" data-testid="text-total-sales">
                {sr.formatAmount(sr.totals.totalSales)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              <span className="text-muted-foreground text-xs">Cost Price</span>
              <span className="font-semibold font-mono text-sm" data-testid="text-total-cost">
                {sr.formatAmount(sr.totals.totalCost)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              {sr.displayedCostProfit >= 0 ? (
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5 text-red-500" />
              )}
              <span className="text-muted-foreground text-xs">Cost Profit</span>
              <span
                className={`font-semibold font-mono text-sm ${sr.displayedCostProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                data-testid="text-cost-profit"
                title={sr.isAllTimeReconciliationView ? sr.cogsReconciliation?.formula : undefined}
              >
                {sr.displayedCostProfit < 0 ? "-" : ""}
                {sr.formatAmount(Math.abs(sr.displayedCostProfit))}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              <span className="text-muted-foreground text-xs">Hassan's Price</span>
              <span className="font-semibold font-mono text-sm" data-testid="text-configured-cost">
                {sr.formatAmount(sr.totals.totalConfiguredCost)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              {sr.totals.configuredProfit >= 0 ? (
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5 text-red-500" />
              )}
              <span className="text-muted-foreground text-xs">Hassan's Profit</span>
              <span
                className={`font-semibold font-mono text-sm ${sr.totals.configuredProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                data-testid="text-configured-profit"
              >
                {sr.totals.configuredProfit < 0 ? "-" : ""}
                {sr.formatAmount(Math.abs(sr.totals.configuredProfit))}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Unified filter bar (phones: period + search + Filters sheet) */}
      <ErpMobileFilters
        label="Sales report filters"
        primary={
          <PeriodFilter
            value={sr.periodFilter}
            onChange={sr.setPeriodFilter}
            data-testid="period-filter-sales-report"
          />
        }
        quick={
          <Input
            placeholder="Search..."
            value={sr.searchTerm}
            onChange={(e) => sr.setSearchTerm(e.target.value)}
            className="w-full"
            data-testid="input-search"
          />
        }
        activeCount={sr.salesReportActiveFilterCount}
        onClear={sr.handleClearFilters}
        canClear={sr.salesReportActiveFilterCount > 0 || !!sr.searchTerm}
        data-testid="sales-report-filters"
      >
        {(layout) =>
          layout === "sheet" ? (
            <div className="grid gap-3">
              <SalesReportFilterControls {...sr.salesReportFilterControls} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {/* Date period */}
              <PeriodFilter
                value={sr.periodFilter}
                onChange={sr.setPeriodFilter}
                data-testid="period-filter-sales-report"
              />

              <SalesReportFilterControls {...sr.salesReportFilterControls} showSeparator />

              {/* Search */}
              <Input
                placeholder="Search..."
                value={sr.searchTerm}
                onChange={(e) => sr.setSearchTerm(e.target.value)}
                className="w-40 h-9"
                data-testid="input-search"
              />

              {/* Clear — only when filters are active */}
              {(sr.searchTerm ||
                sr.selectedLocations.length > 0 ||
                sr.selectedStockGroups.length > 0 ||
                sr.profitFilter !== "all") && (
                <Button variant="ghost" size="sm" onClick={sr.handleClearFilters} data-testid="button-clear-filters">
                  Clear
                </Button>
              )}
            </div>
          )
        }
      </ErpMobileFilters>

      {/* Data Table */}
      <div>
        <p className="text-xs text-muted-foreground mb-3">
          Sales by {sr.grouping.charAt(0).toUpperCase() + sr.grouping.slice(1)}
          {sr.filteredGroupedData.length > 0 &&
            ` · ${sr.filteredGroupedData.length} row${sr.filteredGroupedData.length !== 1 ? "s" : ""}`}
          {" · "}Click any row to drill in
        </p>
        <div className="border rounded-xl overflow-hidden max-sm:overflow-visible max-sm:border-0">
          <div className="overflow-x-auto">
            <Table mobileLayout="cards">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="text-xs h-9 font-semibold">Date</TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">Items</TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right">Qty</TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right">Total Sales</TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">
                    Cost Price
                  </TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">
                    Cost Profit
                  </TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">
                    Hassan's Price
                  </TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">
                    Hassan's Profit
                  </TableHead>
                  <TableHead className="text-xs h-9 w-8"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sr.isLoading ? (
                  [...Array(6)].map((_, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-8 ml-auto" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-10 ml-auto" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-16 ml-auto" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-16 ml-auto" />
                      </TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  ))
                ) : sr.isError ? (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <ErrorState
                        title="Sales report unavailable"
                        description="The sales data could not be loaded for this period."
                        actionLabel="Retry report"
                        onAction={() => void sr.refetchReport()}
                      />
                    </TableCell>
                  </TableRow>
                ) : sr.filteredGroupedData.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <div className="flex flex-col items-center gap-2 py-10 text-center">
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                          <TrendingUp className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <p className="text-sm font-medium">No sales found</p>
                        <p className="text-xs text-muted-foreground">Try adjusting your date range or filters</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {sr.filteredGroupedData.map((group) => (
                      <TableRow
                        key={group.date}
                        data-testid={`row-sale-${group.date}`}
                        className={`cursor-pointer hover:bg-muted/40${sr.selectedRowDate === group.date ? " bg-muted/40" : ""}`}
                        onClick={() => sr.handleRowClick(group)}
                      >
                        <TableCell className="font-medium py-3">
                          <div className="flex items-center gap-2">
                            {group.displayDate}
                            {group.hasMixedSales ? (
                              <Badge
                                variant="secondary"
                                className="text-xs no-default-active-elevate bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
                              >
                                Credit + Cash
                              </Badge>
                            ) : group.isCreditSale ? (
                              <Badge
                                variant="secondary"
                                className="text-xs no-default-active-elevate bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                              >
                                Credit
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm hidden sm:table-cell">
                          {formatNumber(group.itemCount, 0)}
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm">
                          {formatNumber(group.totalQty, 0)}
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm">
                          {sr.formatAmount(group.totalSales)}
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm text-muted-foreground hidden sm:table-cell">
                          {sr.formatAmount(group.totalCost)}
                        </TableCell>
                        <TableCell
                          className={`py-3 text-right font-mono text-sm font-semibold hidden sm:table-cell ${group.costProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                        >
                          {group.costProfit < 0 ? "-" : ""}
                          {sr.formatAmount(Math.abs(group.costProfit))}
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm text-muted-foreground hidden sm:table-cell">
                          {sr.formatAmount(group.totalConfiguredCost)}
                        </TableCell>
                        <TableCell
                          className={`py-3 text-right font-mono text-sm font-semibold hidden sm:table-cell ${group.configuredProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                        >
                          {group.configuredProfit < 0 ? "-" : ""}
                          {sr.formatAmount(Math.abs(group.configuredProfit))}
                        </TableCell>
                        <TableCell className="py-3">
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    ))}
                    {/* Totals Row */}
                    <TableRow className="bg-muted/40 hover:bg-muted/40 font-semibold">
                      <TableCell className="py-3 text-xs uppercase tracking-wide text-muted-foreground">
                        Total
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm hidden sm:table-cell">
                        {formatNumber(sr.totals.itemCount, 0)}
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm">
                        {formatNumber(sr.totals.totalQty, 0)}
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm">
                        {sr.formatAmount(sr.totals.totalSales)}
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm hidden sm:table-cell">
                        {sr.formatAmount(sr.totals.totalCost)}
                      </TableCell>
                      <TableCell
                        className={`py-3 text-right font-mono text-sm hidden sm:table-cell ${sr.totals.costProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                      >
                        {sr.totals.costProfit < 0 ? "-" : ""}
                        {sr.formatAmount(Math.abs(sr.totals.costProfit))}
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm hidden sm:table-cell">
                        {sr.formatAmount(sr.totals.totalConfiguredCost)}
                      </TableCell>
                      <TableCell
                        className={`py-3 text-right font-mono text-sm hidden sm:table-cell ${sr.totals.configuredProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                      >
                        {sr.totals.configuredProfit < 0 ? "-" : ""}
                        {sr.formatAmount(Math.abs(sr.totals.configuredProfit))}
                      </TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <ErpReportPrintFooter
        title="Sales Report"
        companyName={sr.isMultiCompanyMode ? "Selected companies" : sr.selectedCompany?.name}
        fromDate={sr.periodFilter.fromDate}
        toDate={sr.periodFilter.toDate}
      />
      {/* Print Styles */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .container * {
            visibility: visible;
          }
          .container {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
          button {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
