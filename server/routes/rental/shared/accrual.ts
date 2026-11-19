import { db } from "../../../db";
import { propertyUnits, propertyContracts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { type RentAccrualPostingOptions } from "./accrual-posting";
import { recognizeDeferredLandlordRent } from "./accrualEnsureMonthlyForCompany";
import { loadRentAccrualContext } from "./accrualContext";
import { rentAccrualPass3 } from "./accrualPass3";
import { rentAccrualPass2 } from "./accrualPass2";
import { rentAccrualPass1 } from "./accrualPass1";
export { ensureMonthlyForCompany } from "./accrualEnsureMonthlyForCompany";

export type { RentAccrualPostingOptions } from "./accrual-posting";

/**
 * Posts accrual journal vouchers (Dr Rent Expense / Cr Accrued Rent Payable) for
 * all unpaid ERP SHOP ledger rows where:
 *   - accrualVoucherId IS NULL (not yet accrued)
 *   - paidAmount < expectedAmount (still has an outstanding balance)
 *
 * Scoped to ERP module + SHOP unit type only. Safe to call for any contract —
 * it returns 0 immediately if the contract is not an ERP SHOP contract.
 *
 * Returns { accrued, skipped } where accrued = newly-posted rows,
 * skipped = due+unpaid rows that already had an accrual (nothing to do).
 */
export async function postRentAccrualForContract(
  contractId: number,
  shopExpenseAccountName: string
): Promise<{ accrued: number; skipped: number }> {
  // Load contract and verify it is an ERP contract
  const [contract] = await db
    .select()
    .from(propertyContracts)
    .where(and(eq(propertyContracts.id, contractId), eq(propertyContracts.module, "ERP")));
  if (!contract) return { accrued: 0, skipped: 0 };

  // Verify the unit is SHOP type
  const [unit] = await db
    .select({ unitType: propertyUnits.unitType })
    .from(propertyUnits)
    .where(eq(propertyUnits.id, contract.unitId));
  if (!unit || unit.unitType !== "SHOP") return { accrued: 0, skipped: 0 };

  return postRentAccrualForCompany(contract.companyId, shopExpenseAccountName);
}

/**
 * Posts ONE combined accrual journal (Dr Rent Expense / Cr Accrued Rent Payable)
 * for ALL active ERP SHOP contracts of the company that have due, unpaid, unaccrued
 * ledger rows.
 *
 * All rows that are newly accrued point to the same voucher ID so the daybook
 * shows a single journal entry instead of one per unit/month.
 *
 * Returns { accrued: N, skipped: M } where:
 *   accrued = number of ledger rows newly stamped with the combined voucher
 *   skipped = due+unpaid rows already accrued in a prior run
 */
export async function postRentAccrualForCompany(
  companyId: number,
  shopExpenseAccountName: string,
  moduleParam: string = "ERP",
  incomeAccountName: string = "Rental Income",
  asOfDate?: string,
  options: RentAccrualPostingOptions = {}
): Promise<{ accrued: number; skipped: number }> {
  const acx = await loadRentAccrualContext({ asOfDate, companyId, moduleParam });
  const { totals, effectiveAsOf } = acx;
  await rentAccrualPass1({ acx, companyId, shopExpenseAccountName, moduleParam, options });
  await rentAccrualPass2({ acx, companyId, shopExpenseAccountName, moduleParam, options });
  await rentAccrualPass3({ acx, companyId, shopExpenseAccountName, moduleParam, options });

  // Properties landlord receipts are recognised entirely when cash is received.
  // There is no Deferred Rent Revenue account or later landlord recognition pass.
  // SHOP/shared tenant expense accruals above still run normally in PROPERTIES mode.
  if (moduleParam === "PROPERTIES") {
    return { accrued: totals.accrued, skipped: totals.alreadyDone };
  }

  await recognizeDeferredLandlordRent(companyId, moduleParam, incomeAccountName, effectiveAsOf, options);

  return { accrued: totals.accrued, skipped: totals.alreadyDone };
}
