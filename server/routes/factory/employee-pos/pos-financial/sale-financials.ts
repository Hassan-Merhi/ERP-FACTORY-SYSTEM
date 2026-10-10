/**
 * The books a Factory POS sale writes outside its own tables, and how to take
 * them back out. Shared by the edit and void endpoints so both reverse exactly
 * what the sale endpoint posted.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { customerBalances, factoryDaybookEntries, vouchers } from "@shared/schema";
import type { DbTransaction } from "../../../../db";
import { removeFactoryDaybookMirrorTx } from "../../../../services/accounting/factoryDaybookMirrorRemoval";
import { softDeleteVoucherTx } from "../../../../services/accounting/voucherSoftDelete";

/** The live receipt vouchers posted for a sale (numbered FPOS-<saleId>-<timestamp>). */
export async function findFactoryPosSaleVouchersTx(tx: DbTransaction, companyId: number, saleId: number) {
  return tx
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.sourceModule, "FACTORY_POS"),
        isNull(vouchers.deletedAt),
        sql`voucher_number LIKE ${"FPOS-" + saleId + "-%"}`
      )
    );
}

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

/** Soft-deletes one receipt voucher and drops any daybook mirror it has. */
export async function retireFactoryPosVoucherTx(tx: DbTransaction, companyId: number, voucherId: number) {
  await softDeleteVoucherTx(tx, voucherId);
  await removeFactoryDaybookMirrorTx({ tx, voucherId, companyId });
}

/**
 * Takes everything a sale posted back out of the books: its daybook rows
 * (the bale sale and its expense deductions), its credit-customer balance
 * rows, and its receipt voucher. The voucher is soft-deleted so the audit
 * trail keeps it.
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
  for (const voucher of await findFactoryPosSaleVouchersTx(tx, companyId, saleId)) {
    await retireFactoryPosVoucherTx(tx, companyId, voucher.id);
  }
}
