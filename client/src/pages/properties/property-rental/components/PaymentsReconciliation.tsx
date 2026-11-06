import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { accountBalanceHistoryBridge, cents, receiptTotals, type ReceiptRow } from "../paymentsReceiptMath";
import { HISTORICAL_RENT_CUTOFF } from "../historicalRentSnapshot";

/**
 * Read-only accounting calculation for the Properties Payments Log.
 *
 * The previous visible reconciliation dashboard was intentionally removed.
 * Keep the calculation alive for the all-records total and Excel copy, with
 * account balances read from the actual ledger rather than hardcoded amounts.
 * This component renders no UI and performs no accounting writes.
 */
export type ReconciliationSnapshot = {
  companyId: number | undefined;
  loading: boolean;
  verified: boolean;
  accountSum: number | null;
  aliCashLedgerId: number | null;
  recorded: number;
  netAdjustment: number | null;
  reconciled: number | null;
  difference: number | null;
};

export type ReconciliationPayment = ReceiptRow & {
  voucherId: number | null;
  reconciliationCategory?: string;
  currency?: string;
};

type LedgerAccount = { id: number; name: string };
type LedgerMovement = { debitAmount?: string | number | null; creditAmount?: string | number | null };
type LedgerStatement = { transactions: LedgerMovement[] };

function postedMovement(statement: LedgerStatement | undefined, side: "debit" | "credit"): number | null {
  if (!statement) return null;
  return statement.transactions.reduce((total, entry) => total + (side === "debit"
    ? cents(entry.debitAmount) - cents(entry.creditAmount)
    : cents(entry.creditAmount) - cents(entry.debitAmount)), 0);
}

export function PaymentsReconciliation({
  payments,
  companyId,
  isLoading,
  isError = false,
  onReconciliationChange,
}: {
  payments: ReconciliationPayment[];
  companyId: number | undefined;
  isLoading: boolean;
  isError?: boolean;
  onReconciliationChange?: (snapshot: ReconciliationSnapshot) => void;
}) {
  const { data: accounts, isError: accountsError, isLoading: accountsLoading } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/accounts/all-ledger", { companyId, purpose: "properties-cash-reconciliation" }],
    enabled: !!companyId,
    queryFn: async () => {
      const response = await fetch("/api/accounts/all-ledger", { credentials: "include" });
      if (!response.ok) throw new Error("Cannot load Accounts list");
      return response.json();
    },
  });

  const uniqueAccount = (match: (account: LedgerAccount) => boolean) => {
    const matches = (accounts ?? []).filter(match);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const withdrawal = uniqueAccount((a) => a.name.trim().toUpperCase().startsWith("HP RENTAL WITHDRAWAL"));
  const deposits = uniqueAccount((a) => a.name.trim().toUpperCase() === "TENANT DEPOSITS");
  const ali = uniqueAccount((a) => a.name.trim().toUpperCase() === "ALI KOLWEZI RENT CASH");

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

  const totals = useMemo(() => receiptTotals(payments), [payments]);
  const bridge = useMemo(() => accountBalanceHistoryBridge(payments, ali?.id), [payments, ali?.id]);
  const withdrawalAmount = postedMovement(withdrawalStatement, "debit");
  const depositAmount = postedMovement(depositsStatement, "credit");
  const aliAmount = postedMovement(aliStatement, "debit");
  const accountSum = withdrawalAmount !== null && depositAmount !== null && aliAmount !== null
    ? withdrawalAmount + depositAmount + aliAmount
    : null;
  const difference = accountSum !== null && bridge.reconciledTotal !== null
    ? accountSum - bridge.reconciledTotal : null;
  const mixedCurrency = payments.some((row) => row.currency && row.currency.toUpperCase() !== "USD");
  const loading = isLoading || accountsLoading || withdrawalLoading || depositsLoading || aliLoading;
  const unavailable = isError || accountsError || withdrawalError || depositsError || aliError ||
    !withdrawal || !deposits || !ali || mixedCurrency;
  const verified = !loading && !unavailable && difference === 0;

  useEffect(() => {
    onReconciliationChange?.({
      companyId,
      loading: loading || unavailable,
      verified,
      accountSum,
      aliCashLedgerId: ali?.id ?? null,
      recorded: totals.recorded,
      netAdjustment: bridge.netAdjustment,
      reconciled: bridge.reconciledTotal,
      difference,
    });
  }, [onReconciliationChange, companyId, loading, unavailable, verified,
    accountSum, ali?.id, totals.recorded, bridge.netAdjustment, bridge.reconciledTotal, difference]);

  return null;
}
