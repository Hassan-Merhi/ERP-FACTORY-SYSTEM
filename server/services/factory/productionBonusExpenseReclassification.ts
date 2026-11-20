/**
 * Company 12's nine manual Production Targets bonuses from October 31, 2026
 * were reclassified once, by an approved one-time correction that has been
 * applied and removed. Only the read-only boot inspection below remains.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { toMoney } from "../../lib/money";
import { runInCompanyPostingScope } from "../accounting/scheduledPostingScope";

type Row = Record<string, unknown>;
const rows = (r: unknown): Row[] => resultRows<Row>(r);
const NEW_CODE = "FACTORY_PRODUCTION_BONUS_EXPENSE";

/**
 * Read-only status check for the historical payouts after the one-time
 * reclassification has completed. Voucher edits after a payout can make a
 * payment claim stale; this is an accounting reconciliation task, NOT a reason
 * to re-run the old migration or prevent the entire ERP from starting.
 *
 * No vouchers, cash balances, accounts or payment claims are modified.
 */
export async function inspectHistoricalProductionBonusExpenseAccounts(): Promise<{
  inspected: number;
  discrepancies: Array<{
    paymentId: number;
    voucherId: number;
    claimedUsd: string;
    postedExpenseDebitUsd: string;
    postedCashCreditUsd: string;
    expenseAccountCode: string;
    lineCount: number;
    status: string;
  }>;
}> {
  const companyId = 12;
  return runInCompanyPostingScope(
    companyId,
    () =>
      db.transaction(async (tx) => {
        const result = rows(
          await tx.execute(sql`
      SELECT p.id AS "paymentId",
             p.payment_voucher_id AS "voucherId",
             p.amount_usd::text AS "claimedUsd",
             p.status,
             ea.code AS "expenseAccountCode",
             COUNT(ve.id)::int AS "lineCount",
             COALESCE(SUM(CASE WHEN ve.ledger_account_id = p.expense_ledger_account_id
               THEN ve.debit_amount ELSE 0 END), 0)::text AS "postedExpenseDebitUsd",
             COALESCE(SUM(CASE WHEN ve.ledger_account_id = p.cash_ledger_account_id
               THEN ve.credit_amount ELSE 0 END), 0)::text AS "postedCashCreditUsd",
             COALESCE(SUM(ve.debit_amount),0)::text AS "totalDebits",
             COALESCE(SUM(ve.credit_amount),0)::text AS "totalCredits",
             BOOL_AND(v.deleted_at IS NULL AND v.optional = false) AS "voucherLive"
      FROM factory_target_bonus_manual_payments p
      LEFT JOIN ledger_accounts ea
        ON ea.id = p.expense_ledger_account_id AND ea.company_id = p.company_id
      LEFT JOIN vouchers v
        ON v.id = p.payment_voucher_id AND v.company_id = p.company_id
      LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
      WHERE p.company_id = ${companyId} AND p.id BETWEEN 1 AND 9
      GROUP BY p.id, p.payment_voucher_id, p.amount_usd, p.status, ea.code
      ORDER BY p.id
    `)
        );
        const money = (value: unknown) => toMoney(value == null ? "0" : String(value));
        const discrepancies = result
          .filter((r) => {
            const claimed = money(r.claimedUsd);
            const debit = money(r.postedExpenseDebitUsd);
            const credit = money(r.postedCashCreditUsd);
            return (
              Number(r.lineCount) !== 2 ||
              String(r.status) !== "POSTED" ||
              String(r.expenseAccountCode) !== NEW_CODE ||
              r.voucherLive !== true ||
              !debit.eq(credit) ||
              !debit.eq(money(r.totalDebits)) ||
              !credit.eq(money(r.totalCredits)) ||
              !claimed.eq(debit)
            );
          })
          .map((r) => ({
            paymentId: Number(r.paymentId),
            voucherId: Number(r.voucherId),
            claimedUsd: money(r.claimedUsd).toFixed(2),
            postedExpenseDebitUsd: money(r.postedExpenseDebitUsd).toFixed(2),
            postedCashCreditUsd: money(r.postedCashCreditUsd).toFixed(2),
            expenseAccountCode: String(r.expenseAccountCode ?? ""),
            lineCount: Number(r.lineCount),
            status: String(r.status),
          }));
        return { inspected: result.length, discrepancies };
      }),
    "audit-historical-production-bonus-expense"
  );
}
