/**
 * Phase 15: one balanced USD payment voucher per immutable approved worker/week.
 * The worker/week payment claim remains after reversal; a second payment is forbidden.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { db } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { writeDaybookEntry } from "./factoryDaybookWriter";
import { logAudit } from "../../routes/helpers/auditHelpers";
import { payingAccountTx, expenseAccountTx, type TargetBonusPaymentActor } from "./targetBonusPaymentService";
import { isRealBonusDate, exactBonusCents } from "./targetBonusPaymentPolicy";
import type { WeeklyBonusPaymentCommand } from "./weeklyBonusPaymentPolicy";
import { weeklyBonusReviewToken } from "./weeklyBonusReviewSnapshot";

type Row = Record<string, unknown>;
const first = (result: unknown): Row | undefined => resultRows<Row>(result)[0];
function conflict(message: string): never { throw new HttpError(409, message); }
function validId(n: number): boolean { return Number.isSafeInteger(n) && n > 0; }
async function reviewedWeekTx(tx: DbTransaction, companyId: number, weekStart: string, workerId: number) {
  const row = first(await tx.execute(sql`
    SELECT rv.id, rv.status, rv.bonus_amount::text AS amount,
      rv.week_start::text AS "weekStart", rv.week_end::text AS "weekEnd",
      rv.extra_bales::text AS "extraBales",
      rv.credited_bales AS "creditedBales", rv.target_bales::text AS "targetBales",
      rv.method_version_id AS "methodVersionId",
      rv.snapshot_json AS snapshot, rv.snapshot_hash AS "snapshotHash",
      rv.worker_name_snapshot AS "workerName"
    FROM factory_target_bonus_weekly_reviews rv
    WHERE rv.company_id = ${companyId} AND rv.worker_id = ${workerId}
      AND rv.week_start = ${weekStart}::date
    FOR UPDATE OF rv
  `));
  if (!row) throw new HttpError(404, "Reviewed weekly bonus not found");
  const approvedAmount = exactBonusCents(row.amount);
  if (!approvedAmount || Number(row.extraBales) <= 0)
    conflict("Reviewed weekly bonus has no positive entitlement");
  // The review is immutable. Verify its signed frozen snapshot has not drifted,
  // and the selected fee version still exists for this company.
  const snapshot = row.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    conflict("Weekly review source snapshot is missing");
  const saved = snapshot as Record<string, unknown>;
  if (saved.companyId !== companyId || saved.workerId !== workerId ||
      saved.weekStart !== weekStart || saved.weekEnd !== row.weekEnd ||
      saved.method !== "weekly_flat" || Number(saved.methodVersionId) !== Number(row.methodVersionId) ||
      saved.amount !== approvedAmount || saved.targetBales !== row.targetBales ||
      saved.creditedBales !== Number(row.creditedBales) ||
      saved.extraBales !== row.extraBales ||
      weeklyBonusReviewToken(saved) !== row.snapshotHash)
    conflict("Weekly review snapshot integrity check failed");
  const method = first(await tx.execute(sql`
    SELECT id, method FROM factory_production_target_bonus_weekly_methods
    WHERE company_id = ${companyId} AND id = ${Number(row.methodVersionId)}
      AND effective_week <= ${weekStart}::date
  `));
  if (!method || method.method !== "weekly_flat")
    conflict("Saved weekly flat method does not belong to this factory");
  const worker = first(await tx.execute(sql`
    SELECT id FROM factory_workers WHERE company_id = ${companyId} AND id = ${workerId}
  `));
  if (!worker) conflict("Worker no longer belongs to the factory");
  return {
    reviewId: Number(row.id), workerId, weekStart, weekEnd: String(row.weekEnd),
    amount: approvedAmount, status: String(row.status), workerName: String(row.workerName),
  };
}
async function currentWeeklyClaimTx(tx: DbTransaction, companyId: number, reviewId: number) {
  return first(await tx.execute(sql`
    SELECT id, status, bonus_amount::text AS amount, payment_date::text AS "paymentDate",
      cash_ledger_account_id AS "cashAccountId",
      payment_voucher_id AS "voucherId", currency_code AS currency
    FROM factory_target_bonus_weekly_payments
    WHERE company_id = ${companyId} AND review_id = ${reviewId}
    FOR UPDATE
  `));
}
async function conflictingOldBonusTx(
  tx: DbTransaction, companyId: number, workerId: number, start: string, end: string,
) {
  const reviewed = first(await tx.execute(sql`
    SELECT 1 FROM factory_target_bonus_reviews
    WHERE company_id = ${companyId} AND worker_id = ${workerId}
      AND production_date BETWEEN ${start}::date AND ${end}::date LIMIT 1
  `));
  const category = first(await tx.execute(sql`
    SELECT 1 FROM factory_target_bonus_category_reviews
    WHERE company_id = ${companyId} AND worker_id = ${workerId}
      AND production_date BETWEEN ${start}::date AND ${end}::date LIMIT 1
  `));
  const productionPayroll = first(await tx.execute(sql`
    SELECT 1 FROM factory_production_bonus_allocations a
    JOIN factory_production_bonus_runs run ON run.id = a.run_id
      AND run.company_id = a.company_id
    WHERE a.company_id = ${companyId} AND a.worker_id = ${workerId}
      AND run.production_date BETWEEN ${start}::date AND ${end}::date
      AND a.amount > 0 AND (a.decision_status = 'APPROVED' OR a.payroll_id IS NOT NULL)
    LIMIT 1
  `));
  const salary = first(await tx.execute(sql`
    SELECT 1 FROM factory_payrolls p
    WHERE p.company_id = ${companyId} AND p.worker_id = ${workerId}
      AND p.period_start <= ${end}::date AND p.period_end >= ${start}::date
      AND p.status IN ('APPROVED','PAID') LIMIT 1
  `));
  const dailyPayment = first(await tx.execute(sql`
    SELECT 1 FROM factory_target_bonus_payments p
    WHERE p.company_id = ${companyId} AND p.worker_id = ${workerId}
      AND p.production_date BETWEEN ${start}::date AND ${end}::date
    LIMIT 1
  `));
  return Boolean(reviewed || category || productionPayroll || salary || dailyPayment);
}

export async function postWeeklyBonusPayments(
  companyId: number, command: WeeklyBonusPaymentCommand, actor: TargetBonusPaymentActor,
) {
  if (!validId(companyId)) throw new HttpError(400, "Factory company required");
  if (!actor.userId) throw new HttpError(401, "Signed-in approver required");
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const cashId = await payingAccountTx(tx, companyId, command.cashAccountId);
    const results: Array<{paymentId: number; reviewId: number; workerId: number;
      weekStart: string; amount: string; voucherId: number; replayed: boolean}> = [];
    let expenseId: number | null = null;
    for (const choice of command.selections) {
      const review = await reviewedWeekTx(tx, companyId, choice.weekStart, choice.workerId);
      if (review.amount !== choice.expectedAmount)
        conflict("Approved weekly amount changed; refresh before posting");
      const prior = await currentWeeklyClaimTx(tx, companyId, review.reviewId);
      if (prior) {
        if (prior.status !== "POSTED" || String(prior.currency) !== "USD" ||
            String(prior.amount) !== review.amount ||
            Number(prior.cashAccountId) !== cashId ||
            String(prior.paymentDate) !== command.paymentDate)
          conflict("Weekly bonus was already posted or reversed with different details");
        results.push({ paymentId: Number(prior.id), reviewId: review.reviewId,
          workerId: review.workerId, weekStart: review.weekStart, amount: review.amount,
          voucherId: Number(prior.voucherId), replayed: true });
        continue;
      }
      const manualBonus = first(await tx.execute(sql`
        SELECT 1 FROM factory_target_bonus_manual_payments
        WHERE company_id=${companyId} AND worker_id=${review.workerId}
          AND week_start=${review.weekStart}::date AND status='POSTED' LIMIT 1
      `));
      if (manualBonus) conflict("A manual bonus was already paid for this worker/week; reconcile before paying the calculated weekly bonus");
      if (review.status !== "approved") conflict("Only approved weekly bonuses can be paid");
      if (command.paymentDate < review.weekEnd)
        conflict("Weekly bonus payment cannot predate the end of production week");
      if (await conflictingOldBonusTx(tx, companyId, review.workerId, review.weekStart, review.weekEnd))
        conflict("Another reviewed or paid bonus/payroll overlaps this worker/week; reconcile first");
      if (expenseId == null) expenseId = await expenseAccountTx(tx, companyId);
      const narration = `Production Targets weekly flat bonus: ${review.workerName} (${review.weekStart}–${review.weekEnd})`;
      const {voucher,replayed} = await postErpVoucherTx(tx, {
        companyId, voucherType: "Payment", voucherDate: command.paymentDate,
        sourceModule: "FACTORY", description: narration, currency: "USD",
        source: {type: "factory-target-weekly-bonus-review",
          id: `${companyId}:${review.reviewId}`, revision: "paid"},
        actor: {userId: actor.userId, username: actor.username,
          reason: "Approved Production Targets weekly flat bonus"},
        lines: [
          {ledgerAccountId: expenseId, debit: review.amount, narration},
          {ledgerAccountId: cashId, credit: review.amount, narration},
        ],
      });
      if (replayed) conflict("Weekly payment voucher exists without its claim; reconcile manually");
      const inserted = first(await tx.execute(sql`
        INSERT INTO factory_target_bonus_weekly_payments (
          company_id, review_id, worker_id, week_start, week_end, bonus_amount, currency_code,
          payment_date, cash_ledger_account_id, expense_ledger_account_id, payment_voucher_id, posted_by
        ) VALUES (
          ${companyId}, ${review.reviewId}, ${review.workerId},
          ${review.weekStart}::date, ${review.weekEnd}::date, ${review.amount}, 'USD',
          ${command.paymentDate}::date, ${cashId}, ${expenseId}, ${voucher.id}, ${actor.userId}
        ) RETURNING id
      `));
      if (!inserted) throw new HttpError(500, "Weekly payment claim was not recorded");
      const paymentId = Number(inserted.id);
      await writeDaybookEntry(tx, {
        companyId, txDate: command.paymentDate, txType: "PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT",
        referenceTable: "factory_target_bonus_weekly_payments", referenceId: paymentId,
        description: narration, currencyCode: "USD", amountCurrency: Number(review.amount),
        amountUsd: Number(review.amount), createdBy: actor.userId,
        metaJson: JSON.stringify({reviewId: review.reviewId, voucherId: voucher.id,
          workerId: review.workerId, weekStart: review.weekStart}),
      });
      await logAudit({
        userId: actor.userId, username: actor.username, companyId, action: "create",
        tableName: "factory_target_bonus_weekly_payments", recordId: paymentId,
        recordIdentifier: `Weekly bonus review #${review.reviewId} payment #${paymentId}`,
        changes: {
          amount: {old: null, new: review.amount},
          cashAccountId: {old: null, new: cashId},
          voucherId: {old: null, new: voucher.id},
        },
      }, tx);
      results.push({paymentId, reviewId: review.reviewId, workerId: review.workerId,
        weekStart: review.weekStart, amount: review.amount, voucherId: voucher.id, replayed: false});
    }
    return {
      success: true, currency: "USD", paymentDate: command.paymentDate, cashAccountId: cashId,
      results, posted: results.filter(r=>!r.replayed).length,
      replayed: results.filter(r=>r.replayed).length,
    };
  });
}

export async function reverseWeeklyBonusPayment(
  companyId: number, paymentId: number, reversalDate: string, reason: string,
  actor: TargetBonusPaymentActor,
) {
  if (!validId(companyId) || !validId(paymentId)) throw new HttpError(400, "Invalid payment");
  if (!isRealBonusDate(reversalDate)) throw new HttpError(400, "Choose a valid reversal date");
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 400)
    throw new HttpError(400, "Reversal reason is required (up to 400 characters)");
  if (!actor.userId) throw new HttpError(401, "Signed-in approver required");
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const row = first(await tx.execute(sql`
      SELECT id, review_id AS "reviewId", bonus_amount::text AS amount,
        payment_date::text AS "paymentDate", week_start::text AS "weekStart",
        cash_ledger_account_id AS "cashAccountId",
        expense_ledger_account_id AS "expenseAccountId",
        status, reversal_voucher_id AS "reversalVoucherId"
      FROM factory_target_bonus_weekly_payments
      WHERE company_id = ${companyId} AND id = ${paymentId} FOR UPDATE
    `));
    if (!row) throw new HttpError(404, "Weekly payment not found for this company");
    if (row.status === "REVERSED")
      return {paymentId, reversed: true, replayed: true, voucherId: Number(row.reversalVoucherId)};
    if (row.status !== "POSTED") conflict("Weekly payment is not reversible in current state");
    if (reversalDate < String(row.paymentDate))
      conflict("Reversal date cannot precede original payment");
    const narration = `Reversal of Production Targets weekly bonus #${paymentId}: ${reason.trim()}`;
    const amount = String(row.amount);
    const {voucher,replayed} = await postErpVoucherTx(tx, {
      companyId, voucherType: "Receipt", voucherDate: reversalDate,
      sourceModule: "FACTORY", description: narration, currency: "USD",
      source: {type: "factory-target-weekly-bonus-review",
        id: `${companyId}:${row.reviewId}`, revision: "reversed"},
      actor: {userId: actor.userId, username: actor.username,
        reason: "Weekly bonus payout reversal"},
      lines: [
        {ledgerAccountId: Number(row.cashAccountId), debit: amount, narration},
        {ledgerAccountId: Number(row.expenseAccountId), credit: amount, narration},
      ],
    });
    if (replayed) conflict("Reversal voucher exists without reversed claim; reconcile");
    await tx.execute(sql`
      UPDATE factory_target_bonus_weekly_payments
      SET status='REVERSED', reversal_voucher_id=${voucher.id},
        reversed_at=now(), reversed_by=${actor.userId}, reversal_reason=${reason.trim()}
      WHERE company_id=${companyId} AND id=${paymentId} AND status='POSTED'
    `);
    await writeDaybookEntry(tx, {
      companyId, txDate: reversalDate, txType: "PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL",
      referenceTable: "factory_target_bonus_weekly_payments", referenceId: paymentId,
      description: narration, currencyCode: "USD", amountCurrency: -Number(amount),
      amountUsd: -Number(amount), createdBy: actor.userId,
      metaJson: JSON.stringify({reviewId: row.reviewId, voucherId: voucher.id,
        weekStart: row.weekStart}),
    });
    await logAudit({
      userId: actor.userId, username: actor.username, companyId, action: "update",
      tableName: "factory_target_bonus_weekly_payments", recordId: paymentId,
      recordIdentifier: `Production weekly bonus payment #${paymentId} reversed`,
      changes: {status: {old: "POSTED", new: "REVERSED"},
        reversalVoucherId: {old: null, new: voucher.id}},
    }, tx);
    return {paymentId, reversed: true, replayed: false, voucherId: voucher.id};
  });
}
