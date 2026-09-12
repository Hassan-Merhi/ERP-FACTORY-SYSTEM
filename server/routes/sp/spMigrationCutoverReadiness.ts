import { sql } from "drizzle-orm";
import { db } from "../../db";
import { ensurePhase2Schema, getSuspenseReview, loadStockItemMap, pn } from "./spMigrationPhase2Common";
import { ensureCutoverSchema } from "./spMigrationCutoverState";
import { resultRows, firstRow } from "../../lib/queryResult";

const REQUIRED_SP_SUBTYPES = [
  "sp_goods_otw",
  "sp_otw_clearing",
  "sp_prepaid",
  "sp_stock",
  "sp_cost_clearing",
  "sp_pay_deduction_clearing",
  "sp_payable",
  "sp_sales",
  "sp_cogs",
  "sp_shared_charges",
  "sp_opnbal",
  "sp_prepaid_expenses",
  "sp_hadi_intercompany",
  "gc_our_profit_share",
  "gc_supplier_profit_share",
  "gc_accumulated_profit_clearing",
];

export type LocationMapRow = {
  sourceLocationId: number | null;
  targetLocationId: number;
  sourceCode: string | null;
  sourceName: string | null;
  method: string;
};

export async function resolveTargetLocation(
  sourceId: number,
  targetId: number,
  sourceLocationId: number | null
): Promise<LocationMapRow | null> {
  if (!sourceLocationId) {
    const unassigned = await db.execute(sql`
      SELECT id FROM locations
      WHERE company_id = ${targetId} AND code = 'UNASSIGNED' AND deleted_at IS NULL
      LIMIT 1
    `);
    const row = firstRow(unassigned);
    return row
      ? {
          sourceLocationId: null,
          targetLocationId: pn(row.id),
          sourceCode: null,
          sourceName: "Unassigned",
          method: "unassigned",
        }
      : null;
  }

  const sourceResult = await db.execute(sql`
    SELECT id, code, name
    FROM locations
    WHERE id = ${sourceLocationId} AND company_id = ${sourceId} AND deleted_at IS NULL
    LIMIT 1
  `);
  const source = firstRow<{ code: string | null; name: string | null }>(sourceResult);
  if (!source) return null;

  if (source.code) {
    const byCode = await db.execute(sql`
      SELECT id FROM locations
      WHERE company_id = ${targetId} AND code = ${source.code} AND deleted_at IS NULL
      LIMIT 1
    `);
    if (firstRow(byCode)) {
      return {
        sourceLocationId,
        targetLocationId: pn(firstRow(byCode)?.id),
        sourceCode: source.code,
        sourceName: source.name,
        method: "code",
      };
    }
  }

  const byName = await db.execute(sql`
    SELECT id FROM locations
    WHERE company_id = ${targetId} AND lower(name) = lower(${source.name}) AND deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 2
  `);
  const rows = resultRows(byName);
  if (rows.length === 1) {
    return {
      sourceLocationId,
      targetLocationId: pn(rows[0].id),
      sourceCode: source.code,
      sourceName: source.name,
      method: "name",
    };
  }
  return null;
}

export async function resolveTargetLedgerAccount(
  sourceAccountId: number | null,
  targetId: number
): Promise<number | null> {
  if (!sourceAccountId) return null;
  const sourceResult = await db.execute(sql`
    SELECT code, name, account_type, sub_type
    FROM ledger_accounts
    WHERE id = ${sourceAccountId} AND deleted_at IS NULL
    LIMIT 1
  `);
  const source = firstRow<{
    code: string | null;
    name: string | null;
    account_type: string | null;
    sub_type: string | null;
  }>(sourceResult);
  if (!source) return null;

  if (source.sub_type) {
    const bySubtype = await db.execute(sql`
      SELECT id FROM ledger_accounts
      WHERE company_id = ${targetId} AND sub_type = ${source.sub_type} AND deleted_at IS NULL
      LIMIT 1
    `);
    if (firstRow(bySubtype)) return pn(resultRows(bySubtype)[0].id);
  }
  if (source.code) {
    const byCode = await db.execute(sql`
      SELECT id FROM ledger_accounts
      WHERE company_id = ${targetId} AND lower(code) = lower(${source.code}) AND deleted_at IS NULL
      LIMIT 1
    `);
    if (firstRow(byCode)) return pn(resultRows(byCode)[0].id);
  }
  const byName = await db.execute(sql`
    SELECT id FROM ledger_accounts
    WHERE company_id = ${targetId}
      AND lower(name) = lower(${source.name})
      AND account_type = ${source.account_type}
      AND deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 2
  `);
  const rows = resultRows(byName);
  return rows.length === 1 ? pn(rows[0].id) : null;
}

