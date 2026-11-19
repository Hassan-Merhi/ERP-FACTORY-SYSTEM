// Extracted from ./historicalSalesCostRepairLoaders.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";
import {
  canonicalPosRoleFromIdempotencyKey,
  type HistoricalSalesRepairMovement,
} from "./historicalSalesCostRepairEngine";
import {
  CanonicalRow,
  HistoricalMergeRow,
  hscrError,
  InventoryRow,
  iso,
  OffloadValueEvidenceRow,
  SaleRow,
  StockItemRow,
  ValuationCheckpoint,
  ValuationOverrideRow,
} from "./historicalSalesCostRepairTypes";
export { assertSalesCostTargetsInOpenPeriods } from "./historicalSalesCostRepairLoadersLoadCanonicalMovementsHelpers";

/**
 * Direct valuation overwrites recorded by the location cost-price import and
 * the direct location inventory update (inventory_valuation_overrides, stage
 * 031). Each is an exact before/after reset written in the same transaction as
 * the inventory row, so replay can cross it the way it crosses the Wave 6 reset.
 */
export async function loadValuationOverrides(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date
): Promise<ValuationOverrideRow[]> {
  const exists = await client.query<{ present: string | null }>(
    `SELECT to_regclass('public.inventory_valuation_overrides')::text AS present`
  );
  if (!exists.rows[0]?.present) return [];
  const rows = await client.query<ValuationOverrideRow>(
    `SELECT id,location_id,stock_item_id,source_type,
            before_quantity::text,before_average_rate::text,before_total_value::text,
            after_quantity::text,after_average_rate::text,after_total_value::text,
            created_at
       FROM inventory_valuation_overrides
      WHERE company_id=$1
        AND created_at <= $2
      ORDER BY created_at,id`,
    [companyId, sourceCutoff]
  );
  return rows.rows;
}

export async function enableMaintenanceScope(client: PoolClient): Promise<void> {
  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
  await client.query("SELECT set_config('app.current_company_id', '', true)");
  await client.query("SELECT set_config('app.authorized_company_ids', '', true)");
}

/**
 * Phase 19 (B), PE11: the apply and rollback write `sales_items` cost in the
 * tenant scope of the run's companies (the first as the current company, the
 * rest authorized; maintenance off), never in the maintenance scope, so the
 * closed-period guard and the opening lock apply to the transaction. Before
 * the companies are known the transaction runs with maintenance off and no
 * company (the repair's own tables are not company-scoped).
 */
export async function disableMaintenanceScope(client: PoolClient): Promise<void> {
  await client.query(
    `SELECT set_config('app.company_scope_maintenance', 'off', true),
            set_config('app.current_company_id', '', true),
            set_config('app.authorized_company_ids', '', true)`
  );
}

