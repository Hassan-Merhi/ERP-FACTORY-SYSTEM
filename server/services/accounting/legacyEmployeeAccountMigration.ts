/**
 * Legacy EMP-<code> ledger accounts onto the employee (phase 19 A, G2).
 *
 * An EMP-<employee code> ledger account is the old way an employee's lines
 * were posted. The integrity diagnostic lists the ones still holding lines;
 * this moves their lines onto `employee_id` (ledger_account_id cleared) and
 * soft-deletes the emptied account. The routes in
 * routes/admin/userManagementRoutes.ts used to do this statement by statement
 * with no transaction or audit, looked the employee up by code across every
 * company, moved lines of closed periods and could stop halfway on the account
 * delete guard. Now, per account, in the caller's transaction:
 *   - the account (this company's, live, code EMP-) and its lines are locked;
 *   - the employee is the company's employee with that code;
 *   - refused when the account has an opening (the migration does not carry
 *     it; review it first), when any line's voucher is dated in a closed period
 *     by voucher date or COALESCE(effective_date, voucher_date), or when a line
 *     already names another party (it would then name two);
 *   - one audit row with every line before and after.
 * Moving a line from the EMP- account to the employee does not change
 * employees.current_balance: the balance posting already maps EMP- lines to
 * the employee by code.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { employees, ledgerAccounts, voucherEntries } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { companyClosedThrough, isDateInClosedPeriod } from "./scheduledPostingScope";

export type LegacyEmployeeAccountRefusalCode =
  | "ACCOUNT_NOT_FOUND"
  | "NOT_EMP_ACCOUNT"
  | "EMPLOYEE_NOT_FOUND"
  | "ACCOUNT_HAS_OPENING"
  | "PERIOD_CLOSED"
  | "LINE_HAS_OTHER_PARTY";

export class LegacyEmployeeAccountRefusal extends Error {
  constructor(
    readonly code: LegacyEmployeeAccountRefusalCode,
    message: string,
    readonly status: 400 | 404 | 409,
    readonly vouchers: string[] = []
  ) {
    super(message);
    this.name = "LegacyEmployeeAccountRefusal";
  }
}

export interface LegacyEmployeeAccountActor {
  userId: string | number;
  username: string;
}

export interface LegacyEmployeeAccountMigration {
  accountId: number;
  accountCode: string;
  employeeId: number | null;
  employeeCode: string;
  migratedEntries: number;
  accountDeleted: true;
}

interface LineRow extends Record<string, unknown> {
  id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_date: string;
  effective_date: string | null;
  debit_amount: string | null;
  credit_amount: string | null;
  employee_id: number | null;
  supplier_id: number | null;
  factory_supplier_id: number | null;
  customer_id: number | null;
  bank_account_id: number | null;
  fixed_asset_id: number | null;
}

/** Moves one EMP- account's lines onto the employee and retires the account, in `tx`. */
export async function migrateLegacyEmployeeAccountTx(
  tx: DatabaseOrTransaction,
  options: { companyId: number; accountId: number; actor: LegacyEmployeeAccountActor }
): Promise<LegacyEmployeeAccountMigration> {
  const { companyId, accountId, actor } = options;
  const [account] = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt))
    )
    .for("update");
  if (!account) throw new LegacyEmployeeAccountRefusal("ACCOUNT_NOT_FOUND", "Account not found", 404);
  if (!account.code || !account.code.startsWith("EMP-")) {
    throw new LegacyEmployeeAccountRefusal("NOT_EMP_ACCOUNT", "Not an EMP-* legacy account", 400);
  }
  const employeeCode = account.code.slice("EMP-".length);

  const lines = (
    await tx.execute(
      sql`SELECT ve.id, ve.voucher_id, v.voucher_number, v.voucher_date::text AS voucher_date,
                 v.effective_date::text AS effective_date, ve.debit_amount::text AS debit_amount,
                 ve.credit_amount::text AS credit_amount, ve.employee_id, ve.supplier_id, ve.factory_supplier_id,
                 ve.customer_id, ve.bank_account_id, ve.fixed_asset_id
            FROM voucher_entries ve
            JOIN vouchers v ON v.id = ve.voucher_id
           WHERE ve.ledger_account_id = ${accountId} AND v.company_id = ${companyId}
           ORDER BY ve.id
             FOR UPDATE OF ve`
    )
  ).rows as LineRow[];

  if (!toMoney(account.openingBalance).isZero()) {
    throw new LegacyEmployeeAccountRefusal(
      "ACCOUNT_HAS_OPENING",
      `Account ${account.code} has an opening balance, which this migration does not carry. Move it with a journal entry first.`,
      409
    );
  }

  const [employee] = lines.length
    ? await tx
        .select({ id: employees.id, code: employees.code })
        .from(employees)
        .where(and(eq(employees.companyId, companyId), eq(employees.code, employeeCode)))
        .limit(1)
    : [];
  if (lines.length && !employee) {
    throw new LegacyEmployeeAccountRefusal(
      "EMPLOYEE_NOT_FOUND",
      `Cannot migrate: no employee of this company has the code "${employeeCode}"`,
      400
    );
  }

  const employeeId = employee ? employee.id : null;

  const locked = await companyClosedThrough(companyId, tx);
  if (locked) {
    const closed = lines.filter(
      (line) =>
        isDateInClosedPeriod(locked, line.voucher_date) ||
        isDateInClosedPeriod(locked, line.effective_date ?? line.voucher_date)
    );
    if (closed.length) {
      throw new LegacyEmployeeAccountRefusal(
        "PERIOD_CLOSED",
        `Account ${account.code} has lines in a closed period (closed through ${locked}).`,
        409,
        [...new Set(closed.map((line) => line.voucher_number))]
      );
    }
  }

  const tagged = lines.filter(
    (line) =>
      (line.employee_id !== null && Number(line.employee_id) !== employeeId) ||
      line.supplier_id !== null ||
      line.factory_supplier_id !== null ||
      line.customer_id !== null ||
      line.bank_account_id !== null ||
      line.fixed_asset_id !== null
  );
  if (tagged.length) {
    throw new LegacyEmployeeAccountRefusal(
      "LINE_HAS_OTHER_PARTY",
      `Account ${account.code} has lines that already name another account or party.`,
      409,
      [...new Set(tagged.map((line) => line.voucher_number))]
    );
  }

  for (const line of lines) {
    await tx
      .update(voucherEntries)
      .set({ ledgerAccountId: null, employeeId })
      .where(and(eq(voucherEntries.id, line.id), eq(voucherEntries.ledgerAccountId, accountId)));
  }
  const deletedAt = new Date();
  await tx
    .update(ledgerAccounts)
    .set({ deletedAt, active: false })
    .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));

  await writeAuditEvent(
    {
      userId: actor.userId,
      username: actor.username,
      companyId,
      action: "migrate",
      tableName: "ledger_accounts",
      recordId: accountId,
      recordIdentifier: account.code,
      changes: {
        deletedAt: { old: null, new: deletedAt },
        active: { old: account.active, new: false },
        employee: { new: employee ? { id: employee.id, code: employee.code } : null },
        lines: {
          old: lines.map((line) => ({
            id: line.id,
            voucherId: line.voucher_id,
            voucherNumber: line.voucher_number,
            ledgerAccountId: accountId,
            employeeId: line.employee_id,
            debitAmount: line.debit_amount,
            creditAmount: line.credit_amount,
          })),
          new: lines.map((line) => ({
            id: line.id,
            voucherId: line.voucher_id,
            voucherNumber: line.voucher_number,
            ledgerAccountId: null,
            employeeId,
            debitAmount: line.debit_amount,
            creditAmount: line.credit_amount,
          })),
        },
      },
    },
    tx
  );

  return {
    accountId,
    accountCode: account.code,
    employeeId,
    employeeCode,
    migratedEntries: lines.length,
    accountDeleted: true,
  };
}
