import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Scale } from "lucide-react";
import { formatMoneyNumber } from "@/lib/moneyDisplay";
import {
  HISTORICAL_RENT_CUTOFF,
  HISTORICAL_RENT_CUTOFF_LABEL,
  belongsToHistoricalRentSnapshot,
} from "../historicalRentSnapshot";

export type ReconciliationPayment = {
  id: number;
  paymentDate: string;
  amount: string | number;
  voucherId: number | null;
  postingStatus?: string;
  reconciliationCategory?: string;
  tenantName: string | null;
  unitNumber: string | null;
  currency?: string;
  notes: string | null;
};

type LedgerAccount = { id: number; name: string; code?: string };
type LedgerMovement = { debitAmount?: string | number | null; creditAmount?: string | number | null };
type LedgerStatement = { transactions: LedgerMovement[]; preNetBalance?: number };

const inCents = (value: string | number | null | undefined) =>
  Math.round(Number(value ?? 0) * 100);
const money = (cents: number) => "$" + formatMoneyNumber(cents / 100);

function explainExclusion(row: ReconciliationPayment): string {
  if (row.postingStatus === "SCHEDULED") return "Scheduled, not received";
  if (row.paymentDate.slice(0, 10) > HISTORICAL_RENT_CUTOFF) return "Received after 26 Oct";
  if (row.reconciliationCategory === "GUARANTEE") return "Guarantee / deposit movement";
  if (row.voucherId == null) return "No posted voucher — review";
  if (row.postingStatus !== "POSTED") return "Not posted";
  if (row.reconciliationCategory === "OTHER") return "Other / billing adjustment";
  return "Outside historical rent scope";
}

