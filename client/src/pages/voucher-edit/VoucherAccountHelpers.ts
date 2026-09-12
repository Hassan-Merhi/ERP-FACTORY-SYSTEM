import { useMemo } from "react";
import { CombinedAccount } from "@/components/AccountAutocomplete";
import { formatNumber } from "@/lib/formatNumber";
import { LedgerAccount, BankAccount, Supplier } from "./VoucherEditHelpers";

export interface AccountWithBalance {
  type: string;
  id: string | number;
  accountId?: number;
  name: string;
  balance: string | number;
  balanceSide?: string;
  code?: string;
}

export const useAccountsWithBalances = (
  ledgerAccounts: LedgerAccount[],
  bankAccounts: BankAccount[],
  suppliers: Supplier[],
  allAccountsData: AccountWithBalance[],
  balanceAdjustments: Record<string, number>
) => {
  return useMemo(() => {
    const accounts: CombinedAccount[] = [];
    ledgerAccounts.forEach((ledger) => {
      const accountData = allAccountsData.find((a) => a.id === `ledger-${ledger.id}`);
      const baseBalance = Number(accountData?.balance ?? 0);
      const adjustment = balanceAdjustments[`ledger-${ledger.id}`] || 0;
      const adjustedBalance = baseBalance + adjustment;
      accounts.push({
        type: "ledger",
        id: ledger.id,
        name: ledger.name,
        code: ledger.code,
        balance: formatNumber(adjustedBalance),
      });
    });

    bankAccounts.forEach((bank) => {
      const accountData = allAccountsData.find((a) => a.id === `bank-${bank.id}`);
      const baseBalance = Number(accountData?.balance ?? bank.balance ?? 0);
      const adjustment = balanceAdjustments[`bank-${bank.id}`] || 0;
      const adjustedBalance = baseBalance + adjustment;
      accounts.push({
        type: "bank",
        id: bank.id,
        name: bank.bankName,
        code: bank.accountNumber,
        balance: formatNumber(adjustedBalance),
      });
    });

    suppliers.forEach((supplier) => {
      const accountData = allAccountsData.find((a) => a.id === `supplier-${supplier.id}`);
      const baseBalance = Number(accountData?.balance ?? 0);
      const adjustment = balanceAdjustments[`supplier-${supplier.id}`] || 0;
      const adjustedBalance = baseBalance + adjustment;
      accounts.push({
        type: "supplier",
        id: supplier.id,
        name: supplier.legalName,
        code: supplier.code,
        balance: formatNumber(adjustedBalance),
      });
    });

    allAccountsData
      .filter((a) => a.type === "factorySupplier")
      .forEach((fs) => {
        const adjustment = balanceAdjustments[`factorySupplier-${fs.id}`] || 0;
        const adjustedBalance =
          (typeof fs.balance === "number" ? fs.balance : parseFloat(fs.balance || "0")) + adjustment;
        accounts.push({
          type: "factorySupplier" as const,
          id: Number(fs.id),
          name: fs.name,
          code: fs.code || String(fs.id),
          balance: formatNumber(adjustedBalance),
        });
      });

    return accounts.sort((a, b) => a.name.localeCompare(b.name));
  }, [ledgerAccounts, bankAccounts, suppliers, allAccountsData, balanceAdjustments]);
};
