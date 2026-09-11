import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BankAccount } from "./voucherTypes";
import type { Account } from "@/components/AccountSidebar";

interface BalanceTransaction {
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  currency?: string | null;
}

interface CurrencyLedgerBalance {
  currencyCode: string;
  netBalance?: string | number | null;
}

interface UseAccountBalanceProps {
  paymentAccountType: string;
  paymentAccountId: number;
  bankAccounts: BankAccount[];
  selectedAccountOpeningBalance?: string;
  sidebarAccounts?: Account[];
}

export function useAccountBalance({
  paymentAccountType,
  paymentAccountId,
  bankAccounts,
  selectedAccountOpeningBalance,
  sidebarAccounts,
}: UseAccountBalanceProps) {
  // Prefer the pre-computed balance that the voucher-sidebar endpoint already
  // calculates server-side from all voucher entries.  This is authoritative and
  // avoids a second round-trip that can return 0 on first render or drift from
  // the sidebar figure.
  const sidebarAccount = useMemo(
    () => sidebarAccounts?.find((a) => a.type === paymentAccountType && a.id === paymentAccountId) ?? null,
    [sidebarAccounts, paymentAccountType, paymentAccountId]
  );

  // Only run the fetch-based fallback when the sidebar data hasn't arrived yet
  // or (unlikely) doesn't include this particular account.
  const { data: fetchedBalance = 0 } = useQuery({
    queryKey: ["/api/accounts", paymentAccountType, paymentAccountId, "balance"],
    enabled: paymentAccountId > 0 && sidebarAccount === null,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (paymentAccountType === "bank") {
        const account = bankAccounts.find((b) => b.id === paymentAccountId);
        return account ? parseFloat(account.balance || "0") : 0;
      } else if (paymentAccountType === "ledger") {
        const accountRes = await fetch(`/api/ledger-accounts/${paymentAccountId}`);
        const account = await accountRes.json();
        const transRes = await fetch(`/api/accounts/ledger/${paymentAccountId}/transactions`);
        const transactions: BalanceTransaction[] = await transRes.json();
        let openingBalance = parseFloat(account.openingBalance || "0");
        if (account.openingBalanceSide === "Cr") openingBalance = -openingBalance;
        return transactions.reduce((sum: number, t) => {
          return sum + parseFloat(String(t.debitAmount || "0")) - parseFloat(String(t.creditAmount || "0"));
        }, openingBalance);
      } else if (paymentAccountType === "supplier") {
        const supplierRes = await fetch(`/api/suppliers/${paymentAccountId}`);
        const supplier = await supplierRes.json();
        const transRes = await fetch(`/api/accounts/supplier/${paymentAccountId}/transactions`);
        const transactions: BalanceTransaction[] = await transRes.json();
        const openingBalance = parseFloat(supplier.openingBalance || "0");
        return transactions.reduce((sum: number, t) => {
          return sum + parseFloat(String(t.creditAmount || "0")) - parseFloat(String(t.debitAmount || "0"));
        }, openingBalance);
      } else if (paymentAccountType === "employee") {
        const openingBalance = parseFloat(selectedAccountOpeningBalance || "0");
        const transRes = await fetch(`/api/accounts/employee/${paymentAccountId}/transactions`);
        const transactions: BalanceTransaction[] = await transRes.json();
        return transactions.reduce((sum: number, t) => {
          return sum + parseFloat(String(t.creditAmount || "0")) - parseFloat(String(t.debitAmount || "0"));
        }, openingBalance);
      } else if (paymentAccountType === "fixedAsset") {
        const openingBalance = parseFloat(selectedAccountOpeningBalance || "0");
        const transRes = await fetch(`/api/accounts/fixed-asset/${paymentAccountId}/transactions`);
        const transactions: BalanceTransaction[] = await transRes.json();
        return transactions.reduce((sum: number, t) => {
          return sum + parseFloat(String(t.debitAmount || "0")) - parseFloat(String(t.creditAmount || "0"));
        }, openingBalance);
      } else if (paymentAccountType === "customer") {
        const customerRes = await fetch(`/api/customers/${paymentAccountId}`);
        const customer = await customerRes.json();
        const transRes = await fetch(`/api/accounts/customer/${paymentAccountId}/transactions`);
        const transactions: BalanceTransaction[] = await transRes.json();
        const openingBalance = parseFloat(customer.openingBalance || "0");
        return transactions.reduce((sum: number, t) => {
          return sum + parseFloat(String(t.debitAmount || "0")) - parseFloat(String(t.creditAmount || "0"));
        }, openingBalance);
      } else if (paymentAccountType === "factorySupplier") {
        const res = await fetch(`/api/factory/suppliers/${paymentAccountId}/balance`);
        const data = await res.json();
        return parseFloat(data.outstandingUsd || "0");
      }
      return 0;
    },
  });

  // Resolve final balance: sidebar wins when available.
  const accountBalance = sidebarAccount !== null ? (sidebarAccount.balance ?? 0) : fetchedBalance;

  const { data: accountCurrencyBalances } = useQuery<{ currency: string; balance: number }[] | null>({
    queryKey: ["/api/accounts", paymentAccountType, paymentAccountId, "currencyBalances"],
    enabled: paymentAccountId > 0 && (paymentAccountType === "supplier" || paymentAccountType === "factorySupplier"),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (paymentAccountType === "supplier") {
        const [supplierRes, transRes] = await Promise.all([
          fetch(`/api/suppliers/${paymentAccountId}`, { credentials: "include" }),
          fetch(`/api/accounts/supplier/${paymentAccountId}/transactions`, { credentials: "include" }),
        ]);
        const supplier = await supplierRes.json();
        const transactions: BalanceTransaction[] = await transRes.json();
        const openingBalance = parseFloat(supplier.openingBalance || "0");
        const currMap = new Map<string, number>();
        transactions.forEach((t) => {
          const curr = t.currency || "USD";
          currMap.set(
            curr,
            (currMap.get(curr) ?? 0) +
              parseFloat(String(t.creditAmount || "0")) -
              parseFloat(String(t.debitAmount || "0"))
          );
        });
        currMap.set("USD", (currMap.get("USD") ?? 0) + openingBalance);
        const result = Array.from(currMap.entries())
          .map(([currency, balance]) => ({ currency, balance }))
          .filter((r) => Math.abs(r.balance) >= 0.005);
        const hasNonUsd = result.some((r) => r.currency !== "USD");
        return hasNonUsd ? result : null;
      } else if (paymentAccountType === "factorySupplier") {
        const res = await fetch(`/api/factory/suppliers/${paymentAccountId}/broker-statement`, {
          credentials: "include",
        });
        if (!res.ok) return null;
        const data = await res.json();
        const ledgers: CurrencyLedgerBalance[] = data.currencyLedgers || [];
        if (ledgers.length <= 1) return null;
        return ledgers
          .map((section) => ({
            currency: section.currencyCode,
            balance: parseFloat(String(section.netBalance || "0")),
          }))
          .filter((r) => Math.abs(r.balance) >= 0.005);
      }
      return null;
    },
  });

  return { accountBalance, accountCurrencyBalances, sidebarAccount };
}
