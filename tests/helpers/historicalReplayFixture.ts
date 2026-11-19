/**
 * One supplier whose stored costs are stale against the container's contract
 * rate: container rate 2 USD/kg but rate_per_kg_usd, raw stock, the mix source,
 * the batch, the bale and the supplier's running rate all still say 1. The
 * historical replay preview classifies it as safe with every company-wide gate
 * passing, so Prepare signs a scope covering exactly one row of each kind.
 *
 * Rows are written through the given client, so callers inside a rolled-back
 * transaction leave nothing behind.
 */
import type { PoolClient } from "pg";

export interface StaleReplayWorld {
  supplierId: number;
  containerId: number;
  rawStockId: number;
  batchId: number;
  sourceId: number;
  baleId: number;
}

export interface StaleReplayOptions {
  batchStatus?: string;
  baleStatus?: string;
  supplierName?: string;
  /** Skip the bale so the batch has no pressed output (used_kg stays 0). */
  withoutBale?: boolean;
}

const firstId = (result: { rows: Array<{ id: unknown }> }) => Number(result.rows[0].id);

export async function seedStaleReplaySupplier(
  client: PoolClient,
  companyId: number,
  options: StaleReplayOptions = {}
): Promise<StaleReplayWorld> {
  const supplierId = firstId(
    await client.query(
      `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd)
     VALUES ($1, $2, 1) RETURNING id`,
      [companyId, options.supplierName ?? "Replay Supplier"]
    )
  );
  const containerId = firstId(
    await client.query(
      `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, status, actual_received_kg, rate_per_kg,
        rate_per_kg_usd, currency_code, final_payable_amount_usd, arrival_date)
     VALUES ($1, $2, $3, 'RECEIVED', 100, 2, 1, 'USD', 100, '2026-01-01') RETURNING id`,
      [companyId, `RC${supplierId}`, supplierId]
    )
  );
  const rawStockId = firstId(
    await client.query(
      `INSERT INTO factory_raw_stock
       (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd, offloaded_at)
     VALUES ($1, $2, 100, 40, 1, 1, '2026-01-02') RETURNING id`,
      [companyId, containerId]
    )
  );
  const batchId = firstId(
    await client.query(
      `INSERT INTO factory_mix_batches
       (company_id, batch_code, batch_number, status, total_weight_kg, cost_per_kg, total_cost, batch_date)
     VALUES ($1, $2::text, $2::text, $3, 40, 1, 40, '2026-01-05') RETURNING id`,
      [companyId, `RB${supplierId}`, options.batchStatus ?? "OPEN"]
    )
  );
  const sourceId = firstId(
    await client.query(
      `INSERT INTO factory_mix_batch_sources
       (mix_batch_id, supplier_id, container_id, inventory_supplier_id, weight_kg, cost_per_kg, total_cost)
     VALUES ($1, $2, $3, $2, 40, 1, 40) RETURNING id`,
      [batchId, supplierId, containerId]
    )
  );
  if (options.withoutBale) return { supplierId, containerId, rawStockId, batchId, sourceId, baleId: 0 };
  const baleId = firstId(
    await client.query(
      `INSERT INTO factory_bales
       (company_id, reference_number, mix_batch_id, weight_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2, $3, 20, 1, 20, $4) RETURNING id`,
      [companyId, `RBL${supplierId}`, batchId, options.baleStatus ?? "AVAILABLE"]
    )
  );
  return { supplierId, containerId, rawStockId, batchId, sourceId, baleId };
}

/** Current stored cost columns for every row the fixture created. */
export async function readStaleReplayCosts(client: PoolClient, world: StaleReplayWorld) {
  const { rows } = await client.query(
    `SELECT
       (SELECT cost_per_kg_usd::float FROM factory_raw_stock WHERE id = $1) AS raw_stock_rate,
       (SELECT rate_per_kg_usd::float FROM factory_containers WHERE id = $2) AS container_rate,
       (SELECT final_payable_amount_usd::float FROM factory_containers WHERE id = $2) AS container_total,
       (SELECT total_cost::float FROM factory_mix_batch_sources WHERE id = $3) AS source_total,
       (SELECT total_cost::float FROM factory_mix_batches WHERE id = $4) AS batch_total,
       (SELECT total_cost::float FROM factory_bales WHERE id = $5) AS bale_total,
       (SELECT current_raw_material_cost_per_kg_usd::float FROM factory_suppliers WHERE id = $6) AS supplier_rate`,
    [world.rawStockId, world.containerId, world.sourceId, world.batchId, world.baleId, world.supplierId]
  );
  return rows[0] as Record<string, number>;
}

export const STALE_COSTS = {
  raw_stock_rate: 1,
  container_rate: 1,
  container_total: 100,
  source_total: 40,
  batch_total: 40,
  bale_total: 20,
  supplier_rate: 1,
};

export const REPLAYED_COSTS = {
  raw_stock_rate: 2,
  container_rate: 2,
  container_total: 200,
  source_total: 80,
  batch_total: 80,
  bale_total: 40,
  supplier_rate: 2,
};
