import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useQuery } from "@tanstack/react-query";
import { useAppMode, getModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { formatNumber, drCrClass } from "@/lib/formatNumber";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
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

function _formatFullNumber(value: number): string {
  const isWhole = Math.abs(value) % 1 === 0;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export default function LedgerMonthlySummary() {
  const { formatAmountRaw: formatAmount } = useCurrencyContext();
  const { formatShortDate } = useDateFormat();
  const appMode = useAppMode();
  const _modeApiRequest = getApiRequest(appMode);
  const [, navigate] = useLocation();
  const handleBack = useBackToParent();
  const [, params] = useRoute("/ledger-monthly/:accountId");
  const [, factoryParams] = useRoute("/factory/ledger-monthly/:accountId");
  const accountId =
    params?.accountId || factoryParams?.accountId
      ? parseInt((params?.accountId || factoryParams?.accountId) as string)
      : null;

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

  const chartData =
    (Array.isArray(data?.months) ? data!.months : []).map((m) => ({
      name: m.monthName.substring(0, 3),
      debit: m.debit,
      credit: m.credit,
      balance: Math.abs(m.closingBalance),
    })) || [];

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
                        data.grandTotal.closingBalance >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                      data-testid="text-closing-balance"
                    >
                      {formatAmount(Math.abs(data.grandTotal.closingBalance))}{" "}
                      <span className={drCrClass(data.grandTotal.closingBalance >= 0 ? "Cr" : "Dr")}>
                        {data.grandTotal.closingBalance >= 0 ? "Cr" : "Dr"}
                      </span>
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow className="bg-muted/50">
                        <TableHead>Particulars</TableHead>
                        <TableHead className="text-right hidden sm:table-cell">Transactions</TableHead>
                        <TableHead className="hidden sm:table-cell"></TableHead>
                        <TableHead className="text-right">Closing Balance</TableHead>
                        <TableHead className="w-8"></TableHead>
                      </TableRow>
                      <TableRow className="bg-muted/30 text-xs hidden sm:table-row">
                        <TableHead></TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
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
                        <TableCell className="text-right font-mono">
                          {formatAmount(Math.abs(data.openingBalance))} {data.openingBalance >= 0 ? "Cr" : "Dr"}
                        </TableCell>
                        <TableCell></TableCell>
                      </TableRow>

                      {/* Monthly rows */}
                      {(() => {
                        const startYear = parseISO(data.dateRange.startDate).getFullYear();
                        const startMonthNum = parseISO(data.dateRange.startDate).getMonth() + 1;
                        return (Array.isArray(data.months) ? data.months : []).map((month) => {
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
                              <TableCell className="text-right font-mono">
                                {formatAmount(Math.abs(month.closingBalance))}{" "}
                                <span className={`font-semibold ${drCrClass(month.closingBalance >= 0 ? "Cr" : "Dr")}`}>
                                  {month.closingBalance >= 0 ? "Cr" : "Dr"}
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
                          {formatAmount(data.grandTotal.debit)}
                        </TableCell>
                        <TableCell className="text-right font-mono hidden sm:table-cell">
                          {formatAmount(data.grandTotal.credit)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatAmount(Math.abs(data.grandTotal.closingBalance))}{" "}
                          <span
                            className={`font-semibold ${drCrClass(data.grandTotal.closingBalance >= 0 ? "Cr" : "Dr")}`}
                          >
                            {data.grandTotal.closingBalance >= 0 ? "Cr" : "Dr"}
                          </span>
                        </TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Bar Chart */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  {data.grandTotal.closingBalance >= 0 ? (
                    <TrendingUp className="h-4 w-4 text-green-600" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-red-600" />
                  )}
                  Monthly Transactions
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
                        formatter={(value: number) => formatAmount(value)}
                        contentStyle={{
                          backgroundColor: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "6px",
                        }}
                      />
                      <Bar dataKey="debit" fill="hsl(var(--destructive))" name="Debit" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-4">
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
                      data.grandTotal.closingBalance >= 0 ? "text-green-600" : "text-red-600"
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
