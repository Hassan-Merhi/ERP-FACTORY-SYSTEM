// Extracted from ./targetBonusPaymentService.ts
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { db } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { writeDaybookEntry } from "./factoryDaybookWriter";
import { logAudit } from "../../routes/helpers/auditHelpers";
import { exactBonusCents, isRealBonusDate, TargetBonusPaymentPolicyError } from "./targetBonusPaymentPolicy";

export type TargetBonusPaymentActor = {
  userId: string;
  username: string;
};

type Row = Record<string, unknown>;

export function first(result: unknown): Row | undefined {
  return resultRows<Row>(result)[0];
}

export function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function conflict(message: string): never {
  throw new HttpError(409, message);
}

export function policyToHttp(error: unknown): never {
  if (error instanceof TargetBonusPaymentPolicyError) throw new HttpError(error.status, error.message);
  throw error;
}

export async function getReviewTx(tx: DbTransaction, companyId: number, date: string, workerId: number) {
  const review = first(
    await tx.execute(sql`
    SELECT rv.id, rv.company_id AS "companyId",
           rv.worker_id AS "workerId", rv.production_date::text AS date,
           rv.status, rv.bonus_amount::text AS amount,
           rv.extra_bales::text AS "extraBales"
    FROM factory_target_bonus_reviews rv
    WHERE rv.company_id = ${companyId}
      AND rv.production_date = ${date}::date
      AND rv.worker_id = ${workerId}
    FOR UPDATE OF rv
  `)
  );
  if (!review) throw new HttpError(404, "Reviewed worker/day not found");
  const worker = first(
    await tx.execute(sql`
    SELECT id, full_name AS "fullName"
    FROM factory_workers WHERE id = ${workerId} AND company_id = ${companyId}
  `)
  );
  if (!worker) conflict("Worker no longer belongs to this factory");
  // Approved reviews are immutable snapshots of saved targets and live stock
  // evidence. Production closure is not a prerequisite for those snapshots.
  return {
    id: Number(review.id),
    workerId,
    workerName: String(worker.fullName || "Worker #" + workerId),
    date,
    status: String(review.status),
    amount: exactBonusCents(String(review.amount)),
    extraBales: Number(review.extraBales),
  };
}

export async function findPaymentTx(tx: DbTransaction, companyId: number, reviewId: number) {
  return first(
    await tx.execute(sql`
    SELECT id, status, bonus_amount::text AS amount, payment_date::text AS "paymentDate",
      cash_ledger_account_id AS "cashAccountId", payment_voucher_id AS "voucherId",
      currency_code AS currency
    FROM factory_target_bonus_payments
    WHERE company_id = ${companyId} AND review_id = ${reviewId}
    FOR UPDATE
  `)
  );
}

export async function hasLegacyPayrollCollisionTx(
  tx: DbTransaction,
  companyId: number,
  date: string,
  workerId: number
) {
  const blocked = first(
    await tx.execute(sql`
    SELECT 1 AS blocked
    FROM factory_production_bonus_allocations a
    JOIN factory_production_bonus_runs run ON run.id = a.run_id
    WHERE a.company_id = ${companyId} AND run.company_id = ${companyId}
      AND a.worker_id = ${workerId} AND run.production_date = ${date}::date
      AND (a.decision_status = 'APPROVED' OR a.payroll_id IS NOT NULL) AND a.amount > 0
    LIMIT 1
  `)
  );
  // A paid/approved salary payroll might already carry the same bonus in
  // its stored bonuses/net salary even if its legacy allocation has changed.
  // Fail closed: require reconciliation before a second independent payout.
  const finalizedPayroll = first(
    await tx.execute(sql`
    SELECT 1 AS blocked
    FROM factory_payrolls fp
    WHERE fp.company_id = ${companyId} AND fp.worker_id = ${workerId}
      AND ${date}::date BETWEEN fp.period_start AND fp.period_end
      AND fp.status IN ('APPROVED', 'PAID')
    LIMIT 1
  `)
  );
  return Boolean(blocked || finalizedPayroll);
}

