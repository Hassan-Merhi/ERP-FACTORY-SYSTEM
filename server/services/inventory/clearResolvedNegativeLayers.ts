/**
 * Negative FIFO layers describe currently outstanding physical shortages only.
 * Once a location/item reaches zero or positive units, any remaining layer is
 * stale; it must not later settle against unrelated receipts.
 *
 * Run under the same transaction/stock row lock as the inventory movement.
 * This changes only shortage metadata: never inventory quantity, value, COGS,
 * posted vouchers, suppliers or intercompany balances.
 */
import { sql, type SQL } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";
import { logger } from "../../lib/logger";

type Executor = { execute: (query: SQL) => Promise<unknown> };

export async function clearResolvedNegativeLayers(
  tx: Executor,
  companyId: number,
  locationId: number,
  stockItemId: number,
  remainingStockQuantity: string | number
): Promise<void> {
  if (Number(remainingStockQuantity) < -0.0005) return;
  const result = await tx.execute(sql`
    DELETE FROM inventory_negative_layers
    WHERE company_id = ${companyId}
      AND location_id = ${locationId}
      AND stock_item_id = ${stockItemId}
    RETURNING id, qty
  `);
  const rows = resultRows<{ id: number; qty: string | number }>(result);
  if (!rows.length) return;
  logger.warn("[inventory] Removed stale negative-stock shortage layers for non-negative stock", {
    companyId,
    locationId,
    stockItemId,
    outstandingLayerCount: rows.length,
    removedQuantity: rows.reduce((sum, row) => sum + Number(row.qty), 0),
  });
}
