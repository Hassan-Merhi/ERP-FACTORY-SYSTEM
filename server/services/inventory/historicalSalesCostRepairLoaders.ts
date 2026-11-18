/** Database reads that feed the historical sales-cost repair dry run. */
import type { PoolClient } from "pg";

import { repairQuantity } from "./historicalSalesCostRepairEngine";
import { AuditInventoryRow, LegacyRow, RepairCheck, d } from "./historicalSalesCostRepairTypes";
export {
  assertSalesCostTargetsInOpenPeriods,
  companyIdsForRun,
  disableMaintenanceScope,
  enableMaintenanceScope,
  enableRunCompanyScope,
  loadCanonicalMovements,
  loadCanonicalStart,
  loadHistoricalMerges,
  loadOffloadValueEvidence,
  loadSales,
  loadStockItems,
  loadValuationCheckpoint,
  loadValuationOverrides,
} from "./historicalSalesCostRepairLoadersLoadCanonicalMovements";
export { loadLegacyMovements } from "./historicalSalesCostRepairLoadersLoadLegacyMovements";

export async function loadLegacyManualAdjustments(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<{ movements: LegacyRow[]; checks: RepairCheck[] }> {
  const rows = await client.query<AuditInventoryRow>(
    `SELECT id,record_id AS stock_item_id,
            changes->'location'->>'new' AS location_name,
            changes->'quantity'->>'old' AS old_quantity,
            changes->'quantity'->>'new' AS new_quantity,
            created_at
       FROM audit_log
      WHERE company_id=$1
        AND table_name='inventory'
        AND action='update'
        AND changes ? 'adjustmentType'
        AND changes ? 'quantity'
        AND created_at <= $2
      ORDER BY created_at,id`,
    [companyId, sourceCutoff]
  );

  const movements: LegacyRow[] = [];
  const checks: RepairCheck[] = [];
  const locationRows = await client.query<{ id: number; name: string }>(
    `SELECT id,name FROM locations WHERE company_id=$1 ORDER BY id`,
    [companyId]
  );
  const locationsByName = new Map<string, number[]>();
  for (const location of locationRows.rows) {
    const ids = locationsByName.get(location.name) ?? [];
    ids.push(Number(location.id));
    locationsByName.set(location.name, ids);
  }

  for (const row of rows.rows) {
    if (!row.stock_item_id || !row.location_name || row.old_quantity === null || row.new_quantity === null) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: row.stock_item_id ? Number(row.stock_item_id) : null,
        code: "LEGACY_MANUAL_ADJUSTMENT_UNRESOLVED",
        status: "block",
        detail: `Audit row ${row.id} is missing item/location/quantity evidence`,
      });
      continue;
    }

    const locationIds = locationsByName.get(row.location_name) ?? [];
    if (locationIds.length !== 1) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: Number(row.stock_item_id),
        code: "LEGACY_MANUAL_ADJUSTMENT_LOCATION_AMBIGUOUS",
        status: "block",
        actual: String(locationIds.length),
        detail: `Audit row ${row.id} location "${row.location_name}" did not resolve to exactly one location`,
      });
      continue;
    }

    const delta = d(row.new_quantity).minus(d(row.old_quantity));
    if (delta.isZero()) continue;
    movements.push({
      movement_id: `manual-audit:${row.id}`,
      location_id: locationIds[0],
      stock_item_id: Number(row.stock_item_id),
      quantity_delta: repairQuantity(delta).toFixed(3),
      unit_cost: null,
      occurred_at: row.created_at,
      sequence: Number(row.id) * 10 + 9,
      source_type: "legacy-manual-inventory-adjustment",
      source_id: String(row.id),
    });
  }
  return { movements, checks };
}
