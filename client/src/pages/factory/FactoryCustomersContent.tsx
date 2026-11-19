// Extracted from ./FactoryCustomers.tsx
import { Users, Wallet, Scale } from "lucide-react";
import { useFactoryCustomersState } from "./useFactoryCustomersState";

export function FactoryCustomersContent({
  customers,
  formatCashAmount,
  netBalance,
  totalCredit,
  totalDebit,
}: Pick<
  ReturnType<typeof useFactoryCustomersState>,
  "customers" | "formatCashAmount" | "netBalance" | "totalCredit" | "totalDebit"
>) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="customer-balance-summary">
      <div className="rounded-2xl border border-blue-500/25 bg-blue-500/5 p-3 shadow-sm sm:p-4 dark:border-blue-400/30 dark:bg-blue-500/10">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-blue-500/15 p-2.5 text-blue-600 dark:text-blue-400">
            <Users className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Total Customers</p>
            <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl" data-testid="metric-customers-total">
              {customers.length}
            </p>
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-3 shadow-sm sm:p-4 dark:border-emerald-400/30 dark:bg-emerald-500/10">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-emerald-500/15 p-2.5 text-emerald-600 dark:text-emerald-400">
            <Wallet className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Total Debit</p>
            <p
              className="mt-1 break-all text-base font-bold tabular-nums text-emerald-600 sm:text-xl dark:text-emerald-400"
              data-testid="metric-customers-debit"
            >
              {formatCashAmount(totalDebit)}
            </p>
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-rose-500/25 bg-rose-500/5 p-3 shadow-sm sm:p-4 dark:border-rose-400/30 dark:bg-rose-500/10">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-rose-500/15 p-2.5 text-rose-600 dark:text-rose-400">
            <Wallet className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Total Credit</p>
            <p
              className="mt-1 break-all text-base font-bold tabular-nums text-rose-600 sm:text-xl dark:text-rose-400"
              data-testid="metric-customers-credit"
            >
              {formatCashAmount(totalCredit)}
            </p>
          </div>
        </div>
      </div>
      <div className="rounded-2xl border border-violet-500/25 bg-violet-500/5 p-3 shadow-sm sm:p-4 dark:border-violet-400/30 dark:bg-violet-500/10">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-violet-500/15 p-2.5 text-violet-600 dark:text-violet-400">
            <Scale className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Net Balance</p>
            <p
              className={`mt-1 break-all text-base font-bold tabular-nums sm:text-xl ${netBalance < -0.001 ? "text-rose-600 dark:text-rose-400" : netBalance > 0.001 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}
              data-testid="metric-customers-net"
            >
              {netBalance < -0.001 ? "−" : ""}
              {formatCashAmount(Math.abs(netBalance))}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
