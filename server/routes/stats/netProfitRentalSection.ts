import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { propertyContracts, propertyMonthlyLedger, propertyPayments, propertyUnits } from "@shared/schema";
import { db } from "../../db";
import {
  divideInventoryValues,
  inventoryMoney,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  getRentalBillingDay,
  getRentalPeriodDueDate,
  getUtcTodayString,
} from "../../services/rental/rentalPeriodService";

export interface RentalOutstanding {
  /** We overpaid rent: a prepaid-rent asset. */
  prepaidRent: number;
  /** We still owe rent: a rent-payable liability. */
  rentPayable: number;
}

/**
 * ERP Net Position uses the same tenant-side contract population as the ERP
 * rent-accrual writer: owned ERP shops PLUS active leases linked to this
 * company from Properties (even when the owner's unit is a warehouse).
 * The owner company's standalone landlord rentals are not ERP liabilities.
 */
export async function computeRentalOutstanding(
  companyId: number,
  toDate: string | null | undefined,
  currentCfaRate: number,
  businessToday?: string
): Promise<RentalOutstanding> {
  const empty: RentalOutstanding = { prepaidRent: 0, rentPayable: 0 };

  try {
    const ownedShops = await db
      .select({
        id: propertyContracts.id,
        currency: propertyContracts.currency,
        startDate: propertyContracts.startDate,
      })
      .from(propertyContracts)
      .innerJoin(propertyUnits, eq(propertyUnits.id, propertyContracts.unitId))
      .where(
        and(
          eq(propertyContracts.companyId, companyId),
          eq(propertyContracts.module, "ERP"),
          eq(propertyContracts.status, "ACTIVE"),
          eq(propertyUnits.unitType, "SHOP")
        )
      );

    const linkedLeases = await db
      .select({
        id: propertyContracts.id,
        currency: propertyContracts.currency,
        startDate: propertyContracts.startDate,
      })
      .from(propertyContracts)
      .where(and(eq(propertyContracts.linkedCompanyId, companyId), eq(propertyContracts.status, "ACTIVE")));

    // A contract may be both directly owned and linked; count it only once.
    const activeContracts = [...new Map([...ownedShops, ...linkedLeases].map((contract) => [contract.id, contract])).values()];
    if (activeContracts.length === 0) return empty;

    const asOf = toDate ?? businessToday ?? getUtcTodayString();
    const contractIds = activeContracts.map((contract) => contract.id);
    const billingDayByContract = new Map(
      activeContracts.map((contract) => [contract.id, getRentalBillingDay(contract.startDate)])
    );

    // Count only months whose contractual billing date has arrived, not all
    // months in the current calendar month. This matches the Rentals view.
    const monthlyRows = await db
      .select({
        contractId: propertyMonthlyLedger.contractId,
        year: propertyMonthlyLedger.year,
        month: propertyMonthlyLedger.month,
        expectedAmount: propertyMonthlyLedger.expectedAmount,
      })
      .from(propertyMonthlyLedger)
      .where(inArray(propertyMonthlyLedger.contractId, contractIds));

    const expectedMap = new Map<number, ReturnType<typeof toInventoryDecimal>>();
    for (const row of monthlyRows) {
      const billingDay = billingDayByContract.get(row.contractId);
      if (!billingDay || getRentalPeriodDueDate(row.year, row.month, billingDay) > asOf) continue;
      expectedMap.set(
        row.contractId,
        (expectedMap.get(row.contractId) ?? toInventoryDecimal(0)).plus(toInventoryDecimal(row.expectedAmount))
      );
    }

    // Payments of linked Properties leases belong to the owning company in
    // property_payments. Filter by the selected contract IDs rather than by
    // payer company_id, and never treat SCHEDULED/VOID as cash already paid.
    const paidRows = await db
      .select({
        contractId: propertyPayments.contractId,
        paid: sql<string>`COALESCE(SUM(CAST(${propertyPayments.amount} AS numeric)), 0)`,
      })
      .from(propertyPayments)
      .where(
        and(
          inArray(propertyPayments.contractId, contractIds),
          isNotNull(propertyPayments.ledgerRowId),
          eq(propertyPayments.postingStatus, "POSTED"),
          lte(propertyPayments.paymentDate, asOf)
        )
      )
      .groupBy(propertyPayments.contractId);
    const paidMap = new Map(paidRows.map((row) => [row.contractId, toInventoryDecimal(row.paid)]));

    let prepaidRent = toInventoryDecimal(0);
    let rentPayable = toInventoryDecimal(0);
    const cfaRate = toInventoryDecimal(currentCfaRate);
    for (const contract of activeContracts) {
      const net = subtractInventoryValues(paidMap.get(contract.id), expectedMap.get(contract.id) ?? 0);
      const usd = contract.currency === "CFA" && cfaRate.isPositive()
        ? divideInventoryValues(net, cfaRate)
        : net;
      if (usd.isPositive()) prepaidRent = prepaidRent.plus(usd);
      else if (usd.isNegative()) rentPayable = rentPayable.plus(usd.abs());
    }

    return {
      prepaidRent: Number(inventoryMoney(prepaidRent)),
      rentPayable: Number(inventoryMoney(rentPayable)),
    };
  } catch (rentalError: unknown) {
    logger.warn("[/api/stats/net-profit] Rental section skipped (schema or data error):", {
      error: getErrorMessage(rentalError),
    });
    return empty;
  }
}
