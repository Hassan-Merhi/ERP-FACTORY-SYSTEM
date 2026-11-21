// Extracted from ./reportsLedgerRoutes.ts
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { ledgerAccounts } from "@shared/schema";
import { HADI_ERP_RENT_MERGE, isArchivedHadiRentExpenseLedger } from "../services/rental/hadiRentExpenseConsolidation";

/** Include the archived original rent expense voucher lines, not a preview. */
export async function monthlyStatementAccountIds(companyId: number, accountId: number): Promise<number[]> {
  if (companyId !== HADI_ERP_RENT_MERGE.companyId || accountId !== HADI_ERP_RENT_MERGE.targetLedgerId)
    return [accountId];
  const [old] = await db
    .select({
      id: ledgerAccounts.id,
      companyId: ledgerAccounts.companyId,
      active: ledgerAccounts.active,
      isHidden: ledgerAccounts.isHidden,
      openingBalance: ledgerAccounts.openingBalance,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.id, HADI_ERP_RENT_MERGE.legacyLedgerId),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  return old && isArchivedHadiRentExpenseLedger(old) ? [accountId, HADI_ERP_RENT_MERGE.legacyLedgerId] : [accountId];
}
