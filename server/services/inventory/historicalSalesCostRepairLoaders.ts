/** Database reads that feed the historical sales-cost repair dry run. */
import type { PoolClient } from "pg";

import {
  canonicalPosRoleFromIdempotencyKey,
  repairQuantity,
  type HistoricalSalesRepairMovement,
} from "./historicalSalesCostRepairEngine";
import {
  AuditInventoryRow,
  CanonicalRow,
  HistoricalMergeRow,
  InventoryRow,
  LegacyRow,
  OffloadValueEvidenceRow,
  RepairCheck,
  SaleRow,
  StockItemRow,
  ValuationCheckpoint,
  ValuationOverrideRow,
  d,
  hscrError,
  iso,
} from "./historicalSalesCostRepairTypes";

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

export async function loadLegacyMovements(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<LegacyRow[]> {
  const params = [companyId, canonicalStart, sourceCutoff];
  const rows = await client.query<LegacyRow>(
    `
    WITH boundary AS (
      SELECT $1::int AS company_id,$2::timestamptz AS canonical_start,$3::timestamptz AS source_cutoff
    ),
    -- V36: offloadContainer() posts its charge vouchers inside the same
    -- transaction that mutates inventory, numbered
    -- PREFIX-{containerNumber}-{Date.now()}. That system-generated millisecond
    -- stamp, corroborated by vouchers.created_at, is the real inventory
    -- mutation time; offloaded_at is only the user-entered calendar date.
    -- Used only when the container has exactly one offload and exactly one
    -- charge-voucher transaction, so re-offloads and later charge edits fall
    -- back to offloaded_at.
    offload_voucher_groups AS (
      SELECT
        v.company_id,
        substring(v.voucher_number from '^(?:DUTY|OFFICE|TRANS|XFER|CHG)-(.+)-[0-9]{13}$') AS container_number,
        COUNT(DISTINCT v.created_at) AS transaction_groups,
        MIN(v.created_at) AS entered_at,
        bool_and(
          ABS(
            substring(v.voucher_number from '([0-9]{13})$')::bigint -
            (EXTRACT(EPOCH FROM v.created_at) * 1000)::bigint
          ) < 120000
        ) AS stamp_agrees
      FROM vouchers v
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.voucher_type='Payment'
        AND v.voucher_number ~ '^(DUTY|OFFICE|TRANS|XFER|CHG)-.+-[0-9]{13}$'
      GROUP BY 1,2
    ),
    offload_entry AS (
      SELECT co.id AS offload_id, g.entered_at AS mutation_at
      FROM container_offloads co
      JOIN containers c ON c.id=co.container_id
      JOIN boundary b ON b.company_id=c.company_id
      JOIN offload_voucher_groups g
        ON g.company_id=c.company_id
       AND g.container_number=c.container_number
      WHERE COALESCE(co.optional,false)=false
        AND g.transaction_groups=1
        AND g.stamp_agrees
        AND g.entered_at <= b.source_cutoff
        AND (SELECT COUNT(*) FROM container_offloads o2 WHERE o2.container_id=co.container_id)=1
    ),
    offloads AS (
      SELECT
        'offload:'||coi.id::text AS movement_id,
        co.location_id,
        coi.stock_item_id,
        coi.quantity::text AS quantity_delta,
        coi.rate::text AS unit_cost,
        co.offloaded_at AS occurred_at,
        coi.id*10+1 AS sequence,
        'legacy-container-offload'::text AS source_type,
        co.id::text AS source_id
      FROM container_offload_items coi
      JOIN container_offloads co ON co.id=coi.offload_id
      JOIN containers c ON c.id=co.container_id
      JOIN boundary b ON b.company_id=c.company_id
      WHERE COALESCE(co.optional,false)=false
        AND co.offloaded_at <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=coi.stock_item_id
             AND csm.location_id=co.location_id
             AND csm.source_type IN ('legacy-container-offload','container-offload')
             AND csm.source_id=co.id::text
             AND csm.created_at <= b.source_cutoff
        )
    ),
    adjustments AS (
      SELECT
        'adjustment:'||sai.id::text,
        sav.location_id,
        sai.stock_item_id,
        (CASE
           WHEN lower(sav.adjustment_type)='production' THEN ABS(sai.quantity)
           WHEN lower(sav.adjustment_type)='consumption' THEN -ABS(sai.quantity)
           ELSE sai.quantity
         END)::text,
        sai.rate::text,
        GREATEST(sai.created_at,sav.created_at,v.created_at),
        sai.id*10+2,
        'legacy-stock-adjustment',
        sav.id::text
      FROM stock_adjustment_items sai
      JOIN stock_adjustment_vouchers sav ON sav.id=sai.adjustment_id
      JOIN vouchers v ON v.id=sav.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sai.created_at,sav.created_at,v.created_at) <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=sai.stock_item_id
             AND csm.location_id=sav.location_id
             AND csm.source_type='stock-adjustment'
             AND csm.source_id=sav.id::text
             AND csm.created_at <= b.source_cutoff
        )
    ),
    transfer_source AS (
      SELECT
        'transfer-out:'||sti.id::text,
        COALESCE(sti.source_location_id,stv.source_location_id) AS location_id,
        sti.stock_item_id,
        (-ABS(sti.quantity))::text,
        sti.rate::text,
        GREATEST(sti.created_at,stv.created_at,v.created_at),
        sti.id*10+3,
        CASE
          WHEN COALESCE(stv.inventory_applied,false)=true THEN 'legacy-stock-transfer-out'
          ELSE 'legacy-stock-transfer-out-flag-fallback'
        END,
        stv.id::text
      FROM stock_transfer_items sti
      JOIN stock_transfer_vouchers stv ON stv.id=sti.transfer_id
      JOIN vouchers v ON v.id=stv.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE COALESCE(sti.source_location_id,stv.source_location_id) IS NOT NULL
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sti.created_at,stv.created_at,v.created_at) <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=sti.stock_item_id
             AND csm.location_id=COALESCE(sti.source_location_id,stv.source_location_id)
             AND csm.source_type IN ('stock-transfer','stock-transfer-import','stock-transfer-import-multi-source')
             AND csm.source_id IN (stv.id::text,v.id::text)
             AND csm.created_at <= b.source_cutoff
        )
    ),
    transfer_destination AS (
      SELECT
        'transfer-in:'||sti.id::text,
        stv.destination_location_id,
        sti.stock_item_id,
        ABS(sti.quantity)::text,
        sti.rate::text,
        GREATEST(sti.created_at,stv.created_at,v.created_at),
        sti.id*10+4,
        CASE
          WHEN COALESCE(stv.inventory_applied,false)=true THEN 'legacy-stock-transfer-in'
          ELSE 'legacy-stock-transfer-in-flag-fallback'
        END,
        stv.id::text
      FROM stock_transfer_items sti
      JOIN stock_transfer_vouchers stv ON stv.id=sti.transfer_id
      JOIN vouchers v ON v.id=stv.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sti.created_at,stv.created_at,v.created_at) <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=sti.stock_item_id
             AND csm.location_id=stv.destination_location_id
             AND csm.source_type IN ('stock-transfer','stock-transfer-import','stock-transfer-import-multi-source')
             AND csm.source_id IN (stv.id::text,v.id::text)
             AND csm.created_at <= b.source_cutoff
        )
    ),
    notes AS (
      SELECT
        'note:'||cni.id::text,
        cni.location_id,
        cni.stock_item_id,
        (CASE WHEN v.voucher_type='Credit Note' THEN ABS(cni.quantity) ELSE -ABS(cni.quantity) END)::text,
        cni.inventory_cost::text,
        GREATEST(cni.created_at,v.created_at),
        cni.id*10+6,
        CASE WHEN v.voucher_type='Credit Note' THEN 'legacy-credit-note' ELSE 'legacy-debit-note' END,
        v.id::text
      FROM credit_note_items cni
      JOIN vouchers v ON v.id=cni.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.voucher_type IN ('Credit Note','Debit Note')
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(cni.created_at,v.created_at) <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=cni.stock_item_id
             AND csm.location_id=cni.location_id
             AND csm.source_type IN ('credit-note','debit-note')
             AND csm.source_id=v.id::text
             AND csm.created_at <= b.source_cutoff
        )
    ),
    archive_out AS (
      SELECT
        'archive-out:'||ai.id::text,
        a.location_id,
        ai.stock_item_id,
        (-ABS(ai.quantity))::text,
        ai.average_rate::text,
        a.archived_at,
        ai.id*10+7,
        'legacy-stock-group-archive',
        a.id::text
      FROM stock_group_location_archive_items ai
      JOIN stock_group_location_archives a ON a.id=ai.archive_id
      JOIN boundary b ON b.company_id=a.company_id
      WHERE a.archived_at <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=ai.stock_item_id
             AND csm.location_id=a.location_id
             AND csm.source_type='stock_group_location_archive'
             AND csm.source_id=a.id::text
             AND csm.created_at <= b.source_cutoff
        )
    ),
    archive_in AS (
      SELECT
        'archive-in:'||ai.id::text,
        a.location_id,
        ai.stock_item_id,
        ABS(ai.quantity)::text,
        ai.average_rate::text,
        a.restored_at,
        ai.id*10+8,
        'legacy-stock-group-archive-restore',
        a.id::text
      FROM stock_group_location_archive_items ai
      JOIN stock_group_location_archives a ON a.id=ai.archive_id
      JOIN boundary b ON b.company_id=a.company_id
      WHERE a.restored_at IS NOT NULL
        AND a.restored_at <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=ai.stock_item_id
             AND csm.location_id=a.location_id
             AND csm.source_type='stock_group_location_archive_restore'
             AND csm.source_id=a.id::text
             AND csm.created_at <= b.source_cutoff
        )
    )
    SELECT u.*, oe.mutation_at
    FROM (
      SELECT * FROM offloads
      UNION ALL SELECT * FROM adjustments
      UNION ALL SELECT * FROM transfer_source
      UNION ALL SELECT * FROM transfer_destination
      UNION ALL SELECT * FROM notes
      UNION ALL SELECT * FROM archive_out
      UNION ALL SELECT * FROM archive_in
    ) u
    LEFT JOIN offload_entry oe
      ON u.source_type='legacy-container-offload'
     AND oe.offload_id::text=u.source_id
    ORDER BY u.occurred_at,u.sequence
    `,
    params
  );
  return rows.rows;
}

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
