/**
 * Employee amounts as shown on the Accounts statement and in Payroll.
 *
 * The balance engine owns the opening Dr/Cr side and posted voucher attribution.
 * employees.current_balance is a write-side cache and can be stale (especially
 * when a historical opening was changed from Cr to Dr). Never use that cache
 * for balances, deposits, withdrawals or exports shown to users.
 *
 * Payroll is credit-positive (owed to employee), while the accounting engine
 * is debit-positive (employee advance). Convert the sign only once here.
 */
import { db } from "../../db";
import { toMoney } from "../../lib/money";
import { getPartyBalances } from "./balances/ledgerBalanceEngine";

export interface EmployeeLedgerAmounts {
  currentBalance: string;
  totalDeposits: string;
  totalWithdrawals: string;
}

export async function loadEmployeeLedgerAmounts(companyId: number): Promise<Map<number, EmployeeLedgerAmounts>> {
  const { parties } = await getPartyBalances(db, { companyId, kind: "employee" });
  return new Map(
    parties
      .filter((party): party is typeof party & { id: number } => party.id !== null)
      .map((party) => [
        party.id,
        {
          currentBalance: toMoney(party.closing).negated().toFixed(2),
          totalDeposits: toMoney(party.periodCredit).toFixed(2),
          totalWithdrawals: toMoney(party.periodDebit).toFixed(2),
        },
      ])
  );
}
