/**
 * Dated evidence of a stock-item merge (accounting audit phase 29, I5).
 *
 * A merge moves the duplicate item's stock rows onto the kept item at each
 * location (quantity and value conserved, so no journal). The as-of stock
 * replay reverses the dated evidence after a date (inventory_value_movements)
 * and the document lines (repointed to the kept item by the merge, wave 15
 * M9): with no evidence for the merge itself, a date before the merge showed
 * the kept item holding the duplicate's stock. The merge now records, dated
 * the company's business date, one line out of the duplicate and one into the
 * kept item per location, through postInventoryMovementJournalTx (net zero:
 * evidence only, never a journal).
 */
import { toMoney } from "../../lib/money";
import type { DbTransaction } from "../../db";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import {
  postInventoryMovementJournalTx,
  type InventoryMovementLine,
} from "../accounting/perpetualInventory/inventoryMovementJournal";

export async function recordStockMergeEvidenceTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    keptId: number;
    duplicateId: number;
    rows: Array<{ locationId: number; quantity: unknown; totalValue: unknown }>;
    actor?: { userId: string; username: string } | null;
  }
): Promise<void> {
  const lines: InventoryMovementLine[] = [];
  for (const row of params.rows) {
    const value = toMoney(String(row.totalValue ?? 0)).toDecimalPlaces(2);
    const quantity = toMoney(String(row.quantity ?? 0)).toDecimalPlaces(3);
    if (value.isZero() && quantity.isZero()) continue;
    lines.push({
      stockItemId: params.duplicateId,
      locationId: row.locationId,
      valueDelta: value.negated().toFixed(2),
      quantityDelta: quantity.negated().toFixed(3),
    });
    lines.push({
      stockItemId: params.keptId,
      locationId: row.locationId,
      valueDelta: value.toFixed(2),
      quantityDelta: quantity.toFixed(3),
    });
  }
  if (lines.length === 0) return;
  await postInventoryMovementJournalTx(tx, {
    companyId: params.companyId,
    sourceType: "stock-merge",
    sourceId: `${params.duplicateId}-${params.keptId}`,
    date: await companyBusinessDate(params.companyId, tx),
    reference: `merge ${params.duplicateId} into ${params.keptId}`,
    lines,
    offsetAccountCode: "INVENTORY_ADJUSTMENT",
    narration: "Stock item merge (evidence, no value moved)",
    actor: params.actor ?? null,
  });
}
