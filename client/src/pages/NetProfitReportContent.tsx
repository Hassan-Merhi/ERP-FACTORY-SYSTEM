// Extracted from ./NetProfitReport.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ShoppingCart, Receipt, TrendingUp } from "lucide-react";
import { AccountSection, KpiCard, formatAmount, useNetProfitReportState } from "./useNetProfitReportState";

export function NetProfitReportContent({
  closingStock,
  directExpTotal,
  directIncTotal,
  indirectExpTotal,
  indirectIncTotal,
  lp,
  netProfit,
  openingStock,
  periodLabel,
  purchasesTotal,
  rp,
  salesTotal,
  totalExpenses,
  totalIncome,
}: Pick<
  ReturnType<typeof useNetProfitReportState>,
  | "closingStock"
  | "directExpTotal"
  | "directIncTotal"
  | "indirectExpTotal"
  | "indirectIncTotal"
  | "lp"
  | "netProfit"
  | "openingStock"
  | "periodLabel"
  | "purchasesTotal"
  | "rp"
  | "salesTotal"
  | "totalExpenses"
  | "totalIncome"
>) {
  return (
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
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Expenses</p>
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
  );
}
