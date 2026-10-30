/**
 * Phase 5+6: money movement only from immutable Production Targets reviews.
 * Not the separate Production Planner/position payroll allocation table.
 *
 * In a single transaction: company-wide lock, approved snapshot checks, legacy
 * payroll collision guard, account validation, balanced voucher, unique payout
 * claim, factory daybook and audit. All retries are exact or rejected.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { db } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { writeDaybookEntry } from "./factoryDaybookWriter";
import { logAudit } from "../../routes/helpers/auditHelpers";
import {
  exactBonusCents,
  isRealBonusDate,
  decideTargetBonusPaymentState,
  TargetBonusPaymentPolicyError,
  type TargetBonusPaymentCommand,
} from "./targetBonusPaymentPolicy";

export type TargetBonusPaymentActor = {
  userId: string;
  username: string;
};
type Row = Record<string, unknown>;
function first(result: unknown): Row | undefined {
  return resultRows<Row>(result)[0];
}
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function conflict(message: string): never {
  throw new HttpError(409, message);
}
function policyToHttp(error: unknown): never {
  if (error instanceof TargetBonusPaymentPolicyError) throw new HttpError(error.status, error.message);
  throw error;
}

export async function payingAccountTx(tx: DbTransaction, companyId: number, accountId: number): Promise<number> {
  const account = first(await tx.execute(sql`
    SELECT id, account_type AS "accountType", active, opening_balance_currency AS "openingCurrency"
    FROM ledger_accounts
    WHERE id = ${accountId} AND company_id = ${companyId} AND deleted_at IS NULL
    FOR UPDATE
  `));
  if (!account || account.active !== true || !["Cash", "Bank"].includes(String(account.accountType)))
    throw new HttpError(400, "Choose an active Cash or Bank account belonging to this factory");
  if (account.openingCurrency && String(account.openingCurrency).toUpperCase() !== "USD")
    conflict("The selected account has a non-USD opening currency; verified FX is required");
  return Number(account.id);
}
export async function expenseAccountTx(tx: DbTransaction, companyId: number): Promise<number> {
  // This is the user's existing Factory Deposit Expense classification.
  await tx.execute(sql`
    INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
    VALUES (${companyId}, 'PAYROLL_DEPOSIT_EXPENSE', 'Payroll Deposit Expense', 'Indirect Expense', '0', TRUE)
    ON CONFLICT (company_id, code) DO NOTHING
  `);
  const account = first(await tx.execute(sql`
    SELECT id, active, sub_type AS "subType" FROM ledger_accounts
    WHERE company_id = ${companyId} AND code = 'PAYROLL_DEPOSIT_EXPENSE'
      AND deleted_at IS NULL
    FOR UPDATE
  `));
  if (!account || account.active !== true || account.subType === "Group")
    conflict("Payroll Deposit Expense is unavailable in this company");
  return Number(account.id);
}

async function getReviewTx(tx: DbTransaction, companyId: number, date: string, workerId: number) {
  const review = first(await tx.execute(sql`
    SELECT rv.id, rv.company_id AS "companyId",
           rv.worker_id AS "workerId", rv.production_date::text AS date,
           rv.status, rv.bonus_amount::text AS amount,
           rv.extra_bales::text AS "extraBales"
    FROM factory_target_bonus_reviews rv
    WHERE rv.company_id = ${companyId}
      AND rv.production_date = ${date}::date
      AND rv.worker_id = ${workerId}
    FOR UPDATE OF rv
  `));
  if (!review) throw new HttpError(404, "Reviewed worker/day not found");
  const worker = first(await tx.execute(sql`
    SELECT id, full_name AS "fullName"
    FROM factory_workers WHERE id = ${workerId} AND company_id = ${companyId}
  `));
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

async function findPaymentTx(tx: DbTransaction, companyId: number, reviewId: number) {
  return first(await tx.execute(sql`
    SELECT id, status, bonus_amount::text AS amount, payment_date::text AS "paymentDate",
      cash_ledger_account_id AS "cashAccountId", payment_voucher_id AS "voucherId",
      currency_code AS currency
    FROM factory_target_bonus_payments
    WHERE company_id = ${companyId} AND review_id = ${reviewId}
    FOR UPDATE
  `));
}

async function hasLegacyPayrollCollisionTx(tx: DbTransaction, companyId: number, date: string, workerId: number) {
  const blocked = first(await tx.execute(sql`
    SELECT 1 AS blocked
    FROM factory_production_bonus_allocations a
    JOIN factory_production_bonus_runs run ON run.id = a.run_id
    WHERE a.company_id = ${companyId} AND run.company_id = ${companyId}
      AND a.worker_id = ${workerId} AND run.production_date = ${date}::date
      AND (a.decision_status = 'APPROVED' OR a.payroll_id IS NOT NULL) AND a.amount > 0
    LIMIT 1
  `));
  // A paid/approved salary payroll might already carry the same bonus in
  // its stored bonuses/net salary even if its legacy allocation has changed.
  // Fail closed: require reconciliation before a second independent payout.
  const finalizedPayroll = first(await tx.execute(sql`
    SELECT 1 AS blocked
    FROM factory_payrolls fp
    WHERE fp.company_id = ${companyId} AND fp.worker_id = ${workerId}
      AND ${date}::date BETWEEN fp.period_start AND fp.period_end
      AND fp.status IN ('APPROVED', 'PAID')
    LIMIT 1
  `));
  return Boolean(blocked || finalizedPayroll);
}

/** All selected rows post atomically, so a partial failure creates no payments. */
export async function postTargetBonusPayments(
  companyId: number,
  command: TargetBonusPaymentCommand,
  actor: TargetBonusPaymentActor,
) {
  if (!positiveId(companyId)) throw new HttpError(400, "Factory company required");
  if (!actor.userId) throw new HttpError(401, "A signed-in approver is required");
  return db.transaction(tx => postTargetBonusPaymentsInTransaction(tx, companyId, command, actor));
}

