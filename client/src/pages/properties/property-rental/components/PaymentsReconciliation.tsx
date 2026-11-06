import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Scale } from "lucide-react";
import { formatMoneyNumber } from "@/lib/moneyDisplay";
import { cashCents, cents, receiptTotals, type ReceiptRow } from "../paymentsReceiptMath";
import {
  HISTORICAL_RENT_CUTOFF,
  HISTORICAL_RENT_CUTOFF_LABEL,
  belongsToHistoricalRentSnapshot,
} from "../historicalRentSnapshot";

export type ReconciliationPayment = ReceiptRow & {
  id: number;
  paymentDate: string;
  amount: string | number;
  voucherId: number | null;
  tenantName: string | null;
  unitNumber: string | null;
  notes: string | null;
  reconciliationCategory?: string;
  ledgerRowId?: number | null;
  currency?: string;
};

type LedgerAccount = { id: number; name: string; code?: string };
type LedgerMovement = { debitAmount?: string | number | null; creditAmount?: string | number | null };
type LedgerStatement = { transactions: LedgerMovement[]; preNetBalance?: number };

const money = (amount: number) => "$" + formatMoneyNumber(amount / 100);
const postedMovement = (statement: LedgerStatement | undefined, side: "debit" | "credit") =>
  statement
    ? statement.transactions.reduce(
        (sum, line) => sum +
          (side === "debit"
            ? cents(line.debitAmount) - cents(line.creditAmount)
            : cents(line.creditAmount) - cents(line.debitAmount)),
        0
      )
    : null;

function explainExclusion(row: ReconciliationPayment): string {
  if (row.postingStatus === "SCHEDULED") return "Scheduled, not yet received";
  if (row.voucherId == null) return "Non-cash billing adjustment, no receipt voucher";
  if (row.receiptKind === "GUARANTEE_DEPOSIT") return "Guarantee deposit: posted voucher, no stored payment";
  if (row.reconciliationCategory === "GUARANTEE") return "Guarantee movement";
  if (row.paymentDate.slice(0, 10) > HISTORICAL_RENT_CUTOFF) return "Rent after 26 Oct";
  if (row.postingStatus !== "POSTED") return "Not posted";
  return "Other historical payment";
}

/**
 * All comparison rows are read-only: ledger balances and payment history
 * come from their existing endpoints. No backdated vouchers, journals, or
 * opening balances are inserted to force totals to agree.
 */
