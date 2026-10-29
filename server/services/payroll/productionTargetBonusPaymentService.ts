/**
 * Phase 5+6: transaction-owned payout of an APPROVED production bonus allocation.
 * Direct payouts and payroll payouts are mutually exclusive. A reversal
 * preserves the unique allocation claim; manual re-approval is required before
 * any future replacement payment can be designed.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { db } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { toMoney } from "../../lib/money";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { writeDaybookEntry } from "../factory/factoryDaybookWriter";
import { logAudit } from "../../routes/helpers/auditHelpers";

export type BonusPaymentPostingRequest = {
  companyId: number;
  allocationId: number;
  cashAccountId: number;
  paymentDate: string;
  currency: string;
  actorId: string;
  actorName: string;
};

export function validateBonusPaymentPostingRequest(input: BonusPaymentPostingRequest): void {
  if (![input.companyId, input.allocationId, input.cashAccountId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new HttpError(400, "Company, allocation and paying account must be valid IDs");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate) || !Number.isFinite(Date.parse(input.paymentDate + "T00:00:00Z")) ||
      new Date(input.paymentDate + "T00:00:00Z").toISOString().slice(0,10) !== input.paymentDate) {
    throw new HttpError(400, "Payment date must be a real YYYY-MM-DD date");
  }
  // Never silently guess an FX rate. Phase 8 can expand posting to fully verified native-currency vouchers.
  if (input.currency !== "USD") throw new HttpError(400, "Only confirmed USD payments are available; other currencies require verified FX");
}

type AllocationRow = {
  id: number;
  workerId: number;
  workerName: string;
  amount: string;
  decisionStatus: string;
  payrollId: number | null;
  productionDate: string;
  extraBales: number;
  finished: boolean;
};
type PaymentRow = {
  id: number;
  companyId: number;
  allocationId: number;
  cashAccountId: number;
  paymentDate: string;
  currency: string;
  amount: string;
  status: string;
  voucherId: number;
  expenseAccountId: number;
  workerId: number;
  reversalVoucherId: number | null;
};
function first<T extends Record<string, unknown>>(result: unknown): T | undefined {
  return resultRows<T>(result)[0];
}
function cents(value: string | number) {
  return toMoney(value).toDecimalPlaces(2).toFixed(2);
}

async function loadAllocationTx(tx: DbTransaction, companyId: number, allocationId: number): Promise<AllocationRow> {
  const row = first<Record<string, unknown>>(await tx.execute(sql`
    SELECT a.id, a.worker_id AS "workerId", a.worker_name_snapshot AS "workerName",
           a.amount::text AS amount, a.decision_status AS "decisionStatus",
           a.payroll_id AS "payrollId", r.production_date::text AS "productionDate",
           r.extra_bales AS "extraBales",
           EXISTS (
             SELECT 1 FROM factory_staff_tracking_period_closures c
             WHERE c.company_id = a.company_id AND c.page_type = 'production'
               AND c.period_type = 'daily' AND c.period_start = r.production_date
               AND c.period_end = r.production_date
           ) AS finished
    FROM factory_production_bonus_allocations a
    JOIN factory_production_bonus_runs r ON r.id = a.run_id AND r.company_id = a.company_id
    WHERE a.id = ${allocationId} AND a.company_id = ${companyId}
    FOR UPDATE OF a
  `));
  if (!row) throw new HttpError(404, "Production bonus allocation not found");
  return {
    id: Number(row.id), workerId: Number(row.workerId), workerName: String(row.workerName),
    amount: String(row.amount), decisionStatus: String(row.decisionStatus),
    payrollId: row.payrollId == null ? null : Number(row.payrollId),
    productionDate: String(row.productionDate), extraBales: Number(row.extraBales),
    finished: row.finished === true,
  };
}

async function loadPaymentTx(tx: DbTransaction, companyId: number, allocationId: number): Promise<PaymentRow | undefined> {
  const row = first<Record<string, unknown>>(await tx.execute(sql`
    SELECT id, company_id AS "companyId", allocation_id AS "allocationId",
      worker_id AS "workerId", amount::text AS amount, currency_code AS currency,
      cash_ledger_account_id AS "cashAccountId",
      expense_ledger_account_id AS "expenseAccountId",
      payment_date::text AS "paymentDate", status, voucher_id AS "voucherId",
      reversal_voucher_id AS "reversalVoucherId"
    FROM factory_production_target_bonus_payments
    WHERE company_id = ${companyId} AND allocation_id = ${allocationId}
    FOR UPDATE
  `));
  return row ? {
    id: Number(row.id), companyId: Number(row.companyId), allocationId: Number(row.allocationId),
    workerId: Number(row.workerId), amount: String(row.amount), currency: String(row.currency),
    cashAccountId: Number(row.cashAccountId), expenseAccountId: Number(row.expenseAccountId),
    paymentDate: String(row.paymentDate), status: String(row.status),
    voucherId: Number(row.voucherId),
    reversalVoucherId: row.reversalVoucherId == null ? null : Number(row.reversalVoucherId),
  } : undefined;
}

async function ensureUsdCashBalanceTx(tx: DbTransaction, companyId: number, cashAccountId: number, amount: string): Promise<void> {
  const source = first<Record<string, unknown>>(await tx.execute(sql`
    SELECT id, name, active, account_type AS "accountType",
           opening_balance::text AS "openingBalance",
           opening_balance_side AS "openingSide",
           opening_balance_currency AS "openingCurrency"
    FROM ledger_accounts
    WHERE id = ${cashAccountId} AND company_id = ${companyId} AND deleted_at IS NULL
    FOR UPDATE
  `));
  if (!source || source.active !== true || !["Cash", "Bank"].includes(String(source.accountType))) {
    throw new HttpError(400, "Choose an active Cash or Bank ledger account from this company");
  }
  if (source.openingCurrency && String(source.openingCurrency).toUpperCase() !== "USD") {
    throw new HttpError(409, "Paying account has a non-USD opening balance; reconcile its currency first");
  }
  // Legacy non-USD entries cannot be safely counted as USD cash.
  const row = first<Record<string, unknown>>(await tx.execute(sql`
    SELECT
      COALESCE(SUM(COALESCE(ve.debit_amount,0)::numeric - COALESCE(ve.credit_amount,0)::numeric),0)::text AS net,
      COUNT(*) FILTER (WHERE COALESCE(UPPER(v.currency), 'USD') <> 'USD')::integer AS "nonUsdEntries"
    FROM voucher_entries ve
    JOIN vouchers v ON v.id = ve.voucher_id AND v.company_id = ${companyId} AND v.deleted_at IS NULL
    WHERE ve.ledger_account_id = ${cashAccountId}
  `));
  if (Number(row?.nonUsdEntries ?? 0) > 0)
    throw new HttpError(409, "Cash account contains non-USD vouchers; reconcile the account first");
  const opening = toMoney(String(source.openingBalance ?? "0"));
  const signedOpening = source.openingSide === "Cr" ? opening.negated() : opening;
  const available = signedOpening.plus(toMoney(String(row?.net ?? "0")));
  if (available.lessThan(toMoney(amount))) throw new HttpError(409, "Insufficient funds in the selected Cash/Bank account");
}

async function depositExpenseAccountTx(tx: DbTransaction, companyId: number): Promise<number> {
  const row = first<Record<string, unknown>>(await tx.execute(sql`
    INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
    VALUES (${companyId}, 'PAYROLL_DEPOSIT_EXPENSE', 'Payroll Deposit Expense', 'Indirect Expense', '0', true)
    ON CONFLICT DO NOTHING
    RETURNING id
  `));
  if (row) return Number(row.id);
  const existing = first<Record<string, unknown>>(await tx.execute(sql`
    SELECT id FROM ledger_accounts
    WHERE company_id = ${companyId} AND code = 'PAYROLL_DEPOSIT_EXPENSE' AND deleted_at IS NULL
    ORDER BY id LIMIT 1 FOR UPDATE
  `));
  if (!existing) throw new HttpError(409, "Payroll Deposit Expense account is unavailable");
  return Number(existing.id);
}

export async function postProductionTargetBonusPayment(input: BonusPaymentPostingRequest) {
  validateBonusPaymentPostingRequest(input);
  return db.transaction(async (tx) => {
    // Order the allocation lock before checking existing payout and before any payroll association.
    const allocation = await loadAllocationTx(tx, input.companyId, input.allocationId);
    const prior = await loadPaymentTx(tx, input.companyId, input.allocationId);
    if (prior) {
      if (prior.status === "POSTED" && prior.cashAccountId === input.cashAccountId &&
          prior.paymentDate === input.paymentDate && prior.currency === input.currency &&
          prior.amount === cents(allocation.amount)) return { ...prior, replayed: true };
      throw new HttpError(409, "This bonus has already been paid or reversed; duplicate payment blocked");
    }
    if (allocation.decisionStatus !== "APPROVED") throw new HttpError(409, "Bonus must be approved before payment");
    if (!allocation.finished) throw new HttpError(409, "End Production must be finalized before this bonus can be paid");
    if (allocation.payrollId !== null) throw new HttpError(409, "This bonus is assigned to payroll; pay it through payroll instead");
    if (allocation.extraBales <= 0 || toMoney(allocation.amount).lte(0)) throw new HttpError(409, "No payable extra-bale bonus");
    const amount = cents(allocation.amount);
    await ensureUsdCashBalanceTx(tx, input.companyId, input.cashAccountId, amount);
    const expenseAccountId = await depositExpenseAccountTx(tx, input.companyId);
    const narration = `Approved extra-bale bonus: ${allocation.workerName} (${allocation.productionDate})`;
    // Voucher is posted first inside this one transaction. Failed inserts/validations roll it back.
    const { voucher } = await postErpVoucherTx(tx, {
      companyId: input.companyId,
      voucherType: "Payment",
      voucherDate: input.paymentDate,
      description: narration,
      currency: "USD",
      sourceModule: "FACTORY",
      source: { type: "factory-production-target-bonus", id: `${input.companyId}:${input.allocationId}`, revision: "payment" },
      lines: [
        { ledgerAccountId: expenseAccountId, debit: amount, narration },
        { ledgerAccountId: input.cashAccountId, credit: amount, narration },
      ],
    });
    const inserted = first<Record<string, unknown>>(await tx.execute(sql`
      INSERT INTO factory_production_target_bonus_payments
        (company_id, allocation_id, worker_id, amount, currency_code,
         cash_ledger_account_id, expense_ledger_account_id, payment_date, voucher_id, posted_by)
      VALUES
        (${input.companyId}, ${allocation.id}, ${allocation.workerId}, ${amount}, 'USD',
         ${input.cashAccountId}, ${expenseAccountId}, ${input.paymentDate}::date, ${voucher.id}, ${input.actorId})
      RETURNING id
    `));
    if (!inserted) throw new HttpError(500, "Could not record production bonus payment");
    const id = Number(inserted.id);
    await writeDaybookEntry(tx, {
      companyId: input.companyId, txDate: input.paymentDate, txType: "PRODUCTION_BONUS_PAYMENT",
      referenceId: id, referenceTable: "factory_production_target_bonus_payments",
      description: narration, currencyCode: "USD", amountCurrency: Number(amount),
      amountUsd: Number(amount), createdBy: input.actorId,
      metaJson: JSON.stringify({ allocationId: allocation.id, voucherId: voucher.id, cashAccountId: input.cashAccountId }),
    });
    await logAudit({
      userId: input.actorId, username: input.actorName, companyId: input.companyId,
      action: "create", tableName: "factory_production_target_bonus_payments",
      recordId: id, recordIdentifier: `Production bonus payment #${id}`,
      changes: { allocationId: { old: null, new: allocation.id }, amount: { old: null, new: amount }, voucherId: { old: null, new: voucher.id } },
    }, tx);
    return { id, allocationId: allocation.id, workerId: allocation.workerId, amount,
      cashAccountId: input.cashAccountId, paymentDate: input.paymentDate,
      currency: "USD", status: "POSTED", voucherId: voucher.id, replayed: false };
  });
}

export async function reverseProductionTargetBonusPayment(input: {
  companyId: number; paymentId: number; reason: string; actorId: string; actorName: string; reversalDate: string;
}) {
  if (!Number.isSafeInteger(input.paymentId) || input.paymentId <= 0) throw new HttpError(400, "Invalid payment ID");
  if (!input.reason.trim()) throw new HttpError(400, "Reversal reason is required");
  validateBonusPaymentPostingRequest({ ...input, allocationId: input.paymentId, cashAccountId: 1,
    paymentDate: input.reversalDate, currency: "USD" });
  return db.transaction(async (tx) => {
    const base = first<Record<string, unknown>>(await tx.execute(sql`
      SELECT allocation_id AS "allocationId"
      FROM factory_production_target_bonus_payments
      WHERE id = ${input.paymentId} AND company_id = ${input.companyId}
    `));
    if (!base) throw new HttpError(404, "Bonus payment not found");
    const allocation = await loadAllocationTx(tx, input.companyId, Number(base.allocationId));
    const payment = await loadPaymentTx(tx, input.companyId, allocation.id);
    if (!payment) throw new HttpError(404, "Bonus payment not found");
    if (payment.status === "REVERSED") return { ...payment, replayed: true };
    const narration = `Reversal of production bonus payment #${payment.id}: ${input.reason.trim().slice(0, 500)}`;
    const { voucher } = await postErpVoucherTx(tx, {
      companyId: input.companyId, voucherType: "Receipt", voucherDate: input.reversalDate,
      description: narration, currency: "USD", sourceModule: "FACTORY",
      source: { type: "factory-production-target-bonus", id: `${input.companyId}:${allocation.id}`, revision: "reversal" },
      lines: [
        { ledgerAccountId: payment.cashAccountId, debit: payment.amount, narration },
        { ledgerAccountId: payment.expenseAccountId, credit: payment.amount, narration },
      ],
    });
    await tx.execute(sql`
      UPDATE factory_production_target_bonus_payments
      SET status='REVERSED', reversal_voucher_id=${voucher.id}, reversed_at=NOW(),
        reversed_by=${input.actorId}, reversal_reason=${input.reason.trim().slice(0,500)}
      WHERE id=${payment.id} AND company_id=${input.companyId} AND status='POSTED'
    `);
    await writeDaybookEntry(tx, {
      companyId: input.companyId, txDate: input.reversalDate, txType: "PRODUCTION_BONUS_REVERSAL",
      referenceId: payment.id, referenceTable: "factory_production_target_bonus_payments",
      description: narration, currencyCode: "USD", amountCurrency: -Number(payment.amount),
      amountUsd: -Number(payment.amount), createdBy: input.actorId,
      metaJson: JSON.stringify({ allocationId: allocation.id, originalVoucherId: payment.voucherId, reversalVoucherId: voucher.id }),
    });
    await logAudit({
      userId: input.actorId, username: input.actorName, companyId: input.companyId,
      action: "update", tableName: "factory_production_target_bonus_payments",
      recordId: payment.id, recordIdentifier: `Production bonus reversal #${payment.id}`,
      changes: { status: { old: "POSTED", new: "REVERSED" }, reversalVoucherId: { old: null, new: voucher.id } },
    }, tx);
    return { ...payment, status: "REVERSED", reversalVoucherId: voucher.id, replayed: false };
  });
}
