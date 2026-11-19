// Extracted from ./spMigrationPhase4Inventory.ts
import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { db } from "../../db";
import { type VerificationIssue } from "./spMigrationPhase4Policy";
import { resultRows } from "../../lib/queryResult";

export type InventoryPlanEntry = {
  key: string;
  sourceInventoryId: number | null;
  targetInventoryId: number | null;
  sourceStockItemId: number | null;
  targetStockItemId: number;
  sourceLocationId: number | null;
  targetLocationId: number;
  beforeQuantity: number;
  beforeAverageRate: number;
  beforeTotalValue: number;
  afterQuantity: number;
  afterAverageRate: number;
  afterTotalValue: number;
  createdTargetInventory: boolean;
  targetOnly: boolean;
  changed: boolean;
};

export type InventoryPlan = {
  entries: InventoryPlanEntry[];
  blockers: VerificationIssue[];
  sourceRows: number;
  targetRowsInScope: number;
  changedRows: number;
  targetOnlyRows: number;
};

export async function loadTargetInventoryRows(targetId: number, targetItemIds: number[]) {
  if (targetItemIds.length === 0) return [];
  const result = await db.execute(sql`
    SELECT id, stock_item_id, location_id, quantity, average_rate, total_value
    FROM inventory
    WHERE company_id = ${targetId}
      AND stock_item_id = ANY(${sqlArray(targetItemIds)})
    ORDER BY id ASC
  `);
  return resultRows(result);
}

export async function snapshotDelta(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  cutoverId: number,
  entry: InventoryPlanEntry
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO sp_migration_cutover_stock_deltas
      (cutover_id, delta_key, source_inventory_id, target_inventory_id,
       source_stock_item_id, target_stock_item_id, source_location_id, target_location_id,
       before_quantity, before_average_rate, before_total_value,
       after_quantity, after_average_rate, after_total_value, created_target_inventory)
    VALUES
      (${cutoverId}, ${entry.key}, ${entry.sourceInventoryId}, ${entry.targetInventoryId},
       ${entry.sourceStockItemId}, ${entry.targetStockItemId}, ${entry.sourceLocationId}, ${entry.targetLocationId},
       ${entry.beforeQuantity.toFixed(4)}, ${entry.beforeAverageRate.toFixed(6)}, ${entry.beforeTotalValue.toFixed(2)},
       ${entry.afterQuantity.toFixed(4)}, ${entry.afterAverageRate.toFixed(6)}, ${entry.afterTotalValue.toFixed(2)},
       ${entry.createdTargetInventory})
    ON CONFLICT (cutover_id, delta_key) WHERE delta_key IS NOT NULL DO NOTHING
  `);
}
