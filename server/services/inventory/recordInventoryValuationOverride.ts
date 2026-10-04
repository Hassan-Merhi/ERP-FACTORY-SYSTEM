import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";

export type InventoryValuationState = {
  quantity: string;
  averageRate: string;
  totalValue: string;
};

/**
 * Record a direct overwrite of an inventory row's valuation, inside the same
 * transaction that writes the row. See 031-inventory-valuation-overrides.ts.
 * Nothing is recorded when the valuation did not change.
 */
export async function recordInventoryValuationOverride(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId: number;
    stockItemId: number;
    inventoryId?: number | null;
    sourceType: string;
    before: InventoryValuationState;
    after: InventoryValuationState;
  }
): Promise<void> {
  const unchanged =
    Number(input.before.quantity) === Number(input.after.quantity) &&
    Number(input.before.averageRate) === Number(input.after.averageRate) &&
    Number(input.before.totalValue) === Number(input.after.totalValue);
  if (unchanged) return;

  await tx.execute(sql`
    INSERT INTO inventory_valuation_overrides (
      company_id, location_id, stock_item_id, inventory_id, source_type,
      before_quantity, before_average_rate, before_total_value,
      after_quantity, after_average_rate, after_total_value
    ) VALUES (
      ${input.companyId}, ${input.locationId}, ${input.stockItemId}, ${input.inventoryId ?? null}, ${input.sourceType},
      ${input.before.quantity}, ${input.before.averageRate}, ${input.before.totalValue},
      ${input.after.quantity}, ${input.after.averageRate}, ${input.after.totalValue}
    )
  `);
}
