import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingDown, DollarSign, FileText } from "lucide-react";

import { formatSmartCurrency } from "../accountMath";
import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";

export function ExpenseSectionsPanel({ analytics }: { analytics: AnalyticsLegacyState }) {
  const {
    activeSection,
    periodExpenses,
    loadingPeriodExpenses,
    periodExpensesError,
    renderNetProfitAccountsList,
  } = analytics;

  if (!["expenses", "direct-expenses", "indirect-expenses"].includes(activeSection)) return null;

  const isAll = activeSection === "expenses";
  const isDirect = activeSection === "direct-expenses";
  const title = isAll ? "All Expense Accounts" : isDirect ? "Direct Expense Accounts" : "Indirect Expense Accounts";
  const Icon = isAll ? TrendingDown : isDirect ? DollarSign : FileText;
  const iconClasses = isAll
    ? "bg-destructive/10 text-destructive"
    : isDirect
      ? "bg-red-500/10 text-red-600 dark:text-red-400"
      : "bg-orange-500/10 text-orange-600 dark:text-orange-400";

  const report = periodExpenses
    ? isAll
      ? {
          accounts: [...periodExpenses.direct.accounts, ...periodExpenses.indirect.accounts],
          total: periodExpenses.direct.total + periodExpenses.indirect.total,
        }
      : isDirect
        ? periodExpenses.direct
        : periodExpenses.indirect
    : undefined;

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className={`flex h-8 w-8 items-center justify-center rounded-md ${iconClasses}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 className="font-semibold text-base">{title}</h3>
            <p className="text-xs text-muted-foreground">Posted activity for the selected date range</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total</p>
          <p className="text-2xl font-bold font-mono tabular-nums" data-testid="analytics-expense-period-total">
            {report ? formatSmartCurrency(report.total) : "—"}
          </p>
        </div>
      </div>
      {loadingPeriodExpenses ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : periodExpensesError || !report ? (
        <div className="text-sm text-destructive py-6 text-center" role="alert">
          Could not load expenses for this period. Please retry the date filter.
        </div>
      ) : (
        <div className="table-responsive">
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Account Name</TableHead>
                <TableHead className="text-right">Net Expense</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{renderNetProfitAccountsList(report.accounts)}</TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="text-right font-bold font-mono">
                  {formatSmartCurrency(report.total)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </Card>
  );
}
