/**
 * Legacy fully prepaid shop rent, as a reviewed Owner tool (accounting audit
 * wave 18 A, owner decision 2 of 2026-10-10).
 *
 * The case: an owned SHOP month (ERP or FACTORY rental) paid in full before
 * its billing date by payments posted before the prepaid-rent workflow
 * existed (Dr Rent Expense / Cr cash), or that lost its prepaid flag, and
 * never recognised. The correction moves each early payment's expense to
 * Prepaid Rent at the payment date (LEGACY-PREPAID-RECLASS-{company}-{row}-{payment}:
 * Dr Prepaid Rent / Cr Rent Expense) and recognises the month on its billing
 * date (LEGACY-PREPAID-REC-{company}-{row}: Dr Rent Expense / Cr Prepaid Rent),
 * then marks the month accrued and prepaid. Rows whose payments cannot be
 * matched to a prepaid or a rent expense debit are listed as AMBIGUOUS and
 * left alone.
 *
 * Before: `repairLegacyFullyPrepaidRentRecognition` ran in the daily rental
 * job (scheduler, maintenance scope: the closed-period guard bypassed) for
 * every company, posting these journals back-dated to the original payment
 * dates with no audit and no closure check.
 *
 * Now nothing runs by itself. The Owner reviews and applies it:
 * - the plan (GET, read-only) lists each month with its vouchers and lines,
 *   the accounts (a missing Prepaid Rent / expense account is created on
 *   apply, never retyped or restored), the months skipped (AMBIGUOUS,
 *   PERIOD_CLOSED) and a sha256 planHash;
 * - the apply (POST `{ confirm: true, planHash }`) runs for the current
 *   company only in one transaction (company scope asserted, advisory lock,
 *   the monthly rows locked), derives the plan again and applies it only when
 *   the hash matches (409 PLAN_CHANGED); a month any of whose vouchers — the
 *   new ones and the payment vouchers whose expense they move, by
 *   COALESCE(effective_date, voucher_date) — falls in a closed period is not
 *   applied (PERIOD_CLOSED) and the closed-period trigger is never bypassed;
 *   one audit row holds every month before and after, with its vouchers.
 */
import { createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { propertyMonthlyLedger, voucherEntries } from "@shared/schema";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { findOrCreateLedgerAccount } from "../../routes/rental/shared/ledger";
import { writeAuditEvent } from "../audit";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../accounting/infrastructureVoucherIdentity";
import { companyClosedThrough, isDateInClosedPeriod } from "../accounting/scheduledPostingScope";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { getRentalBillingDay, getRentalPeriodDueDate } from "./rentalPeriodService";

const PREPAID_ACCOUNT_NAME = "Prepaid Rent";
const TOLERANCE = new MoneyDecimal("0.005");

export const LEGACY_PREPAID_MESSAGES = {
  NOT_SHOP_RENTAL_MODULE: "The legacy prepaid rent recognition applies to the ERP and factory shop rentals only.",
  NOTHING_TO_APPLY: "There is no legacy prepaid rent month to recognise.",
  PLAN_CHANGED: "The legacy prepaid rent recognition changed since it was reviewed; review it again before applying.",
} as const;

export class LegacyPrepaidRefusal extends Error {
  constructor(readonly code: keyof typeof LEGACY_PREPAID_MESSAGES) {
    super(LEGACY_PREPAID_MESSAGES[code]);
    this.name = "LegacyPrepaidRefusal";
  }
  get status(): number {
    return this.code === "PLAN_CHANGED" ? 409 : 400;
  }
}

interface PlanLine {
  ledgerAccount: "PREPAID" | "EXPENSE";
  debit: string;
  credit: string;
}

interface PlanVoucher {
  voucherNumber: string;
  voucherDate: string;
  amount: string;
  /** The early payment whose expense this moves (reclassification only). */
  paymentId: number | null;
  lines: PlanLine[];
}

export interface LegacyPrepaidPlanRow {
  ledgerRowId: number;
  unitId: number;
  year: number;
  month: number;
  dueDate: string;
  expected: string;
  currency: string;
  reclassifications: PlanVoucher[];
  recognition: PlanVoucher;
  before: { accrualVoucherId: null; usedPrepaidAccount: false; usedAdvanceAccount: false };
}

export interface LegacyPrepaidRecognitionPlan {
  companyId: number;
  module: string;
  asOfDate: string;
  closedThrough: string | null;
  accounts: {
    expense: { name: string; id: number | null };
    prepaid: { name: string; id: number | null };
  };
  rows: LegacyPrepaidPlanRow[];
  skipped: Array<{ ledgerRowId: number; reason: "AMBIGUOUS" | "PERIOD_CLOSED"; dates?: string[] }>;
  blockers: Array<"NOT_SHOP_RENTAL_MODULE" | "NOTHING_TO_APPLY">;
  planHash: string;
}

type CandidateRow = {
  id: number;
  unit_id: number;
  year: number;
  month: number;
  expected_amount: string;
  start_date: string;
  currency: string | null;
} & Record<string, unknown>;

type PaymentRow = {
  id: number;
  payment_date: string;
  amount: string;
  voucher_id: number | null;
  voucher_accounting_date: string | null;
} & Record<string, unknown>;

type DebitSummary = { voucher_id: number; name: string; account_type: string; debit: string } & Record<string, unknown>;

const reclassNumber = (companyId: number, rowId: number, paymentId: number) =>
  `LEGACY-PREPAID-RECLASS-${companyId}-${rowId}-${paymentId}`;
const recognitionNumber = (companyId: number, rowId: number) => `LEGACY-PREPAID-REC-${companyId}-${rowId}`;

async function accountIdByName(executor: DatabaseOrTransaction, companyId: number, name: string) {
  const result = await executor.execute<{ id: number } & Record<string, unknown>>(sql`
    SELECT id FROM ledger_accounts WHERE company_id = ${companyId} AND name = ${name} AND deleted_at IS NULL
     ORDER BY id LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  module: string,
  expenseAccountName: string,
  lock: boolean
): Promise<LegacyPrepaidRecognitionPlan> {
  const asOfDate = await companyBusinessDate(companyId, executor);
  const closedThrough = await companyClosedThrough(companyId, executor);
  const accounts = {
    expense: { name: expenseAccountName, id: await accountIdByName(executor, companyId, expenseAccountName) },
    prepaid: { name: PREPAID_ACCOUNT_NAME, id: await accountIdByName(executor, companyId, PREPAID_ACCOUNT_NAME) },
  };
  const rows: LegacyPrepaidPlanRow[] = [];
  const skipped: LegacyPrepaidRecognitionPlan["skipped"] = [];
  const blockers: LegacyPrepaidRecognitionPlan["blockers"] = [];

  if (module !== "ERP" && module !== "FACTORY") {
    blockers.push("NOT_SHOP_RENTAL_MODULE");
  } else {
    const candidates = await executor.execute<CandidateRow>(sql`
      SELECT pml.id, pml.unit_id, pml.year, pml.month, pml.expected_amount::text AS expected_amount,
             pc.start_date::text AS start_date, COALESCE(pc.currency, 'USD') AS currency
        FROM property_monthly_ledger pml
        JOIN property_contracts pc ON pc.id = pml.contract_id
        JOIN property_units pu ON pu.id = pml.unit_id
       WHERE pml.company_id = ${companyId}
         AND pml.module = ${module}
         AND pml.accrual_voucher_id IS NULL
         AND pml.used_prepaid_account = false
         AND pml.used_advance_account = false
         AND pml.expected_amount::numeric > 0
         AND pml.paid_amount::numeric >= pml.expected_amount::numeric - 0.005
         AND pc.company_id = ${companyId}
         AND pc.module = ${module}
         AND pc.status = 'ACTIVE'
         AND pu.unit_type = 'SHOP'
       ORDER BY pml.year, pml.month, pml.id
       ${lock ? sql`FOR UPDATE OF pml` : sql``}`);

    for (const row of candidates.rows) {
      const expected = toMoney(row.expected_amount);
      if (expected.lte(TOLERANCE)) continue;
      const dueDate = getRentalPeriodDueDate(row.year, row.month, getRentalBillingDay(row.start_date.slice(0, 10)));
      if (dueDate > asOfDate) continue;

      const payments = await executor.execute<PaymentRow>(sql`
        SELECT pp.id, pp.payment_date::text AS payment_date, pp.amount::text AS amount, pp.voucher_id,
               COALESCE(v.effective_date, v.voucher_date)::text AS voucher_accounting_date
          FROM property_payments pp
          LEFT JOIN vouchers v ON v.id = pp.voucher_id
         WHERE pp.ledger_row_id = ${row.id}
           AND pp.company_id = ${companyId}
           AND pp.module = ${module}
           AND pp.posting_status = 'POSTED'
           AND pp.payment_date < ${dueDate}::date
         ORDER BY pp.payment_date, pp.id`);
      const earlyPayments = payments.rows;
      if (sumMoney(earlyPayments.map((p) => p.amount)).lt(expected.minus(TOLERANCE))) continue;

      const voucherIds = [...new Set(earlyPayments.map((p) => p.voucher_id).filter((id): id is number => id !== null))];
      if (voucherIds.length === 0) {
        skipped.push({ ledgerRowId: row.id, reason: "AMBIGUOUS" });
        continue;
      }
      const voucherIdList = sql.join(
        voucherIds.map((id) => sql`${id}`),
        sql`, `
      );
      const debits = await executor.execute<DebitSummary>(sql`
        SELECT ve.voucher_id, la.name, la.account_type,
               COALESCE(SUM(ve.debit_amount::numeric), 0)::text AS debit
          FROM voucher_entries ve
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id
         WHERE ve.voucher_id IN (${voucherIdList})
           AND la.company_id = ${companyId}
           AND ve.debit_amount::numeric > 0
           AND la.deleted_at IS NULL
         GROUP BY ve.voucher_id, la.name, la.account_type`);
      const byVoucher = new Map<number, DebitSummary[]>();
      for (const entry of debits.rows) {
        byVoucher.set(entry.voucher_id, [...(byVoucher.get(entry.voucher_id) ?? []), entry]);
      }

      let remaining: Decimal = expected;
      let ambiguous = false;
      const chunks: Array<{ payment: PaymentRow; amount: Decimal }> = [];
      for (const payment of earlyPayments) {
        if (remaining.lte(TOLERANCE)) break;
        const paymentAmount = toMoney(payment.amount);
        if (paymentAmount.lte(TOLERANCE) || payment.voucher_id === null) {
          ambiguous = true;
          break;
        }
        const allocated = MoneyDecimal.min(paymentAmount, remaining);
        const summaries = byVoucher.get(payment.voucher_id) ?? [];
        const prepaidDebit = sumMoney(
          summaries.filter((e) => e.name.toLowerCase() === "prepaid rent").map((e) => e.debit)
        );
        const rentExpenseDebit = sumMoney(
          summaries
            .filter(
              (e) =>
                (e.account_type === "Indirect Expense" || e.account_type === "Expense") &&
                e.name.toLowerCase().includes("rent")
            )
            .map((e) => e.debit)
        );
        const alreadyPrepaid = prepaidDebit.gte(allocated.minus(TOLERANCE));
        const directExpense = !alreadyPrepaid && rentExpenseDebit.gte(allocated.minus(TOLERANCE));
        if (!alreadyPrepaid && !directExpense) {
          ambiguous = true;
          break;
        }
        if (directExpense) chunks.push({ payment, amount: allocated });
        remaining = remaining.minus(allocated);
      }
      if (ambiguous || remaining.gt(TOLERANCE)) {
        skipped.push({ ledgerRowId: row.id, reason: "AMBIGUOUS" });
        continue;
      }

      const dates = [
        dueDate,
        ...chunks.map((c) => c.payment.payment_date.slice(0, 10)),
        ...chunks.map((c) => c.payment.voucher_accounting_date?.slice(0, 10)).filter((d): d is string => !!d),
      ];
      const closedDates = [...new Set(dates.filter((d) => isDateInClosedPeriod(closedThrough, d)))].sort();
      if (closedDates.length) {
        skipped.push({ ledgerRowId: row.id, reason: "PERIOD_CLOSED", dates: closedDates });
        continue;
      }

      const amount = expected.toFixed(2);
      rows.push({
        ledgerRowId: row.id,
        unitId: row.unit_id,
        year: row.year,
        month: row.month,
        dueDate,
        expected: amount,
        currency: row.currency || "USD",
        reclassifications: chunks.map(({ payment, amount: chunkAmount }) => ({
          voucherNumber: reclassNumber(companyId, row.id, payment.id),
          voucherDate: payment.payment_date.slice(0, 10),
          amount: chunkAmount.toFixed(2),
          paymentId: payment.id,
          lines: [
            { ledgerAccount: "PREPAID", debit: chunkAmount.toFixed(2), credit: "0.00" },
            { ledgerAccount: "EXPENSE", debit: "0.00", credit: chunkAmount.toFixed(2) },
          ],
        })),
        recognition: {
          voucherNumber: recognitionNumber(companyId, row.id),
          voucherDate: dueDate,
          amount,
          paymentId: null,
          lines: [
            { ledgerAccount: "EXPENSE", debit: amount, credit: "0.00" },
            { ledgerAccount: "PREPAID", debit: "0.00", credit: amount },
          ],
        },
        before: { accrualVoucherId: null, usedPrepaidAccount: false, usedAdvanceAccount: false },
      });
    }
    if (rows.length === 0) blockers.push("NOTHING_TO_APPLY");
  }

  const body = { companyId, module, asOfDate, closedThrough, accounts, rows, skipped, blockers };
  const planHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, planHash };
}

/** Read-only plan for the company and module. */
export function planLegacyPrepaidRecognition(
  companyId: number,
  module: string,
  expenseAccountName: string,
  executor: DatabaseOrTransaction = db
): Promise<LegacyPrepaidRecognitionPlan> {
  return derivePlan(executor, companyId, module, expenseAccountName, false);
}

/** Applies the reviewed plan for the company in one transaction, audited in it. */
export async function applyLegacyPrepaidRecognition(
  companyId: number,
  module: string,
  expenseAccountName: string,
  options: { planHash: string; actor: { userId: string; username: string } }
): Promise<LegacyPrepaidRecognitionPlan & { vouchers: Array<{ voucherNumber: string; voucherId: number }> }> {
  return db.transaction(async (tx: DbTransaction) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('rental-legacy-prepaid-recognition'), ${companyId})`);
    const plan = await derivePlan(tx, companyId, module, expenseAccountName, true);
    if (plan.planHash !== options.planHash) throw new LegacyPrepaidRefusal("PLAN_CHANGED");
    if (plan.blockers.length) throw new LegacyPrepaidRefusal(plan.blockers[0]);

    // Created when missing only; an existing account is used as it is.
    const expenseId = await findOrCreateLedgerAccount(
      tx,
      companyId,
      expenseAccountName,
      "Indirect Expense",
      "SHOP-RENT-EXP"
    );
    const prepaidId = await findOrCreateLedgerAccount(tx, companyId, PREPAID_ACCOUNT_NAME, "Asset", "PREP-RENT");
    const accountId = (line: PlanLine) => (line.ledgerAccount === "PREPAID" ? prepaidId : expenseId);
    const posted: Array<{ voucherNumber: string; voucherId: number }> = [];

    for (const row of plan.rows) {
      const period = `${String(row.month).padStart(2, "0")}/${row.year}`;
      const sourceId = `${companyId}:${module}:${row.ledgerRowId}`;
      for (const reclass of row.reclassifications) {
        const narration = `Legacy prepaid rent reclassification - unit${row.unitId} - ${period}`;
        const { voucher } = await insertInfrastructureVoucherTx(
          tx,
          {
            companyId,
            voucherNumber: reclass.voucherNumber,
            voucherType: "Journal",
            voucherDate: reclass.voucherDate,
            description: narration,
            totalAmount: reclass.amount,
            currency: row.currency,
            sourceModule: module,
          },
          infrastructurePostingIdentity("rental-prepaid-repair", sourceId, `reclass:${reclass.paymentId}`),
          {
            ledgerRowId: row.ledgerRowId,
            paymentId: reclass.paymentId,
            amount: reclass.amount,
            paymentDate: reclass.voucherDate,
            dueDate: row.dueDate,
          }
        );
        await tx.insert(voucherEntries).values(
          reclass.lines.map((line) => ({
            voucherId: voucher.id,
            ledgerAccountId: accountId(line),
            debitAmount: line.debit,
            creditAmount: line.credit,
            narration,
          }))
        );
        posted.push({ voucherNumber: reclass.voucherNumber, voucherId: voucher.id });
      }

      const narration = `Prepaid rent recognized - unit${row.unitId} - ${period}`;
      const { voucher: recognition } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId,
          voucherNumber: row.recognition.voucherNumber,
          voucherType: "Journal",
          voucherDate: row.dueDate,
          description: narration,
          totalAmount: row.expected,
          currency: row.currency,
          sourceModule: module,
        },
        infrastructurePostingIdentity("rental-prepaid-repair", sourceId, "recognition"),
        { ledgerRowId: row.ledgerRowId, amount: row.expected, dueDate: row.dueDate }
      );
      await tx.insert(voucherEntries).values(
        row.recognition.lines.map((line) => ({
          voucherId: recognition.id,
          ledgerAccountId: accountId(line),
          debitAmount: line.debit,
          creditAmount: line.credit,
          narration,
        }))
      );
      posted.push({ voucherNumber: row.recognition.voucherNumber, voucherId: recognition.id });

      await tx
        .update(propertyMonthlyLedger)
        .set({ accrualVoucherId: recognition.id, usedPrepaidAccount: true, usedAdvanceAccount: false })
        .where(
          and(
            eq(propertyMonthlyLedger.id, row.ledgerRowId),
            eq(propertyMonthlyLedger.companyId, companyId),
            isNull(propertyMonthlyLedger.accrualVoucherId)
          )
        );
    }

    const voucherIdByNumber = new Map(posted.map((p) => [p.voucherNumber, p.voucherId]));
    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "update",
        tableName: "property_monthly_ledger",
        recordIdentifier: `rental-legacy-prepaid-recognition:${module}`,
        // entryRows and items keep every element (FULL_SNAPSHOT_AUDIT_FIELDS).
        changes: {
          entryRows: {
            old: plan.rows.map((row) => ({ id: row.ledgerRowId, ...row.before })),
            new: plan.rows.map((row) => ({
              id: row.ledgerRowId,
              accrualVoucherId: voucherIdByNumber.get(row.recognition.voucherNumber) ?? null,
              usedPrepaidAccount: true,
              usedAdvanceAccount: false,
            })),
          },
          items: {
            old: null,
            new: plan.rows.flatMap((row) =>
              [...row.reclassifications, row.recognition].map((voucher) => ({
                ...voucher,
                voucherId: voucherIdByNumber.get(voucher.voucherNumber) ?? null,
                ledgerRowId: row.ledgerRowId,
              }))
            ),
          },
          accounts: { new: { expenseId, prepaidId } },
          skipped: { new: plan.skipped },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return { ...plan, vouchers: posted };
  });
}
