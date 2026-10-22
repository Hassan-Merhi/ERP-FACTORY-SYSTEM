/**
 * Today's Prepaid Rent for Factory Net Position (the company is the landlord
 * collecting rent from FACTORY shop tenants). Moved verbatim from the route;
 * past dates use netPositionHistoricalAssets instead.
 *
 * Uses the same billing-day-aware logic as the Shop Rentals dashboard:
 * per ACTIVE contract on an active unit, |expected due by asOf - POSTED paid|.
 */
import { and, eq, inArray } from "drizzle-orm";
import type Decimal from "decimal.js";
import { propertyContracts, propertyMonthlyLedger, propertyUnits } from "@shared/schema";
import { db, pool } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../../../services/rental/rentalPeriodService";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function computeLiveFactoryPrepaidRent(companyId: number, asOf: string): Promise<number> {
  // All FACTORY units owned by this company
  const rentalUnitsRows = await db
    .select({ id: propertyUnits.id })
    .from(propertyUnits)
    .where(
      and(eq(propertyUnits.companyId, companyId), eq(propertyUnits.module, "FACTORY"), eq(propertyUnits.active, true))
    );

  if (rentalUnitsRows.length > 0) {
    const unitIds = rentalUnitsRows.map((u) => u.id);
    const activeContracts = await db
      .select()
      .from(propertyContracts)
      .where(
        and(
          eq(propertyContracts.companyId, companyId),
          eq(propertyContracts.module, "FACTORY"),
          inArray(propertyContracts.unitId, unitIds),
          eq(propertyContracts.status, "ACTIVE")
        )
      );

    if (activeContracts.length > 0) {
      const contractIds = activeContracts.map((c) => c.id);

      // Billing-day-aware expected (same logic as rentalUnitsContractsRoutes)
      const ledgerRows = await db
        .select({
          contractId: propertyMonthlyLedger.contractId,
          year: propertyMonthlyLedger.year,
          month: propertyMonthlyLedger.month,
          expectedAmount: propertyMonthlyLedger.expectedAmount,
        })
        .from(propertyMonthlyLedger)
        .where(inArray(propertyMonthlyLedger.contractId, contractIds));

      const ledgerByContract = new Map<number, typeof ledgerRows>();
      for (const row of ledgerRows) {
        const arr = ledgerByContract.get(row.contractId) ?? [];
        arr.push(row);
        ledgerByContract.set(row.contractId, arr);
      }

      const expectedAsOfByContract = new Map<number, Decimal>();
      for (const c of activeContracts) {
        const billingDay = getRentalBillingDay(c.startDate as string);
        const rows = ledgerByContract.get(c.id) ?? [];
        let expected = new MoneyDecimal(0);
        for (const row of rows) {
          const billingDate = getRentalPeriodDueDate(row.year, row.month, billingDay);
          if (billingDate <= asOf) expected = expected.plus(toMoney(row.expectedAmount as string));
        }
        expectedAsOfByContract.set(c.id, expected);
      }

      // POSTED payments only — same authoritative source as the dashboard
      const { rows: postedRows } = await pool.query<{ contract_id: string; paid: string }>(
        `SELECT contract_id, COALESCE(SUM(amount::numeric), 0) AS paid
           FROM property_payments
           WHERE contract_id = ANY($1) AND posting_status = 'POSTED' AND payment_date <= $2
           GROUP BY contract_id`,
        [contractIds, asOf]
      );
      const paidAsOfByContract = new Map<number, Decimal>();
      postedRows.forEach((r) => paidAsOfByContract.set(parseInt(r.contract_id), toMoney(r.paid)));

      // Positive = tenant still owes (outstanding receivable); negative =
      // tenant overpaid (advance credit we hold). Both count at their size.
      let rentTotal = new MoneyDecimal(0);
      for (const c of activeContracts) {
        const expected = expectedAsOfByContract.get(c.id) ?? new MoneyDecimal(0);
        rentTotal = rentTotal.plus(expected.minus(paidAsOfByContract.get(c.id) ?? 0).abs());
      }
      return round2(rentTotal.toNumber());
    }
  }
  return 0;
}
