/**
 * One-time, source-verified correction of the nine 2026-10-31 company-12
 * manual Production Targets payouts charged to Payroll Deposit Expense.
 * Original payment vouchers, worker claims and cash transactions are preserved.
 * Matching, idempotent Journal vouchers reclassify expense only.
 */
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { runInCompanyPostingScope } from "../accounting/scheduledPostingScope";
import { expenseAccountTx, type TargetBonusPaymentActor } from "./targetBonusPaymentService";

type Row = Record<string, unknown>;
const one = (r: unknown): Row | undefined => resultRows<Row>(r)[0];
const many = (r: unknown): Row[] => resultRows<Row>(r);
type BonusKind = "manual" | "daily" | "weekly";
const sourceId = (companyId: number, kind: BonusKind, id: number) =>
  `${companyId}:${kind}:${id}`;
const correctionType = "factory-production-bonus-expense-reclassification";

/**
 * Payment reversals retain their original expense account. If this source had
 * a reclassification, reverse that journal too in the SAME DB transaction.
 * Not needed for payments originally posted to Production Bonus Expense.
 */
export async function reverseProductionBonusExpenseReclassificationTx(
  tx: DbTransaction, companyId: number, kind: BonusKind, paymentId: number,
  amount: string, originalExpenseId: number, reversalDate: string,
  actor: TargetBonusPaymentActor,
): Promise<void> {
  const key = sourceId(companyId, kind, paymentId);
  const original = one(await tx.execute(sql`
    SELECT v.id, v.deleted_at AS "deletedAt"
    FROM accounting_posting_requests apr
    JOIN vouchers v ON v.id = apr.voucher_id AND v.company_id = apr.company_id
    WHERE apr.company_id = ${companyId}
      AND apr.source_type = ${correctionType}
      AND apr.source_id = ${key + ":expense"}
    LIMIT 1
  `));
  if (!original) return;
  if (original.deletedAt) throw new Error("Historical bonus expense correction was retired; reconcile before reversing");
  const productionBonusExpenseId = await expenseAccountTx(tx, companyId);
  const narration = `Reverse reclassification for ${kind} Production Bonus #${paymentId}`;
  const { replayed } = await postErpVoucherTx(tx, {
    companyId, voucherType: "Journal", voucherDate: reversalDate,
    sourceModule: "FACTORY", currency: "USD", description: narration,
    source: {type: correctionType, id: key, revision: "reversal"},
    actor: {userId: actor.userId, username: actor.username,
      reason: "Undo production bonus expense reclassification alongside bonus payment reversal"},
    lines: [
      {ledgerAccountId: originalExpenseId, debit: amount, narration},
      {ledgerAccountId: productionBonusExpenseId, credit: amount, narration},
    ],
  });
  if (replayed) throw new Error("Expense reclassification reversal already exists; reconcile payment state");
}

/**
 * Safety envelope approved for company 12 only. No mass ledger editing:
 * every original voucher is verified amount/lines/date/company before posting.
 * A source replay creates no second journal. Closed periods remain protected.
 */
export async function reclassifyApprovedManualProductionBonuses20261031(): Promise<{
  inspected: number; posted: number; alreadyPosted: number; totalUsd: string;
}> {
  const companyId = 12;
  const expectedAmounts = ["27.00","25.00","25.00","25.00","25.00","25.00","25.00","25.00","27.00"] as const;
  return runInCompanyPostingScope(companyId, () => db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const payments = many(await tx.execute(sql`
      SELECT p.id, p.status, p.amount_usd::text AS amount,
        p.payment_date::text AS "paymentDate",
        p.cash_ledger_account_id AS "cashId",
        p.expense_ledger_account_id AS "expenseId",
        p.payment_voucher_id AS "voucherId",
        ea.code AS "expenseCode", v.voucher_type AS "voucherType",
        v.voucher_date::text AS "voucherDate", v.currency,
        v.deleted_at AS "deletedAt"
      FROM factory_target_bonus_manual_payments p
      JOIN ledger_accounts ea ON ea.id = p.expense_ledger_account_id AND ea.company_id=p.company_id
      JOIN vouchers v ON v.id=p.payment_voucher_id AND v.company_id=p.company_id
      WHERE p.company_id=${companyId} AND p.id BETWEEN 1 AND 9
      ORDER BY p.id FOR UPDATE OF p
    `));
    if (payments.length !== expectedAmounts.length)
      throw new Error("PRODUCTION_BONUS_RECLASS_UNEXPECTED_PAYMENT_COUNT");
    for (let i=0; i<payments.length; i++) {
      const p = payments[i];
      if (Number(p.id)!==i+1 || String(p.amount)!==expectedAmounts[i] ||
          p.status!=="POSTED" || p.paymentDate!=="2026-10-31" ||
          p.voucherDate!=="2026-10-31" || p.currency!=="USD" ||
          p.voucherType!=="Payment" || p.deletedAt ||
          p.expenseCode!=="PAYROLL_DEPOSIT_EXPENSE" ||
          Number(p.voucherId)!==16893+i || Number(p.expenseId)!==819)
        throw new Error(`PRODUCTION_BONUS_RECLASS_SOURCE_MISMATCH_${i+1}`);
      const lines = many(await tx.execute(sql`
        SELECT ledger_account_id AS "accountId",
          COALESCE(debit_amount,0)::text AS debit, COALESCE(credit_amount,0)::text AS credit
        FROM voucher_entries WHERE voucher_id=${Number(p.voucherId)}
      `));
      if (lines.length!==2 ||
          !lines.some(l=>Number(l.accountId)===Number(p.expenseId) &&
            Number(l.debit)===Number(p.amount) && Number(l.credit)===0) ||
          !lines.some(l=>Number(l.accountId)===Number(p.cashId) &&
            Number(l.credit)===Number(p.amount) && Number(l.debit)===0))
        throw new Error(`PRODUCTION_BONUS_RECLASS_LINES_MISMATCH_${i+1}`);
    }
    const targetId = await expenseAccountTx(tx, companyId);
    const originalId = 819;
    let posted=0, alreadyPosted=0;
    for (const p of payments) {
      const paymentId=Number(p.id);
      const narration=`Reclassify historical manual Production Bonus #${paymentId} (original voucher #${p.voucherId})`;
      const {replayed}=await postErpVoucherTx(tx,{
        companyId, voucherType:"Journal", voucherDate:"2026-10-31",
        currency:"USD",sourceModule:"FACTORY",description:narration,
        source:{type:correctionType,id:sourceId(companyId,"manual",paymentId),revision:"expense"},
        actor:{userId:"system:production-bonus-expense-reclass",username:"system",
          reason:"Owner-approved correction: Payroll Deposit Expense to Production Bonus Expense"},
        lines:[
          {ledgerAccountId:targetId,debit:String(p.amount),narration},
          {ledgerAccountId:originalId,credit:String(p.amount),narration},
        ],
      });
      if(replayed)alreadyPosted++;else posted++;
    }
    return {inspected:payments.length,posted,alreadyPosted,totalUsd:"229.00"};
  }),"approved-production-bonus-expense-reclassification");
}
