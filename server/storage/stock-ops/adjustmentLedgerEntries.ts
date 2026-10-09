import type Decimal from "decimal.js";
import * as schema from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import { getOrCreateInventoryControlAccount } from "../../services/accounting/inventoryControlAccount";
import { inventoryMoney } from "../../lib/inventoryMath";
import { shouldInsertAdjustmentVoucherEntry } from "./adjustmentVoucherEntryGuard";

/**
 * Post a stock adjustment's ledger lines as a balanced pair per side:
 *
 *   Production:  Dr Inventory          Cr Stock Adjustment
 *   Consumption: Dr Stock Adjustment   Cr Inventory
 *
 * Before this, only the Stock Adjustment side was written, so every adjustment
 * voucher was out of balance by its own value. The Inventory side uses the
 * canonical INVENTORY account only (never a "Stock in Hand" account matched by
 * name), so Golden Coast FIFO-backed stock accounts are left alone.
 */
export async function insertStockAdjustmentLedgerEntriesTx(
  tx: DatabaseOrTransaction,
  input: {
    voucherId: number;
    companyId: number;
    adjustmentAccountId: number | null;
    adjustmentType: string;
    productionValue: Decimal;
    consumptionValue: Decimal;
  }
): Promise<void> {
  const { voucherId, adjustmentAccountId, adjustmentType, productionValue, consumptionValue } = input;
  const postsProduction = shouldInsertAdjustmentVoucherEntry(productionValue, adjustmentAccountId);
  const postsConsumption = shouldInsertAdjustmentVoucherEntry(consumptionValue, adjustmentAccountId);
  if (!postsProduction && !postsConsumption) return;

  const inventoryAccount = await getOrCreateInventoryControlAccount(tx, input.companyId, { matchByName: false });

  if (postsProduction) {
    const amount = inventoryMoney(productionValue);
    await tx.insert(schema.voucherEntries).values([
      {
        voucherId,
        ledgerAccountId: inventoryAccount.id,
        debitAmount: amount,
        creditAmount: "0",
        narration: `Inventory in - ${adjustmentType} voucher`,
      },
      {
        voucherId,
        ledgerAccountId: adjustmentAccountId,
        debitAmount: "0",
        creditAmount: amount,
        narration: `Production adjustment - ${adjustmentType} voucher`,
      },
    ]);
  }
  if (postsConsumption) {
    const amount = inventoryMoney(consumptionValue);
    await tx.insert(schema.voucherEntries).values([
      {
        voucherId,
        ledgerAccountId: adjustmentAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: `Consumption expense - ${adjustmentType} voucher`,
      },
      {
        voucherId,
        ledgerAccountId: inventoryAccount.id,
        debitAmount: "0",
        creditAmount: amount,
        narration: `Inventory out - ${adjustmentType} voucher`,
      },
    ]);
  }
}
