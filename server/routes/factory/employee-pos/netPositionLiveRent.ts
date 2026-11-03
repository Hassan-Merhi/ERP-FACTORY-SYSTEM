/**
 * Today's Factory rental balance-sheet positions. This company pays rent on
 * FACTORY shop leases. Billing-day-aware credits (paid over due) are prepaid
 * assets; unpaid rent (due over paid) is a distinct rent-payable liability.
 * Historical requests use netPositionHistoricalAssets instead.
 */
import { and, eq, inArray } from "drizzle-orm";
import type Decimal from "decimal.js";
import { propertyContracts, propertyMonthlyLedger, propertyUnits } from "@shared/schema";
import { db, pool } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../../../services/rental/rentalPeriodService";
import { sumRentalContractPositions } from "../../../services/factory/netPositionHistoricalAssets";

export async function computeLiveFactoryRentalPositions(
  companyId: number,
  asOf: string
): Promise<{ prepaidRent: number; rentPayable: number }> {
  // All FACTORY units owned by this company
  const rentalUnitsRows = await db
    .select({ id: propertyUnits.id })
    .from(propertyUnits)
    .where(
      and(
        eq(propertyUnits.companyId, companyId),
        eq(propertyUnits.module, "FACTORY"),
        eq(propertyUnits.unitType, "SHOP"),
        eq(propertyUnits.active, true)
      )
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
           WHERE contract_id = ANY($1) AND company_id = $3 AND module = 'FACTORY'
             AND posting_status = 'POSTED' AND payment_date <= $2
             AND ledger_row_id IS NOT NULL
           GROUP BY contract_id`,
        [contractIds, asOf, companyId]
      );
      const paidAsOfByContract = new Map<number, Decimal>();
      postedRows.forEach((r) => paidAsOfByContract.set(parseInt(r.contract_id), toMoney(r.paid)));

      return sumRentalContractPositions(
        activeContracts.map((contract) => ({
          expected: (expectedAsOfByContract.get(contract.id) ?? new MoneyDecimal(0)).toFixed(),
          paid: (paidAsOfByContract.get(contract.id) ?? new MoneyDecimal(0)).toFixed(),
        }))
      );
    }
  }
  return { prepaidRent: 0, rentPayable: 0 };
}