export async function enableRunCompanyScope(client: PoolClient, companyIds: readonly number[]): Promise<void> {
  const ids = [...new Set(companyIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  if (ids.length === 0) throw hscrError("HSCR_RUN_SCOPE_EMPTY");
  await client.query(
    `SELECT set_config('app.company_scope_maintenance', 'off', true),
            set_config('app.current_company_id', $1, true),
            set_config('app.authorized_company_ids', $2, true)`,
    [String(ids[0]), ids.slice(1).join(",")]
  );
}

export async function companyIdsForRun(client: PoolClient, requested?: number[]): Promise<number[]> {
  if (requested?.length) {
    const unique = [...new Set(requested.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
    const existing = await client.query<{ id: number }>(
      "SELECT id FROM companies WHERE id = ANY($1::int[]) ORDER BY id",
      [unique]
    );
    if (existing.rows.length !== unique.length) {
      throw hscrError("HSCR_REQUESTED_COMPANY_NOT_FOUND");
    }
    return existing.rows.map((row) => Number(row.id));
  }
  const all = await client.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
  return all.rows.map((row) => Number(row.id));
}

export async function loadCanonicalStart(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date
): Promise<Date | null> {
  const result = await client.query<{ started_at: Date | null }>(
    `SELECT MIN(created_at) AS started_at
       FROM canonical_stock_movements
      WHERE company_id=$1 AND created_at <= $2`,
    [companyId, sourceCutoff]
  );
  return result.rows[0]?.started_at ?? null;
}

export async function loadCanonicalMovements(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<HistoricalSalesRepairMovement[]> {
  if (!canonicalStart) return [];
  const rows = await client.query<CanonicalRow>(
    `SELECT id,location_id,stock_item_id,quantity_delta::text,unit_cost::text,
            source_type,source_id,occurred_at,created_at,reversal_of_movement_id,idempotency_key
       FROM canonical_stock_movements
      WHERE company_id=$1
        AND created_at >= $2
        AND created_at <= $3
      ORDER BY occurred_at,id`,
    [companyId, canonicalStart, sourceCutoff]
  );
  // A voucher created before canonical journaling has canonical revision 0,
  // so its first edit journals rev0:reverse/rev0:issue legs. Only a rev0
  // issue with no reversal legs of the same voucher at the same instant is an
  // original sale issue (the post-2026-09-26 original key format).
  const editInstants = new Set(
    rows.rows
      .filter(
        (row) => row.source_type === "pos-sale" && /^pos-sale:\d+:rev\d+:reverse:/.test(row.idempotency_key ?? "")
      )
      .map((row) => `${row.source_id}:${iso(row.created_at)}`)
  );
  const roleFor = (row: CanonicalRow) => {
    const role = canonicalPosRoleFromIdempotencyKey(row.source_type, row.idempotency_key);
    if (
      role === "sale-issue" &&
      /^pos-sale:\d+:rev0:issue:/.test(row.idempotency_key ?? "") &&
      editInstants.has(`${row.source_id}:${iso(row.created_at)}`)
    ) {
      return "edit-issue" as const;
    }
    return role;
  };
  return rows.rows.map((row) => ({
    canonicalPosRole: roleFor(row),
    idempotencyKey: row.idempotency_key ?? null,
    movementId: `canonical:${row.id}`,
    companyId,
    locationId: Number(row.location_id),
    stockItemId: Number(row.stock_item_id),
    occurredAt: iso(row.occurred_at),
    createdAt: iso(row.created_at),
    sequence: Number(row.id) * 10 + 5,
    quantityDelta: String(row.quantity_delta),
    unitCost: row.unit_cost === null ? null : String(row.unit_cost),
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidence: "canonical" as const,
    reversalOfMovementId: row.reversal_of_movement_id === null ? null : Number(row.reversal_of_movement_id),
  }));
}

export async function loadValuationCheckpoint(
  client: PoolClient,
  companyId: number
): Promise<ValuationCheckpoint | null> {
  const cutover = await client.query<{ movement_cutoff_id: number; created_at: Date }>(
    `SELECT movement_cutoff_id,created_at
       FROM phase3_inventory_valuation_cutovers
      WHERE company_id=$1
      LIMIT 1`,
    [companyId]
  );
  const row = cutover.rows[0];
  if (!row) return null;

  const baseline = await client.query<InventoryRow>(
    `SELECT location_id,stock_item_id,quantity::text,average_rate::text,total_value::text
       FROM phase3_inventory_valuation_baselines
      WHERE company_id=$1
      ORDER BY location_id,stock_item_id`,
    [companyId]
  );
  return {
    movementCutoffId: Number(row.movement_cutoff_id),
    createdAt: row.created_at,
    rows: baseline.rows,
  };
}

export async function loadOffloadValueEvidence(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date
): Promise<OffloadValueEvidenceRow[]> {
  const result = await client.query<OffloadValueEvidenceRow>(
    `SELECT co.id AS offload_id,coi.stock_item_id,
            coi.quantity::text,coi.rate::text,coi.total_value::text,
            co.offloaded_at
       FROM container_offload_items coi
       JOIN container_offloads co ON co.id=coi.offload_id
       JOIN containers c ON c.id=co.container_id
      WHERE c.company_id=$1
        AND co.offloaded_at <= $2
      ORDER BY co.id,coi.stock_item_id`,
    [companyId, sourceCutoff]
  );
  return result.rows;
}

export async function loadHistoricalMerges(client: PoolClient, companyId: number): Promise<HistoricalMergeRow[]> {
  const result = await client.query<HistoricalMergeRow>(
    `SELECT
        a.id AS alias_id,
        a.alias_code,
        a.created_at AS alias_created_at,
        source.id AS source_item_id,
        source.code AS source_code,
        source.opening_qty::text AS source_opening_qty,
        source.opening_rate::text AS source_opening_rate,
        source.opening_value::text AS source_opening_value,
        source.deleted_at AS source_deleted_at,
        kept.id AS kept_item_id,
        kept.code AS kept_code,
        kept.opening_qty::text AS kept_opening_qty,
        kept.opening_rate::text AS kept_opening_rate,
        kept.opening_value::text AS kept_opening_value,
        COALESCE(source.deleted_at,a.created_at) AS merge_at
       FROM stock_item_code_aliases a
       JOIN stock_items kept
         ON kept.company_id=a.company_id
        AND kept.id=a.stock_item_id
       JOIN stock_items source
         ON source.company_id=a.company_id
        AND source.code=a.alias_code
        AND source.id<>a.stock_item_id
      WHERE a.company_id=$1
        AND a.description LIKE 'Merged from:%'
      ORDER BY COALESCE(source.deleted_at,a.created_at),a.id`,
    [companyId]
  );
  return result.rows;
}

export async function loadStockItems(client: PoolClient, companyId: number): Promise<StockItemRow[]> {
  const result = await client.query<StockItemRow>(
    `SELECT id,code,opening_qty::text,opening_rate::text,opening_value::text,
            active,deleted_at,created_at
       FROM stock_items
      WHERE company_id=$1
      ORDER BY id`,
    [companyId]
  );
  return result.rows;
}

export async function loadSales(client: PoolClient, companyId: number, sourceCutoff: Date): Promise<SaleRow[]> {
  const rows = await client.query<SaleRow>(
    `SELECT si.id AS sales_item_id,si.voucher_id,v.location_id,si.stock_item_id,
            si.quantity::text,si.total_sales::text,si.cost_price::text,
            si.total_cost::text,si.profit::text,
            GREATEST(si.created_at,v.created_at) AS created_at
       FROM sales_items si
       JOIN vouchers v ON v.id=si.voucher_id
      WHERE v.company_id=$1
        AND v.voucher_type='Sales'
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(si.created_at,v.created_at) <= $2
      ORDER BY GREATEST(si.created_at,v.created_at),si.id`,
    [companyId, sourceCutoff]
  );
  return rows.rows;
}