/** Shared with checkout's review+pay transaction, rolling back every action on
 * error. The company lock serializes concurrent bonus writers. */
export async function postTargetBonusPaymentsInTransaction(
  tx: DbTransaction, companyId: number, command: TargetBonusPaymentCommand,
  actor: TargetBonusPaymentActor,
) {
    // Same company lock used by Phase 4 decision endpoint. Prevents two
    // administrators choosing incompatible payouts for the same worker/day.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const cashId = await payingAccountTx(tx, companyId, command.cashAccountId);
    const results: Array<{
      paymentId: number; reviewId: number; workerId: number;
      productionDate: string; amount: string; voucherId: number; replayed: boolean;
    }> = [];
    let expenseId: number | null = null;
    for (const choice of command.selections) {
      const review = await getReviewTx(tx, companyId, choice.date, choice.workerId);
      const existing = await findPaymentTx(tx, companyId, review.id);
      const amount = review.amount;
      if (!amount || review.extraBales <= 0) conflict("Review has no positive extra-bale entitlement");
      let state: "POST" | "REPLAY";
      try {
        state = decideTargetBonusPaymentState(
          review.status, amount, choice.expectedAmount, Boolean(existing),
          existing ? false : await hasLegacyPayrollCollisionTx(tx, companyId, choice.date, choice.workerId),
        );
      } catch (error) { policyToHttp(error); }
      if (existing) {
        if (existing.status !== "POSTED" || Number(existing.cashAccountId) !== cashId ||
            String(existing.paymentDate) !== command.paymentDate || String(existing.currency) !== command.currency)
          conflict("Worker/day was already paid or reversed with different payment details");
        results.push({ paymentId: Number(existing.id), reviewId: review.id, workerId: review.workerId,
          productionDate: review.date, amount, voucherId: Number(existing.voucherId), replayed: true });
        continue;
      }
      // A reviewed weekly worker/week must never also receive a new daily payment.
      const weeklyClaim = first(await tx.execute(sql`
        SELECT 1 FROM factory_target_bonus_weekly_reviews
        WHERE company_id = ${companyId} AND worker_id = ${review.workerId}
          AND ${choice.date}::date BETWEEN week_start AND week_end LIMIT 1
      `));
      if (weeklyClaim) conflict("Weekly flat bonus review already covers this worker/day");
      const weeklyMode = first(await tx.execute(sql`
        SELECT method FROM factory_production_target_bonus_weekly_methods
        WHERE company_id = ${companyId}
          AND effective_week <= (${choice.date}::date - (EXTRACT(ISODOW FROM ${choice.date}::date)::integer - 1))
        ORDER BY effective_week DESC, id DESC LIMIT 1
      `));
      if (weeklyMode?.method === "weekly_flat")
        conflict("Weekly flat bonus is selected for this production week; daily payouts are disabled");
      if (state !== "POST") conflict("Payment already exists");
      if (command.paymentDate < choice.date) conflict("Payment cannot predate the finalized production day");
      if (expenseId == null) expenseId = await expenseAccountTx(tx, companyId);
      const narration = `Production Targets extra-bale bonus: ${review.workerName} (${review.date})`;
      const { voucher, replayed } = await postErpVoucherTx(tx, {
        companyId, voucherType: "Payment", voucherDate: command.paymentDate,
        sourceModule: "FACTORY", description: narration, currency: "USD",
        source: { type: "factory-target-bonus-review", id: `${companyId}:${review.id}`, revision: "paid" },
        actor: { userId: actor.userId, username: actor.username, reason: "Approved Production Targets bonus" },
        lines: [
          { ledgerAccountId: expenseId, debit: amount, narration },
          { ledgerAccountId: cashId, credit: amount, narration },
        ],
      });
      if (replayed) conflict("Voucher exists without its payment claim; manual reconciliation required");
      const inserted = first(await tx.execute(sql`
        INSERT INTO factory_target_bonus_payments (
          company_id, review_id, worker_id, production_date, bonus_amount, currency_code,
          payment_date, cash_ledger_account_id, expense_ledger_account_id,
          payment_voucher_id, posted_by
        ) VALUES (
          ${companyId}, ${review.id}, ${review.workerId}, ${choice.date}::date, ${amount}, 'USD',
          ${command.paymentDate}::date, ${cashId}, ${expenseId}, ${voucher.id}, ${actor.userId}
        ) RETURNING id
      `));
      if (!inserted) throw new HttpError(500, "Could not save the payment claim");
      const paymentId = Number(inserted.id);
      await writeDaybookEntry(tx, {
        companyId, txDate: command.paymentDate, txType: "PRODUCTION_TARGET_BONUS_PAYMENT",
        referenceTable: "factory_target_bonus_payments", referenceId: paymentId,
        description: narration, currencyCode: "USD", amountCurrency: Number(amount),
        amountUsd: Number(amount), createdBy: actor.userId,
        metaJson: JSON.stringify({ reviewId: review.id, voucherId: voucher.id, workerId: review.workerId }),
      });
      await logAudit({
        userId: actor.userId, username: actor.username, companyId, action: "create",
        tableName: "factory_target_bonus_payments", recordId: paymentId,
        recordIdentifier: `Production bonus review #${review.id} payment #${paymentId}`,
        changes: {
          amount: { old: null, new: amount },
          cashAccountId: { old: null, new: cashId },
          voucherId: { old: null, new: voucher.id },
        },
      }, tx);
      results.push({ paymentId, reviewId: review.id, workerId: review.workerId,
        productionDate: choice.date, amount, voucherId: voucher.id, replayed: false });
    }
    return { success: true, currency: "USD", paymentDate: command.paymentDate,
      cashAccountId: cashId, results,
      posted: results.filter((row) => !row.replayed).length,
      replayed: results.filter((row) => row.replayed).length };
}