async function getCompletedActions(sourceId: number, targetId: number): Promise<Set<string>> {
  const result = await db.execute(sql`
    SELECT DISTINCT action
    FROM sp_migration_rehearsal_runs
    WHERE source_company_id = ${sourceId}
      AND target_company_id = ${targetId}
      AND status = 'completed'
  `);
  return new Set(resultRows(result).map((row) => String(row.action)));
}

export type CutoverReadinessStockDiff = {
  sourceInventoryId: number;
  targetInventoryId: number | null;
  sourceStockItemId: number;
  targetStockItemId: number;
  sourceLocationId: number | null;
  targetLocationId: number;
  sourceQty: number;
  targetQty: number;
  sourceRate: number;
  targetRate: number;
};

export type CutoverReadinessUnmappedInventory = {
  sourceInventoryId: number;
  sourceStockItemId: number;
  sourceLocationId: number | null;
  missing: string;
};

export type CutoverReadiness = {
  sourceCompanyId: number;
  targetCompanyId: number;
  canPrepare: boolean;
  canFinalize: boolean;
  blockers: Array<{ code: string; message: string; count?: number; detail?: unknown }>;
  deltas: Array<{ code: string; message: string; count: number }>;
  counts: {
    sourceInventoryRows: number;
    stockDiffs: number;
    unmappedInventory: number;
    salesDelta: number;
    containerDelta: number;
    suspenseEntries: number;
    chargeReview: number;
    chargeUnmapped: number;
    unbalancedVouchers: number;
    targetLiveActivity: number;
    unmappablePosUsers: number;
  };
  stockDiffs: CutoverReadinessStockDiff[];
  unmappedInventory: CutoverReadinessUnmappedInventory[];
};

