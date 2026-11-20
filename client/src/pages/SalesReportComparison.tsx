import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Card, CardContent } from "@/components/ui/card";
import { SearchField } from "@/components/ui/search-field";
import { PeriodFilter } from "@/components/ui/period-filter";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Building2, ChevronDown } from "lucide-react";
import { summaryForCompany, type ViewFilter } from "./salesReportComparisonModel";
import { SalesReportComparisonExport } from "./SalesReportComparisonExport";
import { useSalesReportComparisonModel } from "./useSalesReportComparisonState";

export default function SalesReportComparison() {
  const sc = useSalesReportComparisonModel();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 space-y-3 border-b pb-3 sm:px-6 sm:pt-4">
        <PageHeader
          title="Company Comparison"
          subtitle="Compare sales performance across companies"
          onBack={() => sc.navigate("/sales-report")}
        >
          {sc.enabled && (
            <SalesReportComparisonExport
              rows={sc.tableData}
              companies={sc.displayCompanies}
              from={sc.startDate}
              to={sc.endDate}
            />
          )}
        </PageHeader>

        {/* Controls */}
        <ErpMobileFilters
          label="Company comparison filters"
          primary={
            <PeriodFilter
              value={{
                fromDate: sc.startDate,
                toDate: sc.endDate,
                preset: sc.startDate || sc.endDate ? "custom" : "all_time",
              }}
              onChange={(v) => {
                sc.setStartDate(v.fromDate);
                sc.setEndDate(v.toDate);
              }}
              data-testid="input-start-date"
            />
          }
          quick={
            <Popover open={sc.companyPopoverOpen} onOpenChange={sc.setCompanyPopoverOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="gap-2" data-testid="button-company-select">
                  <Building2 className="h-4 w-4" />
                  {sc.selectedCodes.length === 0 ? "Select Companies" : `${sc.selectedCodes.length} Selected`}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-2" align="end">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-2 pb-2">
                  Select 2 or more companies
                </p>
                <div className="space-y-1">
                  {sc.allCompanies.map((c) => (
                    <div
                      key={c.code}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover-elevate"
                      onClick={() => sc.toggleCompany(c.code)}
                      data-testid={`option-company-${c.code}`}
                    >
                      <Checkbox checked={sc.selectedCodes.includes(c.code)} className="h-4 w-4" />
                      <span className="text-sm">{c.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">{c.code}</span>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          }
          activeCount={[sc.stockGroupFilter !== "all", sc.viewFilter !== "all"].filter(Boolean).length}
          onClear={() => {
            sc.setStockGroupFilter("all");
            sc.setViewFilter("all");
          }}
          data-testid="sales-comparison-filters"
        >
          {(layout) =>
            layout === "sheet" ? (
              <div className="grid gap-3">
                <Select
                  value={sc.stockGroupFilter}
                  onValueChange={sc.setStockGroupFilter}
                  data-testid="select-stock-group"
                >
                  <SelectTrigger className="w-44 h-9">
                    <SelectValue placeholder="All Groups" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Groups</SelectItem>
                    {sc.stockGroups.map((g) => (
                      <SelectItem key={g.id} value={g.name}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex rounded-md border overflow-hidden">
                  {(["all", "gaining", "losing"] as ViewFilter[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => sc.setViewFilter(v)}
                      className={`px-3 h-9 text-sm capitalize transition-colors ${
                        sc.viewFilter === v ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
                      }`}
                      data-testid={`filter-${v}`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2" data-erp-filter-bar="sales-report-comparison">
                <PeriodFilter
                  value={{
                    fromDate: sc.startDate,
                    toDate: sc.endDate,
                    preset: sc.startDate || sc.endDate ? "custom" : "all_time",
                  }}
                  onChange={(v) => {
                    sc.setStartDate(v.fromDate);
                    sc.setEndDate(v.toDate);
                  }}
                  data-testid="input-start-date"
                />

                <Popover open={sc.companyPopoverOpen} onOpenChange={sc.setCompanyPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="gap-2" data-testid="button-company-select">
                      <Building2 className="h-4 w-4" />
                      {sc.selectedCodes.length === 0 ? "Select Companies" : `${sc.selectedCodes.length} Selected`}
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-2" align="end">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-2 pb-2">
                      Select 2 or more companies
                    </p>
                    <div className="space-y-1">
                      {sc.allCompanies.map((c) => (
                        <div
                          key={c.code}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover-elevate"
                          onClick={() => sc.toggleCompany(c.code)}
                          data-testid={`option-company-${c.code}`}
                        >
                          <Checkbox checked={sc.selectedCodes.includes(c.code)} className="h-4 w-4" />
                          <span className="text-sm">{c.name}</span>
                          <span className="text-xs text-muted-foreground ml-auto">{c.code}</span>
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                <Select
                  value={sc.stockGroupFilter}
                  onValueChange={sc.setStockGroupFilter}
                  data-testid="select-stock-group"
                >
                  <SelectTrigger className="w-44 h-9">
                    <SelectValue placeholder="All Groups" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Groups</SelectItem>
                    {sc.stockGroups.map((g) => (
                      <SelectItem key={g.id} value={g.name}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex rounded-md border overflow-hidden">
                  {(["all", "gaining", "losing"] as ViewFilter[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => sc.setViewFilter(v)}
                      className={`px-3 h-9 text-sm capitalize transition-colors ${
                        sc.viewFilter === v ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
                      }`}
                      data-testid={`filter-${v}`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            )
          }
        </ErpMobileFilters>
      </div>

      <div className="flex-1 overflow-auto pt-3 sm:p-6">
        {!sc.enabled ? (
          <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground gap-3">
            <Building2 className="h-10 w-10 opacity-30" />
            <p className="text-base font-medium">Select at least 2 companies to compare</p>
            <p className="text-sm">Use the "Select Companies" button above</p>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="flex flex-wrap gap-3 mb-6">
              {sc.displayCompanies.map((c) => {
                const { totalSales, totalProfit } = summaryForCompany(sc.tableData, c.code);
                return (
                  <Card key={c.code} className="flex-1 min-w-44">
                    <CardContent className="p-4">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                        {c.name}
                      </p>
                      <p className="font-mono text-lg font-bold">{sc.fmt(totalSales)}</p>
                      <p
                        className={`font-mono text-sm ${totalProfit >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
                      >
                        {totalProfit >= 0 ? "+" : ""}
                        {sc.fmt(totalProfit)}
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Search */}
            <div className="mb-4">
              <SearchField
                placeholder="Search items..."
                value={sc.search}
                onValueChange={sc.setSearch}
                wrapperClassName="w-full sm:max-w-72"
                data-testid="input-search"
              />
            </div>

            {sc.isFetching && !sc.isLoading && (
              <div className="h-0.5 w-full bg-muted overflow-hidden mb-3 rounded-full">
                <div className="h-full bg-primary w-1/2 rounded-full animate-pulse" />
              </div>
            )}

            {sc.isLoading ? (
              <LoadingState title="Loading comparison data…" className="py-16" />
            ) : sc.isError && sc.rawItems.length === 0 ? (
              <ErrorState onAction={() => void sc.refetch()} actionLabel="Try again" className="py-16" />
            ) : sc.tableData.length === 0 ? (
              <EmptyState title="No data found for the selected filters" className="py-16" />
            ) : (
              <div className="rounded-md border overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    {/* Row 1: Item | Group | [Company name spanning 3 cols each] | AI Result */}
                    <TableRow>
                      <TableHead className="min-w-[200px] sticky left-0 bg-background z-10">Item</TableHead>
                      <TableHead className="w-36">Group</TableHead>
                      {sc.displayCompanies.map((c) => (
                        <TableHead
                          key={c.code}
                          colSpan={3}
                          className="text-center border-l uppercase tracking-wide text-xs"
                        >
                          {c.name}
                        </TableHead>
                      ))}
                      <TableHead className="min-w-[220px] border-l text-center text-xs uppercase tracking-wide">
                        AI Result
                      </TableHead>
                    </TableRow>
                    {/* Row 2: sub-labels per company */}
                    <TableRow className="text-xs text-muted-foreground">
                      <TableHead className="sticky left-0 bg-background z-10" />
                      <TableHead />
                      {sc.displayCompanies.map((c) => (
                        <>
                          <TableHead key={`${c.code}-qty`} className="border-l font-normal">
                            Qty Sold
                          </TableHead>
                          <TableHead key={`${c.code}-avg`} className="font-normal">
                            Av Price
                          </TableHead>
                          <TableHead key={`${c.code}-prf`} className="font-normal">
                            Profit
                          </TableHead>
                        </>
                      ))}
                      <TableHead className="border-l" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sc.tableData.map((row) => (
                      <TableRow key={row.stockItemCode} data-testid={`row-item-${row.stockItemCode}`}>
                        <TableCell className="font-medium sticky left-0 bg-background z-10">
                          {row.stockItemName}
                        </TableCell>
                        <TableCell>
                          {row.stockGroupName ? (
                            <Badge variant="secondary" className="text-xs">
                              {row.stockGroupName}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                        {sc.displayCompanies.map((c) => {
                          const entry = row.byCompany[c.code];
                          if (!entry)
                            return (
                              <>
                                <TableCell
                                  key={`${c.code}-q`}
                                  className="border-l text-muted-foreground text-center text-xs"
                                >
                                  —
                                </TableCell>
                                <TableCell key={`${c.code}-a`} className="text-muted-foreground text-center text-xs">
                                  —
                                </TableCell>
                                <TableCell key={`${c.code}-p`} className="text-muted-foreground text-center text-xs">
                                  —
                                </TableCell>
                              </>
                            );
                          return (
                            <>
                              <TableCell key={`${c.code}-q`} className="border-l font-mono text-sm">
                                {sc.fmtQty(entry.totalQty)}
                              </TableCell>
                              <TableCell key={`${c.code}-a`} className="font-mono text-sm text-muted-foreground">
                                {sc.fmtAvgPrice(entry.totalSales, entry.totalQty)}
                              </TableCell>
                              <TableCell key={`${c.code}-p`}>{sc.profitCell(entry.costProfit)}</TableCell>
                            </>
                          );
                        })}
                        <TableCell className="border-l">{sc.aiResultCell(row)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
