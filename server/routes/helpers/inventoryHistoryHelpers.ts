import { type DatabaseOrTransaction } from "../../db";
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { toMoney } from "../../lib/money";
export type { HistoricalLocationInventoryRow } from "./inventoryHistoryHelpersExactMovementValue";
export { calculateHistoricalLocationInventory } from "./calculateHistoricalLocationInventory";

/**
 * Evidenced movements after `asOfDate` that name no stock item (a transfer's
 * settlement residual, a reversal difference, a container's pre-cut-over
 * offload movement): the signed value they changed, by location (null when the
 * line names none). The as-of company valuation reverses them from the
 * sub-ledger total; they cannot be placed on an item row.
 */
export async function unitemizedInventoryMovementsAfter(
  executor: DatabaseOrTransaction,
  companyId: number,
  asOfDate: string
): Promise<Map<number | null, Decimal>> {
  const result = await executor.execute(sql`
    SELECT location_id, SUM(value_delta)::text AS value
      FROM inventory_value_movements
     WHERE company_id = ${companyId} AND stock_item_id IS NULL AND movement_date > ${asOfDate}::date
     GROUP BY location_id
  `);
  const byLocation = new Map<number | null, Decimal>();
  for (const row of result.rows as unknown as { location_id: number | null; value: string }[]) {
    byLocation.set(row.location_id === null ? null : Number(row.location_id), toMoney(row.value));
  }
  return byLocation;
}
