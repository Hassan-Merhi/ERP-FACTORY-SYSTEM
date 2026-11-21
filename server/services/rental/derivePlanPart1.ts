// Extracted from ./legacyPrepaidRecognitionRepair.ts
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { type DatabaseOrTransaction } from "../../db";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { companyClosedThrough, isDateInClosedPeriod } from "../accounting/scheduledPostingScope";
import { getRentalBillingDay, getRentalPeriodDueDate } from "./rentalPeriodService";

export const PREPAID_ACCOUNT_NAME = "Prepaid Rent";

const TOLERANCE = new MoneyDecimal("0.005");

export interface PlanLine {
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

export async function derivePlanPart1(
  executor: DatabaseOrTransaction,
  companyId: number,
  module: string,
  expenseAccountName: string,
  lock: boolean
) {
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
  return { body };
}
