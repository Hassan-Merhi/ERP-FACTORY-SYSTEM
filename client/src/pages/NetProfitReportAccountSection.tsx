// Extracted from ./NetProfitReport.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";

export type Period =
  "today" | "yesterday" | "this_week" | "this_month" | "this_year" | "all_time" | "specific_month" | "custom_range";

export const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This Week" },
  { value: "this_month", label: "This Month" },
  { value: "this_year", label: "This Year" },
  { value: "all_time", label: "All Time" },
  { value: "specific_month", label: "Monthly" },
  { value: "custom_range", label: "Custom Range" },
];

export const MONTH_NAMES = [
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

export function getDateRange(
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

export function formatAmount(n: number) {
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
