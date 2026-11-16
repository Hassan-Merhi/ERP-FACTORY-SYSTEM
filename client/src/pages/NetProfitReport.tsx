import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { ErrorState } from "@/components/ui/page-state";
import { ShoppingCart, Receipt, BarChart3, Building2, Loader2, TrendingUp } from "lucide-react";
import {
  AccountSection,
  KpiCard,
  MONTH_NAMES,
  PERIODS,
  formatAmount,
  useNetProfitReportState,
  type Period,
} from "./useNetProfitReportState";

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
                <>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-sm text-muted-foreground whitespace-nowrap">From:</Label>
                    <Input
                      type="date"
                      value={customFromDate}
                      onChange={(e) => setCustomFromDate(e.target.value)}
                      className="w-36 text-sm"
                      data-testid="input-custom-from-date"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-sm text-muted-foreground whitespace-nowrap">To:</Label>
                    <Input
                      type="date"
                      value={customToDate}
                      onChange={(e) => setCustomToDate(e.target.value)}
                      className="w-36 text-sm"
                      data-testid="input-custom-to-date"
                    />
                  </div>
                </>
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
          <>
            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <KpiCard
                title="Total Revenue"
                value={salesTotal + directIncTotal + indirectIncTotal}
                icon={ShoppingCart}
                color="bg-blue-600"
              />
              <KpiCard
                title="Total Expenses"
                value={purchasesTotal + directExpTotal + indirectExpTotal}
                icon={Receipt}
                color="bg-red-600"
              />
              <KpiCard
                title="Net Profit"
                value={netProfit}
                icon={TrendingUp}
                color={netProfit >= 0 ? "bg-green-600" : "bg-orange-600"}
                isProfit
              />
            </div>

            {/* Profit & Loss Summary */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Profit & Loss — {periodLabel}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Income side */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Income</p>
                    {[
                      { label: "Sales (Revenue)", value: salesTotal },
                      { label: "Closing Stock", value: closingStock },
                      { label: "Direct Incomes", value: directIncTotal },
                      { label: "Indirect Incomes", value: indirectIncTotal },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex justify-between text-sm">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="text-green-700 dark:text-green-400 font-mono">{formatAmount(value)}</span>
                      </div>
                    ))}
                    <Separator className="my-2" />
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Total Income</span>
                      <span className="text-green-700 dark:text-green-400 font-mono">{formatAmount(totalIncome)}</span>
                    </div>
                  </div>

                  {/* Expense side */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Expenses
                    </p>
                    {[
                      { label: "Opening Stock", value: openingStock },
                      { label: "Purchases", value: purchasesTotal },
                      { label: "Direct Expenses", value: directExpTotal },
                      { label: "Indirect Expenses", value: indirectExpTotal },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex justify-between text-sm">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="text-red-600 dark:text-red-400 font-mono">{formatAmount(value)}</span>
                      </div>
                    ))}
                    <Separator className="my-2" />
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Total Expenses</span>
                      <span className="text-red-600 dark:text-red-400 font-mono">{formatAmount(totalExpenses)}</span>
                    </div>
                  </div>
                </div>

                <Separator className="my-4" />

                {/* Net Profit bottom line */}
                <div
                  className={`flex justify-between items-center font-bold text-base rounded-md px-4 py-3 ${
                    netProfit >= 0 ? "bg-green-50 dark:bg-green-950/30" : "bg-red-50 dark:bg-red-950/30"
                  }`}
                >
                  <span>{netProfit >= 0 ? "Net Profit" : "Net Loss"}</span>
                  <span
                    className={`font-mono ${
                      netProfit >= 0 ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {netProfit < 0 ? "-" : ""}
                    {formatAmount(Math.abs(netProfit))}
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Account Breakdown */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Account Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <AccountSection
                  title="Sales"
                  accounts={rp?.salesAccounts?.accounts || []}
                  total={salesTotal}
                  type="income"
                  badgeColor="bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                />
                <AccountSection
                  title="Purchases"
                  accounts={lp?.purchaseAccounts?.accounts || []}
                  total={purchasesTotal}
                  type="expense"
                  badgeColor="bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                />
                <AccountSection
                  title="Direct Incomes"
                  accounts={rp?.directIncomes?.accounts || []}
                  total={directIncTotal}
                  type="income"
                  badgeColor="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                />
                <AccountSection
                  title="Direct Expenses"
                  accounts={lp?.directExpenses?.accounts || []}
                  total={directExpTotal}
                  type="expense"
                  badgeColor="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                />
                <AccountSection
                  title="Indirect Incomes"
                  accounts={rp?.indirectIncomes?.accounts || []}
                  total={indirectIncTotal}
                  type="income"
                  badgeColor="bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300"
                />
                <AccountSection
                  title="Indirect Expenses"
                  accounts={lp?.indirectExpenses?.accounts || []}
                  total={indirectExpTotal}
                  type="expense"
                  badgeColor="bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
                />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
