import { storage } from "../../storage";
import { db } from "../../db";
import { employees } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../lib/money";

type EmployeeBalanceChanges = { balanceChange: Decimal; deposits: Decimal; withdrawals: Decimal };

function emptyChanges(): EmployeeBalanceChanges {
  return { balanceChange: new MoneyDecimal(0), deposits: new MoneyDecimal(0), withdrawals: new MoneyDecimal(0) };
}

async function applyEmployeeBalanceChanges(
  employee: {
    id: number;
    currentBalance: string | null;
    totalDeposits: string | null;
    totalWithdrawals: string | null;
  },
  changes: EmployeeBalanceChanges
): Promise<void> {
  // Changes are taken at cents (half away from zero) before they are applied,
  // so reversing a voucher removes exactly what posting it added.
  const cents = (value: Decimal) => value.toDecimalPlaces(2);
  const newBalance = toMoney(employee.currentBalance).plus(cents(changes.balanceChange));
  const newDeposits = MoneyDecimal.max(0, toMoney(employee.totalDeposits).plus(cents(changes.deposits)));
  const newWithdrawals = MoneyDecimal.max(0, toMoney(employee.totalWithdrawals).plus(cents(changes.withdrawals)));
  await db
    .update(employees)
    .set({
      currentBalance: newBalance.toFixed(2),
      totalDeposits: newDeposits.toFixed(2),
      totalWithdrawals: newWithdrawals.toFixed(2),
    })
    .where(eq(employees.id, employee.id));
}

function hasChanges(changes: EmployeeBalanceChanges): boolean {
  return !changes.balanceChange.isZero() || !changes.deposits.isZero() || !changes.withdrawals.isZero();
}

// ─── Employee balance sync ────────────────────────────────────────────────────
export async function syncEmployeeBalancesFromEntries(
  entries: Array<{
    ledgerAccountId: number | null;
    employeeId?: number | null;
    debitAmount: string | null;
    creditAmount: string | null;
  }>,
  companyId: number,
  reverse: boolean = false
): Promise<void> {
  const allAccounts = await storage.getAllLedgerAccounts(companyId);

  const employeeAccountMap = new Map<number, { code: string; employeeCode: string }>();
  for (const account of allAccounts) {
    if (account.code && account.code.startsWith("EMP-")) {
      const employeeCode = account.code.replace("EMP-", "");
      employeeAccountMap.set(account.id, { code: account.code, employeeCode });
    }
  }

  const employeeChangesById = new Map<number, EmployeeBalanceChanges>();
  const employeeChangesByCode = new Map<string, EmployeeBalanceChanges>();

  const accumulate = <K>(map: Map<K, EmployeeBalanceChanges>, key: K, debit: Decimal, credit: Decimal) => {
    const current = map.get(key) ?? emptyChanges();
    const balanceChange = reverse ? debit.minus(credit) : credit.minus(debit);
    map.set(key, {
      balanceChange: current.balanceChange.plus(balanceChange),
      deposits: current.deposits.plus(reverse ? credit.negated() : credit),
      withdrawals: current.withdrawals.plus(reverse ? debit.negated() : debit),
    });
  };

  for (const entry of entries) {
    const debit = toMoney(entry.debitAmount);
    const credit = toMoney(entry.creditAmount);

    if (entry.employeeId) {
      accumulate(employeeChangesById, entry.employeeId, debit, credit);
      continue;
    }

    if (entry.ledgerAccountId) {
      const employeeAccount = employeeAccountMap.get(entry.ledgerAccountId);
      if (employeeAccount) {
        accumulate(employeeChangesByCode, employeeAccount.employeeCode, debit, credit);
      }
    }
  }

  // Lookups are scoped to the voucher's company so an entry can never move
  // another tenant's employee balance (employee codes are only unique per company).
  for (const [employeeId, changes] of Array.from(employeeChangesById.entries())) {
    if (!hasChanges(changes)) continue;
    const [employee] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, employeeId), eq(employees.companyId, companyId)));
    if (!employee) continue;
    await applyEmployeeBalanceChanges(employee, changes);
  }

  for (const [employeeCode, changes] of Array.from(employeeChangesByCode.entries())) {
    if (!hasChanges(changes)) continue;
    const [employee] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.code, employeeCode), eq(employees.companyId, companyId)));
    if (!employee) continue;
    await applyEmployeeBalanceChanges(employee, changes);
  }
}
