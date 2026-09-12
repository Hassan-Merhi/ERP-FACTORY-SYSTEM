import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ui/page-state";
import {
  Download,
  ChevronDown,
  ChevronRight,
  ShoppingCart,
  Receipt,
  BarChart3,
  Building2,
  Loader2,
  TrendingUp,
} from "lucide-react";
import type { AuthMe, ApiListRow } from "@shared/apiTypes";
import type { LucideIcon } from "lucide-react";

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

  if (period === "specific_month" && specificMonth !== undefined && specificYear !== undefined) {
    const lastDay = new Date(specificYear, specificMonth, 0).getDate();
    const start = `${specificYear}-${pad(specificMonth)}-01`;
    const end = `${specificYear}-${pad(specificMonth)}-${pad(lastDay)}`;
    return { startDate: start, endDate: end };
  }

  if (period === "custom_range") {
    return {
      startDate: customFromDate || null,
      endDate: customToDate || null,
    };
  }

  return { startDate: null, endDate: null };
}

function formatAmount(n: number) {
  return (
    "$" +
    new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(
      Math.abs(Math.round(n))
    )
  );
}

function AmountCell({ value, alwaysGreen }: { value: number; alwaysGreen?: boolean }) {
  const isNeg = value < 0;
  const color = alwaysGreen
    ? "text-green-700 dark:text-green-400"
    : isNeg
      ? "text-red-600 dark:text-red-400"
      : "text-green-700 dark:text-green-400";
  return (
    <span className={color}>
      {isNeg ? "-" : ""}
      {formatAmount(Math.abs(value))}
    </span>
  );
}

function KpiCard({
  title,
  value,
  icon: Icon,
  color,
  isProfit,
}: {
  title: string;
  value: number;
  icon: LucideIcon;
  color: string;
  isProfit?: boolean;
}) {
  const isNeg = value < 0;
  const textColor = isProfit ? (isNeg ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400") : "";
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-4">
        <div className={`p-3 rounded-md shrink-0 ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">{title}</p>
          <p className={`text-lg font-bold ${textColor}`}>
            {isNeg ? "-" : ""}
            {formatAmount(Math.abs(value))}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function AccountSection({
  title,
  accounts,
  total,
  type,
  badgeColor,
}: {
  title: string;
  accounts: { name: string; debit: number; credit: number; balance: number }[];
  total: number;
  type: "income" | "expense";
  badgeColor: string;
}) {
  const [open, setOpen] = useState(false);
  const filteredAccounts = accounts.filter((a) => a.debit !== 0 || a.credit !== 0);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full" data-testid={`toggle-section-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        <div className="flex items-center justify-between p-3 rounded-md hover-elevate cursor-pointer">
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
            <Badge className={badgeColor}>{title}</Badge>
            <span className="text-xs text-muted-foreground">
              {filteredAccounts.length} account{filteredAccounts.length !== 1 ? "s" : ""}
            </span>
          </div>
          <span
            className={`font-semibold text-sm ${
              type === "income" ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"
            }`}
          >
            {formatAmount(Math.abs(total))}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-6 mt-1 mb-2 border rounded-md overflow-hidden">
          {filteredAccounts.length === 0 ? (
            <p className="text-xs text-muted-foreground italic p-3">No accounts with transactions in this category.</p>
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
                {filteredAccounts.map((acc, i: number) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2 text-foreground">{acc.name}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{formatAmount(acc.debit)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{formatAmount(acc.credit)}</td>
                    <td className="px-3 py-2 text-right font-medium">
                      <AmountCell value={acc.balance} alwaysGreen={type === "income"} />
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

export default function NetProfitReport() {
  const { data: user } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const isAdminOrDev = user?.role === "Admin" || user?.role === "Developer";

  const now = new Date();
  const [period, setPeriod] = useState<Period>("today");
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("current");
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
    return PERIODS.find((p) => p.value === period)?.label || "This Month";
  }, [period, specificMonth, specificYear, customFromDate, customToDate]);

  const { data: companies = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/companies"],
    enabled: isAdminOrDev,
  });

  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (startDate) p.set("startDate", startDate);
    if (endDate) p.set("endDate", endDate);
    if (isAdminOrDev && selectedCompanyId !== "current" && selectedCompanyId !== "") {
      p.set("companyId", selectedCompanyId);
    }
    return p.toString();
  }, [startDate, endDate, selectedCompanyId, isAdminOrDev]);

  const { data, isLoading, isError, error, refetch } = useQuery({
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
    if (isAdminOrDev && selectedCompanyId !== "current" && selectedCompanyId !== "") {
      p.set("companyId", selectedCompanyId);
    }
    window.open(`/api/reports/net-profit-excel?${p.toString()}`, "_blank");
  };

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

  const yearOptions = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b flex-wrap">
        <div>
          <PageHeader title="Net Profit Report" icon={<BarChart3 className="h-5 w-5" />} />
          <p className="text-sm text-muted-foreground mt-0.5">Income, expenses, and net profit — {periodLabel}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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
          <Button onClick={handleExport} data-testid="button-export-excel" disabled={isLoading}>
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
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
