import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { db } from "../../db";
import { assertNoInventoryCutoverTx } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { loadStockItemMap, pn } from "./spMigrationPhase2Common";
import { resolveTargetLocation } from "./spMigrationCutoverReadiness";
import { ensureCutoverSchema } from "./spMigrationCutoverState";
import { exactInventoryValue, numbersDiffer, type VerificationIssue } from "./spMigrationPhase4Policy";
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

let phase4SchemaPromise: Promise<void> | null = null;

export function ensurePhase4CutoverSchema(): Promise<void> {
  if (!phase4SchemaPromise) {
    phase4SchemaPromise = (async () => {
      await ensureCutoverSchema();
      await db.execute(
        sql.raw(`
        ALTER TABLE sp_migration_cutovers
          ADD COLUMN IF NOT EXISTS target_write_hold BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS verification_snapshot JSONB,
          ADD COLUMN IF NOT EXISTS recovery_summary JSONB
      `)
      );
      await db.execute(
        sql.raw(`
        ALTER TABLE sp_migration_cutover_stock_deltas
          ALTER COLUMN source_inventory_id DROP NOT NULL,
          ALTER COLUMN source_stock_item_id DROP NOT NULL,
          ADD COLUMN IF NOT EXISTS delta_key TEXT,
          ADD COLUMN IF NOT EXISTS created_target_inventory BOOLEAN NOT NULL DEFAULT false
      `)
      );
      await db.execute(
        sql.raw(`
        UPDATE sp_migration_cutover_stock_deltas
        SET delta_key = COALESCE(delta_key, 'source:' || source_inventory_id::text)
        WHERE delta_key IS NULL
      `)
      );
      await db.execute(
        sql.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS sp_migration_cutover_stock_delta_key_unique
        ON sp_migration_cutover_stock_deltas(cutover_id, delta_key)
        WHERE delta_key IS NOT NULL
      `)
      );
      await db.execute(
        sql.raw(`
        ALTER TABLE sp_migration_cutover_role_changes
          ADD COLUMN IF NOT EXISTS source_locations_snapshot JSONB,
          ADD COLUMN IF NOT EXISTS source_cash_mappings_snapshot JSONB,
          ADD COLUMN IF NOT EXISTS target_locations_snapshot_before JSONB,
          ADD COLUMN IF NOT EXISTS target_cash_mappings_snapshot_before JSONB
      `)
      );
    })().catch((error) => {
      phase4SchemaPromise = null;
      throw error;
    });
  }
  return phase4SchemaPromise;
}

async function loadTargetInventoryRows(targetId: number, targetItemIds: number[]) {
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

export async function buildExactInventoryPlan(sourceId: number, targetId: number): Promise<InventoryPlan> {
  await ensurePhase4CutoverSchema();
  const stockItemMap = await loadStockItemMap(sourceId, targetId);
  const sourceResult = await db.execute(sql`
    SELECT id, stock_item_id, location_id, quantity, average_rate, total_value
    FROM inventory
    WHERE company_id = ${sourceId}
    ORDER BY id ASC
  `);
  const sourceRows = resultRows(sourceResult);
  const blockers: VerificationIssue[] = [];
  const targetLocationBySource = new Map<number | null, number>();
  const sourceLocationsByTarget = new Map<number, Array<number | null>>();

  for (const sourceRow of sourceRows) {
    const sourceLocationId = sourceRow.location_id ? pn(sourceRow.location_id) : null;
    if (!targetLocationBySource.has(sourceLocationId)) {
      const location = await resolveTargetLocation(sourceId, targetId, sourceLocationId);
      if (!location) {
        blockers.push({
          code: "UNMAPPED_INVENTORY_LOCATION",
          message: `Source location ${sourceLocationId ?? "UNASSIGNED"} has no safe target mapping.`,
          detail: { sourceLocationId },
        });
        continue;
      }
      targetLocationBySource.set(sourceLocationId, location.targetLocationId);
      sourceLocationsByTarget.set(location.targetLocationId, [
        ...(sourceLocationsByTarget.get(location.targetLocationId) ?? []),
        sourceLocationId,
      ]);
    }
  }

  for (const [targetLocationId, sourceLocationIds] of sourceLocationsByTarget.entries()) {
    const unique = Array.from(new Set(sourceLocationIds.map((value) => value ?? -1)));
    if (unique.length > 1) {
      blockers.push({
        code: "INVENTORY_LOCATION_COLLISION",
        message: `Multiple source locations map to target location ${targetLocationId}; exact stock synchronization would merge locations.`,
        count: unique.length,
        detail: { targetLocationId, sourceLocationIds },
      });
    }
  }

  const plannedByTargetKey = new Map<string, InventoryPlanEntry>();
  for (const sourceRow of sourceRows) {
    const sourceStockItemId = pn(sourceRow.stock_item_id);
    const targetStockItemId = stockItemMap.get(sourceStockItemId);
    const sourceLocationId = sourceRow.location_id ? pn(sourceRow.location_id) : null;
    const targetLocationId = targetLocationBySource.get(sourceLocationId);
    if (!targetStockItemId) {
      blockers.push({
        code: "UNMAPPED_INVENTORY_ITEM",
        message: `Source inventory ${sourceRow.id} has no target stock-item mapping.`,
        detail: { sourceInventoryId: pn(sourceRow.id), sourceStockItemId },
      });
      continue;
    }
    if (!targetLocationId) continue;

    const targetKey = `${targetStockItemId}:${targetLocationId}`;
    if (plannedByTargetKey.has(targetKey)) {
      blockers.push({
        code: "INVENTORY_TARGET_KEY_COLLISION",
        message: `More than one source inventory row maps to target stock item ${targetStockItemId}, location ${targetLocationId}.`,
        detail: {
          targetStockItemId,
          targetLocationId,
          sourceInventoryIds: [plannedByTargetKey.get(targetKey)?.sourceInventoryId, pn(sourceRow.id)],
        },
      });
      continue;
    }

    plannedByTargetKey.set(targetKey, {
      key: `source:${pn(sourceRow.id)}`,
      sourceInventoryId: pn(sourceRow.id),
      targetInventoryId: null,
      sourceStockItemId,
      targetStockItemId,
      sourceLocationId,
      targetLocationId,
      beforeQuantity: 0,
      beforeAverageRate: 0,
      beforeTotalValue: 0,
      afterQuantity: pn(sourceRow.quantity),
      afterAverageRate: pn(sourceRow.average_rate),
      afterTotalValue: exactInventoryValue(sourceRow.quantity, sourceRow.average_rate, sourceRow.total_value),
      createdTargetInventory: false,
      targetOnly: false,
      changed: false,
    });
  }

  const targetRows = await loadTargetInventoryRows(targetId, Array.from(new Set(Array.from(stockItemMap.values()))));
  const targetByKey = new Map();
  for (const targetRow of targetRows) {
    const key = `${pn(targetRow.stock_item_id)}:${pn(targetRow.location_id)}`;
    if (targetByKey.has(key)) {
      blockers.push({
        code: "DUPLICATE_TARGET_INVENTORY",
        message: `Target contains duplicate inventory rows for stock item ${targetRow.stock_item_id}, location ${targetRow.location_id}.`,
        detail: { targetKey: key },
      });
      continue;
    }
    targetByKey.set(key, targetRow);
  }

  const entries: InventoryPlanEntry[] = [];
  for (const [targetKey, entry] of plannedByTargetKey.entries()) {
    const target = targetByKey.get(targetKey);
    entry.targetInventoryId = target ? pn(target.id) : null;
    entry.beforeQuantity = pn(target?.quantity);
    entry.beforeAverageRate = pn(target?.average_rate);
    entry.beforeTotalValue = exactInventoryValue(target?.quantity, target?.average_rate, target?.total_value);
    entry.createdTargetInventory = !target;
    entry.changed =
      !target ||
      numbersDiffer(entry.beforeQuantity, entry.afterQuantity, 0.0001) ||
      numbersDiffer(entry.beforeAverageRate, entry.afterAverageRate, 0.000001) ||
      numbersDiffer(entry.beforeTotalValue, entry.afterTotalValue, 0.01);
    entries.push(entry);
  }

  for (const [targetKey, target] of targetByKey.entries()) {
    if (plannedByTargetKey.has(targetKey)) continue;
    const beforeQuantity = pn(target.quantity);
    const beforeAverageRate = pn(target.average_rate);
    const beforeTotalValue = exactInventoryValue(target.quantity, target.average_rate, target.total_value);
    entries.push({
      key: `target-only:${pn(target.id)}`,
      sourceInventoryId: null,
      targetInventoryId: pn(target.id),
      sourceStockItemId: null,
      targetStockItemId: pn(target.stock_item_id),
      sourceLocationId: null,
      targetLocationId: pn(target.location_id),
      beforeQuantity,
      beforeAverageRate,
      beforeTotalValue,
      afterQuantity: 0,
      afterAverageRate: 0,
      afterTotalValue: 0,
      createdTargetInventory: false,
      targetOnly: true,
      changed: numbersDiffer(beforeQuantity, 0, 0.0001) || numbersDiffer(beforeTotalValue, 0, 0.01),
    });
  }

  return {
    entries,
    blockers,
    sourceRows: sourceRows.length,
    targetRowsInScope: targetRows.length,
    changedRows: entries.filter((entry) => entry.changed).length,
    targetOnlyRows: entries.filter((entry) => entry.targetOnly && entry.changed).length,
  };
}

async function snapshotDelta(
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

export async function synchronizeExactCutoverStock(cutoverId: number, sourceId: number, targetId: number) {
  // Wave 11: stock rewrites with no journal are refused after the cut-over.
  await assertNoInventoryCutoverTx(db, targetId, "sp-migration-stock");
  const plan = await buildExactInventoryPlan(sourceId, targetId);
  if (plan.blockers.length > 0) {
    throw new Error(
      plan.blockers
        .map((blocker) => blocker.message)
        .slice(0, 10)
        .join(" ")
    );
  }

  let updated = 0;
  let inserted = 0;
  let zeroed = 0;
  let unchanged = 0;

  await db.transaction(async (tx) => {
    for (const originalEntry of plan.entries) {
      if (!originalEntry.changed) {
        unchanged++;
        continue;
      }
      const entry = { ...originalEntry };
      if (!entry.targetInventoryId) {
        const insertedResult = await tx.execute(sql`
          INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
          VALUES (${targetId}, ${entry.targetLocationId}, ${entry.targetStockItemId},
                  ${entry.afterQuantity.toFixed(4)}, ${entry.afterAverageRate.toFixed(6)}, ${entry.afterTotalValue.toFixed(2)})
          RETURNING id
        `);
        entry.targetInventoryId = pn(resultRows(insertedResult)[0].id);
        entry.createdTargetInventory = true;
        await snapshotDelta(tx, cutoverId, entry);
        inserted++;
        continue;
      }

      await snapshotDelta(tx, cutoverId, entry);
      await tx.execute(sql`
        UPDATE inventory
        SET quantity = ${entry.afterQuantity.toFixed(4)},
            average_rate = ${entry.afterAverageRate.toFixed(6)},
            total_value = ${entry.afterTotalValue.toFixed(2)}
        WHERE id = ${entry.targetInventoryId} AND company_id = ${targetId}
      `);
      if (entry.targetOnly) zeroed++;
      else updated++;
    }
  });

  return { updated, inserted, zeroed, unchanged, plan };
}

export async function restoreExactCutoverStock(
  cutoverId: number,
  targetId: number
): Promise<{ restored: number; deleted: number }> {
  // Wave 11: stock rewrites with no journal are refused after the cut-over.
  await assertNoInventoryCutoverTx(db, targetId, "sp-migration-stock");
  await ensurePhase4CutoverSchema();
  const result = await db.execute(sql`
    SELECT * FROM sp_migration_cutover_stock_deltas
    WHERE cutover_id = ${cutoverId}
    ORDER BY id DESC
  `);
  let restored = 0;
  let deleted = 0;
  await db.transaction(async (tx) => {
    for (const row of resultRows(result)) {
      if (row.created_target_inventory) {
        await tx.execute(
          sql`DELETE FROM inventory WHERE id = ${pn(row.target_inventory_id)} AND company_id = ${targetId}`
        );
        deleted++;
      } else if (row.target_inventory_id) {
        await tx.execute(sql`
          UPDATE inventory
          SET quantity = ${row.before_quantity},
              average_rate = ${row.before_average_rate},
              total_value = ${row.before_total_value}
          WHERE id = ${pn(row.target_inventory_id)} AND company_id = ${targetId}
        `);
        restored++;
      }
    }
  });
  return { restored, deleted };
}
