import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PageHeader } from "@/components/PageHeader";
import {
  TrendingUp,
  TrendingDown,
  BarChart3,
  Receipt,
  ShoppingCart,
  ChevronDown,
  ChevronRight,
  Download,
  ArrowUpRight,
  Equal,
} from "lucide-react";
import { useLocation } from "wouter";

type Period =
  "today" | "yesterday" | "this_week" | "this_month" | "this_year" | "all_time" | "specific_month" | "custom_range";

const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This Week" },
  { value: "this_month", label: "This Month" },
  { value: "this_year", label: "This Year" },
  { value: "all_time", label: "All Time" },
  { value: "specific_month", label: "Monthly" },
  { value: "custom_range", label: "Custom Range" },
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function getDateRange(
  period: Period,
  specificMonth?: number,
  specificYear?: number,
  customFromDate?: string,
  customToDate?: string
): { startDate: string | null; endDate: string | null } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = fmt(now);

  if (period === "today") return { startDate: today, endDate: today };

  if (period === "yesterday") {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const y = fmt(yesterday);
    return { startDate: y, endDate: y };
  }

  if (period === "this_week") {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now);
    monday.setDate(diff);
    return { startDate: fmt(monday), endDate: today };
  }

  if (period === "this_month") {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { startDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, endDate: fmt(lastDay) };
  }

  if (period === "this_year") {
    return { startDate: `${now.getFullYear()}-01-01`, endDate: today };
  }

  if (period === "custom_range") {
    return {
      startDate: customFromDate || null,
      endDate: customToDate || null,
    };
  }

  if (period === "specific_month" && specificMonth !== undefined && specificYear !== undefined) {
    const lastDay = new Date(specificYear, specificMonth, 0).getDate();
    const start = `${specificYear}-${pad(specificMonth)}-01`;
    const end = `${specificYear}-${pad(specificMonth)}-${pad(lastDay)}`;
    return { startDate: start, endDate: end };
  }

  return { startDate: null, endDate: null };
}

function fmt(n: number): string {
  return (
    "$" +
    new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(n))
  );
}

interface BreakdownAccount {
  id?: number;
  name: string;
  debit: number;
  credit: number;
  balance: number;
}