export async function buildCutoverReadiness(
  sourceId: number,
  targetId: number
): Promise<CutoverReadiness> {
  await Promise.all([ensurePhase2Schema(), ensureCutoverSchema()]);
  const blockers: Array<{ code: string; message: string; count?: number }> = [];
  const deltas: Array<{ code: string; message: string; count: number }> = [];

  const completed = await getCompletedActions(sourceId, targetId);
  for (const action of ["gc_stock_master", "gc_stock_opening", "gc_sales_readonly", "gc_containers"]) {
    if (!completed.has(action)) {
      blockers.push({
        code: `MISSING_${action.toUpperCase()}`,
        message: `Required migration action ${action} is not complete.`,
      });
    }
  }

  const missingAccountsResult = await db.execute(sql`
    SELECT required.sub_type
    FROM unnest(${REQUIRED_SP_SUBTYPES}::text[]) AS required(sub_type)
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger_accounts a
      WHERE a.company_id = ${targetId}
        AND a.sub_type = required.sub_type
        AND a.deleted_at IS NULL
    )
  `);
  const missingAccounts = resultRows(missingAccountsResult);
  if (missingAccounts.length) {
    blockers.push({
      code: "MISSING_TARGET_ACCOUNTS",
      message: `Target is missing required accounts: ${missingAccounts.map((row) => row.sub_type).join(", ")}.`,
      count: missingAccounts.length,
    });
  }

  const stockItemMap = await loadStockItemMap(sourceId, targetId);
  const sourceInventoryResult = await db.execute(sql`
    SELECT id, stock_item_id, location_id, quantity, average_rate, total_value
    FROM inventory
    WHERE company_id = ${sourceId}
    ORDER BY id ASC
  `);
  const sourceInventory = resultRows(sourceInventoryResult);
  const stockDiffs = [];
  const unmappedInventory = [];

  for (const sourceRow of sourceInventory) {
    const targetStockItemId = stockItemMap.get(pn(sourceRow.stock_item_id));
    const locationMap = await resolveTargetLocation(
      sourceId,
      targetId,
      sourceRow.location_id ? pn(sourceRow.location_id) : null
    );
    if (!targetStockItemId || !locationMap) {
      unmappedInventory.push({
        sourceInventoryId: pn(sourceRow.id),
        sourceStockItemId: pn(sourceRow.stock_item_id),
        sourceLocationId: sourceRow.location_id ? pn(sourceRow.location_id) : null,
        missing: !targetStockItemId ? "stock_item" : "location",
      });
      continue;
    }

    const targetResult = await db.execute(sql`
      SELECT id, quantity, average_rate, total_value
      FROM inventory
      WHERE company_id = ${targetId}
        AND stock_item_id = ${targetStockItemId}
        AND location_id = ${locationMap.targetLocationId}
      LIMIT 1
    `);
    const targetRow = firstRow(targetResult);
    const sourceQty = pn(sourceRow.quantity);
    const sourceRate = pn(sourceRow.average_rate);
    const targetQty = pn(targetRow?.quantity);
    const targetRate = pn(targetRow?.average_rate);
    if (Math.abs(sourceQty - targetQty) > 0.0001 || Math.abs(sourceRate - targetRate) > 0.0001) {
      stockDiffs.push({
        sourceInventoryId: pn(sourceRow.id),
        targetInventoryId: targetRow ? pn(targetRow.id) : null,
        sourceStockItemId: pn(sourceRow.stock_item_id),
        targetStockItemId,
        sourceLocationId: sourceRow.location_id ? pn(sourceRow.location_id) : null,
        targetLocationId: locationMap.targetLocationId,
        sourceQty,
        targetQty,
        sourceRate,
        targetRate,
      });
    }
  }

  if (unmappedInventory.length) {
    blockers.push({
      code: "UNMAPPED_INVENTORY",
      message: `${unmappedInventory.length} source inventory row(s) have no safe target stock-item/location mapping.`,
      count: unmappedInventory.length,
    });
  }
  if (stockDiffs.length) {
    deltas.push({
      code: "STOCK_DELTA",
      message: `${stockDiffs.length} inventory row(s) require final quantity/rate synchronization.`,
      count: stockDiffs.length,
    });
  }

  const salesDeltaResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM vouchers v
    WHERE v.company_id = ${sourceId}
      AND v.voucher_type IN ('Sales', 'Sale')
      AND v.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sp_migration_source_links l
        JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
        WHERE r.source_company_id = ${sourceId}
          AND r.target_company_id = ${targetId}
          AND r.status <> 'rolled_back'
          AND l.source_table = 'vouchers'
          AND l.source_id = v.id
          AND l.target_table = 'vouchers'
      )
      AND NOT EXISTS (
        SELECT 1 FROM vouchers tv
        WHERE tv.company_id = ${targetId}
          AND tv.voucher_number = LEFT('MIG-GC-' || v.voucher_number, 100)
      )
  `);
  const salesDeltaCount = pn(firstRow(salesDeltaResult)?.count);
  if (salesDeltaCount) {
    deltas.push({
      code: "SALES_DELTA",
      message: `${salesDeltaCount} sale voucher(s) require final migration.`,
      count: salesDeltaCount,
    });
  }

  const containerDeltaResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM containers c
    WHERE c.company_id = ${sourceId}
      AND NOT EXISTS (
        SELECT 1
        FROM sp_migration_source_links l
        JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
        WHERE r.source_company_id = ${sourceId}
          AND r.target_company_id = ${targetId}
          AND r.status <> 'rolled_back'
          AND l.source_table = 'containers'
          AND l.source_id = c.id
          AND l.target_table = 'sp_containers'
      )
  `);
  const containerDeltaCount = pn(firstRow(containerDeltaResult)?.count);
  if (containerDeltaCount) {
    deltas.push({
      code: "CONTAINER_DELTA",
      message: `${containerDeltaCount} container(s) require final migration.`,
      count: containerDeltaCount,
    });
  }

  const suspenseReview = await getSuspenseReview(sourceId, targetId);
  if (suspenseReview.count > 0) {
    blockers.push({
      code: "SUSPENSE_REVIEW_REQUIRED",
      message: `${suspenseReview.count} migrated accounting entry row(s) remain in Migration Suspense.`,
      count: suspenseReview.count,
    });
  }

  const chargeReviewResult = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE m.review_status = 'review')::int AS review_count,
      COUNT(*) FILTER (WHERE m.review_status = 'unmapped')::int AS unmapped_count
    FROM sp_migration_container_charges m
    JOIN sp_migration_rehearsal_runs r ON r.id = m.run_id
    WHERE m.source_company_id = ${sourceId}
      AND m.target_company_id = ${targetId}
      AND r.status <> 'rolled_back'
  `);
  const chargeReview = pn(firstRow(chargeReviewResult)?.review_count);
  const chargeUnmapped = pn(firstRow(chargeReviewResult)?.unmapped_count);
  if (chargeReview || chargeUnmapped) {
    blockers.push({
      code: "CONTAINER_CHARGE_REVIEW_REQUIRED",
      message: `${chargeReview} charge mapping(s) need approval and ${chargeUnmapped} remain unmapped.`,
      count: chargeReview + chargeUnmapped,
    });
  }

  const unbalancedResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT v.id
      FROM vouchers v
      JOIN voucher_entries e ON e.voucher_id = v.id
      WHERE v.company_id = ${targetId}
        AND v.source_module IN ('SP_MIGRATION', 'SP_MIGRATION_READONLY')
        AND v.deleted_at IS NULL
      GROUP BY v.id
      HAVING ABS(SUM(e.debit_amount::numeric) - SUM(e.credit_amount::numeric)) > 0.01
    ) unbalanced
  `);
  const unbalancedCount = pn(firstRow(unbalancedResult)?.count);
  if (unbalancedCount) {
    blockers.push({
      code: "UNBALANCED_MIGRATION_VOUCHERS",
      message: `${unbalancedCount} migrated voucher(s) are unbalanced.`,
      count: unbalancedCount,
    });
  }

  const profitOpeningResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM vouchers
    WHERE company_id = ${targetId}
      AND voucher_number LIKE 'GC-PROFIT-OPN-%'
      AND deleted_at IS NULL
  `);
  const profitOpeningCount = pn(firstRow(profitOpeningResult)?.count);
  if (!profitOpeningCount) {
    blockers.push({ code: "PROFIT_OPENING_MISSING", message: "Profit-share opening balance has not been posted." });
  }

  const targetLiveActivityResult = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM vouchers
       WHERE company_id = ${targetId}
         AND deleted_at IS NULL
         AND COALESCE(source_module, 'ERP') NOT IN ('SP_MIGRATION', 'SP_MIGRATION_READONLY'))::int AS voucher_count,
      (SELECT COUNT(*) FROM sp_sales WHERE company_id = ${targetId})::int AS sale_count,
      (SELECT COUNT(*) FROM sp_offloads WHERE company_id = ${targetId})::int AS offload_count
  `);
  const targetLive = firstRow(targetLiveActivityResult) ?? {};
  const targetLiveCount = pn(targetLive.voucher_count) + pn(targetLive.sale_count) + pn(targetLive.offload_count);
  if (targetLiveCount) {
    blockers.push({
      code: "TARGET_ALREADY_LIVE",
      message: `Target contains ${targetLiveCount} non-migration live transaction(s). Cutover cannot overwrite an active company.`,
      count: targetLiveCount,
    });
  }

  const posRoleResult = await db.execute(sql`
    SELECT id, user_id, assigned_location_id, cash_account_id
    FROM user_company_roles
    WHERE company_id = ${sourceId} AND role = 'POS'
  `);
  const unmappablePosUsers: string[] = [];
  for (const role of resultRows(posRoleResult)) {
    const location = await resolveTargetLocation(
      sourceId,
      targetId,
      role.assigned_location_id ? pn(role.assigned_location_id) : null
    );
    const cashAccount = await resolveTargetLedgerAccount(
      role.cash_account_id ? pn(role.cash_account_id) : null,
      targetId
    );
    if (!location || !cashAccount) unmappablePosUsers.push(String(role.user_id));
  }
  if (unmappablePosUsers.length) {
    blockers.push({
      code: "POS_ASSIGNMENT_MAPPING_MISSING",
      message: `${unmappablePosUsers.length} POS user(s) have no safe target location/cash-account mapping.`,
      count: unmappablePosUsers.length,
    });
  }

  return {
    sourceCompanyId: sourceId,
    targetCompanyId: targetId,
    canPrepare: blockers.length === 0,
    canFinalize: blockers.length === 0 && deltas.length === 0,
    blockers,
    deltas,
    counts: {
      sourceInventoryRows: sourceInventory.length,
      stockDiffs: stockDiffs.length,
      unmappedInventory: unmappedInventory.length,
      salesDelta: salesDeltaCount,
      containerDelta: containerDeltaCount,
      suspenseEntries: suspenseReview.count,
      chargeReview,
      chargeUnmapped,
      unbalancedVouchers: unbalancedCount,
      targetLiveActivity: targetLiveCount,
      unmappablePosUsers: unmappablePosUsers.length,
    },
    stockDiffs: stockDiffs.slice(0, 200),
    unmappedInventory: unmappedInventory.slice(0, 200),
  };
}

