// Extracted from ./accrual.ts: a stage of postRentAccrualForCompany.
import { db } from "../../../db";
import { getUtcTodayString, isRentalPeriodDue } from "../../../services/rental/rentalPeriodService";
import { propertyUnits, propertyContracts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { isFutureHadiLinkedRentMonth, isHadiProtectedRentMonth } from "../../../services/rental/hadiRentLedgerPolicy";

export async function loadRentAccrualContext({
  asOfDate,
  companyId,
  moduleParam,
}: {
  asOfDate: string | undefined;
  companyId: number;
  moduleParam: string;
}) {
  // FIX #4: use explicit asOfDate instead of hidden new Date() so accruals
  //          are reproducible and safe to call from any date context.
  const effectiveAsOf = asOfDate ?? getUtcTodayString();
  // Load all active SHOP contracts owned by this company for the given module
  const shopContracts = await db
    .select({
      id: propertyContracts.id,
      unitId: propertyContracts.unitId,
      unitNumber: propertyUnits.unitNumber,
      startDate: propertyContracts.startDate,
      currency: propertyContracts.currency,
    })
    .from(propertyContracts)
    .innerJoin(propertyUnits, eq(propertyUnits.id, propertyContracts.unitId))
    .where(
      and(
        eq(propertyContracts.companyId, companyId),
        eq(propertyContracts.module, moduleParam),
        eq(propertyContracts.status, "ACTIVE"),
        eq(propertyUnits.unitType, "SHOP")
      )
    );

  // Also load shared contracts — units rented FROM another company (linkedCompanyId = this company).
  // These always appear in the Shops view regardless of their unit type, so they should
  // be accrued the same way (Dr Rent Expense / Cr Accrued Rent Payable).
  const sharedContracts = await db
    .select({
      ownerCompanyId: propertyContracts.companyId,
      ownerModule: propertyContracts.module,
      id: propertyContracts.id,
      unitId: propertyContracts.unitId,
      unitNumber: propertyUnits.unitNumber,
      startDate: propertyContracts.startDate,
      currency: propertyContracts.currency,
    })
    .from(propertyContracts)
    .innerJoin(propertyUnits, eq(propertyUnits.id, propertyContracts.unitId))
    .where(and(eq(propertyContracts.linkedCompanyId, companyId), eq(propertyContracts.status, "ACTIVE")));

  // Deduplicate in case a contract somehow appears in both (shouldn't happen, but be safe)
  const seen = new Set<number>();
  const allContracts = [...shopContracts, ...sharedContracts].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  // If there are no SHOP/shared contracts, pass 1 and pass 2 will no-op via
  // their own guards (contractIds.length === 0), but pass 3 (landlord deferred)
  // must still run for landlord-only companies outside PROPERTIES mode.

  // Determine the dominant currency for this batch of contracts (fallback USD).
  const currencyCount = new Map<string, number>();
  for (const c of allContracts) {
    const cur = c.currency || "USD";
    currencyCount.set(cur, (currencyCount.get(cur) ?? 0) + 1);
  }
  const batchCurrency = currencyCount.size > 0 ? [...currencyCount.entries()].sort((a, b) => b[1] - a[1])[0][0] : "USD";

  const contractIds = allContracts.map((c) => c.id);
  const hadiLinkedContractIds = new Set(
    companyId === 1 && moduleParam === "ERP"
      ? sharedContracts.filter((c) => c.ownerCompanyId === 13 && c.ownerModule === "PROPERTIES").map((c) => c.id)
      : []
  );
  const isFutureLinked = (row: { contractId: number; year: number; month: number }) =>
    isFutureHadiLinkedRentMonth(companyId, moduleParam, hadiLinkedContractIds.has(row.contractId), row.year, row.month);
  const isHistoricalHadiLinked = (row: { contractId: number; year: number; month: number }) =>
    hadiLinkedContractIds.has(row.contractId) && isHadiProtectedRentMonth(companyId, moduleParam, row.year, row.month);

  // Unit name (display label) keyed by unitId
  const unitNameById = new Map(allContracts.map((c) => [c.unitId, c.unitNumber]));

  // Billing day (day-of-month) keyed by contractId
  const billingDayByContract = new Map(allContracts.map((c) => [c.id, new Date(c.startDate).getUTCDate()]));

  const [asY, asM, asD] = effectiveAsOf.split("-").map(Number);
  const curYear = asY;
  const curMonth = asM;
  const curDay = asD;

  // isDue: billing-day-aware using explicit effectiveAsOf (not server-local now())
  const isDue = (row: { year: number; month: number; contractId: number }) => {
    const billingDay = billingDayByContract.get(row.contractId) ?? 1;
    return isRentalPeriodDue(row.year, row.month, billingDay, effectiveAsOf);
  };

  const totals = { accrued: 0, alreadyDone: 0 };

  return {
    effectiveAsOf,
    batchCurrency,
    contractIds,
    isFutureLinked,
    isHistoricalHadiLinked,
    unitNameById,
    curYear,
    curMonth,
    curDay,
    isDue,
    totals,
  };
}
