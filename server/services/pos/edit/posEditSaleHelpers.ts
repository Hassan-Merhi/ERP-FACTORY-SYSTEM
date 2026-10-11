/**
 * server/services/pos/edit/posEditSaleHelpers.ts
 *
 * PHASE 20 structural split — moved (unchanged) from
 * server/routes/pos/posEditSaleRoutes.ts:
 *   - Supplier-partner accounting configuration lookup for edit-sale
 *   - Supplier-partner per-qty deduction rate lookup for a target location
 */
import { db } from "../../../db";
import { storage } from "../../../storage";
import { companies, ledgerAccounts, locations } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import type { HandlerErrorResult, SpEditAccountingContext } from "./posEditSaleTypes";
import { toMoney } from "../../../lib/money";

type SelectConnection = Pick<typeof db, "select">;

/** Detects supplier_partner company type and, if so, fetches/validates the SP POS accounts used for edit-sale accounting. */
export async function fetchSpEditAccountingContext(
  companyId: number
): Promise<{ context: SpEditAccountingContext } | { error: HandlerErrorResult }> {
  const [editCoRow] = await db
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const isSpCompanyEdit = editCoRow?.companyType === "supplier_partner";

  let editSpPayableAccountId: number | null = null;
  let editSpProfitAccountId: number | null = null;
  let editSpCostClrAccountId: number | null = null;
  let editSpDeductionClrAccountId: number | null = null;

  if (isSpCompanyEdit) {
    const spSettings = await storage.getCompanySettings(companyId);
    editSpPayableAccountId = spSettings?.spPosPayableAccountId ?? null;
    editSpProfitAccountId = spSettings?.spPosProfitAccountId ?? null;
    if (!editSpPayableAccountId || !editSpProfitAccountId) {
      return {
        error: {
          status: 400,
          body: {
            message: "Supplier POS payable/profit accounts are not configured. Go to SP Setup to set them up.",
          },
        },
      };
    }
    // Look up Stock Cost Payable Clearing account (sp_cost_clearing subType)
    const [clrAcct] = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.subType, "sp_cost_clearing"),
          isNull(ledgerAccounts.deletedAt)
        )
      )
      .limit(1);
    editSpCostClrAccountId = clrAcct?.id ?? null;
    // Look up Supplier Payable Deduction Clearing account (sp_pay_deduction_clearing subType)
    const [ddcAcct] = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.subType, "sp_pay_deduction_clearing"),
          isNull(ledgerAccounts.deletedAt)
        )
      )
      .limit(1);
    editSpDeductionClrAccountId = ddcAcct?.id ?? null;
  }

  return {
    context: {
      isSpCompanyEdit,
      editSpPayableAccountId,
      editSpProfitAccountId,
      editSpCostClrAccountId,
      editSpDeductionClrAccountId,
    },
  };
}

/**
 * For SP companies, load the target location's per-qty supplier payable
 * deduction rate. A transaction connection may be supplied so the rate is read
 * after the sale voucher has been locked and the final target location resolved.
 */
export async function fetchSpEditDeductionPerQty(
  isSpCompanyEdit: boolean,
  targetLocationId: number,
  connection: SelectConnection = db
): Promise<number> {
  if (!isSpCompanyEdit) return 0;
  const [editTargetLoc] = await connection
    .select({ supplierPartnerPayableDeductionPerQty: locations.supplierPartnerPayableDeductionPerQty })
    .from(locations)
    .where(eq(locations.id, targetLocationId))
    .limit(1);
  return toMoney(editTargetLoc?.supplierPartnerPayableDeductionPerQty).toNumber();
}
