import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { propertyContracts, propertyMonthlyLedger } from "@shared/schema";

import { db, type DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import { clampRentalPeriodToContractStart, getRentalPeriodDueDate } from "./rentalPeriodService";

type PostedMonthTotal = { for_year: string; for_month: string; paid_total: string };

/**
 * POSTED payment totals per month. Inside a posting transaction the read runs
 * on that transaction: borrowing a second pool connection while the first is
 * held deadlocks a one-connection pool and can exhaust a larger one.
 */
/**
 * Historical Properties contract #6 has one documented non-cash billing
 * transition allocation. It is included in the rental paid-month calculation
 * but must NEVER be treated as cash or assigned a receipt voucher.
 *
 * Explicit identity + full original evidence keep the normal missing-voucher
 * guard effective for every other POSTED payment.
 * See tests/properties-payment-history-reconciliation.test.ts.
 */
export const approvedLegacyNonCashBillingAdjustment = sql`
  p.id = 342 AND p.company_id = 13 AND p.module = 'PROPERTIES'
  AND p.contract_id = 6 AND p.ledger_row_id = 787687
  AND p.cash_account_id = 859 AND p.voucher_id IS NULL
  AND p.amount::numeric = 800.00 AND p.currency = 'USD'
  AND p.payment_date = DATE '2026-07-25'
  AND p.for_year = 2026 AND p.for_month = 8
  AND p.payment_group_id IS NULL
  AND p.posting_status = 'POSTED'
  AND p.notes = 'Billing transition adjustment'
`;

async function postedTotalsByMonth(contractId: number, tx?: DbTransaction): Promise<PostedMonthTotal[]> {
  const runner = tx ?? db;
  return resultRows<PostedMonthTotal>(
    await runner.execute(sql`
      SELECT p.for_year, p.for_month,
        COALESCE(SUM(p.amount::numeric), 0) AS paid_total
      FROM property_payments p
      LEFT JOIN vouchers v ON v.id=p.voucher_id AND v.company_id=p.company_id
        AND v.deleted_at IS NULL AND v.optional=FALSE
      WHERE p.contract_id = ${contractId} AND p.posting_status = 'POSTED'
        AND p.ledger_row_id IS NOT NULL
        AND (v.id IS NOT NULL OR (${approvedLegacyNonCashBillingAdjustment}))
      GROUP BY p.for_year, p.for_month
    `)
  );
}

/**
 * Billing-day-aware "earliest outstanding month" finder.
 * Uses POSTED property_payments rows as the authoritative paid total —
 * NOT the paidAmount cache which can be stale or include future SCHEDULED rows.
 *
 * Returns the earliest month where:
 *   1. billingDate(year, month, billingDay) <= paymentDate  (month is due by payment time)
 *   2. SUM(POSTED payments for that month) < expectedAmount
 *
 * Falls back to the payment month (as the start of prepaid allocations) if
 * every due month is fully paid, but never before the contract start month.
 */
export async function findEarliestOutstandingMonth(
  contractId: number,
  billingDay: number,
  paymentDate: string,
  tx?: DbTransaction
): Promise<{ year: number; month: number }> {
  const runner = tx ?? db;
  const [contractRow] = await runner
    .select({ startDate: propertyContracts.startDate, rentalAmount: propertyContracts.rentalAmount })
    .from(propertyContracts)
    .where(eq(propertyContracts.id, contractId));

  const contractStartDate = contractRow?.startDate as string | Date | undefined;

  const ledgerRows = await runner
    .select({
      year: propertyMonthlyLedger.year,
      month: propertyMonthlyLedger.month,
      expectedAmount: propertyMonthlyLedger.expectedAmount,
    })
    .from(propertyMonthlyLedger)
    .where(eq(propertyMonthlyLedger.contractId, contractId))
    .orderBy(propertyMonthlyLedger.year, propertyMonthlyLedger.month);

  const postedRows = await postedTotalsByMonth(contractId, tx);

  const postedByMonth = new Map<string, Decimal>();
  for (const r of postedRows) {
    postedByMonth.set(`${r.for_year}-${r.for_month}`, toMoney(r.paid_total));
  }

  for (const row of ledgerRows) {
    if (contractStartDate) {
      const clamped = clampRentalPeriodToContractStart(row.year, row.month, contractStartDate);
      if (clamped.year !== row.year || clamped.month !== row.month) continue;
    }

    const billingDate = getRentalPeriodDueDate(row.year, row.month, billingDay);
    if (billingDate > paymentDate) continue;
    const posted = postedByMonth.get(`${row.year}-${row.month}`) ?? new MoneyDecimal(0);
    const persistedExpected = toMoney(row.expectedAmount as string);
    // A future prepaid month may still have a zero expected_amount cache
    // when it becomes due. Match the allocation builder's existing fallback
    // to the contract rent until its due-month upsert populates the amount.
    const expected = persistedExpected.isZero()
      ? toMoney(contractRow?.rentalAmount ?? 0)
      : persistedExpected;
    if (expected.minus(posted).gt("0.005")) {
      return { year: row.year, month: row.month };
    }
  }

  const pd = new Date(paymentDate + "T00:00:00Z");
  const fallback = { year: pd.getUTCFullYear(), month: pd.getUTCMonth() + 1 };
  return contractStartDate
    ? clampRentalPeriodToContractStart(fallback.year, fallback.month, contractStartDate)
    : fallback;
}

/**
 * Build allocations for a payment starting from (startYear, startMonth).
 * Uses billingDay + paymentDate to distinguish due vs. prepaid months.
 * Uses POSTED payments as the authoritative paid total.
 */
export async function buildAllocationsForPayment(
  contractId: number,
  startYear: number,
  startMonth: number,
  totalAmount: MoneyInput,
  rentalAmountInput: MoneyInput,
  billingDay: number,
  paymentDate: string,
  tx?: DbTransaction
): Promise<Array<{ year: number; month: number; chunk: string }>> {
  const ledgerRows = await (tx ?? db)
    .select({
      year: propertyMonthlyLedger.year,
      month: propertyMonthlyLedger.month,
      expectedAmount: propertyMonthlyLedger.expectedAmount,
    })
    .from(propertyMonthlyLedger)
    .where(eq(propertyMonthlyLedger.contractId, contractId));

  // Exact decimals at cents: each chunk is stored, and the chunks add up to the
  // payment exactly.
  const rentalAmount = toMoney(rentalAmountInput);
  const ledgerMap = new Map<string, Decimal>();
  for (const r of ledgerRows) {
    const expected = toMoney(r.expectedAmount as string);
    ledgerMap.set(`${r.year}-${r.month}`, expected.isZero() ? rentalAmount : expected);
  }

  const postedRows = await postedTotalsByMonth(contractId, tx);
  const postedByMonth = new Map<string, Decimal>();
  for (const r of postedRows) {
    postedByMonth.set(`${r.for_year}-${r.for_month}`, toMoney(r.paid_total));
  }

  const allocations: Array<{ year: number; month: number; chunk: string }> = [];
  let remaining = toMoney(totalAmount).toDecimalPlaces(2);
  let ay = startYear,
    am = startMonth;
  let skipped = 0;

  while (remaining.gt(0.005)) {
    const billingDate = getRentalPeriodDueDate(ay, am, billingDay);
    const isDue = billingDate <= paymentDate;
    const expected = ledgerMap.get(`${ay}-${am}`) ?? rentalAmount;
    const posted = postedByMonth.get(`${ay}-${am}`) ?? new MoneyDecimal(0);
    const capacity = MoneyDecimal.max(0, (isDue ? expected : rentalAmount).minus(posted));

    if (capacity.lte("0.005")) {
      ay = am === 12 ? ay + 1 : ay;
      am = am === 12 ? 1 : am + 1;
      skipped++;
      if (skipped > 500) break;
      continue;
    }

    skipped = 0;
    const chunk = MoneyDecimal.min(remaining, capacity).toDecimalPlaces(2);
    allocations.push({ year: ay, month: am, chunk: chunk.toFixed(2) });
    remaining = remaining.minus(chunk);
    ay = am === 12 ? ay + 1 : ay;
    am = am === 12 ? 1 : am + 1;
    if (allocations.length >= 120) break;
  }

  return allocations;
}
