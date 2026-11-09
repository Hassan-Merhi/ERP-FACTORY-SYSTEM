import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  accountBalanceHistoryBridge,
  propertiesAccountBalanceSplit,
  cents,
  receiptTotals,
  type ReceiptRow,
} from "@/pages/properties/property-rental/paymentsReceiptMath";
import { HISTORICAL_RENT_CUTOFF } from "@/pages/properties/property-rental/historicalRentSnapshot";

/** Read-only ledger reconciliation. Fetches accounting statements but NEVER writes. */
export type ReconciliationSnapshot = {
  companyId: number | undefined;
  loading: boolean;
  verified: boolean;
  accountSum: number | null;
  aliCashLedgerId: number | null;
  cashboxLedgerId: number | null;
  rentAndCashBalance: number | null;
  depositBalance: number | null;
  guaranteeCashOverlap: number | null;
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
  return statement.transactions.reduce(
    (total, entry) =>
      total +
      (side === "debit"
        ? cents(entry.debitAmount) - cents(entry.creditAmount)
        : cents(entry.creditAmount) - cents(entry.debitAmount)),
    0
  );
}


export function useRentalReconciliation({ payments, companyId, isLoading, isError = false }: {
  payments: ReconciliationPayment[];
  companyId: number | undefined;
  isLoading: boolean;
  isError?: boolean;
}): ReconciliationSnapshot {
  const {
    data: accounts,
    isError: accountsError,
    isLoading: accountsLoading,
  } = useQuery<LedgerAccount[]>({
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
  const cashbox = uniqueAccount((a) => a.name.trim().toUpperCase() === "PROPERTIES RENT CASHBOX");

  const {
    data: withdrawalStatement,
    isError: withdrawalError,
    isLoading: withdrawalLoading,
  } = useQuery<LedgerStatement>({
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
  const {
    data: depositsStatement,
    isError: depositsError,
    isLoading: depositsLoading,
  } = useQuery<LedgerStatement>({
    queryKey: ["/api/accounts/ledger", deposits?.id, "transactions", "all", companyId],
    enabled: !!companyId && !!deposits,
    queryFn: async () => {
      const response = await fetch("/api/accounts/ledger/" + deposits!.id + "/transactions", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Cannot load Tenant Deposits statement");
      return response.json();
    },
  });
  const {
    data: aliStatement,
    isError: aliError,
    isLoading: aliLoading,
  } = useQuery<LedgerStatement>({
    queryKey: ["/api/accounts/ledger", ali?.id, "transactions", "all", companyId],
    enabled: !!companyId && !!ali,
    queryFn: async () => {
      const response = await fetch("/api/accounts/ledger/" + ali!.id + "/transactions", { credentials: "include" });
      if (!response.ok) throw new Error("Cannot load ALI KOLWEZI RENT CASH statement");
      return response.json();
    },
  });

  const {
    data: cashboxStatement,
    isError: cashboxError,
    isLoading: cashboxLoading,
  } = useQuery<LedgerStatement>({
    queryKey: ["/api/accounts/ledger", cashbox?.id, "transactions", "all", companyId],
    enabled: !!companyId && !!cashbox,
    queryFn: async () => {
      const response = await fetch("/api/accounts/ledger/" + cashbox!.id + "/transactions", { credentials: "include" });
      if (!response.ok) throw new Error("Cannot load Properties Rent Cashbox statement");
      return response.json();
    },
  });

  const totals = useMemo(() => receiptTotals(payments), [payments]);
  const aliLedgerId = ali?.id;
  const cashboxLedgerId = cashbox?.id;
  const bridge = useMemo(
    () =>
      accountBalanceHistoryBridge(
        payments,
        aliLedgerId == null ? null : [aliLedgerId, ...(cashboxLedgerId == null ? [] : [cashboxLedgerId])]
      ),
    [payments, aliLedgerId, cashboxLedgerId]
  );
  const withdrawalAmount = postedMovement(withdrawalStatement, "debit");
  const depositAmount = postedMovement(depositsStatement, "credit");
  const aliAmount = postedMovement(aliStatement, "debit");
  const cashboxAmount = cashbox ? postedMovement(cashboxStatement, "debit") : 0;
  // Account-balance presentation: cash may also include guarantee deposits.
  // Do not label this rent-only or count the result as distinct receipts.
  const { rentAndCashBalance, accountSum } = propertiesAccountBalanceSplit(
    withdrawalAmount,
    depositAmount,
    aliAmount,
    cashboxAmount
  );
  const difference =
    accountSum !== null && bridge.reconciledTotal !== null ? accountSum - bridge.reconciledTotal : null;
  const mixedCurrency = payments.some((row) => row.currency && row.currency.toUpperCase() !== "USD");
  const loading = isLoading || accountsLoading || withdrawalLoading || depositsLoading || aliLoading || cashboxLoading;
  const unavailable =
    isError ||
    accountsError ||
    withdrawalError ||
    depositsError ||
    aliError ||
    cashboxError ||
    !withdrawal ||
    !deposits ||
    !ali ||
    mixedCurrency;
  const verified = !loading && !unavailable && difference === 0;

  return {
    companyId,
    loading: loading || unavailable,
    verified,
    accountSum,
    aliCashLedgerId: ali?.id ?? null,
    cashboxLedgerId: cashbox?.id ?? null,
    rentAndCashBalance,
    depositBalance: depositAmount,
    guaranteeCashOverlap: bridge.cashAndLiabilityOverlap,
    recorded: totals.recorded,
    netAdjustment: bridge.netAdjustment,
    reconciled: bridge.reconciledTotal,
    difference,
  };
}
