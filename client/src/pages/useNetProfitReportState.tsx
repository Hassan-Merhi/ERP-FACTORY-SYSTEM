// Extracted from ./NetProfitReport.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import type { ApiListRow, AuthMe } from "@shared/apiTypes";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { formatUsd } from "@/lib/moneyDisplay";
import { PERIODS, MONTH_NAMES, getDateRange, type Period } from "./useNetProfitReportStateGetDateRange";
export { PERIODS, MONTH_NAMES, type Period } from "./useNetProfitReportStateGetDateRange";

export function formatAmount(n: number) {
  return formatUsd(Math.abs(Math.round(n)), 0);
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

export function KpiCard({
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

export function AccountSection({
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
              <thead className="sticky top-0 z-30 bg-muted">
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

export function useNetProfitReportState() {
  const { data: user } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const isAdminOrDev = user?.role === "Admin" || user?.role === "Developer";

  const now = new Date();
  const [period, setPeriod] = useState<Period>("today");
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("current");
  const [specificMonth, setSpecificMonth] = useState<number>(now.getMonth() + 1);
  const [specificYear, setSpecificYear] = useState<number>(now.getFullYear());
  const [customFromDate, setCustomFromDate] = useState<string>("");
  const [customToDate, setCustomToDate] = useState<string>("");
  const [isExporting, setIsExporting] = useState(false);
  const { toast } = useToast();

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

  const handleExport = async () => {
    const p = new URLSearchParams();
    if (startDate) p.set("startDate", startDate);
    if (endDate) p.set("endDate", endDate);
    p.set("periodLabel", periodLabel);
    if (isAdminOrDev && selectedCompanyId !== "current" && selectedCompanyId !== "") {
      p.set("companyId", selectedCompanyId);
    }
    setIsExporting(true);
    try {
      await downloadFromUrl(`/api/reports/net-profit-excel?${p.toString()}`, {
        fileName: exportFileName("net profit report", "xlsx", { from: startDate, to: endDate }),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
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
  return {
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
  };
}