export async function synchronizeCutoverStock(
  cutoverId: number,
  sourceId: number,
  targetId: number
): Promise<{ updated: number; inserted: number; unchanged: number }> {
  await ensureCutoverSchema();
  const stockItemMap = await loadStockItemMap(sourceId, targetId);
  const sourceResult = await db.execute(sql`
    SELECT id, stock_item_id, location_id, quantity, average_rate, total_value
    FROM inventory
    WHERE company_id = ${sourceId}
    ORDER BY id ASC
  `);

  let updated = 0;
  let inserted = 0;
  let unchanged = 0;
  const errors: string[] = [];

  await db.transaction(async (tx) => {
    for (const sourceRow of resultRows(sourceResult)) {
      const targetStockItemId = stockItemMap.get(pn(sourceRow.stock_item_id));
      const location = await resolveTargetLocation(
        sourceId,
        targetId,
        sourceRow.location_id ? pn(sourceRow.location_id) : null
      );
      if (!targetStockItemId || !location) {
        errors.push(`Inventory ${sourceRow.id}: missing target stock item or location.`);
        continue;
      }

      const targetRows = await tx.execute(sql`
        SELECT id, quantity, average_rate, total_value
        FROM inventory
        WHERE company_id = ${targetId}
          AND stock_item_id = ${targetStockItemId}
          AND location_id = ${location.targetLocationId}
        LIMIT 1
      `);
      let target = firstRow(targetRows) ?? null;
      const beforeQty = pn(target?.quantity);
      const beforeRate = pn(target?.average_rate);
      const beforeValue = pn(target?.total_value);
      const afterQty = pn(sourceRow.quantity);
      const afterRate = pn(sourceRow.average_rate);
      const afterValue = Math.round(afterQty * afterRate * 100) / 100;
      const changed =
        Math.abs(beforeQty - afterQty) > 0.0001 ||
        Math.abs(beforeRate - afterRate) > 0.0001 ||
        Math.abs(beforeValue - afterValue) > 0.01;
      if (!changed) {
        unchanged++;
        continue;
      }

      let createdTargetInventory = false;
      if (!target) {
        const insertedRow = await tx.execute(sql`
          INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
          VALUES (${targetId}, ${location.targetLocationId}, ${targetStockItemId},
                  ${afterQty.toFixed(4)}, ${afterRate.toFixed(6)}, ${afterValue.toFixed(2)})
          RETURNING id
        `);
        target = { id: pn(resultRows(insertedRow)[0].id) };
        createdTargetInventory = true;
        inserted++;
      } else {
        await tx.execute(sql`
          UPDATE inventory
          SET quantity = ${afterQty.toFixed(4)},
              average_rate = ${afterRate.toFixed(6)},
              total_value = ${afterValue.toFixed(2)}
          WHERE id = ${pn(target.id)} AND company_id = ${targetId}
        `);
        updated++;
      }

      await tx.execute(sql`
        INSERT INTO sp_migration_cutover_stock_deltas
          (cutover_id, source_inventory_id, target_inventory_id,
           source_stock_item_id, target_stock_item_id, source_location_id, target_location_id,
           before_quantity, before_average_rate, before_total_value,
           after_quantity, after_average_rate, after_total_value, created_target_inventory)
        VALUES
          (${cutoverId}, ${pn(sourceRow.id)}, ${pn(target.id)}, ${pn(sourceRow.stock_item_id)}, ${targetStockItemId},
           ${sourceRow.location_id ? pn(sourceRow.location_id) : null}, ${location.targetLocationId},
           ${beforeQty.toFixed(4)}, ${beforeRate.toFixed(6)}, ${beforeValue.toFixed(2)},
           ${afterQty.toFixed(4)}, ${afterRate.toFixed(6)}, ${afterValue.toFixed(2)}, ${createdTargetInventory})
        ON CONFLICT (cutover_id, source_inventory_id) DO NOTHING
      `);
    }
  });

  if (errors.length) throw new Error(errors.slice(0, 10).join(" "));
  return { updated, inserted, unchanged };
}

export async function restoreCutoverStock(
  cutoverId: number,
  targetId: number
): Promise<{ restored: number; deleted: number }> {
  await ensureCutoverSchema();
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
      } else {
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
