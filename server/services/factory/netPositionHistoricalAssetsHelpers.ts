// Extracted from ./netPositionHistoricalAssets.ts
import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { propertyContracts, propertyMonthlyLedger, propertyPayments, propertyUnits } from "@shared/schema";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { getRentalBillingDay, getRentalPeriodDueDate } from "../rental/rentalPeriodService";
import { netPositionRecordedThrough } from "./netPositionAsOf";
import { loadFactoryRowsKnownAt } from "./netPositionRowHistoryReader";

export const value = (v: string | number | null | undefined) => toMoney(v);

export const cents = (v: InstanceType<typeof MoneyDecimal>) =>
  v.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();

export const recorded = (column: SQL, scope: FactoryNetPositionAsOf) =>
  netPositionRecordedThrough(column, scope, "utc-naive-timestamp");

export type HistoricalAssetLiabilityOperations = {
  workerAdvancesValue: number;
  prepaidRent: number;
  rentPayable: number;
  warnings: string[];
};

/**
 * Split the balance-sheet positions per contract without offsetting tenants.
 * Overpayments are prepaid assets; unpaid rent is a separate liability.
 */
export function sumRentalContractPositions(positions: readonly { expected: string; paid: string }[]): {
  prepaidRent: number;
  rentPayable: number;
} {
  let prepaidRent = new MoneyDecimal(0);
  let rentPayable = new MoneyDecimal(0);
  for (const position of positions) {
    const netPaid = value(position.paid).minus(value(position.expected));
    if (netPaid.gt(0)) prepaidRent = prepaidRent.plus(netPaid);
    else if (netPaid.lt(0)) rentPayable = rentPayable.plus(netPaid.abs());
  }
  return { prepaidRent: cents(prepaidRent), rentPayable: cents(rentPayable) };
}

export type DatedWorkerAdvance = {
  id: number;
  workerId: number;
  amount: string;
  advanceDate: string;
  repaymentType: string;
};

/** Post-baseline Factory rent, reconstructed from recorded unit, contract,
 * monthly-ledger and posted-payment state. Earlier dates fall back to the
 * existing dated-source calculations and their explicit limitations.
 */
async function recordedFactoryRentalAsOf(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<{ prepaidRent: number; rentPayable: number; warnings: string[] } | null> {
  const [units, contracts, monthly, payments] = await Promise.all([
    loadFactoryRowsKnownAt("property_units", companyId, scope),
    loadFactoryRowsKnownAt("property_contracts", companyId, scope),
    loadFactoryRowsKnownAt("property_monthly_ledger", companyId, scope),
    loadFactoryRowsKnownAt("property_payments", companyId, scope),
  ]);
  if (!units.ready || !contracts.ready || !monthly.ready || !payments.ready) return null;
  const activeUnitIds = new Set(
    [...units.rows.values()]
      .filter((r) => r.module === "FACTORY" && r.active === true && r.deleted_at == null)
      .map((r) => Number(r.id))
  );
  const selected = [...contracts.rows.values()]
    .filter(
      (r) =>
        r.company_id === companyId &&
        r.module === "FACTORY" &&
        r.deleted_at == null &&
        String(r.start_date ?? "").slice(0, 10) <= scope.asOf
    )
    .filter((r) =>
      r.status === "ACTIVE"
        ? activeUnitIds.has(Number(r.unit_id))
        : r.end_date != null && String(r.end_date).slice(0, 10) >= scope.asOf
    )
    .map((r) => ({ id: Number(r.id), startDate: String(r.start_date).slice(0, 10) }));
  if (!selected.length) return { prepaidRent: 0, rentPayable: 0, warnings: [] };
  const sums = new Map<
    number,
    { expected: InstanceType<typeof MoneyDecimal>; paid: InstanceType<typeof MoneyDecimal> }
  >();
  const billingDays = new Map<number, number>();
  for (const contract of selected) {
    if (!Number.isSafeInteger(contract.id) || contract.id <= 0) throw new Error("HISTORICAL_RENT_CONTRACT_ID_INVALID");
    sums.set(contract.id, { expected: new MoneyDecimal(0), paid: new MoneyDecimal(0) });
    billingDays.set(contract.id, getRentalBillingDay(contract.startDate));
  }
  for (const r of monthly.rows.values()) {
    if (r.module !== "FACTORY" || r.deleted_at != null) continue;
    const contractId = Number(r.contract_id);
    const row = sums.get(contractId);
    if (!row) continue;
    const year = Number(r.year);
    const month = Number(r.month);
    if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || month < 1 || month > 12) {
      throw new Error("HISTORICAL_RENT_PERIOD_INVALID");
    }
    if (getRentalPeriodDueDate(year, month, billingDays.get(contractId)!) <= scope.asOf) {
      row.expected = row.expected.plus(value(r.expected_amount as string | number | null | undefined));
    }
  }
  const warnings = new Set<string>();
  for (const r of payments.rows.values()) {
    if (r.module !== "FACTORY" || r.deleted_at != null) continue;
    if (String(r.payment_date ?? "").slice(0, 10) > scope.asOf) continue;
    const row = sums.get(Number(r.contract_id));
    if (!row) continue;
    if (r.posting_status !== "POSTED") continue;
    if (!r.posted_at) warnings.add("HISTORICAL_RENT_POSTING_TIMESTAMP_MISSING");
    row.paid = row.paid.plus(value(r.amount as string | number | null | undefined));
  }
  const positions = sumRentalContractPositions(
    [...sums.values()].map((r) => ({
      expected: r.expected.toFixed(),
      paid: r.paid.toFixed(),
    }))
  );
  return { ...positions, warnings: [...warnings] };
}

