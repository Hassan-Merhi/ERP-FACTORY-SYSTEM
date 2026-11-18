// Extracted from ./accrual.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { getUtcTodayString, isRentalPeriodDue } from "../../../services/rental/rentalPeriodService";
import { propertyContracts, propertyMonthlyLedger, propertyUnits } from "@shared/schema";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { findOrCreateLedgerAccount, RentalModule } from "./ledger";
import { ensureMonthlyLedgerRows } from "./monthly-rows";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { postAccrualPassTx, type RentAccrualPostingOptions } from "./accrual-posting";

export async function ensureMonthlyForCompany(companyId: number, module: RentalModule, asOfDate?: string) {
  const active = await db
    .select({ id: propertyContracts.id })
    .from(propertyContracts)
    .where(
      and(
        eq(propertyContracts.companyId, companyId),
        eq(propertyContracts.module, module),
        eq(propertyContracts.status, "ACTIVE")
      )
    );
  for (const c of active) await ensureMonthlyLedgerRows(c.id, asOfDate);

  // Landlord-owned periods are the source for HADI's linked-company leases.
  if (companyId === 1 && module === "ERP" && (asOfDate ?? getUtcTodayString()) >= "2026-12-01") {
    const shared = await db
      .select({ id: propertyContracts.id })
      .from(propertyContracts)
      .where(
        and(
          eq(propertyContracts.companyId, 13),
          eq(propertyContracts.linkedCompanyId, 1),
          eq(propertyContracts.module, "PROPERTIES"),
          eq(propertyContracts.status, "ACTIVE")
        )
      );
    for (const contract of shared) await ensureMonthlyLedgerRows(contract.id, asOfDate);
  }
}

/**
 * Pass 3 of postRentAccrualForCompany: landlord deferred revenue recognition.
 * For rows where usedPrepaidAccount=true, accrualVoucherId IS NULL, and isDue:
 *   Dr Deferred Rent Revenue / Cr Rent Income
 * Failures are logged and never abort the accrual run (unchanged behaviour).
 */
export async function recognizeDeferredLandlordRent(
  companyId: number,
  moduleParam: string,
  incomeAccountName: string,
  effectiveAsOf: string,
  options: RentAccrualPostingOptions
): Promise<void> {
  try {
    const landlordContracts = await db
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
          ne(propertyUnits.unitType, "SHOP")
        )
      );
    if (landlordContracts.length > 0) {
      const landlordIds = landlordContracts.map((c) => c.id);
      const landlordUnitNames = new Map(landlordContracts.map((c) => [c.unitId, c.unitNumber]));
      const landlordBillingDay = new Map(landlordContracts.map((c) => [c.id, new Date(c.startDate).getUTCDate()]));
      const isLandlordDue = (row: { year: number; month: number; contractId: number }) => {
        const bd = landlordBillingDay.get(row.contractId) ?? 1;
        return isRentalPeriodDue(row.year, row.month, bd, effectiveAsOf);
      };
      const deferredUnaccrued = await db
        .select()
        .from(propertyMonthlyLedger)
        .where(
          and(
            inArray(propertyMonthlyLedger.contractId, landlordIds),
            isNull(propertyMonthlyLedger.accrualVoucherId),
            eq(propertyMonthlyLedger.usedPrepaidAccount, true)
          )
        );
      const dueDeferred = deferredUnaccrued.filter((r) => isLandlordDue(r));
      if (dueDeferred.length > 0) {
        const lCurrCount = new Map<string, number>();
        for (const c of landlordContracts) {
          const cur = c.currency || "USD";
          lCurrCount.set(cur, (lCurrCount.get(cur) ?? 0) + 1);
        }
        const lBatchCurrency = [...lCurrCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
        await db.transaction(async (tx) => {
          // Recognize only the collected (deferred) portion — paidAmount, not expectedAmount.
          // Uncollected rent has no deferred account entry, so no recognition needed for it.
          const collected = (r: (typeof dueDeferred)[number]) =>
            MoneyDecimal.min(toMoney(r.paidAmount).toDecimalPlaces(2), toMoney(r.expectedAmount).toDecimalPlaces(2));
          const totalDeferred = dueDeferred.reduce((s, r) => s.plus(collected(r)), new MoneyDecimal(0));
          if (!totalDeferred.gt(0)) return; // nothing to recognize
          const incomeId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            incomeAccountName,
            "Income",
            "RENT-INC",
            "Indirect Income"
          );
          const deferredId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            "Deferred Rent Revenue",
            "Liability",
            "DEF-RENT-REV"
          );
          const months = [...new Set(dueDeferred.map((r) => `${String(r.month).padStart(2, "0")}/${r.year}`))].sort();
          const periodLabel = months.length === 1 ? months[0] : `${months[0]}–${months[months.length - 1]}`;
          const vDesc = `Deferred rent recognized - ${companyId} - ${periodLabel}`;
          // One debit line per row for only the deferred (collected) portion.
          await postAccrualPassTx(tx, {
            companyId,
            module: moduleParam,
            pass: "deferred-recognition",
            voucherDate: effectiveAsOf,
            description: vDesc,
            currency: lBatchCurrency,
            lines: [
              ...dueDeferred.map((r) => ({
                ledgerAccountId: deferredId,
                debit: collected(r),
                narration: `Deferred rent recognized - ${landlordUnitNames.get(r.unitId) ?? `unit${r.unitId}`} - ${String(r.month).padStart(2, "0")}/${r.year}`,
              })),
              { ledgerAccountId: incomeId, credit: totalDeferred, narration: vDesc },
            ],
            ledgerRowIds: dueDeferred.map((r) => r.id),
            options,
          });
        });
      }
    }
  } catch (e: unknown) {
    const detail = (getErrorMessage(e) ?? String(e)).replace(/\n/g, " | ");
    logger.error(`[ERP/rental] deferred recognition failed company ${companyId}: ${detail}`);
  }
}