export async function reverseTargetBonusPayment(
  companyId: number,
  paymentId: number,
  reversalDate: string,
  reason: string,
  actor: TargetBonusPaymentActor
) {
  if (!positiveId(companyId) || !positiveId(paymentId)) throw new HttpError(400, "Invalid payment reference");
  if (!isRealBonusDate(reversalDate)) throw new HttpError(400, "Choose a valid reversal date");
  if (typeof reason !== "string" || !reason.trim()) throw new HttpError(400, "A reversal explanation is required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const row = first(
      await tx.execute(sql`
      SELECT id, review_id AS "reviewId", bonus_amount::text AS amount, worker_id AS "workerId",
        production_date::text AS "productionDate", payment_date::text AS "paymentDate",
        cash_ledger_account_id AS "cashAccountId", expense_ledger_account_id AS "expenseAccountId",
        status, reversal_voucher_id AS "reversalVoucherId"
      FROM factory_target_bonus_payments
      WHERE company_id = ${companyId} AND id = ${paymentId}
      FOR UPDATE
    `)
    );
    if (!row) throw new HttpError(404, "Payment not found for this factory");
    if (row.status === "REVERSED")
      return { paymentId, reversed: true, replayed: true, voucherId: Number(row.reversalVoucherId) };
    if (row.status !== "POSTED") conflict("Payment is not reversible in its current state");
    if (reversalDate < String(row.paymentDate)) conflict("Reversal date cannot precede payment date");
    const narration = `Reversal of Production Targets bonus payment #${paymentId}: ${reason.trim().slice(0, 400)}`;
    const amount = String(row.amount);
    const { voucher, replayed } = await postErpVoucherTx(tx, {
      companyId,
      voucherType: "Receipt",
      voucherDate: reversalDate,
      sourceModule: "FACTORY",
      description: narration,
      currency: "USD",
      source: { type: "factory-target-bonus-review", id: `${companyId}:${row.reviewId}`, revision: "reversed" },
      actor: { userId: actor.userId, username: actor.username, reason: "Bonus payout reversal" },
      lines: [
        { ledgerAccountId: Number(row.cashAccountId), debit: amount, narration },
        { ledgerAccountId: Number(row.expenseAccountId), credit: amount, narration },
      ],
    });
    if (replayed) conflict("Reversal voucher is already posted; reconcile payment state");
    await tx.execute(sql`
      UPDATE factory_target_bonus_payments
      SET status='REVERSED', reversal_voucher_id=${voucher.id},
        reversed_at=now(), reversed_by=${actor.userId}, reversal_reason=${reason.trim().slice(0, 400)}
      WHERE company_id=${companyId} AND id=${paymentId} AND status='POSTED'
    `);
    await writeDaybookEntry(tx, {
      companyId,
      txDate: reversalDate,
      txType: "PRODUCTION_TARGET_BONUS_REVERSAL",
      referenceTable: "factory_target_bonus_payments",
      referenceId: paymentId,
      description: narration,
      currencyCode: "USD",
      amountCurrency: -Number(amount),
      amountUsd: -Number(amount),
      createdBy: actor.userId,
      metaJson: JSON.stringify({ reviewId: row.reviewId, voucherId: voucher.id }),
    });
    await logAudit(
      {
        userId: actor.userId,
        username: actor.username,
        companyId,
        action: "update",
        tableName: "factory_target_bonus_payments",
        recordId: paymentId,
        recordIdentifier: `Production bonus payment #${paymentId} reversed`,
        changes: { status: { old: "POSTED", new: "REVERSED" }, reversalVoucherId: { old: null, new: voucher.id } },
      },
      tx
    );
    return { paymentId, reversed: true, replayed: false, voucherId: voucher.id };
  });
}
