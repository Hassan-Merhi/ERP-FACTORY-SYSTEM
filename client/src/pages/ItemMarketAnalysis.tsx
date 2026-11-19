import { BarChart3, Building2, ChevronDown, Download, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ErpPendingButton } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PeriodFilter } from "@/components/ui/period-filter";
import { SearchField } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";

import { MetricCard, type ProfitDirectionFilter } from "./itemMarketAnalysisParts";
import { useItemMarketAnalysisModel } from "./itemMarketAnalysisModel";
import { ItemMarketAnalysisTable } from "./ItemMarketAnalysisTable";

export default function ItemMarketAnalysis() {
  const m = useItemMarketAnalysisModel();

  if (m.selectedCompany && m.selectedCompany.companyType !== "erp") {
    return (
      <div className="container mx-auto p-4 sm:p-6">
        <PageHeader title="Market Price Analysis" onBack={() => window.history.back()} />
        <div className="mt-6 rounded-xl border p-6 text-sm text-muted-foreground">
          Item Market Analysis is available for ERP companies only.
        </div>
      </div>
    );
  }

  // The main KPI must match Sales Report's posted Cost Profit, not a revalued purchase-cost scenario.
  const reportedProfit = m.data?.salesReportTotals?.profit ?? 0;
  const reportedRevenue = m.data?.salesReportTotals?.revenue ?? 0;
  const profitClass = reportedProfit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className="container mx-auto space-y-5 p-0 sm:p-6">
      <PageHeader
        title="Market Price Analysis"
        onBack={() => window.history.back()}
        meta={
          <span>
            Imports, sales and modeled profit at the selected purchase cost
            {m.multiCompany
              ? ` · ${m.selectedCompanyIds.length} companies selected`
              : m.selectedCompanyNames[0]?.name
                ? ` · ${m.selectedCompanyNames[0].name}`
                : ""}
          </span>
        }
      >
        <ErpPendingButton
          variant="outline"
          size="sm"
          onClick={m.handleExportExcel}
          disabled={m.isLoading || m.isFetching || !m.data || !!m.isError || m.search.trim() !== m.debouncedSearch}
          pending={m.isExporting}
          pendingLabel="Exporting..."
          data-testid="button-item-market-export-excel"
        >
          {!m.isExporting && <Download className="mr-2 h-4 w-4" />}
          Export Excel
        </ErpPendingButton>
        <Button variant="outline" size="sm" onClick={() => m.refetch()} disabled={m.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${m.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </PageHeader>

      {m.comparableToSalesReport && m.salesReportReconciliation && (
        <div className="grid gap-3 sm:grid-cols-2">
          <MetricCard
            label="Sales Report Revenue (all sales, including credit)"
            value={m.formatAmount(m.salesReportReconciliation.totalSales)}
          />
          <MetricCard
            label="Sales Report Cost Profit (reconciled COGS)"
            value={m.formatAmount(m.salesReportReconciliation.adjustedCostProfit)}
          />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Items" value={formatNumber(m.summary.itemCount)} />
        <MetricCard label="Imported Qty" value={formatNumber(m.summary.importedQty)} />
        <MetricCard
          label="Sold Qty (Sales Report)"
          value={formatNumber(m.data?.salesReportTotals?.soldQty ?? m.summary.soldQty)}
        />
        <MetricCard
          label="Total Sales (Sales Report)"
          value={m.formatAmount(m.data?.salesReportTotals?.revenue ?? m.summary.revenue)}
        />
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Cost Profit (Sales Report)
          </div>
          <div className={`mt-1 text-xl font-semibold tabular-nums ${profitClass}`}>
            {m.data?.salesReportTotals ? m.formatAmount(reportedProfit) : "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {reportedRevenue ? ((reportedProfit / reportedRevenue) * 100).toFixed(1) : "0.0"}% margin
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
        <PeriodFilter value={m.period} onChange={m.setPeriod} data-testid="period-filter-item-market-analysis" />
        <SearchField
          value={m.search}
          onValueChange={m.setSearch}
          placeholder="Search item code or name"
          wrapperClassName="min-w-[220px] flex-1 sm:max-w-sm"
          data-testid="input-item-market-search"
        />
        <Popover open={m.companyPopoverOpen} onOpenChange={m.setCompanyPopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-[190px] justify-between" data-testid="button-item-market-companies">
              <span className="flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                {m.selectedCompanyIds.length === 1 ? "1 Company" : `${m.selectedCompanyIds.length} Companies`}
              </span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Compare ERP companies
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {m.erpCompanies.map((company) => (
                <button
                  type="button"
                  key={company.id}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => m.toggleCompany(company.id)}
                  data-testid={`option-item-market-company-${company.id}`}
                >
                  <Checkbox checked={m.selectedCompanyIds.includes(company.id)} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate text-sm">{company.name}</span>
                  <span className="text-xs text-muted-foreground">{company.code}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Popover open={m.stockGroupPopoverOpen} onOpenChange={m.setStockGroupPopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-[190px] justify-between" data-testid="button-item-market-groups">
              <span className="min-w-0 truncate">
                {m.selectedStockGroupNames.length === 0
                  ? "All Stock Groups"
                  : m.selectedStockGroupNames.length === 1
                    ? m.selectedStockGroupNames[0]
                    : `${m.selectedStockGroupNames.length} Stock Groups`}
              </span>
              <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <button
              type="button"
              className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              onClick={() => {
                m.setSelectedStockGroupNames([]);
                m.setExpandedItemCode(null);
                m.setExpandedSalePriceKey(null);
              }}
              data-testid="option-item-market-group-all"
            >
              <Checkbox checked={m.selectedStockGroupNames.length === 0} className="h-4 w-4" />
              <span className="text-sm">All Stock Groups</span>
            </button>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {m.stockGroups.map((groupName) => (
                <button
                  type="button"
                  key={groupName}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => m.toggleStockGroup(groupName)}
                  data-testid={`option-item-market-group-${groupName}`}
                >
                  <Checkbox checked={m.selectedStockGroupNames.includes(groupName)} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate text-sm">{groupName}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Select
          value={m.profitDirection}
          onValueChange={(value) => {
            m.setProfitDirection(value as ProfitDirectionFilter);
            m.setExpandedItemCode(null);
            m.setExpandedSalePriceKey(null);
          }}
        >
          <SelectTrigger className="w-[150px]" data-testid="select-item-market-profit-direction">
            <SelectValue placeholder="All Profit" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Profit</SelectItem>
            <SelectItem value="gaining">Gaining</SelectItem>
            <SelectItem value="losing">Losing</SelectItem>
            <SelectItem value="none">None</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={m.includeOffloadingCost ? "default" : "outline"}
          onClick={() => m.setIncludeOffloadingCost((current) => !current)}
          data-testid="button-item-market-offloading-cost"
        >
          {m.includeOffloadingCost ? "Cost + Offloading" : "Cost Only"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Profit, margin, company totals and profit filters use the selected purchase cost. Where USD purchase rates are
        unavailable, posted historical profit is retained. No accounting entries are changed.
      </p>

      {m.multiCompany && m.companySummaries.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {m.companySummaries.map((company) => {
            const companyProfitClass =
              company.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";
            return (
              <div key={company.companyId} className="rounded-xl border bg-card p-4">
                <div className="truncate text-sm font-semibold">{company.companyName}</div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Sold Qty</div>
                    <div className="font-medium tabular-nums">{formatNumber(company.soldQty)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Revenue</div>
                    <div className="font-medium tabular-nums">{m.formatAmount(company.revenue)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Profit</div>
                    <div className={`font-medium tabular-nums ${companyProfitClass}`}>
                      {m.formatAmount(company.profit)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Margin</div>
                    <div className="font-medium tabular-nums">{company.marginPct.toFixed(1)}%</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {m.isError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {m.error?.message || "Failed to load item market analysis."}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <div className="font-medium">Item performance</div>
          <div className="ml-auto hidden text-xs text-muted-foreground lg:block">
            {m.multiCompany
              ? "Items are matched by code · expand Companies to compare each company"
              : "Historical item performance for this company"}
          </div>
          <ErpPendingButton
            variant="outline"
            size="sm"
            className="ml-auto shrink-0 lg:ml-0"
            onClick={m.handleExportExcel}
            disabled={m.isLoading || m.isFetching || !m.data || !!m.isError || m.search.trim() !== m.debouncedSearch}
            pending={m.isExporting}
            pendingLabel="Exporting..."
            data-testid="button-item-market-export-excel-table"
          >
            {!m.isExporting && <Download className="mr-2 h-4 w-4" />}
            Export Excel
          </ErpPendingButton>
        </div>
        <ItemMarketAnalysisTable m={m} />
        {!m.isLoading && m.visibleRowCount < m.totalVisibleSourceRows && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <div className="text-xs text-muted-foreground">
              Showing {formatNumber(Math.min(m.visibleRowCount, m.totalVisibleSourceRows))} of{" "}
              {formatNumber(m.totalVisibleSourceRows)} items
            </div>
            <Button variant="outline" size="sm" onClick={() => m.setVisibleRowCount((count) => count + 250)}>
              Load 250 more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