export async function reverseTargetBonusPayment(
  companyId: number,
  paymentId: number,
  reversalDate: string,
  reason: string,
  actor: TargetBonusPaymentActor,
) {
  if (!positiveId(companyId) || !positiveId(paymentId)) throw new HttpError(400, "Invalid payment reference");
  if (!isRealBonusDate(reversalDate)) throw new HttpError(400, "Choose a valid reversal date");
  if (typeof reason !== "string" || !reason.trim()) throw new HttpError(400, "A reversal explanation is required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const row = first(await tx.execute(sql`
      SELECT id, review_id AS "reviewId", bonus_amount::text AS amount, worker_id AS "workerId",
        production_date::text AS "productionDate", payment_date::text AS "paymentDate",
        cash_ledger_account_id AS "cashAccountId", expense_ledger_account_id AS "expenseAccountId",
        status, reversal_voucher_id AS "reversalVoucherId"
      FROM factory_target_bonus_payments
      WHERE company_id = ${companyId} AND id = ${paymentId}
      FOR UPDATE
    `));
    if (!row) throw new HttpError(404, "Payment not found for this factory");
    if (row.status === "REVERSED")
      return { paymentId, reversed: true, replayed: true, voucherId: Number(row.reversalVoucherId) };
    if (row.status !== "POSTED") conflict("Payment is not reversible in its current state");
    if (reversalDate < String(row.paymentDate)) conflict("Reversal date cannot precede payment date");
    const narration = `Reversal of Production Targets bonus payment #${paymentId}: ${reason.trim().slice(0, 400)}`;
    const amount = String(row.amount);
    const { voucher, replayed } = await postErpVoucherTx(tx, {
      companyId, voucherType: "Receipt", voucherDate: reversalDate,
      sourceModule: "FACTORY", description: narration, currency: "USD",
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
      companyId, txDate: reversalDate, txType: "PRODUCTION_TARGET_BONUS_REVERSAL",
      referenceTable: "factory_target_bonus_payments", referenceId: paymentId,
      description: narration, currencyCode: "USD", amountCurrency: -Number(amount),
      amountUsd: -Number(amount), createdBy: actor.userId,
      metaJson: JSON.stringify({ reviewId: row.reviewId, voucherId: voucher.id }),
    });
    await logAudit({
      userId: actor.userId, username: actor.username, companyId,
      action: "update", tableName: "factory_target_bonus_payments", recordId: paymentId,
      recordIdentifier: `Production bonus payment #${paymentId} reversed`,
      changes: { status: { old: "POSTED", new: "REVERSED" }, reversalVoucherId: { old: null, new: voucher.id } },
    }, tx);
    return { paymentId, reversed: true, replayed: false, voucherId: voucher.id };
  });
}
