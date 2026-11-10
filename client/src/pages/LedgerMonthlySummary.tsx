import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useQuery } from "@tanstack/react-query";
import { useAppMode, getModePrefix } from "@/contexts/AppModeContext";
import { formatNumber, drCrClass, creditPositiveBalanceClass } from "@/lib/formatNumber";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { netExpenseMovement, sumPresentedMonthlyMovements } from "@/lib/monthlyRentExpensePresentation";
import { format, parseISO } from "date-fns";
import { PageHeader } from "@/components/PageHeader";
import { ChevronRight, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PeriodFilter, PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface MonthlyData {
  month: number;
  monthName: string;
  debit: number;
  credit: number;
  closingBalance: number;
}

interface LedgerMonthlySummaryData {
  account: {
    id: number;
    code: string;
    name: string;
  };
  openingBalance: number;
  /** HADI original vouchers remain gross in API; net Dr/Cr only in monthly summary UI. */
  presentation?: "net-expense" | "gross";
  months: MonthlyData[];
  grandTotal: {
    debit: number;
    credit: number;
    closingBalance: number;
  };
  dateRange: {
    startDate: string;
    endDate: string;
  };
  /** Read-only rental-subledger preview; never a replacement for posted GL. */
  rentServiceMonthPreview?: {
    kind: "non-posting-rental-subledger";
    months: Array<{ month: number; monthName: string; amount: number }>;
    total: number;
  } | null;
}

function formatSmartNumber(value: number): string {
  if (value === 0) return "0.00";
  if (Math.abs(value) >= 1000000) {
    return formatNumber(value / 1000000) + "M";
  }
  if (Math.abs(value) >= 1000) {
    return formatNumber(value / 1000) + "K";
  }
  return formatNumber(value);
}

export default function LedgerMonthlySummary() {
  const { formatAmountRaw: formatAmount } = useCurrencyContext();
  const { formatShortDate } = useDateFormat();
  const appMode = useAppMode();
  const [, navigate] = useLocation();
  const handleBack = useBackToParent();
  const [, params] = useRoute("/ledger-monthly/:accountId");
  const [, factoryParams] = useRoute("/factory/ledger-monthly/:accountId");
  const [, propertiesParams] = useRoute("/properties/ledger-monthly/:accountId");
  const accountParam = params?.accountId || factoryParams?.accountId || propertiesParams?.accountId;
  const accountId = accountParam ? parseInt(accountParam, 10) : null;

  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(getDefaultPeriodValue("this_year"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));

  useEscapeToParent();

  const startDate = periodFilter.fromDate;
  const endDate = periodFilter.toDate;

  const { data, isLoading } = useQuery<LedgerMonthlySummaryData>({
    queryKey: ["/api/reports/ledger-monthly-summary", accountId, startDate, endDate],
    queryFn: async () => {
      const response = await fetch(
        `/api/reports/ledger-monthly-summary/${accountId}?startDate=${startDate}&endDate=${endDate}`,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Failed to fetch ledger monthly summary");
      return response.json();
    },
    enabled: !!accountId,
  });

  // This is display-only: preserve the original raw Dr/Cr API values, voucher
  // drilldown and actual closing balance. HADI #1007 includes archived #881.
  const netRentExpense = data?.presentation === "net-expense";
  const displayedMonths = (Array.isArray(data?.months) ? data!.months : []).map((month) => {
    if (!netRentExpense) return month;
    return { ...month, ...netExpenseMovement(month) };
  });
  const displayedTotals = netRentExpense
    ? sumPresentedMonthlyMovements(displayedMonths)
    : { debit: data?.grandTotal.debit ?? 0, credit: data?.grandTotal.credit ?? 0 };
  const chartData = displayedMonths.map((m) => ({
    name: m.monthName.substring(0, 3),
    debit: m.debit,
    credit: m.credit,
    balance: Math.abs(m.closingBalance),
  }));

  const handleMonthClick = (month: number, year: number) => {
    const prefix = getModePrefix(appMode);
    const startDate = format(new Date(year, month - 1, 1), "yyyy-MM-dd");
    const endDate = format(new Date(year, month, 0), "yyyy-MM-dd");
    navigate(`${prefix}/accounts?accountId=${accountId}&accountType=ledger&startDate=${startDate}&endDate=${endDate}`);
  };

  if (!accountId) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Invalid account ID</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sm:px-4 sm:pt-4">
        <PageHeader
          title={data?.account?.name || "Loading..."}
          onBack={handleBack}
          meta={
            <>
              <span>Ledger Monthly Summary</span>
              {startDate && endDate && <span>· {`${formatShortDate(startDate)} to ${formatShortDate(endDate)}`}</span>}
            </>
          }
        >
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />
        </PageHeader>
      </div>

      <div className="space-y-6 sm:p-4">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-[400px] w-full" />
            <Skeleton className="h-[300px] w-full" />
          </div>
        ) : data ? (
          <>
            {/* Monthly Table */}
            <Card>
              <CardHeader className="pb-0">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-sm text-muted-foreground">{data.account.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatShortDate(data.dateRange.startDate)} to {formatShortDate(data.dateRange.endDate)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">Closing Balance</p>
                    <p
                      className={`text-xl font-bold font-mono ${
                        creditPositiveBalanceClass(data.grandTotal.closingBalance)
                      }`}
                      data-testid="text-closing-balance"
                    >
                      {formatAmount(Math.abs(data.grandTotal.closingBalance))}{" "}
                      <span className={creditPositiveBalanceClass(data.grandTotal.closingBalance)}>
                        {data.grandTotal.closingBalance === 0 ? "—" : data.grandTotal.closingBalance > 0 ? "Cr" : "Dr"}
                      </span>
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  {netRentExpense
                    ? "Rent Expense is presented as each month’s net debit or credit, with no double-counted historical corrections. Original gross voucher debits and credits remain available when you open a month."
                    : "Debit and credit show posted voucher movements. Net Movement shows the monthly result without changing vouchers, cash or other account balances."}
                </p>
                <div className="border rounded-lg overflow-hidden">
                  <Table mobileLayout="cards">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow className="bg-muted/50">
                        <TableHead>Particulars</TableHead>
                        <TableHead className="text-right hidden sm:table-cell">Transactions</TableHead>
                        <TableHead className="hidden sm:table-cell"></TableHead>
                        <TableHead className="text-right">Net Movement</TableHead>
                        <TableHead className="text-right">Closing Balance</TableHead>
                        <TableHead className="w-8"></TableHead>
                      </TableRow>
                      <TableRow className="bg-muted/30 text-xs hidden sm:table-row">
                        <TableHead></TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                        <TableHead></TableHead>
                        <TableHead></TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {/* Opening Balance */}
                      <TableRow className="bg-muted/20">
                        <TableCell className="font-medium">Opening Balance</TableCell>
                        <TableCell className="hidden sm:table-cell"></TableCell>
                        <TableCell className="hidden sm:table-cell"></TableCell>
                        <TableCell className={`text-right font-mono ${creditPositiveBalanceClass(data.openingBalance)}`}>
                          {formatAmount(Math.abs(data.openingBalance))} {data.openingBalance === 0 ? "—" : data.openingBalance > 0 ? "Cr" : "Dr"}
                        </TableCell>
                        <TableCell></TableCell>
                      </TableRow>

                      {/* Monthly rows */}
                      {(() => {
                        const startYear = parseISO(data.dateRange.startDate).getFullYear();
                        const startMonthNum = parseISO(data.dateRange.startDate).getMonth() + 1;
                        return displayedMonths.map((month) => {
                          const year = month.month >= startMonthNum ? startYear : startYear + 1;
                          return (
                            <TableRow
                              key={month.month}
                              className="cursor-pointer hover-elevate"
                              onClick={() => handleMonthClick(month.month, year)}
                              data-testid={`row-month-${month.month}`}
                            >
                              <TableCell className="font-medium">{month.monthName}</TableCell>
                              <TableCell className="text-right font-mono hidden sm:table-cell">
                                {month.debit > 0 ? formatAmount(month.debit) : ""}
                              </TableCell>
                              <TableCell className="text-right font-mono hidden sm:table-cell">
                                {month.credit > 0 ? formatAmount(month.credit) : ""}
                              </TableCell>
                              <TableCell className={`text-right font-mono font-semibold ${month.debit === month.credit ? "text-muted-foreground" : drCrClass(month.debit > month.credit ? "Dr" : "Cr")}`} data-testid={`net-month-${month.month}`}>
                                {formatAmount(Math.abs(month.debit - month.credit))}{" "}
                                {month.debit === month.credit ? "—" : month.debit > month.credit ? "Dr" : "Cr"}
                              </TableCell>
                              <TableCell className={`text-right font-mono ${creditPositiveBalanceClass(month.closingBalance)}`}>
                                {formatAmount(Math.abs(month.closingBalance))}{" "}
                                <span className="font-semibold">
                                  {month.closingBalance === 0 ? "—" : month.closingBalance > 0 ? "Cr" : "Dr"}
                                </span>
                              </TableCell>
                              <TableCell>
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              </TableCell>
                            </TableRow>
                          );
                        });
                      })()}

                      {/* Grand Total */}
                      <TableRow className="bg-primary/10 font-bold border-t-2">
                        <TableCell>Grand Total</TableCell>
                        <TableCell className="text-right font-mono hidden sm:table-cell">
                          {formatAmount(displayedTotals.debit)}
                        </TableCell>
                        <TableCell className="text-right font-mono hidden sm:table-cell">
                          {displayedTotals.credit > 0 ? formatAmount(displayedTotals.credit) : ""}
                        </TableCell>
                        <TableCell className={`text-right font-mono ${displayedTotals.debit === displayedTotals.credit ? "text-muted-foreground" : drCrClass(displayedTotals.debit > displayedTotals.credit ? "Dr" : "Cr")}`}>
                          {formatAmount(Math.abs(displayedTotals.debit - displayedTotals.credit))}{" "}
                          {displayedTotals.debit === displayedTotals.credit ? "—" : displayedTotals.debit > displayedTotals.credit ? "Dr" : "Cr"}
                        </TableCell>
                        <TableCell className={`text-right font-mono ${creditPositiveBalanceClass(data.grandTotal.closingBalance)}`}>
                          {formatAmount(Math.abs(data.grandTotal.closingBalance))}{" "}
                          <span className="font-semibold">
                            {data.grandTotal.closingBalance === 0 ? "—" : data.grandTotal.closingBalance > 0 ? "Cr" : "Dr"}
                          </span>
                        </TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Historic rental allocations are verified from posted payment links.
                They intentionally do not alter the posted GL or cash vouchers. */}
            {data.rentServiceMonthPreview?.months?.length ? (
              <Card data-testid="rent-service-month-preview">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Rent allocated by service month</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Read-only reconciliation from the paid rental subledger. January's original
                    cash payments remain dated January 1. This schedule is not a posted journal
                    and does not replace the gross debit/credit ledger or financial statements.
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Service month</TableHead>
                          <TableHead className="text-right">Allocated rent expense</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.rentServiceMonthPreview.months.map((m) => (
                          <TableRow key={m.month}>
                            <TableCell>{m.monthName}</TableCell>
                            <TableCell className={`text-right font-mono font-semibold ${drCrClass("Dr")}`}>
                              {formatAmount(m.amount)} Dr
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/40 font-bold">
                          <TableCell>Total allocated</TableCell>
                          <TableCell className={`text-right font-mono ${drCrClass("Dr")}`}>
                            {formatAmount(data.rentServiceMonthPreview.total)} Dr
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {/* Bar Chart */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  {data.grandTotal.closingBalance >= 0 ? (
                    <TrendingUp className="h-4 w-4 text-green-600" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-red-600" />
                  )}
                  {netRentExpense ? "Monthly Net Rent Expense" : "Monthly Transactions"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} className="text-muted-foreground" />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        className="text-muted-foreground"
                        tickFormatter={(value) => formatSmartNumber(value)}
                      />
                      <Tooltip
                        formatter={(value) => formatAmount(Number(value))}
                        contentStyle={{
                          backgroundColor: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "6px",
                        }}
                      />
                      <Bar dataKey="debit" fill="hsl(var(--chart-2))" name={netRentExpense ? "Net debit" : "Debit"} radius={[4, 4, 0, 0]} />
                      {netRentExpense && displayedMonths.some((m) => m.credit > 0) ? (
                        <Bar dataKey="credit" fill="hsl(var(--destructive))" name="Net credit" radius={[4, 4, 0, 0]} />
                      ) : null}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3 sm:gap-4">
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-sm text-muted-foreground">Opening Balance</p>
                  <p className="text-lg font-bold font-mono">{formatAmount(Math.abs(data.openingBalance))}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-sm text-muted-foreground">Current Total</p>
                  <p className="text-lg font-bold font-mono">
                    {formatAmount(data.grandTotal.debit - data.grandTotal.credit)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-sm text-muted-foreground">Closing Balance</p>
                  <p
                    className={`text-lg font-bold font-mono ${
                      creditPositiveBalanceClass(data.grandTotal.closingBalance)
                    }`}
                  >
                    {formatAmount(Math.abs(data.grandTotal.closingBalance))}
                  </p>
                </CardContent>
              </Card>
            </div>
          </>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-muted-foreground">No data available</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