function AccountBreakdown({
  title,
  accounts,
  total,
  type,
  badgeClass,
}: {
  title: string;
  accounts: BreakdownAccount[];
  total: number;
  type: "income" | "expense";
  badgeClass: string;
}) {
  const [open, setOpen] = useState(false);
  const [, _navigate] = useLocation();
  const active = (accounts || []).filter((a) => a.debit !== 0 || a.credit !== 0);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full" data-testid={`toggle-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        <div className="flex items-center justify-between px-3 py-2.5 rounded-md hover-elevate cursor-pointer">
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badgeClass}`}>{title}</span>
            <span className="text-xs text-muted-foreground">
              {active.length} account{active.length !== 1 ? "s" : ""}
            </span>
          </div>
          <span
            className={`font-mono text-sm font-semibold ${type === "income" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          >
            {fmt(total)}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-6 mb-2 border rounded-md overflow-x-auto">
          {active.length === 0 ? (
            <p className="text-xs text-muted-foreground italic p-3">No transactions in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-30 bg-muted/50">
                <tr className="bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Account</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Debit</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Credit</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Net</th>
                </tr>
              </thead>
              <tbody>
                {active.map((acc, i: number) => (
                  <tr
                    key={i}
                    className="border-t hover-elevate cursor-pointer"
                    onClick={() => acc.id && window.open(`/factory/ledger-monthly/${acc.id}`, "_blank")}
                  >
                    <td className="px-3 py-2 text-foreground hover:underline">{acc.name}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground font-mono">{fmt(acc.debit)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground font-mono">{fmt(acc.credit)}</td>
                    <td
                      className={`px-3 py-2 text-right font-mono font-medium ${type === "income" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                    >
                      {fmt(Math.abs(acc.balance))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function FactoryNetProfitAnalytics() {
  const now = new Date();
  const [period, setPeriod] = useState<Period>("today");
  const [specificMonth, setSpecificMonth] = useState<number>(now.getMonth() + 1);
  const [specificYear, setSpecificYear] = useState<number>(now.getFullYear());
  const [customFromDate, setCustomFromDate] = useState<string>("");
  const [customToDate, setCustomToDate] = useState<string>("");

  const { startDate, endDate } = useMemo(
    () => getDateRange(period, specificMonth, specificYear, customFromDate, customToDate),
    [period, specificMonth, specificYear, customFromDate, customToDate]
  );

  const periodLabel = useMemo(() => {
    if (period === "specific_month") {
      return `${MONTH_NAMES[specificMonth - 1]} ${specificYear}`;
    }
    if (period === "custom_range") {
      if (customFromDate && customToDate) return `${customFromDate} — ${customToDate}`;
      if (customFromDate) return `From ${customFromDate}`;
      if (customToDate) return `Until ${customToDate}`;
      return "Custom Range";
    }
    return PERIODS.find((p) => p.value === period)?.label || "All Time";
  }, [period, specificMonth, specificYear, customFromDate, customToDate]);

  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (startDate) p.set("startDate", startDate);
    if (endDate) p.set("endDate", endDate);
    return p.toString();
  }, [startDate, endDate]);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/reports/net-profit-statement", queryParams],
    queryFn: async ({ queryKey }) => {
      const params = queryKey[1] as string;
      const url = `/api/reports/net-profit-statement${params ? `?${params}` : ""}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const handleExport = () => {
    const p = new URLSearchParams();
    if (startDate) p.set("startDate", startDate);
    if (endDate) p.set("endDate", endDate);
    p.set("periodLabel", periodLabel);
    window.open(`/api/reports/net-profit-excel?${p.toString()}`, "_blank");
  };

  const yearOptions = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  const lp = data?.leftPane;
  const rp = data?.rightPane;

  const salesTotal = rp?.salesAccounts?.total ?? 0;
  const closingStock = rp?.closingStock?.value ?? 0;
  const openingStock = lp?.openingStock?.value ?? 0;
  const purchasesTotal = lp?.purchaseAccounts?.total ?? 0;
  const directExpTotal = lp?.directExpenses?.total ?? 0;
  const directIncTotal = rp?.directIncomes?.total ?? 0;
  const indirectExpTotal = lp?.indirectExpenses?.total ?? 0;
  const indirectIncTotal = rp?.indirectIncomes?.total ?? 0;

  const totalIncome = salesTotal + directIncTotal + indirectIncTotal + closingStock;
  const totalExpenses = openingStock + purchasesTotal + directExpTotal + indirectExpTotal;
  const netProfit = totalIncome - totalExpenses;
  const isPositive = netProfit >= 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <PageHeader title="Net Profit Analytics" icon={<BarChart3 className="h-5 w-5" />} />
          <p className="text-muted-foreground text-sm mt-1">Income, expenses and profitability — {periodLabel}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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
                <Label htmlFor="factory-np-from" className="text-sm whitespace-nowrap text-muted-foreground">
                  From:
                </Label>
                <Input
                  id="factory-np-from"
                  type="date"
                  value={customFromDate}
                  onChange={(e) => setCustomFromDate(e.target.value)}
                  className="w-36"
                  data-testid="input-custom-from-date"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="factory-np-to" className="text-sm whitespace-nowrap text-muted-foreground">
                  To:
                </Label>
                <Input
                  id="factory-np-to"
                  type="date"
                  value={customToDate}
                  onChange={(e) => setCustomToDate(e.target.value)}
                  className="w-36"
                  data-testid="input-custom-to-date"
                />
              </div>
              {(customFromDate || customToDate) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCustomFromDate("");
                    setCustomToDate("");
                  }}
                  data-testid="button-clear-custom-dates"
                >
                  Clear
                </Button>
              )}
            </>
          )}
          <Button variant="outline" onClick={handleExport} data-testid="button-export" disabled={isLoading}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      {/* Net Position Breakdown — 4 panel layout */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="section-breakdown">
          {/* Panel 1 — What We Made */}
          <Card data-testid="card-income">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <ArrowUpRight className="h-4 w-4 text-green-600 dark:text-green-400" />
                <span className="text-sm font-semibold text-green-600 dark:text-green-400">What We Made</span>
              </div>
              <p className="text-xs text-muted-foreground mb-1">Total Revenue:</p>
              <p
                className="text-xl font-bold text-green-600 dark:text-green-400 font-mono"
                data-testid="text-total-income"
              >
                {fmt(totalIncome)}
              </p>
              <div className="mt-3 space-y-1">
                {salesTotal > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Sales</span>
                    <span className="font-mono">{fmt(salesTotal)}</span>
                  </div>
                )}
                {directIncTotal > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Direct Income</span>
                    <span className="font-mono">{fmt(directIncTotal)}</span>
                  </div>
                )}
                {indirectIncTotal > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Indirect Income</span>
                    <span className="font-mono">{fmt(indirectIncTotal)}</span>
                  </div>
                )}
                {closingStock > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Closing Stock</span>
                    <span className="font-mono">{fmt(closingStock)}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Panel 2 — What We Bought */}
          <Card data-testid="card-purchases">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <ShoppingCart className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                <span className="text-sm font-semibold text-orange-600 dark:text-orange-400">What We Bought</span>
              </div>
              <p className="text-xs text-muted-foreground mb-1">Total Purchases:</p>
              <p
                className="text-xl font-bold text-orange-600 dark:text-orange-400 font-mono"
                data-testid="text-purchases"
              >
                {fmt(purchasesTotal + openingStock)}
              </p>
              <div className="mt-3 space-y-1">
                {openingStock > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Opening Stock</span>
                    <span className="font-mono">{fmt(openingStock)}</span>
                  </div>
                )}
                {purchasesTotal > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Purchases</span>
                    <span className="font-mono">{fmt(purchasesTotal)}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Panel 3 — What We Spent */}
          <Card data-testid="card-expenses">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <Receipt className="h-4 w-4 text-red-600 dark:text-red-400" />
                <span className="text-sm font-semibold text-red-600 dark:text-red-400">What We Spent</span>
              </div>
              <p className="text-xs text-muted-foreground mb-1">Total Expenses:</p>
              <p className="text-xl font-bold text-red-600 dark:text-red-400 font-mono" data-testid="text-expenses">
                {fmt(directExpTotal + indirectExpTotal)}
              </p>
              <div className="mt-3 space-y-1">
                {directExpTotal > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Direct Expense</span>
                    <span className="font-mono">{fmt(directExpTotal)}</span>
                  </div>
                )}
                {indirectExpTotal > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Indirect Expense</span>
                    <span className="font-mono">{fmt(indirectExpTotal)}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Panel 4 — Net Profit */}
          <Card data-testid="card-net-profit">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <Equal className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Net Profit</span>
              </div>
              <p className="text-xs text-muted-foreground mb-1">{isPositive ? "Revenue − Expenses:" : "Deficit:"}</p>
              <p
                className={`text-xl font-bold font-mono ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                data-testid="text-net-profit"
              >
                {netProfit < 0 ? "-" : ""}
                {fmt(Math.abs(netProfit))}
              </p>
              <div className="mt-3 space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Revenue</span>
                  <span className="font-mono text-green-600 dark:text-green-400">{fmt(totalIncome)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>− Expenses</span>
                  <span className="font-mono text-red-600 dark:text-red-400">{fmt(totalExpenses)}</span>
                </div>
                <Separator className="my-1" />
                <div className="flex justify-between text-xs font-semibold">
                  <span>= Net</span>
                  <span
                    className={`font-mono ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                  >
                    {netProfit < 0 ? "-" : ""}
                    {fmt(Math.abs(netProfit))}
                  </span>
                </div>
              </div>
              <div className="mt-3">
                <Badge
                  variant="outline"
                  className={`text-xs ${isPositive ? "border-green-500 text-green-600 dark:text-green-400" : "border-red-500 text-red-600 dark:text-red-400"}`}
                  data-testid="badge-net-position-label"
                >
                  {isPositive ? "Profitable" : "Loss-making"}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Summary P&L Card */}
      {!isLoading && data && (
        <Card data-testid="card-pnl-summary">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Profit & Loss Summary — {periodLabel}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Income Side */}
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
                    <span className="text-green-600 dark:text-green-400 font-mono">{fmt(value)}</span>
                  </div>
                ))}
                <Separator className="my-2" />
                <div className="flex justify-between text-sm font-semibold">
                  <span>Total Income</span>
                  <span className="text-green-600 dark:text-green-400 font-mono">{fmt(totalIncome)}</span>
                </div>
              </div>

              {/* Expense Side */}
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Expenses</p>
                {[
                  { label: "Opening Stock", value: openingStock },
                  { label: "Purchases", value: purchasesTotal },
                  { label: "Direct Expenses", value: directExpTotal },
                  { label: "Indirect Expenses", value: indirectExpTotal },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="text-red-600 dark:text-red-400 font-mono">{fmt(value)}</span>
                  </div>
                ))}
                <Separator className="my-2" />
                <div className="flex justify-between text-sm font-semibold">
                  <span>Total Expenses</span>
                  <span className="text-red-600 dark:text-red-400 font-mono">{fmt(totalExpenses)}</span>
                </div>
              </div>
            </div>

            <Separator className="my-4" />

            <div
              className={`flex justify-between items-center font-bold text-base rounded-md px-4 py-3 ${
                isPositive ? "bg-green-50 dark:bg-green-950/30" : "bg-red-50 dark:bg-red-950/30"
              }`}
              data-testid="row-net-profit-bottom"
            >
              <span className="flex items-center gap-2">
                {isPositive ? (
                  <TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />
                ) : (
                  <TrendingDown className="h-5 w-5 text-red-600 dark:text-red-400" />
                )}
                {isPositive ? "Net Profit" : "Net Loss"}
              </span>
              <span
                className={`font-mono ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {netProfit < 0 ? "-" : ""}
                {fmt(Math.abs(netProfit))}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Account Breakdown */}
      {!isLoading && data && (
        <Card data-testid="card-account-breakdown">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Account Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <AccountBreakdown
              title="Sales"
              accounts={rp?.salesAccounts?.accounts || []}
              total={salesTotal}
              type="income"
              badgeClass="bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
            />
            <AccountBreakdown
              title="Purchases"
              accounts={lp?.purchaseAccounts?.accounts || []}
              total={purchasesTotal}
              type="expense"
              badgeClass="bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
            />
            <AccountBreakdown
              title="Direct Incomes"
              accounts={rp?.directIncomes?.accounts || []}
              total={directIncTotal}
              type="income"
              badgeClass="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
            />
            <AccountBreakdown
              title="Direct Expenses"
              accounts={lp?.directExpenses?.accounts || []}
              total={directExpTotal}
              type="expense"
              badgeClass="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            />
            <AccountBreakdown
              title="Indirect Incomes"
              accounts={rp?.indirectIncomes?.accounts || []}
              total={indirectIncTotal}
              type="income"
              badgeClass="bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300"
            />
            <AccountBreakdown
              title="Indirect Expenses"
              accounts={lp?.indirectExpenses?.accounts || []}
              total={indirectExpTotal}
              type="expense"
              badgeClass="bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