export async function factoryRentalAsOf(companyId: number, scope: FactoryNetPositionAsOf) {
  const recordedRent = await recordedFactoryRentalAsOf(companyId, scope);
  if (recordedRent) return recordedRent;
  const units = await db
    .select({ id: propertyUnits.id, active: propertyUnits.active })
    .from(propertyUnits)
    .where(
      and(
        eq(propertyUnits.companyId, companyId),
        eq(propertyUnits.module, "FACTORY"),
        eq(propertyUnits.unitType, "SHOP"),
        recorded(sql`${propertyUnits.createdAt}`, scope)
      )
    );
  if (!units.length) return { prepaidRent: 0, rentPayable: 0, warnings: [] as string[] };

  // Today's report counts ACTIVE contracts on active units. Neither flag has
  // a dated history, so a contract that is no longer ACTIVE is counted only
  // while its own term still covered the selected date; one that ended (or
  // has no end date) before then is excluded as it is today.
  const activeUnitIds = new Set(units.filter((u) => u.active).map((u) => u.id));
  const allContracts = await db
    .select({
      id: propertyContracts.id,
      unitId: propertyContracts.unitId,
      startDate: propertyContracts.startDate,
      endDate: propertyContracts.endDate,
      status: propertyContracts.status,
    })
    .from(propertyContracts)
    .where(
      and(
        eq(propertyContracts.companyId, companyId),
        eq(propertyContracts.module, "FACTORY"),
        inArray(
          propertyContracts.unitId,
          units.map((u) => u.id)
        ),
        lte(propertyContracts.startDate, scope.asOf),
        recorded(sql`${propertyContracts.createdAt}`, scope)
      )
    );
  const contracts = allContracts.filter((c) =>
    c.status === "ACTIVE" ? activeUnitIds.has(c.unitId) : c.endDate != null && String(c.endDate) >= scope.asOf
  );
  if (!contracts.length) return { prepaidRent: 0, rentPayable: 0, warnings: [] as string[] };
  const ids = contracts.map((c) => c.id);
  const [ledger, payments] = await Promise.all([
    db
      .select({
        contractId: propertyMonthlyLedger.contractId,
        year: propertyMonthlyLedger.year,
        month: propertyMonthlyLedger.month,
        expectedAmount: propertyMonthlyLedger.expectedAmount,
      })
      .from(propertyMonthlyLedger)
      .where(
        and(
          eq(propertyMonthlyLedger.companyId, companyId),
          eq(propertyMonthlyLedger.module, "FACTORY"),
          inArray(propertyMonthlyLedger.contractId, ids),
          recorded(sql`${propertyMonthlyLedger.createdAt}`, scope)
        )
      ),
    db
      .select({
        contractId: propertyPayments.contractId,
        amount: propertyPayments.amount,
        status: propertyPayments.postingStatus,
        createdAt: propertyPayments.createdAt,
        postedAt: propertyPayments.postedAt,
      })
      .from(propertyPayments)
      .where(
        and(
          eq(propertyPayments.companyId, companyId),
          eq(propertyPayments.module, "FACTORY"),
          inArray(propertyPayments.contractId, ids),
          // Guarantee payments are deposits, not rental-month payments.
          sql`${propertyPayments.ledgerRowId} IS NOT NULL`,
          lte(propertyPayments.paymentDate, scope.asOf),
          recorded(sql`${propertyPayments.createdAt}`, scope),
          // For scheduled rows that were posted later, created_at is not enough.
          sql`(${propertyPayments.postedAt} IS NULL OR ${recorded(sql`${propertyPayments.postedAt}`, scope)})`
        )
      ),
  ]);
  const warnings = new Set<string>();
  warnings.add("HISTORICAL_RENT_EXPECTED_AMOUNTS_UNVERSIONED");
  // Status ACTIVE/EXPIRED/CANCELLED is mutable with no reliable transition
  // timestamps. Even currently ACTIVE contracts may have been reopened.
  warnings.add("HISTORICAL_RENT_CONTRACT_STATUS_UNVERSIONED");
  const sums = new Map<
    number,
    { expected: InstanceType<typeof MoneyDecimal>; paid: InstanceType<typeof MoneyDecimal> }
  >();
  for (const contract of contracts) sums.set(contract.id, { expected: new MoneyDecimal(0), paid: new MoneyDecimal(0) });
  const billingDays = new Map(contracts.map((c) => [c.id, getRentalBillingDay(c.startDate)]));
  for (const row of ledger) {
    const due = getRentalPeriodDueDate(row.year, row.month, billingDays.get(row.contractId)!);
    if (due > scope.asOf) continue;
    const sumsRow = sums.get(row.contractId);
    if (sumsRow) sumsRow.expected = sumsRow.expected.plus(value(row.expectedAmount));
  }
  for (const payment of payments) {
    if (payment.status !== "POSTED") {
      if (payment.status === "VOID") warnings.add("HISTORICAL_RENT_VOID_DATE_UNAVAILABLE");
      continue;
    }
    if (!payment.postedAt) warnings.add("HISTORICAL_RENT_POSTING_TIMESTAMP_MISSING");
    const sumsRow = sums.get(payment.contractId);
    if (sumsRow) sumsRow.paid = sumsRow.paid.plus(value(payment.amount));
  }
  const positions = sumRentalContractPositions(
    [...sums.values()].map((row) => ({
      expected: row.expected.toFixed(),
      paid: row.paid.toFixed(),
    }))
  );
  return { ...positions, warnings: [...warnings] };
}