export function PaymentsReconciliation({
  payments,
  companyId,
  isLoading,
}: {
  payments: ReconciliationPayment[];
  companyId: number | undefined;
  isLoading: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const sums = useMemo(() => {
    const historical = payments.filter(belongsToHistoricalRentSnapshot);
    const excluded = payments.filter((row) => !belongsToHistoricalRentSnapshot(row));
    const guarantee = payments.filter((row) => row.reconciliationCategory === "GUARANTEE");
    const postCutoffRent = payments.filter((row) =>
      (row.reconciliationCategory === "ACTIVE_RENT" || row.reconciliationCategory === "ENDED_RENT") &&
      row.paymentDate.slice(0, 10) > HISTORICAL_RENT_CUTOFF
    );
    const unvouchered = payments.filter((row) => row.postingStatus === "POSTED" && row.voucherId == null);
    const sumCash = (rows: ReconciliationPayment[]) => rows.reduce((sum, row) => sum + cashCents(row), 0);
    return {
      ...receiptTotals(payments),
      historical: sumCash(historical),
      guarantee: sumCash(guarantee),
      postCutoffRent: sumCash(postCutoffRent),
      excludedRows: excluded,
      historicalCount: historical.length,
      unvouchered,
      voucherOnlyGuarantees: payments.filter((row) => row.receiptKind === "GUARANTEE_DEPOSIT"),
      mixedCurrency: payments.some((row) => row.currency && row.currency.toUpperCase() !== "USD"),
    };
  }, [payments]);

  const { data: accounts, isError: accountsError, isLoading: accountsLoading } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/accounts/all-ledger", { companyId, purpose: "properties-cash-reconciliation" }],
    enabled: !!companyId,
    queryFn: async () => {
      const response = await fetch("/api/accounts/all-ledger", { credentials: "include" });
      if (!response.ok) throw new Error("Cannot load Accounts list");
      return response.json();
    },
  });

  // Resolve account IDs from the selected company's ledger; never hardcode IDs.
  const withdrawalMatches = (accounts ?? []).filter((a) => a.name.trim().toUpperCase().startsWith("HP RENTAL WITHDRAWAL"));
  const depositsMatches = (accounts ?? []).filter((a) => a.name.trim().toUpperCase() === "TENANT DEPOSITS");
  const aliMatches = (accounts ?? []).filter((a) => a.name.trim().toUpperCase() === "ALI KOLWEZI RENT CASH");
  const withdrawal = withdrawalMatches.length === 1 ? withdrawalMatches[0] : undefined;
  const deposits = depositsMatches.length === 1 ? depositsMatches[0] : undefined;
  const ali = aliMatches.length === 1 ? aliMatches[0] : undefined;

  const { data: withdrawalStatement, isError: withdrawalError, isLoading: withdrawalLoading } = useQuery<LedgerStatement>({
    queryKey: ["/api/accounts/ledger", withdrawal?.id, "transactions", HISTORICAL_RENT_CUTOFF, companyId],
    enabled: !!companyId && !!withdrawal,
    queryFn: async () => {
      const response = await fetch(
        "/api/accounts/ledger/" + withdrawal!.id + "/transactions?endDate=" + HISTORICAL_RENT_CUTOFF,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Cannot load HP Rental Withdrawal statement");
      return response.json();
    },
  });
  const { data: depositsStatement, isError: depositsError, isLoading: depositsLoading } = useQuery<LedgerStatement>({
    queryKey: ["/api/accounts/ledger", deposits?.id, "transactions", "all", companyId],
    enabled: !!companyId && !!deposits,
    queryFn: async () => {
      const response = await fetch("/api/accounts/ledger/" + deposits!.id + "/transactions", { credentials: "include" });
      if (!response.ok) throw new Error("Cannot load Tenant Deposits statement");
      return response.json();
    },
  });
  const { data: aliStatement, isError: aliError, isLoading: aliLoading } = useQuery<LedgerStatement>({
    queryKey: ["/api/accounts/ledger", ali?.id, "transactions", "all", companyId],
    enabled: !!companyId && !!ali,
    queryFn: async () => {
      const response = await fetch("/api/accounts/ledger/" + ali!.id + "/transactions", { credentials: "include" });
      if (!response.ok) throw new Error("Cannot load ALI KOLWEZI RENT CASH statement");
      return response.json();
    },
  });

  const withdrawalAmount = postedMovement(withdrawalStatement, "debit");
  const depositsAmount = postedMovement(depositsStatement, "credit");
  const aliAmount = postedMovement(aliStatement, "debit");
  const overlap = ali
    ? payments
        .filter((row) => row.reconciliationCategory === "GUARANTEE" && row.cashAccountId === ali.id)
        .reduce((sum, row) => sum + cashCents(row), 0)
    : null;

  const accountSum = withdrawalAmount !== null && depositsAmount !== null && aliAmount !== null
    ? withdrawalAmount + depositsAmount + aliAmount
    : null;
  const adjustedAccountTotal = accountSum !== null && overlap !== null ? accountSum - overlap : null;
  const difference = adjustedAccountTotal !== null ? adjustedAccountTotal - sums.cash : null;
  const loading = isLoading || accountsLoading || withdrawalLoading || depositsLoading || aliLoading;
  const unavailable = accountsError || withdrawalError || depositsError || aliError ||
    withdrawalMatches.length !== 1 || depositsMatches.length !== 1 || aliMatches.length !== 1;
  const verified = !loading && !unavailable && !sums.mixedCurrency && difference === 0;
  const figures = [
    { label: "Historical rent through 26 Oct", amount: sums.historical, hint: "Posted rent with linked vouchers" },
    { label: "Guarantee cash receipts", amount: sums.guarantee, hint: "Includes voucher-only deposits" },
    { label: "Rent received after 26 Oct", amount: sums.postCutoffRent, hint: "Newer posted rent" },
    { label: "Total cash received", amount: sums.cash, hint: "Actual voucher-backed receipts" },
  ];

  return (
    <section className="rounded-lg border border-border p-3 sm:p-4 space-y-3" aria-label="Rent and ledger reconciliation" data-testid="properties-payments-reconciliation">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold flex items-center gap-2"><Scale className="h-4 w-4" /> Properties receipt reconciliation</h2>
          <p className="text-xs text-muted-foreground">
            Historical cutoff {HISTORICAL_RENT_CUTOFF_LABEL}; account movements current. Read-only: no journals or balances changed.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowDetails((previous) => !previous)}>
          {showDetails ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
          {showDetails ? "Hide breakdown" : "Inspect transactions (" + sums.excludedRows.length + ")"}
        </Button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {figures.map((figure) => (
          <div className="rounded-md bg-muted/50 p-3" key={figure.label}>
            <p className="text-xs text-muted-foreground">{figure.label}</p>
            <p className="text-xl font-bold tabular-nums">{isLoading ? "…" : money(figure.amount)}</p>
            <p className="text-xs text-muted-foreground">{figure.hint}</p>
          </div>
        ))}
      </div>
      <div className="border-t pt-3 space-y-2 text-sm">
        <h3 className="font-semibold">Accounts reconciliation (posted movements)</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2">
          {[
            { label: "HP Rental Withdrawal", amount: withdrawalAmount },
            { label: "Tenant Deposits (liability)", amount: depositsAmount },
            { label: "ALI KOLWEZI RENT CASH", amount: aliAmount },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="font-semibold tabular-nums">{loading || unavailable || item.amount === null ? "Unavailable" : money(item.amount)}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>Sum of three account balances: <strong>{!loading && !unavailable && accountSum !== null ? money(accountSum) : "Unavailable"}</strong></span>
          <span>Less overlapping deposit/cash receipt: <strong>{!loading && !unavailable && overlap !== null ? "−" + money(overlap) : "Unavailable"}</strong></span>
          <span>Adjusted cash total: <strong>{!loading && !unavailable && adjustedAccountTotal !== null ? money(adjustedAccountTotal) : "Unavailable"}</strong></span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {verified ? (
            <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400" role="status">
              <CheckCircle2 className="h-4 w-4" /> Cash receipts reconcile — difference $0
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400" role="status">
              <AlertTriangle className="h-4 w-4" />
              {loading || unavailable || sums.mixedCurrency || difference === null
                ? "Verification incomplete" : "Unreconciled difference " + money(difference)}
            </span>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Payment history contains {money(sums.recorded)} in recorded allocations.
        {money(sums.nonCash)} is non-cash billing/adjustments, leaving {money(sums.cash)} in voucher-backed cash.
        {sums.voucherOnlyGuarantees.length} guarantee voucher(s) have no original payment row; they are shown read-only.
      </p>
      {unavailable && !loading && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          One of the three account statements is missing, duplicated, or unavailable.
          Figures cannot be certified until the ledger read succeeds.
        </p>
      )}
      {sums.mixedCurrency && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Some receipts are not in USD. Translate at their booked historical rate before comparing USD totals.
        </p>
      )}
      {showDetails && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Transactions outside the historical rent snapshot</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="rent-reconcile-exceptions-table">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left p-2">Date</th>
                  <th className="text-left p-2">Tenant / unit</th>
                  <th className="text-left p-2">Explanation</th>
                  <th className="text-left p-2">Voucher</th>
                  <th className="text-right p-2">Cash received</th>
                  <th className="text-right p-2">Adjustment</th>
                </tr>
              </thead>
              <tbody>
                {sums.excludedRows.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-2 whitespace-nowrap">{row.paymentDate.slice(0, 10)}</td>
                    <td className="p-2">{row.tenantName ?? "—"} / {row.unitNumber ?? "—"}</td>
                    <td className="p-2">{explainExclusion(row)}</td>
                    <td className="p-2">{row.voucherId == null ? "No voucher" : "#" + row.voucherId}</td>
                    <td className="p-2 text-right tabular-nums">{cashCents(row) ? money(cashCents(row)) : "—"}</td>
                    <td className="p-2 text-right tabular-nums">{row.voucherId == null ? money(cents(row.amount)) : "—"}</td>
                  </tr>
                ))}
                {sums.excludedRows.length === 0 && (
                  <tr><td colSpan={6} className="p-3 text-muted-foreground">No exclusions.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {sums.unvouchered.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Billing-only record(s) without vouchers: {sums.unvouchered.map((row) => "#" + row.id).join(", ")}.
              They remain visible and are not treated as cash.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
