import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { propertyContracts, propertyMonthlyLedger } from "@shared/schema";

import { db, pool, type DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import { clampRentalPeriodToContractStart, getRentalPeriodDueDate } from "./rentalPeriodService";

type PostedMonthTotal = { for_year: string; for_month: string; paid_total: string };

/**
 * POSTED payment totals per month. Inside a posting transaction the read runs
 * on that transaction: borrowing a second pool connection while the first is
 * held deadlocks a one-connection pool and can exhaust a larger one.
 */
async function postedTotalsByMonth(contractId: number, tx?: DbTransaction): Promise<PostedMonthTotal[]> {
  if (tx)
    return resultRows<PostedMonthTotal>(
      await tx.execute(sql`SELECT for_year, for_month, COALESCE(SUM(amount::numeric), 0) AS paid_total
     FROM property_payments
     WHERE contract_id = ${contractId} AND posting_status = 'POSTED'
     GROUP BY for_year, for_month`)
    );
  const { rows } = await pool.query<PostedMonthTotal>(
    `SELECT for_year, for_month, COALESCE(SUM(amount::numeric), 0) AS paid_total
     FROM property_payments
     WHERE contract_id = $1 AND posting_status = 'POSTED'
     GROUP BY for_year, for_month`,
    [contractId]
  );
  return rows;
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
    .select({ startDate: propertyContracts.startDate })
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
    const expected = toMoney(row.expectedAmount as string);
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
