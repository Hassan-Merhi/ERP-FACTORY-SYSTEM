/**
 * Ordinary ERP POS sales can use the voucher optional toggle: its sale rows,
 * COGS journal, inventory and ledger entries are all in the same company.
 *
 * Supplier Partner/Golden Coast sales and intercompany POS sales also create
 * independently posted settlement documents (sometimes in other companies).
 * An ordinary voucher flag toggle cannot reverse those documents atomically.
 * Fail closed rather than silently leaving cash, payables or intercompany
 * balances posted after the physical sale stock has been restored.
 *
 * Use this on BOTH optional-status write paths, not only the POS Daybook UI.
 */
import { eq } from "drizzle-orm";
import { companies, intercompanyPosConfigs, salesItems } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";

export const POS_OPTIONAL_LINKED_SETTLEMENT_MESSAGE =
  "This POS sale has a supplier-partner or intercompany accounting arrangement. " +
  "It cannot be made optional until its linked settlements can be reversed together with the sale.";

export function posOptionalLinkedSettlementBlocked(
  voucherType: string,
  hasSalesItems: boolean,
  companyType: string | null | undefined,
  hasIntercompanyConfig: boolean
): boolean {
  return ["Sales", "Receipt", "POS"].includes(voucherType) && hasSalesItems &&
    (companyType === "supplier_partner" || hasIntercompanyConfig);
}

export async function assertPosOptionalSettlementSafeTx(
  tx: DbTransaction,
  voucher: { id: number; companyId: number; voucherType: string }
): Promise<void> {
  if (!["Sales", "Receipt", "POS"].includes(voucher.voucherType)) return;
  const [saleLine] = await tx.select({ id: salesItems.id })
    .from(salesItems).where(eq(salesItems.voucherId, voucher.id)).limit(1);
  if (!saleLine) return;
  const [company] = await tx.select({ companyType: companies.companyType })
    .from(companies).where(eq(companies.id, voucher.companyId)).limit(1);
  const [intercompanyConfig] = await tx.select({ id: intercompanyPosConfigs.id })
    .from(intercompanyPosConfigs)
    .where(eq(intercompanyPosConfigs.sourceCompanyId, voucher.companyId))
    .limit(1);

  // Even a currently disabled configuration may have live historical mirror
  // postings. Do not assume disabling it removed those postings.
  if (posOptionalLinkedSettlementBlocked(
    voucher.voucherType, true, company?.companyType, Boolean(intercompanyConfig)
  )) {
    throw new HttpError(409, POS_OPTIONAL_LINKED_SETTLEMENT_MESSAGE);
  }
}
