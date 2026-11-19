/**
 * Explicit, user-entered worker bonus disbursements from Production Bonuses.
 * These are NOT changes to calculated weekly/daily bonus awards. Each request
 * posts auditable balanced vouchers and Daybook entries in one DB transaction.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { writeDaybookEntry } from "./factoryDaybookWriter";
import { logAudit } from "../../routes/helpers/auditHelpers";
import { payingAccountTx, expenseAccountTx, type TargetBonusPaymentActor } from "./targetBonusPaymentService";
import { isRealBonusDate } from "./targetBonusPaymentPolicy";
import { loadProductionTargetsRosterIds } from "./productionTargetsRoster";
import {
  first,
  all,
  bad,
  id,
  conflictingAwardTx,
  type ManualBonusCommand,
} from "./manualProductionBonusPaymentServiceHelpers";
export {
  parseManualBonusCommand,
  type ManualBonusSelection,
  type ManualBonusCommand,
} from "./manualProductionBonusPaymentServiceHelpers";

export async function postManualProductionBonuses(
  companyId: number,
  command: ManualBonusCommand,
  actor: TargetBonusPaymentActor
) {
  if (!id(companyId) || !actor.userId) bad(401, "Signed-in factory approver required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const cashId = await payingAccountTx(tx, companyId, command.cashAccountId);
    const existing = all(
      await tx.execute(sql`
      SELECT id, worker_id AS "workerId", amount_usd::text AS amount,
        week_start::text AS "weekStart", payment_date::text AS "paymentDate",
        cash_ledger_account_id AS "cashAccountId", payment_voucher_id AS "voucherId",
        status FROM factory_target_bonus_manual_payments
      WHERE company_id=${companyId} AND request_key=${command.requestKey}::uuid
      ORDER BY worker_id FOR UPDATE
    `)
    );
    if (existing.length) {
      if (
        existing.length !== command.selections.length ||
        existing.some((row, index) => {
          const choice = command.selections[index];
          return (
            Number(row.workerId) !== choice.workerId ||
            String(row.amount) !== choice.amount ||
            String(row.weekStart) !== command.weekStart ||
            String(row.paymentDate) !== command.paymentDate ||
            Number(row.cashAccountId) !== cashId
          );
        })
      )
        bad(409, "This payment request was already used with different details");
      return {
        posted: 0,
        replayed: existing.length,
        results: existing.map((row) => ({
          paymentId: Number(row.id),
          workerId: Number(row.workerId),
          amount: String(row.amount),
          voucherId: Number(row.voucherId),
          status: String(row.status),
          replayed: true,
        })),
      };
    }
    const rosterDate = command.rosterDate; // The same roster day displayed in checkout.
    const roster = await loadProductionTargetsRosterIds(tx, companyId, rosterDate);
    const expenseId = await expenseAccountTx(tx, companyId);
    const results: Array<{
      paymentId: number;
      workerId: number;
      amount: string;
      voucherId: number;
      status: string;
      replayed: boolean;
    }> = [];
    for (const selection of command.selections) {
      if (!roster.has(selection.workerId))
        bad(409, "Selected worker is not on the Production Targets roster for this week");
      const worker = first(
        await tx.execute(sql`
        SELECT full_name AS name FROM factory_workers
        WHERE company_id=${companyId} AND id=${selection.workerId}
      `)
      );
      if (!worker) bad(404, "Worker does not belong to this factory");
      await conflictingAwardTx(tx, companyId, selection.workerId, command.weekStart);
      const priorManual = first(
        await tx.execute(sql`
        SELECT 1 FROM factory_target_bonus_manual_payments
        WHERE company_id=${companyId} AND worker_id=${selection.workerId}
          AND week_start=${command.weekStart}::date AND status='POSTED' LIMIT 1
      `)
      );
      if (priorManual)
        bad(409, "This worker already has a manual bonus payment for the selected week. Reverse or reconcile it first");
      const narration = `Manual Production Bonus - ${String(worker.name)} - week ${command.weekStart}`;
      const { voucher, replayed } = await postErpVoucherTx(tx, {
        companyId,
        voucherType: "Payment",
        voucherDate: command.paymentDate,
        sourceModule: "FACTORY",
        description: narration,
        currency: "USD",
        source: {
          type: "factory-target-bonus-manual",
          id: `${companyId}:${command.requestKey}:${selection.workerId}`,
          revision: "paid",
        },
        actor: { userId: actor.userId, username: actor.username, reason: "Confirmed manual Production Bonuses payout" },
        lines: [
          { ledgerAccountId: expenseId, debit: selection.amount, narration },
          { ledgerAccountId: cashId, credit: selection.amount, narration },
        ],
      });
      if (replayed) bad(409, "Manual bonus voucher already exists without a payment record. Reconcile first");
      const inserted = first(
        await tx.execute(sql`
        INSERT INTO factory_target_bonus_manual_payments
          (company_id,worker_id,week_start,amount_usd,payment_date,request_key,
           cash_ledger_account_id,expense_ledger_account_id,payment_voucher_id,posted_by)
        VALUES (${companyId},${selection.workerId},${command.weekStart}::date,${selection.amount},
          ${command.paymentDate}::date,${command.requestKey}::uuid,${cashId},${expenseId},${voucher.id},${actor.userId})
        RETURNING id
      `)
      );
      if (!inserted) bad(500, "Could not save manual bonus record");
      const paymentId = Number(inserted.id);
      await writeDaybookEntry(tx, {
        companyId,
        txDate: command.paymentDate,
        txType: "PRODUCTION_TARGET_MANUAL_BONUS_PAYMENT",
        referenceTable: "factory_target_bonus_manual_payments",
        referenceId: paymentId,
        description: narration,
        currencyCode: "USD",
        amountCurrency: Number(selection.amount),
        amountUsd: Number(selection.amount),
        createdBy: actor.userId,
        metaJson: JSON.stringify({
          voucherId: voucher.id,
          workerId: selection.workerId,
          weekStart: command.weekStart,
          manual: true,
        }),
      });
      await logAudit(
        {
          userId: actor.userId,
          username: actor.username,
          companyId,
          action: "create",
          tableName: "factory_target_bonus_manual_payments",
          recordId: paymentId,
          recordIdentifier: `Manual production bonus #${paymentId}`,
          changes: {
            amount: { old: null, new: selection.amount },
            workerId: { old: null, new: selection.workerId },
            cashAccountId: { old: null, new: cashId },
            voucherId: { old: null, new: voucher.id },
          },
        },
        tx
      );
      results.push({
        paymentId,
        workerId: selection.workerId,
        amount: selection.amount,
        voucherId: Number(voucher.id),
        status: "POSTED",
        replayed: false,
      });
    }
    return { posted: results.length, replayed: 0, results };
  });
}
export async function reverseManualProductionBonus(
  companyId: number,
  paymentId: number,
  date: string,
  reason: string,
  actor: TargetBonusPaymentActor
) {
  if (!id(companyId) || !id(paymentId) || !actor.userId) bad(400, "Invalid manual bonus payment");
  if (!isRealBonusDate(date) || !reason.trim()) bad(400, "Reversal date and reason required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
    const row = first(
      await tx.execute(sql`
      SELECT id,worker_id AS "workerId",week_start::text AS "weekStart",
        amount_usd::text AS amount,payment_date::text AS "paymentDate",
        cash_ledger_account_id AS "cashId",expense_ledger_account_id AS "expenseId",
        status,reversal_voucher_id AS "reversalVoucherId"
      FROM factory_target_bonus_manual_payments
      WHERE company_id=${companyId} AND id=${paymentId} FOR UPDATE
    `)
    );
    if (!row) bad(404, "Manual payment not found");
    if (row.status === "REVERSED") return { paymentId, replayed: true, voucherId: Number(row.reversalVoucherId) };
    if (row.status !== "POSTED" || date < String(row.paymentDate))
      bad(409, "Cannot reverse payment before its posting date");
    const narration = `Reversal of manual production bonus #${paymentId}: ${reason.trim().slice(0, 400)}`;
    const { voucher, replayed } = await postErpVoucherTx(tx, {
      companyId,
      voucherType: "Receipt",
      voucherDate: date,
      sourceModule: "FACTORY",
      description: narration,
      currency: "USD",
      source: { type: "factory-target-bonus-manual", id: `${companyId}:${paymentId}`, revision: "reversed" },
      actor: { userId: actor.userId, username: actor.username, reason: "Manual bonus reversal" },
      lines: [
        { ledgerAccountId: Number(row.cashId), debit: String(row.amount), narration },
        { ledgerAccountId: Number(row.expenseId), credit: String(row.amount), narration },
      ],
    });
    if (replayed) bad(409, "Manual reversal voucher already posted; reconcile before trying again");
    await tx.execute(sql`
      UPDATE factory_target_bonus_manual_payments
      SET status='REVERSED',reversal_voucher_id=${voucher.id},
        reversal_reason=${reason.trim().slice(0, 400)},reversed_by=${actor.userId},reversed_at=now()
      WHERE company_id=${companyId} AND id=${paymentId} AND status='POSTED'
    `);
    await writeDaybookEntry(tx, {
      companyId,
      txDate: date,
      txType: "PRODUCTION_TARGET_MANUAL_BONUS_REVERSAL",
      referenceTable: "factory_target_bonus_manual_payments",
      referenceId: paymentId,
      description: narration,
      currencyCode: "USD",
      amountCurrency: -Number(row.amount),
      amountUsd: -Number(row.amount),
      createdBy: actor.userId,
      metaJson: JSON.stringify({ voucherId: voucher.id, workerId: Number(row.workerId), manual: true }),
    });
    await logAudit(
      {
        userId: actor.userId,
        username: actor.username,
        companyId,
        action: "update",
        tableName: "factory_target_bonus_manual_payments",
        recordId: paymentId,
        recordIdentifier: `Manual production bonus #${paymentId} reversed`,
        changes: { status: { old: "POSTED", new: "REVERSED" }, reversalVoucherId: { old: null, new: voucher.id } },
      },
      tx
    );
    return { paymentId, replayed: false, voucherId: Number(voucher.id) };
  });
}