/**
 * Read-only reconciliation. Both source totals are calculated from the same
 * company-scoped payments endpoint, while the GL comparison is independently
 * fetched from the existing Accounts statement endpoint. No books are changed.
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
    const excluded = payments.filter((payment) => !belongsToHistoricalRentSnapshot(payment));
    const sum = (rows: ReconciliationPayment[]) => rows.reduce((total, row) => total + inCents(row.amount), 0);
    const unvouchered = payments.filter((row) => row.postingStatus === "POSTED" && row.voucherId == null);
    return {
      all: sum(payments),
      historical: sum(historical),
      excluded: sum(excluded),
      excludedRows: excluded,
      historicalCount: historical.length,
      unvouchered,
      mixedCurrency: payments.some((row) => row.currency && row.currency.toUpperCase() !== "USD"),
    };
  }, [payments]);

  const { data: accounts, isError: accountsError, isLoading: accountsLoading } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/accounts/all-ledger", { companyId, purpose: "properties-rent-reconciliation" }],
    enabled: !!companyId,
    queryFn: async () => {
      const response = await fetch("/api/accounts/all-ledger", { credentials: "include" });
      if (!response.ok) throw new Error("Cannot load account list");
      return response.json();
    },
  });
  // Do not assume an account ID: resolve its name within the selected company.
  const matches = (accounts ?? []).filter((account) =>
    account.name.trim().toUpperCase().startsWith("HP RENTAL WITHDRAWAL")
  );
  const ledgerAccount = matches.length === 1 ? matches[0] : undefined;
  const {
    data: statement,
    isError: ledgerError,
    isLoading: ledgerLoading,
  } = useQuery<LedgerStatement>({
    queryKey: ["/api/accounts/ledger", ledgerAccount?.id, "transactions", HISTORICAL_RENT_CUTOFF, companyId],
    enabled: !!companyId && !!ledgerAccount,
    queryFn: async () => {
      const response = await fetch(
        "/api/accounts/ledger/" + ledgerAccount!.id + "/transactions?endDate=" + HISTORICAL_RENT_CUTOFF,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Cannot load ledger transactions");
      return response.json();
    },
  });

  const ledgerMovement = statement
    ? statement.transactions.reduce(
        (total, entry) => total + inCents(entry.debitAmount) - inCents(entry.creditAmount),
        0
      )
    : null;
  const ledgerDifference = ledgerMovement === null ? null : sums.historical - ledgerMovement;
  const notReady = isLoading || accountsLoading || ledgerLoading;
  const hasExceptions = sums.unvouchered.length > 0 || (ledgerDifference !== null && ledgerDifference !== 0);
  const ledgerUnavailable = !notReady && (accountsError || ledgerError || matches.length !== 1);
  const comparable = !sums.mixedCurrency;

  return (
    <section className="rounded-lg border border-border p-3 sm:p-4 space-y-3" aria-label="Rent and ledger reconciliation" data-testid="properties-payments-reconciliation">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold flex items-center gap-2"><Scale className="h-4 w-4" /> Payments reconciliation</h2>
          <p className="text-xs text-muted-foreground">
            Same company and cutoff: {HISTORICAL_RENT_CUTOFF_LABEL}. Read-only — no journals or balances are changed.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowDetails((previous) => !previous)}>
          {showDetails ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
          {showDetails ? "Hide exceptions" : "Inspect differences (" + sums.excludedRows.length + ")"}
        </Button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <div className="rounded-md bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">All payment records</p>
          <p className="text-xl font-bold tabular-nums" data-testid="rent-reconcile-all">{isLoading ? "…" : money(sums.all)}</p>
          <p className="text-xs text-muted-foreground">{payments.length} records, all dates and categories</p>
        </div>
        <div className="rounded-md bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">Excluded from historical rent</p>
          <p className="text-xl font-bold tabular-nums" data-testid="rent-reconcile-excluded">{isLoading ? "…" : money(sums.excluded)}</p>
          <p className="text-xs text-muted-foreground">{sums.excludedRows.length} later / other records</p>
        </div>
        <div className="rounded-md bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">Rent received through 26 Oct</p>
          <p className="text-xl font-bold tabular-nums" data-testid="rent-reconcile-historical">{isLoading ? "…" : money(sums.historical)}</p>
          <p className="text-xs text-muted-foreground">{sums.historicalCount} posted rent allocations</p>
        </div>
        <div className="rounded-md bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">HP Rental Withdrawal — ledger movements</p>
          <p className="text-xl font-bold tabular-nums" data-testid="rent-reconcile-ledger">
            {notReady ? "…" : ledgerUnavailable || ledgerMovement === null ? "Unavailable" : money(ledgerMovement)}
          </p>
          <p className="text-xs text-muted-foreground">Posted debits less credits through 26 Oct; opening excluded</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 items-center text-sm">
        <span className="font-medium" data-testid="rent-reconcile-difference">
          Rent vs ledger: {notReady || ledgerUnavailable || ledgerDifference === null ? "Not verified" : money(ledgerDifference)}
        </span>
        {!notReady && !ledgerUnavailable && comparable && !hasExceptions ? (
          <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" /> Ledger movements match historical rent
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" /> {hasExceptions ? "Issues require review" : "Ledger verification incomplete"}
          </span>
        )}
        {sums.unvouchered.length > 0 && (
          <span className="text-amber-600 dark:text-amber-400">{sums.unvouchered.length} posted payment(s) without a voucher</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        All records {money(sums.all)} − excluded {money(sums.excluded)} = historical rent {money(sums.historical)}.
        Exclusions are not automatically missing money. Only compare historical rent with GL movements at the same cutoff.
      </p>
      {ledgerUnavailable && <p className="text-xs text-amber-600 dark:text-amber-400">
        {matches.length > 1 ? "Multiple HP Rental Withdrawal accounts exist; automatic comparison is unsafe."
          : matches.length === 0 && !accountsError ? "HP Rental Withdrawal account was not found in this company."
          : "Account statement is unavailable; no ledger match can be certified."}
      </p>}
      {sums.mixedCurrency && <p className="text-xs text-amber-600 dark:text-amber-400">
        Non-USD receipts are present. Raw currency amounts cannot be compared without conversion to their booked USD values.
      </p>}
      {showDetails && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Records outside the 26 Oct posted-rent snapshot</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="rent-reconcile-exceptions-table">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left p-2">Date</th>
                  <th className="text-left p-2">Tenant / unit</th>
                  <th className="text-left p-2">Reason</th>
                  <th className="text-left p-2">Voucher</th>
                  <th className="text-right p-2">Amount</th>
                </tr>
              </thead>
              <tbody>
                {sums.excludedRows.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-2 whitespace-nowrap">{row.paymentDate.slice(0, 10)}</td>
                    <td className="p-2">{row.tenantName ?? "—"} / {row.unitNumber ?? "—"}</td>
                    <td className="p-2">{explainExclusion(row)}</td>
                    <td className="p-2">{row.voucherId == null ? "No entry" : "#" + row.voucherId}</td>
                    <td className="p-2 text-right tabular-nums">{money(inCents(row.amount))}</td>
                  </tr>
                ))}
                {sums.excludedRows.length === 0 && <tr><td colSpan={5} className="p-3 text-muted-foreground">No exclusions.</td></tr>}
              </tbody>
              <tfoot className="border-t bg-muted/40">
                <tr><td colSpan={4} className="p-2 font-semibold">Excluded subtotal</td>
                  <td className="p-2 text-right font-semibold tabular-nums">{money(sums.excluded)}</td></tr>
              </tfoot>
            </table>
          </div>
          {sums.unvouchered.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Review unvouchered posted payment IDs: {sums.unvouchered.map((row) => "#" + row.id).join(", ")}.
              A legacy billing adjustment may be intentional; verify before correcting anything.
            </p>
          )}
          {ledgerDifference !== null && ledgerDifference !== 0 && <p className="text-xs text-amber-600 dark:text-amber-400">
            The ledger discrepancy is not explained by the payment-log exclusions. Inspect posted voucher lines, opening balances and any migrated rent entries before making accounting corrections.
          </p>}
        </div>
      )}
    </section>
  );
}
