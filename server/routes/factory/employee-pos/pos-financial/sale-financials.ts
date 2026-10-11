/**
 * The books a Factory POS sale writes outside its own tables, and how to take
 * them back out. Shared by the edit and void endpoints so both reverse exactly
 * what the sale endpoint posted.
 *
 * Merge of main #2129 into the accounting audit branch: the receipt voucher is
 * removed through `removeFactoryPosReceiptTx` (FPOS-RCPT-{sale} and legacy
 * FPOS-{sale}-{timestamp}; retired, audited, numbers released), not a plain
 * soft delete; the edit re-posts it through `postFactoryPosReceiptTx`.
 */
import { and, eq, or } from "drizzle-orm";
import { customerBalances, factoryDaybookEntries } from "@shared/schema";
import type { DbTransaction } from "../../../../db";
import { removeFactoryPosReceiptTx } from "../../../../services/accounting/factoryPosReceipt";

/** Removes the sale's credit-customer ledger rows (the sale debit and any deposit credit). */
export async function removeFactoryPosCustomerBalancesTx(tx: DbTransaction, companyId: number, saleId: number) {
  await tx
    .delete(customerBalances)
    .where(
      and(
        eq(customerBalances.referenceId, saleId),
        eq(customerBalances.companyId, companyId),
        or(
          eq(customerBalances.referenceType, "FACTORY_POS_SALE"),
          eq(customerBalances.referenceType, "FACTORY_POS_DEPOSIT")
        )
      )
    );
}

/**
 * Takes everything a sale posted back out of the books: its daybook rows
 * (the bale sale and its expense deductions), its credit-customer balance
 * rows, and its receipt voucher (retired, so the audit trail keeps it). The
 * cost-of-sales journal and the bales are the caller's (sale-delete.ts).
 */
export async function reverseFactoryPosSaleFinancialsTx(tx: DbTransaction, companyId: number, saleId: number) {
  await tx
    .delete(factoryDaybookEntries)
    .where(
      and(
        eq(factoryDaybookEntries.companyId, companyId),
        eq(factoryDaybookEntries.referenceTable, "factory_pos_sales"),
        eq(factoryDaybookEntries.referenceId, saleId)
      )
    );
  await removeFactoryPosCustomerBalancesTx(tx, companyId, saleId);
  await removeFactoryPosReceiptTx(tx, companyId, saleId);
}
