import { db } from "../../../db";
import { getDuePeriods, getRentalBillingDay, getUtcTodayString } from "../../../services/rental/rentalPeriodService";
import { propertyContracts, propertyMonthlyLedger } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../../lib/money";

export async function ensureMonthlyLedgerRows(contractId: number, asOfDate?: string) {
  const [contract] = await db.select().from(propertyContracts).where(eq(propertyContracts.id, contractId));
  if (!contract || contract.status !== "ACTIVE") return;

  const billingDay = getRentalBillingDay(contract.startDate as string);
  const targetDate = asOfDate ?? getUtcTodayString();

  // Get all periods whose billing date has arrived as of targetDate.
  // getDuePeriods uses the contract's startDate and billingDay to determine
  // which month/year periods should have ledger rows.
  const duePeriods = getDuePeriods(contract.startDate as string, billingDay, targetDate);
  if (duePeriods.length === 0) return;

  // Upsert each period: insert new rows; update expectedAmount if it was stored as 0
  // (handles the case where a row was created before the contract amount was set).
  for (const period of duePeriods) {
    await db.execute(sql`
      INSERT INTO property_monthly_ledger (
        company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount
      ) VALUES (
        ${contract.companyId}, ${contract.module}, ${contract.id}, ${contract.unitId},
        ${period.year}, ${period.month}, ${contract.rentalAmount}, 0
      )
      ON CONFLICT (contract_id, year, month)
      DO UPDATE SET
        expected_amount = CASE
          WHEN property_monthly_ledger.expected_amount::numeric = 0
          THEN EXCLUDED.expected_amount
          ELSE property_monthly_ledger.expected_amount
        END
    `);
  }
}

// ── Oldest unpaid month finder ─────────────────────────────────────────────
// Returns the earliest past-or-current month for this contract that still has
// an outstanding balance.  Falls back to (fallbackYear, fallbackMonth) when
// every recorded month is fully paid.
export async function findEarliestOutstandingMonth(
  contractId: number,
  fallbackYear: number,
  fallbackMonth: number
): Promise<{ year: number; month: number }> {
  const rows = await db
    .select({
      year: propertyMonthlyLedger.year,
      month: propertyMonthlyLedger.month,
      paidAmount: propertyMonthlyLedger.paidAmount,
      expectedAmount: propertyMonthlyLedger.expectedAmount,
    })
    .from(propertyMonthlyLedger)
    .where(eq(propertyMonthlyLedger.contractId, contractId))
    .orderBy(propertyMonthlyLedger.year, propertyMonthlyLedger.month);

  const now = new Date();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;

  for (const row of rows) {
    // Only consider past and current months (not future prepaid months)
    const isPastOrCurrent = row.year < nowYear || (row.year === nowYear && row.month <= nowMonth);
    if (!isPastOrCurrent) continue;

    const outstanding = toMoney(row.expectedAmount as string).minus(toMoney(row.paidAmount as string));
    if (outstanding.gt("0.005")) {
      return { year: row.year, month: row.month };
    }
  }

  return { year: fallbackYear, month: fallbackMonth };
}

// ── Smart allocation builder ───────────────────────────────────────────────
// Builds the list of (year, month, chunk) allocations for a payment, starting
// from (startYear, startMonth) but SKIPPING any month that is already fully
// paid or fully prepaid, so the payment cascades to the next unpaid month.
//
// "Fully paid" rules:
//   • Current / past month  → paidAmount >= expectedAmount (standard due month)
//   • Future month          → paidAmount >= rentalAmount   (already prepaid in full)
export async function buildAllocations(
  contractId: number,
  startYear: number,
  startMonth: number,
  totalAmount: MoneyInput,
  rentalAmount: MoneyInput
): Promise<Array<{ year: number; month: number; chunk: string }>> {
  // Load all existing ledger rows for this contract so we can check balances
  const existingRows = await db
    .select({
      year: propertyMonthlyLedger.year,
      month: propertyMonthlyLedger.month,
      paidAmount: propertyMonthlyLedger.paidAmount,
      expectedAmount: propertyMonthlyLedger.expectedAmount,
    })
    .from(propertyMonthlyLedger)
    .where(eq(propertyMonthlyLedger.contractId, contractId));

  const ledgerMap = new Map<string, { paid: Decimal; expected: Decimal }>();
  for (const row of existingRows) {
    ledgerMap.set(`${row.year}-${row.month}`, {
      paid: toMoney(row.paidAmount as string),
      expected: toMoney(row.expectedAmount as string),
    });
  }

  const now = new Date();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;

  const allocations: Array<{ year: number; month: number; chunk: string }> = [];
  // Exact decimals at cents: each chunk is stored, and the chunks must add up
  // to the payment exactly.
  const rental = toMoney(rentalAmount);
  let remaining = toMoney(totalAmount).toDecimalPlaces(2);
  let ay = startYear,
    am = startMonth;
  let skipped = 0; // guard against infinite loops of already-paid months

  while (remaining.gt("0.005")) {
    const isFuture = ay > nowYear || (ay === nowYear && am > nowMonth);
    const existing = ledgerMap.get(`${ay}-${am}`);

    let outstanding: Decimal;
    if (existing) {
      if (isFuture) {
        // Future prepaid month: compare against contract rental amount
        outstanding = MoneyDecimal.max(0, rental.minus(existing.paid));
      } else {
        // Current / past due month: compare against its expected amount
        outstanding = MoneyDecimal.max(0, existing.expected.minus(existing.paid));
      }
    } else {
      // No ledger row yet — full capacity available
      outstanding = rental.gt(0) ? rental : remaining;
    }

    if (outstanding.lte("0.005")) {
      // Already fully paid — skip this month and try the next
      am++;
      if (am > 12) {
        am = 1;
        ay++;
      }
      skipped++;
      if (skipped > 500) break; // absolute safety cap
      continue;
    }

    skipped = 0; // reset skip counter once we found an allocatable month
    const chunk = MoneyDecimal.min(remaining, outstanding).toDecimalPlaces(2);
    allocations.push({ year: ay, month: am, chunk: chunk.toFixed(2) });
    remaining = remaining.minus(chunk);
    am++;
    if (am > 12) {
      am = 1;
      ay++;
    }
    if (allocations.length >= 120) break; // safety cap ~10 years
  }

  return allocations;
}
