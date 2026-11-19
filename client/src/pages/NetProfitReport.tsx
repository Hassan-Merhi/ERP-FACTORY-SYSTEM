import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PeriodFilter } from "@/components/ui/period-filter";
import { PageHeader } from "@/components/PageHeader";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { ErrorState } from "@/components/ui/page-state";
import { BarChart3, Building2, Loader2 } from "lucide-react";
import { MONTH_NAMES, PERIODS, useNetProfitReportState, type Period } from "./useNetProfitReportState";
import { NetProfitReportContent } from "./NetProfitReportContent";

export default function NetProfitReport() {
  const {
    closingStock,
    companies,
    customFromDate,
    customToDate,
    data,
    directExpTotal,
    directIncTotal,
    error,
    handleExport,
    indirectExpTotal,
    indirectIncTotal,
    isAdminOrDev,
    isError,
    isExporting,
    isLoading,
    lp,
    netProfit,
    openingStock,
    period,
    periodLabel,
    purchasesTotal,
    refetch,
    rp,
    salesTotal,
    selectedCompanyId,
    setCustomFromDate,
    setCustomToDate,
    setPeriod,
    setSelectedCompanyId,
    setSpecificMonth,
    setSpecificYear,
    specificMonth,
    specificYear,
    totalExpenses,
    totalIncome,
    yearOptions,
  } = useNetProfitReportState();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 space-y-3 sm:px-6 sm:pt-4">
        <PageHeader
          title="Net Profit Report"
          icon={<BarChart3 className="h-5 w-5" />}
          meta={<span>Income, expenses, and net profit — {periodLabel}</span>}
        >
          <ExportButton
            onClick={() => void handleExport()}
            data-testid="button-export-excel"
            disabled={isLoading}
            busy={isExporting}
          />
        </PageHeader>
        <ErpMobileFilters
          label="Net profit filters"
          className="pb-3"
          activeCount={[selectedCompanyId !== "current", period !== "today"].filter(Boolean).length}
          onClear={() => {
            setSelectedCompanyId("current");
            setPeriod("today");
          }}
          data-testid="net-profit-filters"
        >
          {(layout) => (
            <div
              className={layout === "sheet" ? "grid gap-3" : "flex items-center gap-2 flex-wrap pb-3"}
              data-erp-filter-bar="net-profit-report"
            >
              {isAdminOrDev && companies.length > 0 && (
                <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                  <SelectTrigger className="w-44" data-testid="select-company">
                    <Building2 className="w-4 h-4 mr-2 text-muted-foreground" />
                    <SelectValue placeholder="Company" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current">Current Company</SelectItem>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)} data-testid={`option-company-${c.id}`}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
                <SelectTrigger className="w-36" data-testid="select-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIODS.map((p) => (
                    <SelectItem key={p.value} value={p.value} data-testid={`option-period-${p.value}`}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {period === "specific_month" && (
                <>
                  <Select value={String(specificMonth)} onValueChange={(v) => setSpecificMonth(Number(v))}>
                    <SelectTrigger className="w-36" data-testid="select-month">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTH_NAMES.map((name, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)} data-testid={`option-month-${i + 1}`}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(specificYear)} onValueChange={(v) => setSpecificYear(Number(v))}>
                    <SelectTrigger className="w-28" data-testid="select-year">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {yearOptions.map((y) => (
                        <SelectItem key={y} value={String(y)} data-testid={`option-year-${y}`}>
                          {y}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
              {period === "custom_range" && (
                <PeriodFilter
                  value={{ fromDate: customFromDate, toDate: customToDate, preset: "custom" }}
                  onChange={(v) => {
                    setCustomFromDate(v.fromDate);
                    setCustomToDate(v.toDate);
                  }}
                  data-testid="net-profit-custom-period"
                />
              )}
            </div>
          )}
        </ErpMobileFilters>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-6 sm:p-6">
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {isError && (
          <ErrorState
            title="Net profit report unavailable"
            description={error instanceof Error ? error.message : "The report could not be loaded."}
            actionLabel="Retry report"
            onAction={() => void refetch()}
          />
        )}

        {!isLoading && !isError && data && (
          <NetProfitReportContent
            closingStock={closingStock}
            directExpTotal={directExpTotal}
            directIncTotal={directIncTotal}
            indirectExpTotal={indirectExpTotal}
            indirectIncTotal={indirectIncTotal}
            lp={lp}
            netProfit={netProfit}
            openingStock={openingStock}
            periodLabel={periodLabel}
            purchasesTotal={purchasesTotal}
            rp={rp}
            salesTotal={salesTotal}
            totalExpenses={totalExpenses}
            totalIncome={totalIncome}
          />
        )}
      </div>
    </div>
  );
}
